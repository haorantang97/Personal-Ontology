import json
import subprocess
import time
from pathlib import Path
from typing import Callable

from .atomic import append_jsonl, read_jsonl
from .hashing import digest_object


class ProcessMonitorError(RuntimeError):
    pass


class TaskProcessMonitor:
    def __init__(self, case_root: Path, task_ref: str, process_ids: list[int], platform: str,
                 runner: Callable = subprocess.run):
        if not task_ref or any(character in task_ref for character in ("/", "\\", "\x00")):
            raise ProcessMonitorError("invalid task reference")
        if not process_ids or any(not isinstance(pid, int) or pid <= 0 for pid in process_ids):
            raise ProcessMonitorError("process ids must be positive integers")
        if len(process_ids) != len(set(process_ids)):
            raise ProcessMonitorError("process ids must be unique")
        if platform not in {"posix", "windows"}:
            raise ProcessMonitorError("platform must be posix or windows")
        self.case_root = Path(case_root)
        self.task_ref = task_ref
        self.process_ids = sorted(process_ids)
        self.platform = platform
        self.runner = runner
        self.path = self.case_root / "receipts" / "process-observations.jsonl"

    def _posix_sample(self) -> list[dict]:
        process_list = ",".join(str(pid) for pid in self.process_ids)
        result = self.runner(
            ["ps", "-o", "pid=,ppid=,%cpu=,rss=,etime=", "-p", process_list],
            text=True, capture_output=True, check=False,
        )
        if result.returncode != 0:
            raise ProcessMonitorError("task process sampling failed")
        processes = []
        for line in result.stdout.splitlines():
            parts = line.split(None, 4)
            if len(parts) != 5:
                continue
            processes.append({
                "pid": int(parts[0]), "ppid": int(parts[1]), "cpu_percent": float(parts[2]),
                "rss_kib": int(parts[3]), "elapsed": parts[4],
            })
        return processes

    def _windows_sample(self) -> list[dict]:
        identifiers = ",".join(str(pid) for pid in self.process_ids)
        command = (
            f"Get-Process -Id {identifiers} | Select-Object Id,CPU,WorkingSet64,StartTime | "
            "ConvertTo-Json -Compress"
        )
        result = self.runner(
            ["powershell", "-NoProfile", "-Command", command],
            text=True, capture_output=True, check=False,
        )
        if result.returncode != 0:
            raise ProcessMonitorError("task process sampling failed")
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise ProcessMonitorError("Windows process sampler returned invalid JSON") from exc
        rows = payload if isinstance(payload, list) else [payload]
        return [{
            "pid": int(row["Id"]), "cpu_seconds": float(row.get("CPU") or 0),
            "rss_kib": int(row.get("WorkingSet64") or 0) // 1024,
            "start_time": row.get("StartTime"),
        } for row in rows]

    def sample(self, now: float | None = None) -> dict:
        processes = self._posix_sample() if self.platform == "posix" else self._windows_sample()
        observed = sorted(process["pid"] for process in processes)
        if observed != self.process_ids:
            raise ProcessMonitorError("not every registered task process was observed")
        observation = {
            "schema_version": "pcd-process-observation/v1",
            "task_ref": self.task_ref,
            "platform": self.platform,
            "observed_at": time.time() if now is None else now,
            "registered_process_count": len(self.process_ids),
            "observed_process_count": len(processes),
            "total_rss_kib": sum(process["rss_kib"] for process in processes),
            "total_cpu_percent": sum(process.get("cpu_percent", 0) for process in processes),
            "total_cpu_seconds": sum(process.get("cpu_seconds", 0) for process in processes),
            "processes": sorted(processes, key=lambda process: process["pid"]),
        }
        observation["receipt_hash"] = digest_object(observation)
        append_jsonl(self.path, observation)
        return observation

    def trend(self) -> dict:
        samples = [item for item in read_jsonl(self.path) if item.get("task_ref") == self.task_ref]
        if not samples:
            raise ProcessMonitorError("no process samples exist for this task")
        first, last = samples[0], samples[-1]
        return {
            "task_ref": self.task_ref,
            "sample_count": len(samples),
            "window_seconds": last["observed_at"] - first["observed_at"],
            "rss_kib_change": last["total_rss_kib"] - first["total_rss_kib"],
            "latest_total_rss_kib": last["total_rss_kib"],
            "latest_total_cpu_percent": last["total_cpu_percent"],
            "latest_total_cpu_seconds": last["total_cpu_seconds"],
        }
