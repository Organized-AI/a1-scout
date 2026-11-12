"""Tests for download progress on repos of many small files (the DTap-Bench run of 2026-11-12:
133,850 files in 69,774 folders, 3.75 GB, onto the exFAT A1).

    cd ~/nvme-stash/a1-scout && python3 -m unittest discover -s tests -v
"""
import os, stat, sys, tempfile, unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
sys.path.insert(0, str(ROOT / "gates"))
import agent as A                 # noqa: E402
import statusbar_probe as P       # noqa: E402

NOW = datetime(2026, 11, 12, 22, 0, 0, tzinfo=timezone.utc)
DTAP = {"pid": 1, "repo": "AI-Secure/DTap-Bench-Agent-Trajectories", "dest": "/Volumes/A1/stash/datasets/raw/DTap-Bench-Agent-Trajectories"}
# What hf 1.8 writes to stderr when it is not on a terminal.
HF_ERR = ("Still waiting to acquire lock on x.lock (elapsed: 0.1 seconds)\n"
          "Fetching 133850 files:   0%|          | 0/133850 [00:00<?, ?it/s]\n"
          "Fetching 133850 files:  10%|█         | 13385/133850 [12:01<1:40:14, 20.03it/s]\r"
          "Fetching 133850 files:  79%|███████▉  | 106065/133850 [2:03:10<1:38:02,  4.72it/s]")


def fake_hf(body):
    """An executable that stands in for `hf download`."""
    d = tempfile.mkdtemp()
    f = Path(d) / "hf"
    f.write_text("#!/bin/sh\n" + body)
    f.chmod(f.stat().st_mode | stat.S_IEXEC)
    return str(f)


class FetchCounter(unittest.TestCase):
    def test_reads_the_latest_count(self):
        self.assertEqual(A.fetch_progress(HF_ERR), (106065, 133850))

    def test_big_repos_report_a_count_without_a_total(self):
        # hf 1.8 on DTap-Bench: "Number of files in the repo is unreliable. Using `list_repo_tree`..."
        self.assertEqual(A.fetch_progress("Fetching ... files: 0it [00:00, ?it/s]\nFetching ... files: 4812it [03:10, 25.3it/s]"), (4812, None))

    def test_file_count_comes_from_the_hub_and_respects_include(self):
        orig = A.hub_tree
        A.hub_tree = lambda kind, repo, rev: {"a/1.json": ("x", 1), "a/2.json": ("x", 1), "b/3.json": ("x", 1)} if (kind, repo, rev) == ("dataset", "org/r", "abc") else {}
        try:
            cmd = ["caffeinate", "-i", "hf", "download", "org/r", "--repo-type", "dataset", "--local-dir", "/x", "--revision", "abc"]
            self.assertEqual(A.repo_file_count(cmd), 3)
            self.assertEqual(A.repo_file_count(cmd + ["--include", "a/*"]), 2)
        finally:
            A.hub_tree = orig

    def test_none_before_hf_reports(self):
        self.assertIsNone(A.fetch_progress("Warning: You are sending unauthenticated requests\n"))


class FilesSize(unittest.TestCase):
    def test_counts_files_not_folders_or_hf_bookkeeping(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "a/b").mkdir(parents=True)
            (root / "a/b/t.json").write_bytes(b"x" * 700)
            (root / "README.md").write_bytes(b"y" * 300)
            (root / ".cache/huggingface/download").mkdir(parents=True)
            (root / ".cache/huggingface/download/t.json.metadata").write_bytes(b"z" * 5000)
            self.assertEqual(A.files_size(root), 1000)
            self.assertEqual(P.disk_bytes(str(root)), 1000)

    def test_gives_up_past_its_budget(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "a").mkdir()
            self.assertIsNone(A.files_size(Path(d), budget_s=-1))


class CachedCommit(unittest.TestCase):
    def test_reads_a_sample_not_every_metadata_file(self):
        sha = "836caf2fdd78b888ddd14fb62dc038e932e17898"
        with tempfile.TemporaryDirectory() as d:
            for i in range(300):
                m = Path(d) / f".cache/huggingface/download/claudesdk/run{i}/t.json.metadata"
                m.parent.mkdir(parents=True)
                m.write_text(f"{sha}\netag\n1.0\n")
            reads, orig = [], Path.read_text
            Path.read_text = lambda self, *a, **k: reads.append(self) or orig(self, *a, **k)
            try:
                self.assertEqual(A.cached_commit(Path(d)), sha)
            finally:
                Path.read_text = orig
            self.assertEqual(len(reads), A.COMMIT_SAMPLE)

    def test_none_without_hf_bookkeeping(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(A.cached_commit(Path(d)))


class GoneFromTheHub(unittest.TestCase):
    """nvidia/Nemotron-RL-Agentic-Conversational-Tool-Use-Seed-v1 was approved, then taken off the Hub (2026-11-12)."""
    ERR = "Error: Dataset 'nvidia/Nemotron-RL-Agentic-Conversational-Tool-Use-Seed-v1' not found. If the repo is private, make sure you are authenticated."

    def test_the_real_error_text_reads_as_gone_not_as_a_license(self):
        self.assertTrue(A.GONE_RE.search(self.ERR))
        self.assertFalse(A.LICENSE_RE.search(self.ERR))

    def test_gone_only_when_the_hub_says_so(self):
        self.assertTrue(A.hub_gone("nvidia/x", "dataset", http=lambda u, m: (401, b"")))
        self.assertTrue(A.hub_gone("nvidia/x", "dataset", http=lambda u, m: (404, b"")))
        self.assertFalse(A.hub_gone("nvidia/x", "dataset", http=lambda u, m: (200, b"{}")))   # gated repos still answer
        self.assertFalse(A.hub_gone("nvidia/x", "dataset", http=lambda u, m: (0, b"")))       # offline is not proof

    def test_retiring_skips_the_pick(self):
        calls, orig = [], A.api
        A.api = lambda path, method="GET", body=None, raw=False: calls.append((path, method, body)) or {"ok": True}
        try:
            self.assertTrue(A.retire_pick({"id": "dataset:nvidia/x", "repo": "nvidia/x", "kind": "dataset"}))
        finally:
            A.api = orig
        self.assertEqual(calls, [("/api/picks/status", "POST", {"id": "dataset:nvidia/x", "status": "skipped"})])


class HfDownload(unittest.TestCase):
    def setUp(self):
        self.posts, self._activity, self._progress = [], A.activity, A.PROGRESS
        self.tmp = tempfile.TemporaryDirectory()
        A.PROGRESS = Path(self.tmp.name) / "scout-progress.json"
        A.ACT.clear(); A.ACT["current"] = {"repo": DTAP["repo"]}
        A.activity = lambda force=False, **kw: (A.ACT.update(kw), self.posts.append(kw))

    def tearDown(self):
        A.activity, A.PROGRESS = self._activity, self._progress
        A.ACT.clear(); self.tmp.cleanup()

    def test_many_file_repo_is_tracked_by_file_count_without_walking_the_drive(self):
        hf = fake_hf("printf 'Fetching 4000 files:  25%%|##  | 1000/4000 [00:01<00:03]\\n' >&2\nsleep 17\necho done-path\n")
        walked = []
        orig = A.disk_size
        A.disk_size = lambda p, budget_s=None: walked.append(p) or 0
        try:
            r = A.hf_download([hf], Path(self.tmp.name), 8_000_000)
        finally:
            A.disk_size = orig
        self.assertEqual(r.returncode, 0)
        self.assertIn("done-path", r.stdout)
        cur = self.posts[-1]["current"]
        self.assertEqual((cur["done_files"], cur["total_files"], cur["done_bytes"]), (1000, 4000, 2_000_000))
        self.assertGreaterEqual(cur["rate"], 0)
        self.assertEqual(walked, [])
        self.assertEqual(A.last_progress(DTAP["repo"])["done_files"], 1000)

    def test_uncounted_repo_gets_its_total_from_the_hub(self):
        hf = fake_hf("printf 'Fetching ... files: 0it [00:00, ?it/s]\n' >&2\nsleep 1\nprintf 'Fetching ... files: 1000it [00:01, 9it/s]\n' >&2\nsleep 17\n")
        r = A.hf_download([hf], Path(self.tmp.name), 8_000_000, count_files=lambda args: 4000)
        self.assertEqual(r.returncode, 0)
        cur = self.posts[-1]["current"]
        self.assertEqual((cur["done_files"], cur["total_files"], cur["done_bytes"]), (1000, 4000, 2_000_000))

    def test_a_network_timeout_resumes_instead_of_failing_the_item(self):
        import subprocess
        outs = [subprocess.CompletedProcess([], 1, "", "httpx.ReadTimeout: The read operation timed out"),
                subprocess.CompletedProcess([], 0, "/dest", "")]
        tries, logs, orig = [], [], A.log
        A.log = logs.append
        try:
            r = A.hf_download(["hf"], Path(self.tmp.name), 1000, once=lambda *a: tries.append(a) or outs[len(tries) - 1], pause=0)
        finally:
            A.log = orig
        self.assertEqual((r.returncode, len(tries)), (0, 2))
        self.assertIn("resuming, try 2 of 4", logs[0])

    def test_gives_up_after_the_last_try_and_never_retries_a_refusal(self):
        import subprocess
        orig = A.log; A.log = lambda m: None
        try:
            tries = []
            fail = lambda *a: tries.append(1) or subprocess.CompletedProcess([], 1, "", "httpx.ReadTimeout")
            self.assertEqual(A.hf_download(["hf"], Path(self.tmp.name), 1, once=fail, pause=0).returncode, 1)
            self.assertEqual(len(tries), A.HF_TRIES)
            tries.clear()
            gone = lambda *a: tries.append(1) or subprocess.CompletedProcess([], 1, "", "Error: Dataset 'x/y' not found.")
            A.hf_download(["hf"], Path(self.tmp.name), 1, once=gone, pause=0)
            self.assertEqual(len(tries), 1)
        finally:
            A.log = orig

    def test_failure_keeps_the_error_text(self):
        hf = fake_hf("echo 'GatedRepoError: 403 Client Error' >&2\nexit 1\n")
        r = A.hf_download([hf], Path(self.tmp.name), 1000, count_files=lambda args: None)
        self.assertEqual(r.returncode, 1)
        self.assertIn("403", r.stderr)


class Probe(unittest.TestCase):
    def data(self, **cur):
        iso = lambda s: (NOW - timedelta(seconds=s)).isoformat()
        return {"activity": {"state": "running", "phase": "Downloading approved picks", "updated_at": iso(5),
                             "current": {"repo": DTAP["repo"], "action": "Downloading", "total_bytes": 3.75e9, **cur}, "queue": []},
                "presence": {"present": True, "busy": True, "at": iso(30), "logrun": {}}, "next": []}

    def test_many_file_download_is_checked_by_count_not_by_walking(self):
        def no_walk(_p):
            raise AssertionError("the drive must not be walked for a many-file download")
        r = P.probe(data=self.data(done_bytes=2.97e9, done_files=106065, total_files=133850), procs=[DTAP], present=True, disk=no_walk, now=NOW)
        self.assertTrue(r["ok"], r)
        self.assertIn("files_within_total", r["checks"])

    def test_a_walk_that_ran_out_of_time_is_not_a_failure(self):
        r = P.probe(data=self.data(done_bytes=1e9), procs=[DTAP], present=True, disk=lambda _p: None, now=NOW)
        self.assertTrue(r["ok"], r)


if __name__ == "__main__":
    unittest.main()
