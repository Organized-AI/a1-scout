"""Speed measurements reuse Bench retries without mixing quality rows or paths."""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
import urllib.error
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
import speed_upload as U
import speed_runner as S


class SpeedQueue(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.queue = self.root / "bench/pending-speed.jsonl"
        self.sent = []
        self.fail = None
        def api(path, method, body):
            self.sent.append((path, method, body))
            if self.fail:
                raise self.fail
            return {"ok": True}
        self.A = SimpleNamespace(STATE_DIR=self.root, api=api, log=lambda *args: None)
        self.row = {"uid": "synthetic-uid", "suite": "speed", "model": "fake", "fit": True}

    def test_posts_only_speed_path(self):
        self.assertEqual(U.publish_rows([self.row], self.A), {"flushed": 0, "posted": 1, "attempted": 1})
        self.assertEqual(self.sent, [("/api/bench/speed", "POST", self.row)])
        self.assertFalse(self.queue.exists())
        with self.assertRaises(ValueError):
            U.speed_api(self.A.api)("/api/other", "POST", self.row)

    def test_network_failure_queues_then_flushes_same_uid(self):
        self.fail = urllib.error.URLError("offline")
        first = U.publish_rows([self.row], self.A)
        self.assertEqual(first["posted"], 0)
        self.assertEqual(json.loads(self.queue.read_text()), self.row)
        self.fail = None
        self.assertEqual(U.publish_rows([], self.A), {"flushed": 1, "posted": 0, "attempted": 0})
        self.assertFalse(self.queue.exists())
        self.assertEqual([x[2]["uid"] for x in self.sent], ["synthetic-uid"] * 2)

    def test_server_errors_retry_and_client_rejections_drop(self):
        self.fail = urllib.error.HTTPError("http://fake", 503, "unavailable", {}, None)
        self.addCleanup(self.fail.close)
        U.publish_rows([self.row], self.A)
        self.assertTrue(self.queue.exists())
        self.fail = urllib.error.HTTPError("http://fake", 400, "bad row", {}, None)
        self.addCleanup(self.fail.close)
        U.publish_rows([self.row], self.A)
        self.assertFalse(self.queue.exists())

    def test_quality_queue_remains_untouched(self):
        quality = self.root / "bench/pending.jsonl"
        quality.parent.mkdir(parents=True)
        quality.write_text('{"suite":"html-json"}\n')
        self.fail = OSError("offline")
        U.publish_rows([self.row], self.A)
        self.assertEqual(quality.read_text(), '{"suite":"html-json"}\n')
        self.assertTrue(self.queue.exists())

    def test_runner_persists_before_upload_and_removes_output(self):
        A = SimpleNamespace(STATE_DIR=self.root, ENV={"BENCH_MACHINE": "fake"})
        row = {**self.row, "output": "unneeded response"}
        def publish(rows, agent):
            saved = self.root / "bench/speed/synthetic-uid.json"
            self.assertTrue(saved.exists())
            self.assertNotIn("output", json.loads(saved.read_text()))
            self.assertNotIn("output", rows[0])
            return {"posted": 1}
        with mock.patch.object(S, "run_tasks", return_value=[row]), mock.patch.object(U, "publish_rows", side_effect=publish) as upload:
            result = S.main(["--target", "endpoint", "--endpoint", "http://localhost/v1", "--model", "org/fake", "--smoke"], A)
        upload.assert_called_once()
        self.assertEqual(result[0]["uid"], "synthetic-uid")


if __name__ == "__main__":
    unittest.main()
