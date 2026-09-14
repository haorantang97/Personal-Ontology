from datetime import datetime, timezone
from pathlib import Path

from .atomic import append_jsonl, read_jsonl
from .hashing import digest_object


class AuthorizationError(RuntimeError):
    pass


IMPLICIT_ACTIONS = {"analyze_redacted"}
EXPLICIT_ACTIONS = {"new_source", "local_key_access", "send_unredacted", "kb_write"}


class AuthorizationStore:
    def __init__(self, case_root: Path):
        self.path = Path(case_root) / "authorization.jsonl"

    def grant(self, action: str, note: str = "") -> dict:
        if action not in EXPLICIT_ACTIONS:
            raise AuthorizationError(f"unsupported explicit authorization action: {action}")
        events = read_jsonl(self.path)
        previous_hash = events[-1]["event_hash"] if events else None
        body = {
            "event": "authorization_granted",
            "action": action,
            "note": note,
            "approved_at": datetime.now(timezone.utc).isoformat(),
            "previous_hash": previous_hash,
        }
        body["receipt_id"] = "auth_" + digest_object(body)[:16]
        body["event_hash"] = digest_object(body)
        append_jsonl(self.path, body)
        return body

    def require(self, action: str) -> None:
        if action in IMPLICIT_ACTIONS:
            return
        if action not in EXPLICIT_ACTIONS:
            raise AuthorizationError(f"unknown authorization action: {action}")
        if not any(e.get("event") == "authorization_granted" and e.get("action") == action for e in read_jsonl(self.path)):
            raise AuthorizationError(f"explicit authorization required for: {action}")

    def verify(self) -> None:
        previous = None
        for event in read_jsonl(self.path):
            if event.get("previous_hash") != previous:
                raise AuthorizationError("authorization receipt chain is broken")
            claimed = event.get("event_hash")
            body = {k: v for k, v in event.items() if k != "event_hash"}
            if digest_object(body) != claimed:
                raise AuthorizationError("authorization receipt hash mismatch")
            previous = claimed
