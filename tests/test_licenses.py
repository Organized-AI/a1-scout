"""Gated-repo flow: access checks, license state, and the heartbeat that approves and starts a run.

    cd ~/nvme-stash/a1-scout && python3 -m unittest discover -s tests -v
"""
import json, sys, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
import agent as A  # noqa: E402

FIX = ROOT / "tests/fixtures/run-2026-10-03-evening.log"
TREE = json.dumps([{"type": "file", "path": ".gitattributes"}, {"type": "file", "path": "README.md"},
                   {"type": "file", "path": "config.json"}]).encode()


def fake_http(tree_status=200, file_status=403):
    calls = []
    def http(url, method="GET"):
        calls.append((method, url))
        return (tree_status, TREE) if "/tree/" in url else (file_status, b"")
    http.calls = calls
    return http


class Access(unittest.TestCase):
    def test_blocked_when_files_are_refused(self):
        h = fake_http(200, 403)
        self.assertEqual(A.hub_access("google/gemma-2-2b", "model", http=h), "blocked")
        self.assertTrue(h.calls[-1][1].endswith("/google/gemma-2-2b/resolve/main/config.json"))  # probes a real file, not README
        self.assertEqual(h.calls[-1][0], "HEAD")                                                  # and never downloads it

    def test_granted_when_a_file_resolves(self):
        self.assertEqual(A.hub_access("Qwen/Qwen3-0.6B", "model", http=fake_http(200, 200)), "granted")

    def test_dataset_urls(self):
        h = fake_http(200, 200)
        A.hub_access("org/data", "dataset", http=h)
        self.assertIn("/api/datasets/org/data/tree/main", h.calls[0][1])
        self.assertIn("/datasets/org/data/resolve/main/", h.calls[1][1])

    def test_unknown_on_hub_errors(self):
        self.assertEqual(A.hub_access("x/y", http=fake_http(500, 500)), "unknown")


class State(unittest.TestCase):
    def setUp(self):
        self._lic, self._log = A.licenses, A.LOG
        A.LOG = FIX

    def tearDown(self):
        A.licenses, A.LOG = self._lic, self._log

    def test_granted_check_clears_the_old_refusal(self):
        A.licenses = lambda: {"google/gemma-2-2b": {"access": "granted"}}
        self.assertEqual(A.needs_license(), {"meta-llama/Llama-Prompt-Guard-2-86M"})

    def test_blocked_preflight_adds_a_repo_the_log_never_tried(self):
        A.licenses = lambda: {"org/new-gated": {"access": "blocked"}}
        self.assertIn("org/new-gated", A.needs_license())


class Heartbeat(unittest.TestCase):
    def setUp(self):
        self.saved = {k: getattr(A, k) for k in ("api", "sh", "notify", "needs_license", "check_licenses", "load_state", "save_state", "log")}
        self.posts, self.kicked, self.state = [], [], {}
        A.load_state = lambda: dict(self.state)
        A.save_state = lambda s: self.state.update(s)
        A.notify = lambda *a: None
        A.log = lambda *a: None
        A.needs_license = lambda lines=None: {"google/gemma-2-2b"}
        A.check_licenses = lambda repos, kinds=None: {r: {"access": "granted", "was": "blocked", "kind": "model", "url": ""} for r in repos}
        def api(path, method="GET", body=None, raw=False):
            if path == "/api/picks":
                return [{"id": "model:google/gemma-2-2b", "repo": "google/gemma-2-2b", "kind": "model", "gated": "manual", "status": "new"}]
            self.posts.append((path, body)); return {}
        A.api = api
        class R: returncode = 0; stderr = ""
        A.sh = lambda args, timeout=None, **kw: (self.kicked.append(args), R)[1]

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(A, k, v)

    def test_check_access_approves_and_starts_a_run(self):
        A.license_heartbeat({"license_check": {"state": "pending", "repos": ["google/gemma-2-2b"]}}, present=True, busy=False)
        self.assertIn(("/api/picks/status", {"id": "model:google/gemma-2-2b", "status": "approved"}), self.posts)
        self.assertTrue(self.kicked and "kickstart" in self.kicked[0])
        ack = [b for p, b in self.posts if p == "/api/license-check/ack"]
        self.assertTrue(ack and ack[0]["started"])

    def test_no_run_when_the_a1_is_busy(self):
        A.license_heartbeat({"license_check": {"state": "pending"}}, present=True, busy=True)
        self.assertFalse(self.kicked)

    def test_quiet_when_nothing_asked_and_checked_recently(self):
        import time
        self.state["license_checked_at"] = time.time()
        A.license_heartbeat({}, present=True, busy=False)
        self.assertFalse(self.posts)


if __name__ == "__main__":
    unittest.main()
