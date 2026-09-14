import tempfile
import unittest
from pathlib import Path

from personal_context_distillation.process_monitor import ProcessMonitorError, TaskProcessMonitor


class ProcessMonitorTests(unittest.TestCase):
    def test_posix_monitor_samples_every_registered_task_process_over_time(self):
        with tempfile.TemporaryDirectory() as temp:
            outputs = iter([
                "101 1 12.5 1000 00:01\n102 101 25.0 2000 00:01\n",
                "101 1 10.0 1200 00:02\n102 101 20.0 2400 00:02\n",
            ])

            def runner(command, **kwargs):
                self.assertIn("101,102", command)
                return type("Result", (), {"returncode": 0, "stdout": next(outputs), "stderr": ""})()

            monitor = TaskProcessMonitor(Path(temp), "run_fixture", [101, 102], platform="posix", runner=runner)
            first = monitor.sample(now=1.0)
            second = monitor.sample(now=2.0)
            self.assertEqual(first["observed_process_count"], 2)
            self.assertEqual(second["total_rss_kib"], 3600)
            trend = monitor.trend()
            self.assertEqual(trend["sample_count"], 2)
            self.assertEqual(trend["rss_kib_change"], 600)

    def test_monitor_rejects_unregistered_or_missing_process_set(self):
        with tempfile.TemporaryDirectory() as temp:
            def runner(command, **kwargs):
                return type("Result", (), {"returncode": 0, "stdout": "101 1 1.0 100 00:01\n", "stderr": ""})()

            monitor = TaskProcessMonitor(Path(temp), "run_fixture", [101, 102], platform="posix", runner=runner)
            with self.assertRaises(ProcessMonitorError):
                monitor.sample(now=1.0)


if __name__ == "__main__":
    unittest.main()
