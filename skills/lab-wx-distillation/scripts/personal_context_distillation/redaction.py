import re
from copy import deepcopy

from .hashing import digest_object


class RedactionError(RuntimeError):
    pass


FATAL_PATTERNS = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", re.IGNORECASE),
]

PATTERNS = [
    ("email", re.compile(r"(?<![\w.+-])[\w.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("url", re.compile(r"https?://[^\s<>()]+", re.IGNORECASE)),
    ("phone", re.compile(r"(?<!\d)(?:\+?\d[\d -]{8,}\d)(?!\d)")),
    ("secret", re.compile(r"(?i)\b(api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+")),
    ("mention", re.compile(r"(?<!\w)@[A-Za-z0-9_\u4e00-\u9fff-]{1,64}")),
]


def _redact_text(text: str, field: str) -> tuple[str, list[dict]]:
    for pattern in FATAL_PATTERNS:
        if pattern.search(text):
            raise RedactionError(f"fatal secret material detected in {field}")
    findings = []
    output = text
    for kind, pattern in PATTERNS:
        count = len(pattern.findall(output))
        if count:
            output = pattern.sub(f"[REDACTED_{kind.upper()}]", output)
            findings.append({"field": field, "kind": kind, "count": count})
    for pattern in FATAL_PATTERNS:
        if pattern.search(output):
            raise RedactionError(f"secret material survived redaction in {field}")
    return output, findings


def build_identity_alias_map(contacts: list[dict], groups: list[dict]) -> dict[str, str]:
    aliases = {}
    token_by_username = {}
    for contact in contacts:
        username = str(contact.get("username") or "")
        if not username:
            continue
        token = "[IDENTITY_" + digest_object({"username": username})[:10].upper() + "]"
        token_by_username[username] = token
        for field in ("username", "nickname", "remark", "alias"):
            alias = str(contact.get(field) or "").strip()
            if len(alias) >= 2:
                aliases[alias] = token
    for group in groups:
        username = str(group.get("username") or "")
        token = token_by_username.get(username) or (
            "[IDENTITY_" + digest_object({"username": username})[:10].upper() + "]" if username else None
        )
        if username and token:
            aliases[username] = token
        for member in group.get("members", []):
            member_token = token_by_username.get(str(member.get("username") or ""))
            room_name = str(member.get("room_nickname") or "").strip()
            if member_token and len(room_name) >= 2:
                aliases[room_name] = member_token
    return aliases


def _replace_identities(text: str, aliases: dict[str, str]) -> tuple[str, int]:
    output = text
    count = 0
    for alias in sorted(aliases, key=lambda value: (-len(value), value)):
        output, replacements = re.subn(re.escape(alias), aliases[alias], output, flags=re.IGNORECASE)
        count += replacements
    return output, count


def redact_record(record: dict, identity_aliases: dict[str, str] | None = None) -> tuple[dict, list[dict]]:
    redacted = deepcopy(record)
    findings = []
    identity_aliases = identity_aliases or {}
    for field in ("authored_text", "quoted_text", "forwarded_context"):
        redacted[field], identity_count = _replace_identities(str(redacted.get(field) or ""), identity_aliases)
        if identity_count:
            findings.append({"field": field, "kind": "identity", "count": identity_count})
        redacted[field], field_findings = _redact_text(redacted[field], field)
        findings.extend(field_findings)
    if redacted.get("quoted_author"):
        redacted["quoted_author"] = identity_aliases.get(str(redacted["quoted_author"]), "[REDACTED_IDENTITY]")
        findings.append({"field": "quoted_author", "kind": "identity", "count": 1})
    redacted["redaction_status"] = "redacted"
    redacted["redaction_findings"] = findings
    return redacted, findings
