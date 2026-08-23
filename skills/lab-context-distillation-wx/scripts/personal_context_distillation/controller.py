import time
from pathlib import Path

from .atomic import append_jsonl, read_json, write_json
from .hashing import digest_object


def freeze_runtime_policy(case_root: Path, name: str, policy: dict) -> dict:
    if not name or any(character in name for character in ("/", "\\", "\x00")):
        raise RuntimeError("invalid runtime policy name")
    required = {"semantic_model", "capability_tier", "dynamic_concurrency", "fast_mode"}
    if set(policy) != required:
        raise RuntimeError("runtime policy has unknown or missing fields")
    if policy["semantic_model"] != "current_user_model":
        raise RuntimeError("runtime policy cannot bind a vendor or model name")
    if policy["capability_tier"] not in {"ordinary", "advanced", "mixed"}:
        raise RuntimeError("runtime capability tier is invalid")
    if policy["dynamic_concurrency"] is not True or policy["fast_mode"] is not False:
        raise RuntimeError("runtime policy requires dynamic concurrency and has no Fast mode")
    body = {"schema_version": "pcd-runtime-policy/v1", "name": name, **policy}
    body["seal"] = digest_object(body)
    path = Path(case_root) / "run-scopes" / f"{name}.runtime-policy.json"
    if path.exists():
        existing = read_json(path)
        if existing != body:
            raise RuntimeError("runtime policy is immutable")
        return existing
    write_json(path, body)
    return body


def freeze_run_scope(case_root: Path, name: str, unit_ids: list[str], generation: str) -> dict:
    if not name or any(character in name for character in ("/", "\\", "\x00")):
        raise RuntimeError("invalid run scope name")
    path = Path(case_root) / "run-scopes" / f"{name}.json"
    body = {
        "schema_version": "pcd-run-scope/v1",
        "name": name,
        "generation": generation,
        "unit_ids": sorted(set(unit_ids)),
        "unit_count": len(set(unit_ids)),
        "migration_watermark": digest_object({"generation": generation, "unit_ids": sorted(set(unit_ids))}),
    }
    body["seal"] = digest_object(body)
    if path.exists():
        existing = read_json(path)
        if existing != body:
            raise RuntimeError("run scope is immutable")
        return existing
    write_json(path, body)
    return body


def observe_run_scope(case_root: Path, name: str, states: dict[str, dict], now: float | None = None) -> dict:
    path = Path(case_root) / "run-scopes" / f"{name}.json"
    if not path.is_file():
        raise RuntimeError("run scope does not exist")
    scope = read_json(path)
    claimed = scope.get("seal")
    unsigned = {key: value for key, value in scope.items() if key != "seal"}
    if not claimed or digest_object(unsigned) != claimed:
        raise RuntimeError("run scope seal verification failed")
    counts = {}
    missing = []
    for unit_id in scope["unit_ids"]:
        state = states.get(unit_id)
        if state is None:
            missing.append(unit_id)
            continue
        counts[state["status"]] = counts.get(state["status"], 0) + 1
    terminal = counts.get("accepted", 0) + counts.get("quarantined_content", 0)
    observation = {
        "schema_version": "pcd-scope-observation/v1",
        "scope": name,
        "scope_seal": scope["seal"],
        "observed_at": time.time() if now is None else now,
        "unit_count": scope["unit_count"],
        "pending": scope["unit_count"] - terminal,
        "accepted": counts.get("accepted", 0),
        "quarantined": counts.get("quarantined_content", 0),
        "status_counts": counts,
        "missing_units": missing,
        "drained": terminal == scope["unit_count"] and not missing,
    }
    observation["receipt_hash"] = digest_object(observation)
    append_jsonl(Path(case_root) / "receipts" / "scope-observations.jsonl", observation)
    return observation


class AdaptiveController:
    def __init__(self, case, max_concurrency: int, validator_backlog_limit: int = 16,
                 canary_sample_size: int = 3, systemic_failure_threshold: float = 0.67,
                 infrastructure_cooldown_threshold: int = 3, infrastructure_cooldown_seconds: float = 60):
        if max_concurrency < 1 or validator_backlog_limit < 1:
            raise ValueError("controller limits must be positive")
        if canary_sample_size < 1 or not 0 < systemic_failure_threshold <= 1:
            raise ValueError("canary policy is invalid")
        if infrastructure_cooldown_threshold < 1 or infrastructure_cooldown_seconds <= 0:
            raise ValueError("infrastructure cooldown policy is invalid")
        self.case = case
        self.max_concurrency = max_concurrency
        self.validator_backlog_limit = validator_backlog_limit
        self.canary_sample_size = canary_sample_size
        self.systemic_failure_threshold = systemic_failure_threshold
        self.infrastructure_cooldown_threshold = infrastructure_cooldown_threshold
        self.infrastructure_cooldown_seconds = infrastructure_cooldown_seconds

    def systemic_rejection(self) -> bool:
        assessed = [state for state in self.case.ledger.states().values()
                    if state["status"] in {"accepted", "quarantined_content", "needs_human"}]
        if len(assessed) < self.canary_sample_size:
            return False
        rejected = [state for state in assessed
                    if state.get("failure_category") in {"content", "structure"}]
        return len(rejected) / len(assessed) >= self.systemic_failure_threshold

    def infrastructure_signal(self, now: float) -> tuple[int, float | None, bool]:
        failures = [
            state.get("failed_at")
            for state in self.case.ledger.states().values()
            if state.get("failure_category") == "infrastructure"
            and isinstance(state.get("failed_at"), (int, float))
        ]
        latest = max(failures) if failures else None
        repeated = len(failures) >= self.infrastructure_cooldown_threshold
        cooldown_until = latest + self.infrastructure_cooldown_seconds if repeated and latest is not None else None
        return len(failures), cooldown_until, repeated

    def target_concurrency(self, now: float | None = None) -> int:
        now = time.time() if now is None else now
        if self.systemic_rejection():
            return 0
        _, cooldown_until, repeated = self.infrastructure_signal(now)
        if repeated and cooldown_until is not None and now < cooldown_until:
            return 0
        states = self.case.ledger.states().values()
        infra = sum(
            state.get("failure_category") == "infrastructure" and state["status"] != "accepted"
            for state in states
        )
        return max(1, self.max_concurrency // 2) if infra else self.max_concurrency

    def refill(self, worker_prefix: str, now: float | None = None, lease_seconds: int = 900) -> dict:
        now = time.time() if now is None else now
        states = self.case.ledger.states()
        systemic = self.systemic_rejection()
        infra_count, cooldown_until, fallback_recommended = self.infrastructure_signal(now)
        cooling = fallback_recommended and cooldown_until is not None and now < cooldown_until
        target = self.target_concurrency(now)
        halted = target == 0
        halt_reason = "systemic_content_or_structure" if systemic else "infrastructure_cooldown" if cooling else None
        active = sum(
            state["status"] == "reserved" and state.get("lease_until", 0) >= now
            for state in states.values()
        )
        backlog = sum(state["status"] == "produced" for state in states.values())
        available = 0 if halted or backlog >= self.validator_backlog_limit else max(0, target - active)
        claimed = []
        for unit_id in sorted(states):
            if len(claimed) >= available:
                break
            if self.case.ledger.claim(unit_id, f"{worker_prefix}-{active + len(claimed) + 1}", now=now, lease_seconds=lease_seconds):
                claimed.append(unit_id)
        observation = {
            "schema_version": "pcd-controller-observation/v1",
            "observed_at": now,
            "target_concurrency": target,
            "halted_systemic": systemic,
            "halt_reason": halt_reason,
            "infrastructure_failure_count": infra_count,
            "cooldown_until": cooldown_until if cooling else None,
            "fallback_recommended": fallback_recommended,
            "active_before_refill": active,
            "validator_backlog": backlog,
            "claimed": claimed,
        }
        observation["observation_hash"] = digest_object(observation)
        append_jsonl(self.case.root / "receipts" / "controller-observations.jsonl", observation)
        return observation
