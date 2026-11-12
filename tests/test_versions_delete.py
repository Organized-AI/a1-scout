"""Tests for deleting kept old versions from the Drive map: the only delete the agent ever does on the A1.

    cd ~/nvme-stash/a1-scout && python3 -m unittest discover -s tests -v
"""
import sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
import agent as A                 # noqa: E402

OLD = "versions/models/mlx/Qwen@815b83c"


class DeleteOldVersion(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.keep = (A.STASH, A.MOUNT, A.api, A.log)
        A.MOUNT = Path(self.tmp.name); A.STASH = A.MOUNT / "stash"
        self.acks = []
        A.api = lambda path, method="GET", body=None, raw=False: self.acks.append((path, body)) or {}
        A.log = lambda msg: None
        self.old = A.STASH / OLD
        self.cur = A.STASH / "models/mlx/Qwen"
        for d in (self.old, self.cur):
            d.mkdir(parents=True)
            (d / "weights.bin").write_bytes(b"x" * 1000)
        (self.cur / ".verified").write_text("{}")

    def tearDown(self):
        A.STASH, A.MOUNT, A.api, A.log = self.keep
        self.tmp.cleanup()

    def test_deletes_when_the_current_copy_is_verified(self):
        self.assertEqual(A.delete_old_version(OLD), (True, None, 1000))
        self.assertFalse(self.old.exists())
        self.assertTrue((self.cur / "weights.bin").exists())

    def test_keeps_it_when_the_current_copy_is_not_verified(self):
        (self.cur / ".verified").unlink()
        ok, why, _ = A.delete_old_version(OLD)
        self.assertEqual((ok, why), (False, "current copy not verified"))
        self.assertTrue(self.old.exists())

    def test_keeps_it_when_there_is_no_current_copy(self):
        import shutil; shutil.rmtree(self.cur)
        self.assertFalse(A.delete_old_version(OLD)[0])
        self.assertTrue(self.old.exists())

    def test_never_touches_anything_but_an_old_version(self):
        outside = Path(self.tmp.name) / "elsewhere@815b83c"; outside.mkdir()
        (A.STASH / "versions/models/mlx/link@815b83c").symlink_to(self.cur, target_is_directory=True)
        (A.STASH / "models/mlx/link").mkdir(); (A.STASH / "models/mlx/link/.verified").write_text("{}")
        for bad in ("models/mlx/Qwen", "versions/../models/mlx/Qwen@815b83c", "versions/../../elsewhere@815b83c",
                    "/versions/models/mlx/Qwen@815b83c", "versions/models/mlx/Qwen", "versions/models/mlx/link@815b83c", "versions/@815b83c"):
            self.assertFalse(A.delete_old_version(bad)[0], bad)
        self.assertTrue(self.cur.exists() and self.old.exists() and outside.exists())
        self.assertTrue((self.cur / "weights.bin").exists())

    def test_request_waits_for_a_run_and_for_the_drive(self):
        vd = {"state": "pending", "paths": [OLD]}
        A.versions_delete(vd, present=True, busy=True)
        A.versions_delete(vd, present=False, busy=False)
        self.assertTrue(self.old.exists())
        self.assertEqual(self.acks, [])

    def test_request_deletes_reports_and_skips(self):
        A.versions_delete({"state": "pending", "paths": [OLD, "versions/spaces/gone@418e1d6"]}, present=True, busy=False)
        self.assertFalse(self.old.exists())
        path, body = self.acks[-1]
        self.assertEqual(path, "/api/versions-delete/ack")
        self.assertEqual([r["outcome"] for r in body["results"]], ["deleted", "skipped"])
        self.assertEqual(body["results"][1]["why"], "old copy missing")
        self.assertEqual(body["freed_bytes"], 1000)


if __name__ == "__main__":
    unittest.main()
