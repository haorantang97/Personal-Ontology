import json
import os
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .atomic import append_jsonl, read_json, read_jsonl, write_json, write_private_json
from .authorization import AuthorizationStore
from .connectors import load_csv_rows, load_sqlite_rows
from .hashing import canonical_json, digest_file, digest_object
from .ledger import WorkLedger
from .planner import freeze_candidate_set, iter_record_packets
from .records import normalize_rows, validate_coverage
from .redaction import build_identity_alias_map, redact_record
from .release import build_release, verify_release
from .repair import SemanticRepairRequired, repair_structure
from .stage_quality import QualityError, validate_stage_output
from .transport import build_packet, preflight_packet
from .validation import ValidationError, validate_candidate


class PipelineError(RuntimeError):
    pass


DEFAULT_INSTRUCTIONS = {
    "map": "Extract evidence-bounded observations about expression, reasoning, values, behavior, limitations, counterexamples, costs, and change over time. Return JSON candidates only.",
    "merge": "Merge related candidates across events while preserving conflicts, gaps, counterexamples, costs, and every evidence link. Return JSON candidates only.",
    "final": "Synthesize a personal operating model from the frozen candidate set. Do not overstate weak evidence. Return JSON candidates only.",
    "qa": "Audit structure, evidence recall, attribution, negative patterns, counterexamples, coverage, and overreach. Return JSON findings only.",
}


class PCDCase:
    def __init__(self, root: Path):
        self.root = Path(root)
        if not (self.root / "case.json").exists():
            raise PipelineError("case is not initialized")
        self.authorizations = AuthorizationStore(self.root)
        self.ledger = WorkLedger(self.root / "ledger.jsonl")

    @classmethod
    def initialize(cls, root: Path) -> "PCDCase":
        root = Path(root)
        if (root / "case.json").exists():
            return cls(root)
        root.mkdir(parents=True, exist_ok=True)
        for relative in ("local", "packets", "results", "receipts", "kb-proposals", "kb-approvals"):
            (root / relative).mkdir(exist_ok=True)
        write_json(root / "case.json", {
            "schema_version": "pcd-case/v1",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "privacy_boundary": "raw-local; model-redacted-only",
        })
        return cls(root)

    def ingest_jsonl(self, path: Path, source_name: str) -> dict:
        path = Path(path)
        if not path.is_file():
            raise PipelineError("input JSONL does not exist")
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        if not rows:
            raise PipelineError("input JSONL is empty")
        return self.ingest_rows(rows, source_name=source_name, source_hash=digest_file(path))

    def ingest_csv(self, path: Path, source_name: str) -> dict:
        path = Path(path)
        return self.ingest_rows(load_csv_rows(path), source_name=source_name, source_hash=digest_file(path))

    def ingest_sqlite(self, path: Path, query: str, source_name: str) -> dict:
        path = Path(path)
        query_hash = digest_object({"query": query})
        source_hash = digest_object({"file_hash": digest_file(path), "query_hash": query_hash})
        return self.ingest_rows(load_sqlite_rows(path, query), source_name=source_name, source_hash=source_hash)

    def ingest_rows(self, rows: list[dict], source_name: str, source_hash: str) -> dict:
        self.authorizations.require("new_source")
        for row in rows:
            row["source"] = source_name
        previous_sources = read_jsonl(self.root / "local" / "sources.jsonl")
        if any(item["source_hash"] == source_hash for item in previous_sources):
            raise PipelineError("source has already been ingested")
        normalized = normalize_rows(rows)
        validate_coverage(rows, normalized)
        redacted = [redact_record(record)[0] for record in normalized]
        for record in normalized:
            append_jsonl(self.root / "local" / "normalized.jsonl", record)
        for record in redacted:
            append_jsonl(self.root / "local" / "redacted.jsonl", record)
        receipt = {
            "operation": "ingest_jsonl/v1",
            "source_hash": source_hash,
            "source_name_hash": digest_object({"source_name": source_name}),
            "record_count": len(records := normalized),
            "fingerprint_set_hash": digest_object(sorted(r["source_fingerprint"] for r in records)),
            "source_fingerprints": sorted(r["source_fingerprint"] for r in records),
        }
        append_jsonl(self.root / "local" / "sources.jsonl", receipt)
        return receipt

    @staticmethod
    def read_private_identity(path: Path) -> str:
        path = Path(path)
        if not path.is_file():
            raise PipelineError("private identity file does not exist")
        if os.name != "nt" and path.stat().st_mode & 0o077:
            raise PipelineError("private identity file permissions must not allow group or other access")
        identity = path.read_text(encoding="utf-8").strip()
        if not identity or len(identity) > 512 or "\x00" in identity:
            raise PipelineError("private identity file has an invalid value")
        return identity

    @staticmethod
    def _wechat_mapping_source_hash(mapping: dict) -> str:
        proposal = mapping["checkpoint_proposal"]
        return digest_object({
            "account_ref": mapping.get("account_ref"),
            "schema_fingerprint": mapping.get("schema_fingerprint"),
            "checkpoint_based_on": proposal.get("based_on"),
            "watermarks": proposal.get("watermarks"),
            "source_fingerprints": sorted(record["source_fingerprint"] for record in mapping["records"]),
        })

    @classmethod
    def _wechat_mapping_receipt(cls, mapping: dict, mapping_id: str) -> dict:
        fingerprints = sorted(record["source_fingerprint"] for record in mapping["records"])
        return {
            "operation": "ingest_wechat4_mapping/v1",
            "source_hash": cls._wechat_mapping_source_hash(mapping),
            "source_name_hash": digest_object({"account_ref": mapping.get("account_ref")}),
            "mapping_id": mapping_id,
            "record_count": len(mapping["records"]),
            "fingerprint_set_hash": digest_object(fingerprints),
            "source_fingerprints": fingerprints,
            "schema_fingerprint": mapping.get("schema_fingerprint"),
        }

    def ingest_wechat4_mapping(self, mapping: dict) -> dict:
        self.authorizations.require("new_source")
        if mapping.get("schema_version") != "pcd-wechat4-mapping/v1":
            raise PipelineError("unsupported WeChat 4.x mapping schema")
        source_rows = mapping.get("source_rows")
        records = mapping.get("records")
        proposal = mapping.get("checkpoint_proposal")
        if not isinstance(source_rows, list) or not isinstance(records, list) or not isinstance(proposal, dict):
            raise PipelineError("WeChat mapping is missing records or checkpoint proposal")
        if not records:
            raise PipelineError("WeChat mapping has no new records")
        validate_coverage(source_rows, records)
        source_hash = self._wechat_mapping_source_hash(mapping)
        previous_sources = read_jsonl(self.root / "local" / "sources.jsonl")
        if any(item.get("source_hash") == source_hash for item in previous_sources):
            raise PipelineError("WeChat mapping has already been ingested")
        mapping_id = "wmap_" + source_hash[:20]
        identity_aliases = build_identity_alias_map(mapping.get("contacts", []), mapping.get("groups", []))
        redacted = [redact_record(record, identity_aliases)[0] for record in records]
        private_body = {**mapping, "mapping_id": mapping_id}
        private_body["private_seal"] = digest_object(private_body)
        private_path = self.root / "local" / "wechat4-mappings" / f"{mapping_id}.json"
        if private_path.exists():
            raise PipelineError("private WeChat mapping artifact already exists")
        write_private_json(private_path, private_body)
        for record in records:
            append_jsonl(self.root / "local" / "normalized.jsonl", record)
        for record in redacted:
            append_jsonl(self.root / "local" / "redacted.jsonl", record)
        receipt = self._wechat_mapping_receipt(mapping, mapping_id)
        append_jsonl(self.root / "local" / "sources.jsonl", receipt)
        return receipt

    def recover_ingestions(self) -> dict:
        completed = []
        failed = []
        source_receipts = read_jsonl(self.root / "local" / "sources.jsonl")
        receipted = {item.get("mapping_id") for item in source_receipts if item.get("mapping_id")}
        normalized = read_jsonl(self.root / "local" / "normalized.jsonl")
        redacted = read_jsonl(self.root / "local" / "redacted.jsonl")
        normalized_by_fingerprint = {item.get("source_fingerprint"): item for item in normalized}
        redacted_by_fingerprint = {item.get("source_fingerprint"): item for item in redacted}
        if len(normalized_by_fingerprint) != len(normalized) or len(redacted_by_fingerprint) != len(redacted):
            raise PipelineError("partial ingestion contains duplicate source fingerprints")
        directory = self.root / "local" / "wechat4-mappings"
        for path in sorted(directory.glob("wmap_*.json")) if directory.is_dir() else []:
            try:
                mapping = read_json(path)
                mapping_id = mapping.get("mapping_id")
                claimed = mapping.get("private_seal")
                unsigned = {key: value for key, value in mapping.items() if key != "private_seal"}
                if not mapping_id or not claimed or digest_object(unsigned) != claimed:
                    raise PipelineError("private mapping seal verification failed")
                aliases = build_identity_alias_map(mapping.get("contacts", []), mapping.get("groups", []))
                for record in mapping.get("records", []):
                    fingerprint = record["source_fingerprint"]
                    existing = normalized_by_fingerprint.get(fingerprint)
                    if existing is not None and existing != record:
                        raise PipelineError("normalized partial record differs from private mapping")
                    if existing is None:
                        append_jsonl(self.root / "local" / "normalized.jsonl", record)
                        normalized_by_fingerprint[fingerprint] = record
                    safe_record = redact_record(record, aliases)[0]
                    existing_safe = redacted_by_fingerprint.get(fingerprint)
                    if existing_safe is not None and existing_safe != safe_record:
                        raise PipelineError("redacted partial record differs from deterministic redaction")
                    if existing_safe is None:
                        append_jsonl(self.root / "local" / "redacted.jsonl", safe_record)
                        redacted_by_fingerprint[fingerprint] = safe_record
                if mapping_id not in receipted:
                    append_jsonl(self.root / "local" / "sources.jsonl",
                                 self._wechat_mapping_receipt(mapping, mapping_id))
                    receipted.add(mapping_id)
                completed.append(mapping_id)
            except (RuntimeError, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
                failed.append({"mapping": path.stem, "error": type(exc).__name__})
        return {"completed": completed, "failed": failed}

    def commit_wechat4_checkpoint(self, mapping_id: str, generation: str) -> dict:
        if not mapping_id.startswith("wmap_") or any(character in mapping_id for character in ("/", "\\", "\x00")):
            raise PipelineError("invalid WeChat mapping id")
        if not generation or any(character in generation for character in ("/", "\\", "\x00")):
            raise PipelineError("invalid release generation")
        private_path = self.root / "local" / "wechat4-mappings" / f"{mapping_id}.json"
        if not private_path.is_file():
            raise PipelineError("private WeChat mapping artifact does not exist")
        mapping = read_json(private_path)
        claimed = mapping.get("private_seal")
        unsigned = {key: value for key, value in mapping.items() if key != "private_seal"}
        if not claimed or digest_object(unsigned) != claimed:
            raise PipelineError("private WeChat mapping seal verification failed")
        release = verify_release(self.root / "releases" / generation)
        mapped_fingerprints = {record["source_fingerprint"] for record in mapping.get("records", [])}
        if not mapped_fingerprints.issubset(set(release.get("source_fingerprints", []))):
            raise PipelineError("release does not contain every mapped WeChat record")
        from .wechat4.checkpoint import CheckpointStore

        store = CheckpointStore(self.root, mapping["account_ref"])
        return store.commit(mapping["checkpoint_proposal"], release_seal=release["seal"])

    def freeze_release(self, generation: str, gaps: list[str] | None = None) -> Path:
        records = read_jsonl(self.root / "local" / "redacted.jsonl")
        if not records:
            raise PipelineError("no redacted records are ready")
        sources = read_jsonl(self.root / "local" / "sources.jsonl")
        expected = Counter(
            fingerprint for source in sources for fingerprint in source.get("source_fingerprints", [])
        )
        actual = Counter(record.get("source_fingerprint") for record in records)
        if not expected or expected != actual:
            raise PipelineError("redacted record set does not match completed ingestion receipts")
        return build_release(self.root, generation, records, gaps=gaps)

    def plan_stage(
        self,
        stage: str,
        input_jsonl: Path,
        max_bytes: int,
        instruction: str | None = None,
        dependencies: list[str] | None = None,
        candidate_set: str | None = None,
    ) -> list[dict]:
        if stage not in DEFAULT_INSTRUCTIONS:
            raise PipelineError(f"unsupported stage: {stage}")
        instruction = DEFAULT_INSTRUCTIONS[stage] if instruction is None else instruction
        if not instruction or not instruction.strip():
            raise PipelineError("packet instruction must be non-empty")
        input_jsonl = Path(input_jsonl)
        if (input_jsonl.parent / "manifest.json").exists():
            verify_release(input_jsonl.parent)
        if stage in {"merge", "final", "qa"} and not dependencies:
            raise PipelineError(f"{stage} planning requires explicit upstream dependencies")
        def iter_input_records():
            with input_jsonl.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if line.strip():
                        yield json.loads(line)
        packet_source = iter_input_records()
        if stage == "final":
            if not candidate_set:
                raise PipelineError("final planning requires a frozen candidate set")
            records = list(packet_source)
            candidate_ids = [record.get("candidate_id") for record in records]
            if any(not item for item in candidate_ids):
                raise PipelineError("final input contains an item without candidate_id")
            freeze_candidate_set(self.root, candidate_set, candidate_ids)
            packet_source = iter(records)
        empty_envelope = build_packet(stage, instruction, [])
        envelope_overhead = len(canonical_json(empty_envelope).encode("utf-8")) - 2
        record_budget = max_bytes - envelope_overhead
        if record_budget <= 2:
            raise PipelineError("transport byte limit cannot hold the packet contract")
        created = []
        for index, packet_records in enumerate(iter_record_packets(packet_source, max_bytes=record_budget), start=1):
            envelope = build_packet(stage, instruction, packet_records)
            preflight = preflight_packet(envelope, max_bytes=max_bytes)
            payload_hash = digest_object(envelope)
            unit_id = f"{stage}:{payload_hash[:20]}"
            packet_path = self.root / "packets" / f"{unit_id.replace(':', '_')}.json"
            if packet_path.exists():
                if json.loads(packet_path.read_text(encoding="utf-8")) != envelope:
                    raise PipelineError(f"existing packet differs: {unit_id}")
            else:
                write_json(packet_path, envelope)
            self.ledger.add(unit_id, stage=stage, payload_hash=payload_hash, dependencies=dependencies)
            created.append({"unit_id": unit_id, "packet_path": packet_path, "packet_index": index,
                            "payload_hash": payload_hash, "preflight": preflight})
        if not created:
            raise PipelineError("stage input is empty")
        return created

    def freeze_candidates(self, name: str, input_jsonl: Path) -> dict:
        records = [json.loads(line) for line in Path(input_jsonl).read_text(encoding="utf-8").splitlines() if line.strip()]
        candidate_ids = [record.get("candidate_id") for record in records]
        if not candidate_ids or any(not item for item in candidate_ids):
            raise PipelineError("candidate-set input must contain candidate_id on every line")
        return freeze_candidate_set(self.root, name, candidate_ids)

    def claim(self, unit_id: str, worker_id: str, lease_seconds: int = 900) -> bool:
        return self.ledger.claim(unit_id, worker_id, lease_seconds=lease_seconds)

    def submit_result(self, unit_id: str, output: dict | list[dict]) -> dict:
        self.record_result(unit_id, output)
        self.validate_result(unit_id)
        return self.commit_result(unit_id)

    def record_result(self, unit_id: str, output: dict | list[dict]) -> dict:
        state = self.ledger.state(unit_id)
        if state["status"] != "reserved":
            raise PipelineError("result submission requires a live reservation")
        body = {"candidates": output} if isinstance(output, list) else output
        if not isinstance(body, dict) or not isinstance(body.get("candidates"), list) or not body["candidates"]:
            raise PipelineError("model result must be a non-empty candidate list")
        raw_path = self.root / "results" / "raw" / f"{unit_id.replace(':', '_')}.json"
        write_json(raw_path, {"unit_id": unit_id, **body})
        output_hash = digest_file(raw_path)
        self.ledger.produced(unit_id, output_hash)
        return {"unit_id": unit_id, "status": "produced", "output_hash": output_hash}

    def validate_result(self, unit_id: str) -> dict:
        state = self.ledger.state(unit_id)
        if state["status"] != "produced":
            raise PipelineError("local validation requires a produced result")
        packet_path = self.root / "packets" / f"{unit_id.replace(':', '_')}.json"
        packet = read_json(packet_path)
        evidence_ids = {
            value
            for record in packet["records"]
            for key in ("record_id", "candidate_id")
            if (value := record.get(key))
        }
        raw_path = self.root / "results" / "raw" / f"{unit_id.replace(':', '_')}.json"
        if not raw_path.exists() or digest_file(raw_path) != state["output_hash"]:
            raise PipelineError("produced artifact is missing or changed")
        raw_body = json.loads(raw_path.read_text(encoding="utf-8"))
        if raw_body.get("unit_id") != unit_id:
            raise PipelineError("produced artifact is bound to another unit")
        candidates = raw_body.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            self.ledger.needs_human(unit_id, "empty_candidate_list")
            raise PipelineError("model result must be a non-empty candidate list")
        repaired_candidates = []
        repair_receipts = []
        try:
            for candidate in candidates:
                repaired, repair_receipt = repair_structure(candidate, evidence_ids)
                validate_candidate(repaired, evidence_ids)
                repaired_candidates.append(repaired)
                if repair_receipt["before_hash"] != repair_receipt["after_hash"]:
                    repair_receipts.append(repair_receipt)
            stage_body = {key: value for key, value in raw_body.items() if key != "unit_id"}
            stage_body["candidates"] = repaired_candidates
            stage_body, quality_receipt = validate_stage_output(state["stage"], packet, stage_body)
        except (SemanticRepairRequired, ValidationError, QualityError) as exc:
            self.ledger.needs_human(unit_id, type(exc).__name__)
            raise PipelineError("semantic or evidence failure requires human adjudication") from exc
        result_body = {"unit_id": unit_id, **stage_body}
        result_path = self.root / "results" / f"{unit_id.replace(':', '_')}.json"
        write_json(result_path, result_body)
        accepted_result_hash = digest_file(result_path)
        validation_receipt = {
            "unit_id": unit_id,
            "produced_hash": state["output_hash"],
            "result_hash": accepted_result_hash,
            "candidate_count": len(repaired_candidates),
            "repair_receipts": repair_receipts,
            "quality_receipt": quality_receipt,
            "validator": "pcd-local/v1",
        }
        validation_hash = digest_object(validation_receipt)
        prior = [item for item in read_jsonl(self.root / "receipts" / "validation.jsonl")
                 if item.get("unit_id") == unit_id]
        if len(prior) > 1:
            raise PipelineError("multiple validation receipts exist for one unit")
        if prior:
            existing = prior[0]
            claimed = existing.get("receipt_hash")
            unsigned = {key: value for key, value in existing.items() if key != "receipt_hash"}
            if claimed != validation_hash or unsigned != validation_receipt:
                raise PipelineError("orphan validation receipt does not match deterministic validation")
        else:
            append_jsonl(self.root / "receipts" / "validation.jsonl",
                         {**validation_receipt, "receipt_hash": validation_hash})
        self.ledger.validated(unit_id, validation_hash, accepted_result_hash)
        return {"unit_id": unit_id, "status": "validated", "result_hash": accepted_result_hash,
                "validation_hash": validation_hash}

    def commit_result(self, unit_id: str) -> dict:
        state = self.ledger.state(unit_id)
        if state["status"] != "validated":
            raise PipelineError("commit requires a validated result")
        prior = [item for item in read_jsonl(self.root / "receipts" / "commit.jsonl")
                 if item.get("unit_id") == unit_id]
        if len(prior) > 1:
            raise PipelineError("multiple commit receipts exist for one unit")
        if prior:
            commit_receipt = prior[0]
            claimed = commit_receipt.get("receipt_hash")
            unsigned = {key: value for key, value in commit_receipt.items() if key != "receipt_hash"}
            if (not claimed or digest_object(unsigned) != claimed
                    or commit_receipt.get("validation_hash") != state["validation_hash"]
                    or commit_receipt.get("result_hash") != state["validated_output_hash"]):
                raise PipelineError("orphan commit receipt does not match validated output")
        else:
            commit_receipt = {
                "unit_id": unit_id,
                "validation_hash": state["validation_hash"],
                "result_hash": state["validated_output_hash"],
                "committed_at": datetime.now(timezone.utc).isoformat(),
            }
            commit_receipt["receipt_hash"] = digest_object(commit_receipt)
            append_jsonl(self.root / "receipts" / "commit.jsonl", commit_receipt)
        self.ledger.accept(unit_id)
        return {"unit_id": unit_id, "status": "accepted", "result_hash": state["validated_output_hash"],
                "validation_hash": state["validation_hash"], "commit_receipt": commit_receipt["receipt_hash"]}

    def adjudicate(self, unit_id: str, decision: str, note: str, replacement_candidates: dict | list[dict] | None = None) -> dict:
        if self.ledger.state(unit_id)["status"] != "needs_human":
            raise PipelineError("unit is not waiting for human adjudication")
        if decision not in {"accept", "reject"}:
            raise PipelineError("adjudication decision must be accept or reject")
        result_hash = None
        if decision == "accept":
            packet_path = self.root / "packets" / f"{unit_id.replace(':', '_')}.json"
            packet = read_json(packet_path)
            if not replacement_candidates:
                raise PipelineError("accepted adjudication requires replacement candidates")
            stage = self.ledger.state(unit_id)["stage"]
            replacement_body, quality_receipt = validate_stage_output(stage, packet, replacement_candidates)
            result_path = self.root / "results" / f"{unit_id.replace(':', '_')}.json"
            write_json(result_path, {"unit_id": unit_id, **replacement_body, "human_adjudicated": True,
                                     "quality_receipt": quality_receipt})
            result_hash = digest_file(result_path)
        receipt = {
            "unit_id": unit_id,
            "decision": decision,
            "note": note,
            "result_hash": result_hash,
            "decided_at": datetime.now(timezone.utc).isoformat(),
        }
        receipt["receipt_hash"] = digest_object(receipt)
        append_jsonl(self.root / "receipts" / "adjudication.jsonl", receipt)
        self.ledger.human_adjudicate(unit_id, decision, receipt["receipt_hash"], result_hash)
        return receipt

    def recover_results(self) -> dict:
        recovered = {"accepted": [], "failed": [], "ignored": []}
        known_raw_names = set()
        for unit_id, state in sorted(self.ledger.states().items()):
            raw_path = self.root / "results" / "raw" / f"{unit_id.replace(':', '_')}.json"
            known_raw_names.add(raw_path.name)
            try:
                if state["status"] == "reserved" and raw_path.is_file():
                    body = read_json(raw_path)
                    if body.get("unit_id") != unit_id:
                        raise PipelineError("orphan output has a mismatched unit binding")
                    self.ledger.produced(unit_id, digest_file(raw_path))
                    state = self.ledger.state(unit_id)
                if state["status"] == "produced":
                    self.validate_result(unit_id)
                    state = self.ledger.state(unit_id)
                if state["status"] == "validated":
                    self.commit_result(unit_id)
                    recovered["accepted"].append(unit_id)
            except (RuntimeError, OSError, ValueError, json.JSONDecodeError) as exc:
                recovered["failed"].append({"unit_id": unit_id, "error": type(exc).__name__})
        raw_directory = self.root / "results" / "raw"
        if raw_directory.is_dir():
            recovered["ignored"] = sorted(path.name for path in raw_directory.glob("*.json") if path.name not in known_raw_names)
        return recovered

    def status(self) -> dict:
        states = self.ledger.states()
        counts = Counter(state["status"] for state in states.values())
        now = time.time()
        live_reserved = sum(
            state["status"] == "reserved" and state.get("lease_until", 0) >= now
            for state in states.values()
        )
        expired_reserved = counts["reserved"] - live_reserved
        return {
            "stage_denominator": len(states),
            "target_concurrency": None,
            "reserved": counts["reserved"],
            "active": live_reserved,
            "expired_reserved": expired_reserved,
            "pending": counts["pending"],
            "produced": counts["produced"],
            "validated": counts["validated"],
            "accepted": counts["accepted"],
            "quarantined": counts["quarantined_content"],
            "needs_human": counts["needs_human"],
            "retry_infra": counts["retry_infra"],
            "blocked_privacy": counts["blocked_privacy"],
            "blocked_dependency": counts["blocked_dependency"],
            "validator_backlog": counts["produced"],
        }

    def materialize_accepted(self, stage: str, output_path: Path) -> dict:
        states = [state for state in self.ledger.states().values() if state["stage"] == stage]
        if not states:
            raise PipelineError(f"no units exist for stage: {stage}")
        incomplete = [state["unit_id"] for state in states if state["status"] != "accepted"]
        if incomplete:
            raise PipelineError(f"stage is not fully accepted: {len(incomplete)} incomplete units")
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = output_path.with_name(f".{output_path.name}.staging")
        candidate_count = 0
        try:
            with temporary.open("w", encoding="utf-8") as handle:
                for state in sorted(states, key=lambda item: item["unit_id"]):
                    result_path = self.root / "results" / f"{state['unit_id'].replace(':', '_')}.json"
                    if not result_path.exists() or digest_file(result_path) != state.get("validated_output_hash"):
                        raise PipelineError(f"accepted result artifact is missing or changed: {state['unit_id']}")
                    result = read_json(result_path)
                    for index, candidate in enumerate(result.get("candidates", []), start=1):
                        derived = dict(candidate)
                        derived["candidate_id"] = "cand_" + digest_object({
                            "stage": stage, "unit_id": state["unit_id"], "index": index, "candidate": candidate,
                        })[:20]
                        derived["upstream_unit_id"] = state["unit_id"]
                        handle.write(canonical_json(derived) + "\n")
                        candidate_count += 1
                handle.flush()
                os.fsync(handle.fileno())
        except Exception:
            if temporary.exists():
                temporary.unlink()
            raise
        if candidate_count == 0:
            temporary.unlink()
            raise PipelineError("accepted stage has no candidates")
        if output_path.exists():
            if digest_file(output_path) != digest_file(temporary):
                temporary.unlink()
                raise PipelineError("derived materialization target exists with different content")
            temporary.unlink()
        else:
            os.replace(temporary, output_path)
        receipt = {
            "operation": "materialize_accepted/v1",
            "stage": stage,
            "unit_count": len(states),
            "candidate_count": candidate_count,
            "output_hash": digest_file(output_path),
        }
        receipt["receipt_hash"] = digest_object(receipt)
        append_jsonl(self.root / "receipts" / "materialization.jsonl", receipt)
        return receipt

    def create_kb_proposal(self, entries: list[dict]) -> dict:
        if not entries:
            raise PipelineError("knowledge-base proposal cannot be empty")
        body = {"schema_version": "pcd-kb-proposal/v1", "entries": entries}
        body["proposal_id"] = "kbp_" + digest_object(body)[:20]
        body["seal"] = digest_object(body)
        path = self.root / "kb-proposals" / f"{body['proposal_id']}.json"
        if path.exists():
            if read_json(path) != body:
                raise PipelineError("knowledge-base proposal is immutable")
            return body
        write_json(path, body)
        return body

    def approve_kb_proposal(self, proposal_id: str) -> dict:
        self.authorizations.require("kb_write")
        if (not proposal_id.startswith("kbp_") or len(proposal_id) != 24
                or any(character not in "0123456789abcdef" for character in proposal_id[4:])):
            raise PipelineError("invalid knowledge-base proposal id")
        proposal_path = self.root / "kb-proposals" / f"{proposal_id}.json"
        if not proposal_path.exists():
            raise PipelineError("knowledge-base proposal does not exist")
        proposal = json.loads(proposal_path.read_text(encoding="utf-8"))
        claimed = proposal.get("seal")
        unsigned = {key: value for key, value in proposal.items() if key != "seal"}
        if proposal.get("proposal_id") != proposal_id or not claimed or digest_object(unsigned) != claimed:
            raise PipelineError("knowledge-base proposal seal verification failed")
        approval = {
            "proposal_id": proposal_id,
            "proposal_seal": proposal["seal"],
            "status": "approved_for_external_write",
            "write_performed": False,
            "approved_at": datetime.now(timezone.utc).isoformat(),
        }
        approval["approval_receipt"] = digest_object(approval)
        approval_path = self.root / "kb-approvals" / f"{proposal_id}.json"
        if approval_path.exists():
            existing = read_json(approval_path)
            if existing.get("proposal_seal") != proposal["seal"]:
                raise PipelineError("knowledge-base approval is immutable")
            return existing
        write_json(approval_path, approval)
        return approval
