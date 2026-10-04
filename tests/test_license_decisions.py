"""Yes/No license decisions: the gate reader, the decision table, and the submit/skip actions.

    cd ~/nvme-stash/a1-scout && python3 -m unittest discover -s tests -v
"""
import json, sys, tempfile, unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
import agent as A  # noqa: E402

GEMMA = {"id": "google/gemma-2-2b", "gated": "manual", "cardData": {"license": "gemma",
         "extra_gated_button_content": "Acknowledge license", "extra_gated_prompt": "review and agree"}}
LLAMA = {"id": "meta-llama/Llama-Prompt-Guard-2-86M", "gated": "manual", "cardData": {"license": "other",
         "extra_gated_fields": {"First Name": "text", "Date of birth": "date_picker", "Country": "country", "geo": "ip_location",
                                "I accept the terms": "checkbox"}}}
BOXES = {"id": "org/boxes", "gated": "auto", "cardData": {"extra_gated_fields": {"I agree": "checkbox", "geo": "ip_location"}}}


def http_for(doc, status=200):
    def http(url, method="GET"):
        return status, json.dumps(doc).encode()
    return http


class Gate(unittest.TestCase):
    def test_acknowledge_only(self):
        g = A.gate_form("google/gemma-2-2b", http=http_for(GEMMA))
        self.assertEqual((g["mode"], g["license"], g["button"]), ("ack", "gemma", "Acknowledge license"))

    def test_personal_details_form(self):
        g = A.gate_form("meta-llama/x", http=http_for(LLAMA))
        self.assertEqual(g["mode"], "form")
        self.assertEqual(g["asks"], ["First Name", "Date of birth", "Country"])   # ip_location is automatic, checkboxes aren't asks
        self.assertEqual(g["boxes"], ["I accept the terms"])

    def test_checkboxes_only_is_ack(self):
        self.assertEqual(A.gate_form("org/boxes", http=http_for(BOXES))["mode"], "ack")

    def test_not_gated_and_unreachable(self):
        self.assertEqual(A.gate_form("a/b", http=http_for({"gated": False}))["mode"], "open")
        self.assertEqual(A.gate_form("a/b", http=http_for({}, 500))["mode"], "unknown")


class Decide(unittest.TestCase):
    TABLE = [  # (gate mode, decision, access) -> action
        ("ack", "yes", "blocked", "submit"), ("form", "yes", "blocked", "open_page"), ("unknown", "yes", "blocked", "open_page"),
        ("open", "yes", "blocked", "recheck"), ("ack", "no", "blocked", "skip"), ("form", "no", "blocked", "skip"),
        ("ack", "yes", "granted", "none"), ("ack", None, "blocked", "none")]

    def test_table(self):
        for mode, dec, acc, want in self.TABLE:
            with self.subTest(mode=mode, dec=dec, acc=acc):
                self.assertEqual(A.decide_license({"mode": mode, "asks": ["Date of birth"]}, dec, acc)["action"], want)

    def test_form_reason_names_the_fields(self):
        self.assertIn("date of birth", A.decide_license({"mode": "form", "asks": ["Date of birth"]}, "yes", "blocked")["reason"])


class Apply(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = [mock.patch.object(A, "STATE", Path(self.tmp.name) / "state.json"),
                  mock.patch.object(A, "LOG", Path(self.tmp.name) / "scout.log"), mock.patch.object(A, "log", lambda *a, **k: None)]
        for x in self.p: x.start()
        self.api = []

    def tearDown(self):
        for x in self.p: x.stop()
        self.tmp.cleanup()

    def fake_api(self, path, method="GET", body=None):
        self.api.append((path, body)); return {"ok": True}

    def test_yes_on_ack_gate_posts_ask_access_once(self):
        posts = []
        post = lambda url, data: posts.append((url, data)) or (200, "")
        res, recheck = A.apply_decisions({"google/gemma-2-2b": {"decision": "yes", "kind": "model", "state": "pending"}},
                                         {}, http=http_for(GEMMA), post=post, api_call=self.fake_api)
        self.assertEqual(posts, [("https://huggingface.co/google/gemma-2-2b/ask-access", {})])
        self.assertEqual(res["google/gemma-2-2b"]["outcome"], "requested")
        self.assertEqual(recheck, {"google/gemma-2-2b"})

    def test_yes_on_form_never_posts(self):
        post = mock.Mock()
        res, _ = A.apply_decisions({"meta-llama/x": {"decision": "yes", "state": "pending"}}, {}, http=http_for(LLAMA), post=post, api_call=self.fake_api)
        post.assert_not_called()
        self.assertEqual(res["meta-llama/x"]["outcome"], "needs_you")

    def test_no_skips_the_pick_and_clears_the_row(self):
        post = mock.Mock()
        res, _ = A.apply_decisions({"google/gemma-2-2b": {"decision": "no", "state": "pending"}},
                                   {"google/gemma-2-2b": {"id": "p1", "status": "new", "kind": "model"}},
                                   http=http_for(GEMMA), post=post, api_call=self.fake_api)
        post.assert_not_called()
        self.assertEqual(self.api, [("/api/picks/status", {"id": "p1", "status": "skipped"})])
        self.assertEqual(A.licenses()["google/gemma-2-2b"]["access"], "declined")
        self.assertNotIn("google/gemma-2-2b", A.needs_license())

    def test_refused_submit_reports_failure(self):
        res, recheck = A.apply_decisions({"google/gemma-2-2b": {"decision": "yes", "state": "pending"}}, {},
                                         http=http_for(GEMMA), post=lambda u, d: (403, "forbidden"), api_call=self.fake_api)
        self.assertEqual(res["google/gemma-2-2b"]["outcome"], "failed")
        self.assertEqual(recheck, set())

    def test_done_decisions_are_ignored(self):
        res, _ = A.apply_decisions({"a/b": {"decision": "yes", "state": "done"}}, {}, http=http_for(GEMMA), post=mock.Mock())
        self.assertEqual(res, {})


if __name__ == "__main__":
    unittest.main()
