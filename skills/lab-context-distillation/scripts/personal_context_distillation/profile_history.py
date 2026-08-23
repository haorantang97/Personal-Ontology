import os
from copy import deepcopy
from pathlib import Path

from .atomic import append_jsonl, read_json, read_jsonl, write_json
from .hashing import digest_object


class HistoryError(RuntimeError):
    pass


COLLECTION_IDS = {
    "sources": "source_id",
    "events": "event_id",
    "evidence": "evidence_id",
    "assets": "asset_id",
}


class ProfileHistory:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.snapshots = self.root / "snapshots"
        self.events_path = self.root / "history.jsonl"

    def _versions(self) -> list[str]:
        if not self.snapshots.exists():
            return []
        return sorted(path.stem for path in self.snapshots.glob("v[0-9][0-9][0-9][0-9].json"))

    def _next_version(self) -> str:
        versions = self._versions()
        number = int(versions[-1][1:]) + 1 if versions else 1
        return f"v{number:04d}"

    def _snapshot_path(self, version: str) -> Path:
        if not isinstance(version, str) or len(version) != 5 or not version.startswith("v") or not version[1:].isdigit():
            raise HistoryError("invalid profile version")
        return self.snapshots / f"{version}.json"

    @staticmethod
    def _validate_profile(profile: dict) -> None:
        if not isinstance(profile, dict):
            raise HistoryError("profile must be an object")
        required = set(COLLECTION_IDS) | {"coverage"}
        missing = required - set(profile)
        if missing:
            raise HistoryError(f"profile fields missing: {sorted(missing)}")
        for collection, id_field in COLLECTION_IDS.items():
            rows = profile[collection]
            if not isinstance(rows, list):
                raise HistoryError(f"{collection} must be a list")
            ids = []
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get(id_field), str) or not row[id_field]:
                    raise HistoryError(f"{collection} item requires {id_field}")
                ids.append(row[id_field])
            if len(ids) != len(set(ids)):
                raise HistoryError(f"{collection} contains duplicate ids")
        if not isinstance(profile["coverage"], dict):
            raise HistoryError("coverage must be an object")

    def _append_history(self, snapshot: dict, details: dict | None) -> dict:
        existing = read_jsonl(self.events_path)
        event = {
            "schema_version": "pcd-profile-history-event/v2",
            "version": snapshot["version"],
            "parent_version": snapshot["parent_version"],
            "operation": snapshot["operation"],
            "snapshot_hash": snapshot["snapshot_hash"],
            "details": deepcopy(details or {}),
            "previous_event_hash": existing[-1]["event_hash"] if existing else None,
        }
        event["event_hash"] = digest_object(event)
        append_jsonl(self.events_path, event)
        return event

    def _create(self, profile: dict, operation: str, parent_version: str | None, details: dict | None = None) -> dict:
        self._validate_profile(profile)
        version = self._next_version()
        previous_snapshot_hash = self.load(parent_version)["snapshot_hash"] if parent_version else None
        snapshot = {
            "schema_version": "pcd-profile-snapshot/v2",
            "version": version,
            "parent_version": parent_version,
            "operation": operation,
            "previous_snapshot_hash": previous_snapshot_hash,
            "profile_hash": digest_object(profile),
            "profile": deepcopy(profile),
        }
        snapshot["snapshot_hash"] = digest_object(snapshot)
        path = self._snapshot_path(version)
        if path.exists():
            raise HistoryError(f"profile version already exists: {version}")
        write_json(path, snapshot)
        os.chmod(path, 0o444)
        event = self._append_history(snapshot, details)
        return {
            "schema_version": "pcd-profile-transition-receipt/v2",
            "version": version,
            "parent_version": parent_version,
            "operation": operation,
            "snapshot_hash": snapshot["snapshot_hash"],
            "event_hash": event["event_hash"],
        }

    def _current_base(self, version: str) -> dict:
        versions = self._versions()
        if not versions or version != versions[-1]:
            if not self._snapshot_path(version).exists():
                raise HistoryError(f"unknown base version: {version}")
            raise HistoryError("profile transitions must use the latest version as base")
        return self.load(version)

    def initialize(self, profile: dict) -> dict:
        if self._versions() or self.events_path.exists():
            raise HistoryError("profile history is already initialized")
        return self._create(deepcopy(profile), "initialize", None)

    def load(self, version: str | None = None) -> dict:
        versions = self._versions()
        if version is None:
            if not versions:
                raise HistoryError("profile history is empty")
            version = versions[-1]
        path = self._snapshot_path(version)
        if not path.exists():
            raise HistoryError(f"unknown profile version: {version}")
        snapshot = read_json(path)
        claimed = snapshot.get("snapshot_hash")
        body = {key: value for key, value in snapshot.items() if key != "snapshot_hash"}
        if digest_object(body) != claimed or digest_object(snapshot.get("profile")) != snapshot.get("profile_hash"):
            raise HistoryError(f"profile snapshot seal mismatch: {version}")
        return snapshot

    def incremental_update(self, base_version: str, additions: dict[str, list[dict]]) -> dict:
        base = self._current_base(base_version)
        if set(additions) != set(COLLECTION_IDS):
            raise HistoryError("incremental additions must name every appendable collection")
        profile = deepcopy(base["profile"])
        for collection, id_field in COLLECTION_IDS.items():
            new_rows = additions[collection]
            if not isinstance(new_rows, list):
                raise HistoryError(f"{collection} additions must be a list")
            known = {row[id_field] for row in profile[collection]}
            for row in new_rows:
                if not isinstance(row, dict) or not isinstance(row.get(id_field), str) or not row[id_field]:
                    raise HistoryError(f"incremental {collection} item requires {id_field}")
                if row[id_field] in known:
                    raise HistoryError(f"incremental update duplicates {collection} id: {row[id_field]}")
                known.add(row[id_field])
                profile[collection].append(deepcopy(row))
        return self._create(profile, "incremental_update", base_version)

    def correct(self, base_version: str, collection: str, item_id: str, replacement: dict, *, reason: str) -> dict:
        base = self._current_base(base_version)
        if collection not in COLLECTION_IDS or not isinstance(reason, str) or not reason.strip():
            raise HistoryError("correction collection or reason is invalid")
        id_field = COLLECTION_IDS[collection]
        if replacement.get(id_field) != item_id:
            raise HistoryError("correction cannot change the item identity")
        profile = deepcopy(base["profile"])
        indices = [index for index, row in enumerate(profile[collection]) if row[id_field] == item_id]
        if len(indices) != 1:
            raise HistoryError("correction target is missing or ambiguous")
        profile[collection][indices[0]] = deepcopy(replacement)
        return self._create(profile, "correction", base_version, {"collection": collection, "item_id": item_id, "reason": reason})

    def withdraw_source(self, base_version: str, source_id: str, *, reason: str) -> dict:
        base = self._current_base(base_version)
        if not isinstance(reason, str) or not reason.strip():
            raise HistoryError("withdrawal reason is required")
        profile = deepcopy(base["profile"])
        sources = [source for source in profile["sources"] if source["source_id"] == source_id]
        if len(sources) != 1 or sources[0].get("status") == "withdrawn":
            raise HistoryError("source is missing or already withdrawn")
        sources[0]["status"] = "withdrawn"
        for collection in ("events", "evidence", "assets"):
            for row in profile[collection]:
                if source_id in row.get("source_ids", []):
                    row["active"] = False
                    row["withdrawn_source_ids"] = sorted(set(row.get("withdrawn_source_ids", [])) | {source_id})
        return self._create(profile, "source_withdrawal", base_version, {"source_id": source_id, "reason": reason})

    def reextract_domain(self, base_version: str, domain: str, new_events: list[dict], *, coverage: dict) -> dict:
        base = self._current_base(base_version)
        if not isinstance(domain, str) or not domain or not isinstance(new_events, list) or not isinstance(coverage, dict):
            raise HistoryError("domain re-extraction input is invalid")
        if any(event.get("domain") != domain for event in new_events):
            raise HistoryError("re-extracted events must belong to the requested domain")
        profile = deepcopy(base["profile"])
        old_domain = [event for event in profile["events"] if event.get("domain") == domain]
        profile["events"] = [event for event in profile["events"] if event.get("domain") != domain] + deepcopy(new_events)
        profile["coverage"][domain] = deepcopy(coverage)
        superseded = set(profile.get("superseded_event_ids", []))
        superseded.update(event["event_id"] for event in old_domain)
        profile["superseded_event_ids"] = sorted(superseded)
        return self._create(profile, "domain_reextraction", base_version, {
            "domain": domain,
            "superseded_event_ids": sorted(event["event_id"] for event in old_domain),
        })

    def rollback(self, base_version: str, target_version: str, *, reason: str) -> dict:
        self._current_base(base_version)
        if not isinstance(reason, str) or not reason.strip():
            raise HistoryError("rollback reason is required")
        target = self.load(target_version)
        return self._create(deepcopy(target["profile"]), "rollback", base_version, {
            "target_version": target_version,
            "reason": reason,
        })

    def verify(self) -> None:
        versions = self._versions()
        previous_snapshot_hash = None
        for index, version in enumerate(versions, start=1):
            if version != f"v{index:04d}":
                raise HistoryError("profile versions are not contiguous")
            snapshot = self.load(version)
            if snapshot["previous_snapshot_hash"] != previous_snapshot_hash:
                raise HistoryError("profile snapshot chain is broken")
            previous_snapshot_hash = snapshot["snapshot_hash"]
            if self._snapshot_path(version).stat().st_mode & 0o222:
                raise HistoryError("profile snapshot is writable")
        events = read_jsonl(self.events_path)
        if len(events) != len(versions):
            raise HistoryError("profile event/snapshot denominator mismatch")
        previous_event_hash = None
        for event, version in zip(events, versions):
            if event.get("version") != version or event.get("previous_event_hash") != previous_event_hash:
                raise HistoryError("profile event chain is broken")
            claimed = event.get("event_hash")
            body = {key: value for key, value in event.items() if key != "event_hash"}
            if digest_object(body) != claimed:
                raise HistoryError("profile event hash mismatch")
            if event.get("snapshot_hash") != self.load(version)["snapshot_hash"]:
                raise HistoryError("profile event does not bind its snapshot")
            previous_event_hash = claimed
