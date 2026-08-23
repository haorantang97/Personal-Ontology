import time
from pathlib import Path

from .atomic import append_jsonl, read_jsonl
from .hashing import digest_object


class LedgerError(RuntimeError):
    pass


class WorkLedger:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._events_cache: list[dict] | None = None
        self._states_cache: dict[str, dict] | None = None

    def _events(self) -> list[dict]:
        if self._events_cache is None:
            self._events_cache = read_jsonl(self.path)
        return self._events_cache

    def _append(self, event: dict) -> dict:
        events = self._events()
        event = dict(event)
        event["previous_hash"] = events[-1]["event_hash"] if events else None
        event["event_hash"] = digest_object(event)
        append_jsonl(self.path, event)
        events.append(event)
        if self._states_cache is not None:
            self._apply_event(self._states_cache, event)
        return event

    @staticmethod
    def _apply_event(states: dict[str, dict], event: dict) -> None:
        unit_id = event["unit_id"]
        kind = event["event"]
        if kind == "added":
            if unit_id in states:
                raise LedgerError(f"duplicate unit: {unit_id}")
            states[unit_id] = {
                "unit_id": unit_id,
                "stage": event["stage"],
                "payload_hash": event["payload_hash"],
                "dependencies": event.get("dependencies", []),
                "status": "pending",
            }
            return
        if unit_id not in states:
            raise LedgerError(f"event references unknown unit: {unit_id}")
        state = states[unit_id]
        if state["status"] == "accepted":
            raise LedgerError(f"accepted unit has a later event: {unit_id}")
        if kind == "claimed":
            state.update(status="reserved", worker_id=event["worker_id"], lease_until=event["lease_until"])
        elif kind == "produced":
            state.update(status="produced", output_hash=event["output_hash"])
        elif kind == "validated":
            state.update(status="validated", validation_hash=event["validation_hash"],
                         validated_output_hash=event.get("accepted_result_hash", state.get("output_hash")))
        elif kind == "accepted":
            state.update(status="accepted")
        elif kind == "quarantined":
            state.update(status="quarantined_content", reason=event["reason"])
        elif kind == "needs_human":
            state.update(status="needs_human", reason=event["reason"])
        elif kind == "human_adjudicated":
            if event["decision"] == "accept":
                state.update(status="accepted", adjudication_receipt=event["receipt_hash"],
                             validated_output_hash=event.get("accepted_result_hash"))
            else:
                state.update(status="quarantined_content", adjudication_receipt=event["receipt_hash"])
        elif kind == "failed":
            status_by_category = {
                "infrastructure": "retry_infra",
                "structure": "needs_human",
                "content": "quarantined_content",
                "privacy": "blocked_privacy",
                "dependency": "blocked_dependency",
            }
            category = event["category"]
            if category not in status_by_category:
                raise LedgerError(f"unknown failure category: {category}")
            state.update(status=status_by_category[category], reason=event["reason"], failure_category=category,
                         failed_at=event.get("failed_at"))
        else:
            raise LedgerError(f"unknown ledger event: {kind}")

    def verify(self) -> None:
        previous = None
        fresh_events = read_jsonl(self.path)
        for event in fresh_events:
            if event.get("previous_hash") != previous:
                raise LedgerError("ledger hash chain is broken")
            claimed = event.get("event_hash")
            body = {k: v for k, v in event.items() if k != "event_hash"}
            if digest_object(body) != claimed:
                raise LedgerError("ledger event hash mismatch")
            previous = claimed
        self._events_cache = fresh_events
        self._states_cache = None

    def states(self) -> dict[str, dict]:
        if self._states_cache is None:
            self._states_cache = {}
            for event in self._events():
                self._apply_event(self._states_cache, event)
        return self._states_cache

    def state(self, unit_id: str) -> dict:
        states = self.states()
        if unit_id not in states:
            raise LedgerError(f"unknown unit: {unit_id}")
        return states[unit_id]

    def add(self, unit_id: str, stage: str, payload_hash: str, dependencies: list[str] | None = None) -> None:
        states = self.states()
        if unit_id in states:
            current = states[unit_id]
            if current["payload_hash"] == payload_hash and current["stage"] == stage:
                return
            raise LedgerError(f"unit already exists with different definition: {unit_id}")
        self._append({"event": "added", "unit_id": unit_id, "stage": stage, "payload_hash": payload_hash,
                      "dependencies": list(dependencies or [])})

    def claim(self, unit_id: str, worker_id: str, now: float | None = None, lease_seconds: int = 300) -> bool:
        now = time.time() if now is None else now
        state = self.state(unit_id)
        if state["status"] == "accepted":
            return False
        states = self.states()
        if any(dep not in states or states[dep]["status"] != "accepted" for dep in state.get("dependencies", [])):
            return False
        if state["status"] == "reserved" and state.get("lease_until", 0) >= now:
            return False
        if state["status"] not in {"pending", "reserved", "retry_infra", "blocked_dependency"}:
            return False
        self._append({"event": "claimed", "unit_id": unit_id, "worker_id": worker_id,
                      "claimed_at": now, "lease_until": now + lease_seconds})
        return True

    def produced(self, unit_id: str, output_hash: str) -> None:
        if self.state(unit_id)["status"] != "reserved":
            raise LedgerError("output requires a reserved unit")
        self._append({"event": "produced", "unit_id": unit_id, "output_hash": output_hash})

    def validated(self, unit_id: str, validation_hash: str, accepted_result_hash: str | None = None) -> None:
        if self.state(unit_id)["status"] != "produced":
            raise LedgerError("validation requires a produced unit")
        self._append({"event": "validated", "unit_id": unit_id, "validation_hash": validation_hash,
                      "accepted_result_hash": accepted_result_hash})

    def accept(self, unit_id: str) -> None:
        if self.state(unit_id)["status"] != "validated":
            raise LedgerError("acceptance requires a validated unit")
        self._append({"event": "accepted", "unit_id": unit_id})

    def quarantine(self, unit_id: str, reason: str) -> None:
        if self.state(unit_id)["status"] == "accepted":
            raise LedgerError("accepted is a terminal state")
        self._append({"event": "quarantined", "unit_id": unit_id, "reason": reason})

    def needs_human(self, unit_id: str, reason: str) -> None:
        if self.state(unit_id)["status"] == "accepted":
            raise LedgerError("accepted is a terminal state")
        self._append({"event": "needs_human", "unit_id": unit_id, "reason": reason})

    def human_adjudicate(self, unit_id: str, decision: str, receipt_hash: str,
                         accepted_result_hash: str | None = None) -> None:
        if decision not in {"accept", "reject"}:
            raise LedgerError("human decision must be accept or reject")
        if self.state(unit_id)["status"] != "needs_human":
            raise LedgerError("human adjudication requires needs_human state")
        self._append({"event": "human_adjudicated", "unit_id": unit_id,
                      "decision": decision, "receipt_hash": receipt_hash,
                      "accepted_result_hash": accepted_result_hash})

    def fail(self, unit_id: str, category: str, reason: str, now: float | None = None) -> None:
        if category not in {"infrastructure", "structure", "content", "privacy", "dependency"}:
            raise LedgerError(f"unknown failure category: {category}")
        if self.state(unit_id)["status"] == "accepted":
            raise LedgerError("accepted is a terminal state")
        self._append({"event": "failed", "unit_id": unit_id, "category": category, "reason": reason,
                      "failed_at": time.time() if now is None else now})
