from pathlib import Path

from ..atomic import read_json, write_private_json
from ..hashing import digest_object


class CheckpointError(RuntimeError):
    pass


class CheckpointStore:
    def __init__(self, case_root: Path, account_ref: str):
        if not account_ref or any(character in account_ref for character in ("/", "\\", "\x00")):
            raise CheckpointError("invalid account reference")
        self.path = Path(case_root) / "local" / "checkpoints" / f"{account_ref}.json"
        self.account_ref = account_ref

    def load(self) -> dict | None:
        if not self.path.is_file():
            return None
        checkpoint = read_json(self.path)
        expected = checkpoint.get("seal")
        unsigned = {key: value for key, value in checkpoint.items() if key != "seal"}
        if not expected or digest_object(unsigned) != expected:
            raise CheckpointError("checkpoint seal verification failed")
        return checkpoint

    def commit(self, proposal: dict, release_seal: str) -> dict:
        if not release_seal:
            raise CheckpointError("release seal is required before advancing a checkpoint")
        current = self.load()
        current_seal = current.get("seal") if current else None
        if proposal.get("based_on") != current_seal:
            raise CheckpointError("stale checkpoint proposal")
        if proposal.get("account_ref") != self.account_ref:
            raise CheckpointError("checkpoint proposal belongs to another account")
        checkpoint = {
            "schema_version": "pcd-wechat4-checkpoint/v1",
            "account_ref": self.account_ref,
            "schema_fingerprint": proposal.get("schema_fingerprint"),
            "watermarks": proposal.get("watermarks", {}),
            "previous_seal": current_seal,
            "release_seal": release_seal,
        }
        checkpoint["seal"] = digest_object(checkpoint)
        write_private_json(self.path, checkpoint)
        return checkpoint
