"""Tests for the A1 status bar feed: log parsing, the run queue, and the live gate.

    cd ~/nvme-stash/a1-scout && python3 -m unittest discover -s tests -v
Fixtures are real scout.log lines from the evening of 2026-10-03 (Mac slept mid-run, gated models refused).
"""
import sys, unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
sys.path.insert(0, str(ROOT / "gates"))
import agent as A                 # noqa: E402
import statusbar_probe as P       # noqa: E402

FIX = ROOT / "tests/fixtures/run-2026-10-03-evening.log"
GATED = {"meta-llama/Llama-Prompt-Guard-2-86M", "google/gemma-2-2b"}
NOW = datetime(2026, 10, 4, 0, 9, 10, tzinfo=timezone.utc)
iso = lambda s_ago: (NOW - timedelta(seconds=s_ago)).isoformat()
SWE = {"pid": 1, "repo": "SALT-NLP/SWE-chat", "dest": "/Volumes/A1/stash/datasets/raw/.SWE-chat.updating-202b071"}


def snapshot(**over):
    """/api/activity as it looked at 7:09 PM: live update of SWE-chat, gated picks waiting."""
    d = {"activity": {"state": "running", "phase": "Updating stashed items", "updated_at": iso(5),
                      "current": {"repo": "SALT-NLP/SWE-chat", "action": "Updating", "total_bytes": 46.99e9, "done_bytes": 41.43e9},
                      "queue": [], "needs_license": sorted(GATED)},
         "presence": {"present": True, "busy": True, "at": iso(30), "needs_license": sorted(GATED), "logrun": {}},
         "next": [{"repo": r, "bytes": 1e9, "when": "needs license"} for r in sorted(GATED)]}
    for k, v in over.items():
        d[k] = {**d[k], **v} if isinstance(v, dict) else v
    return d


class LogParsing(unittest.TestCase):
    def test_needs_license_from_real_log(self):
        self.assertEqual(A.needs_license(FIX.read_text().splitlines()), GATED)

    def test_success_clears_needs_license(self):
        lines = FIX.read_text().splitlines() + [
            "2026-10-04T09:00:00 downloading model google/gemma-2-2b @ c5ebcd40d2 -> models/hf/gemma-2-2b (~10.48 GB)",
            "2026-10-04T09:20:00   stashed 10.48 GB"]
        self.assertEqual(A.needs_license(lines), GATED - {"google/gemma-2-2b"})

    def test_run_from_log_follows_the_resumed_update(self):
        A.LOG = FIX
        run = A.run_from_log(busy=True)
        self.assertEqual(run["phase"], "Updating stashed items")
        self.assertEqual(run["current"]["repo"], "SALT-NLP/SWE-chat")
        self.assertFalse(run["finished"])

    def test_run_from_log_idle_when_not_busy(self):
        A.LOG = FIX
        run = A.run_from_log(busy=False)
        self.assertIsNone(run["current"])
        self.assertTrue(run["finished"])

    def test_log_view_measures_a_running_update(self):
        # Updates have no dest in the log; the heartbeat reads the staging folder off the running hf process.
        A.LOG = FIX
        run = A.run_from_log(busy=True, procs=[SWE], disk=lambda _p: 46.1e9)
        self.assertEqual(run["current"]["done_bytes"], 46.1e9)
        self.assertGreaterEqual(run["current"]["total_bytes"], 46.1e9)

    def test_update_total_uses_full_size_when_logged(self):
        line = "2026-10-04T10:00:00 updating dataset SALT-NLP/SWE-chat 651fe2a -> 202b071: 17148 changed files, ~29.78 GB to download, 46.99 GB in all"
        A.LOG = Path("/tmp/a1-scout-test.log")
        A.LOG.write_text("2026-10-04T09:59:00 A1 present (mount); stash at /Volumes/A1/stash\n" + line + "\n")
        run = A.run_from_log(busy=True, procs=[], disk=lambda _p: 0)
        self.assertAlmostEqual(run["current"]["total_bytes"], 46.99e9)


class Queue(unittest.TestCase):
    PICKS = [{"repo": "google/gemma-2-2b", "kind": "model", "size_bytes": 10.48e9},
             {"repo": "org/small-model", "kind": "model", "size_bytes": 2e9},
             {"repo": "meta-llama/Llama-Prompt-Guard-2-86M", "kind": "model", "size_bytes": 1.13e9}]

    def test_needs_license_is_listed_not_counted(self):
        q = {x["repo"]: x["when"] for x in A.plan_queue(self.PICKS, 0, 60e9, blocked=GATED)}
        self.assertEqual(q, {"google/gemma-2-2b": "needs license", "org/small-model": "now",
                             "meta-llama/Llama-Prompt-Guard-2-86M": "needs license"})

    def test_cap_ignores_blocked_sizes(self):
        q = {x["repo"]: x["when"] for x in A.plan_queue(self.PICKS, 0, 3e9, blocked=GATED)}
        self.assertEqual(q["org/small-model"], "now")


class Gate(unittest.TestCase):
    def run_probe(self, data, procs=(SWE,), present=True, disk=41.6e9):
        return P.probe(data=data, procs=list(procs), present=present, disk=lambda _p: disk, now=NOW)

    def test_passes_on_a_healthy_live_update(self):
        r = self.run_probe(snapshot())
        self.assertTrue(r["ok"], r)

    def test_fails_when_agent_posts_go_stale_mid_download(self):
        # The Mac slept: hf is running again but the bar still shows old numbers and the log view has no current item.
        r = self.run_probe(snapshot(activity={"updated_at": iso(600)}))
        self.assertIn("live_posts_flowing", r["failed"])
        self.assertIn("bar_shows_running_download", r["failed"])

    def test_fails_when_bar_bytes_disagree_with_disk(self):
        r = self.run_probe(snapshot(), disk=45.9e9)
        self.assertIn("bytes_match_disk", r["failed"])

    def test_fails_when_bar_names_the_wrong_item(self):
        r = self.run_probe(snapshot(activity={"current": {"repo": "google/gemma-2-2b", "action": "Downloading",
                                                          "total_bytes": 10.48e9, "done_bytes": 0}}))
        self.assertIn("bar_shows_running_download", r["failed"])

    def test_fails_when_heartbeat_stops_with_drive_plugged_in(self):
        r = self.run_probe(snapshot(presence={"at": iso(900)}))
        self.assertIn("heartbeat_fresh", r["failed"])

    def test_the_615pm_screen_fails(self):
        # What the dashboard showed at 6:15 PM: checking phase, no current item, and the two gated models
        # counted as 11.6 GB "up next" although Hugging Face had just refused both.
        d = snapshot(activity={"phase": "Checking stashed items for updates", "current": None, "updated_at": iso(20)},
                     next=[{"repo": "meta-llama/Llama-Prompt-Guard-2-86M", "bytes": 1.13e9, "when": "next plug-in"},
                           {"repo": "google/gemma-2-2b", "bytes": 10.48e9, "when": "next plug-in"}])
        r = self.run_probe(d, procs=())
        self.assertEqual(r["failed"], ["needs_license_not_counted"])


if __name__ == "__main__":
    unittest.main()
