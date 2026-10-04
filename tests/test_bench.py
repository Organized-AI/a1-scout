"""A1 Bench: banks, scorers, and `agent.py bench` with a fake runner, fake mount, fake API and a held lock.

    cd ~/nvme-stash/a1-scout && python3 -m unittest discover -s tests -v
No model loads and nothing touches the A1: models are empty folders in a temp "stash".
"""
import io, json, os, re, subprocess, sys, tempfile, time, unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
import agent as A   # noqa: E402
import bench as B   # noqa: E402

FAKE = [sys.executable, str(ROOT / "tests/fakes/fake_runner.py")]
BANK_FILES = sorted((ROOT / "tests/bench").glob("*.jsonl")) + [ROOT / "tests/bench/fixtures/ga4_sample.sql"]


def ideal(t):
    """An answer that should pass: proves every task in the banks is passable."""
    if t["type"] == "exact":
        return t["answer"][0] if isinstance(t["answer"], list) else t["answer"]
    if t["type"] == "sql_result":
        return f"```sql\n{t['gold_sql']};\n```"
    if t["type"] == "click_in_box":
        x0, y0, x1, y1 = t["box"]
        return f"click({(x0 + x1) // 2}, {(y0 + y1) // 2})"
    if t["type"] == "decision":
        return json.dumps(perfect_answers(t))
    return None


def perfect_answers(t, p=1.0):
    """/v1/systemone answers putting probability p on every gold answer (the rest spread over the other options)."""
    out = {}
    for qid, q in t["questions"].items():
        g = t["gold"][qid]
        if q["type"] == "noul":
            out[qid] = {"type": "noul", "noul": p if g else 1 - p}
        else:
            opts = [str(i) for i in range(len(q["criteria"]))] if q["type"] == "score" else list(q["criteria"])
            rest = (1 - p) / max(1, len(opts) - 1)
            out[qid] = {"type": q["type"], "probabilities": {o: (p if o == str(g) else rest) for o in opts}}
    return out


class Banks(unittest.TestCase):
    def test_every_suite_loads_with_unique_ids(self):
        self.assertEqual({p.stem for p in BANK_FILES if p.suffix == ".jsonl"}, set(B.SUITES))
        for s in B.SUITES:
            tasks = B.load_bank(s)
            self.assertGreaterEqual(len(tasks), 8, s)
            self.assertEqual(len({t["id"] for t in tasks}), len(tasks), s)
            self.assertRegex(B.bank_hash(s), r"^[0-9a-f]{12}$")

    def test_unknown_suite_is_refused(self):
        with self.assertRaises(ValueError):
            B.load_bank("client-x")

    def test_every_task_is_passable(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = B.sample_db(Path(tmp))
            for s in B.SUITES:
                for t in B.load_bank(s):
                    out = ideal(t)
                    if out is None:
                        continue
                    ok, sc, why = B.score(t, out, db)
                    self.assertTrue(ok, f"{s}/{t['id']}: {why}")
                    self.assertEqual(sc, 1.0)

    def test_gold_sql_returns_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = B.sample_db(Path(tmp))
            for t in B.load_bank("sql-ga4"):
                self.assertTrue(B.run_sql(db, t["gold_sql"]), t["id"])

    def test_type_fields(self):
        for s in B.SUITES:
            for t in B.load_bank(s):
                if t["type"] == "click_in_box":
                    x0, y0, x1, y1 = t["box"]; w, h = t["screen"]
                    self.assertTrue(0 <= x0 < x1 <= w and 0 <= y0 < y1 <= h, t["id"])
                if t["type"] == "json_schema":
                    self.assertIn("schema", t)
                if s == "asr":
                    self.assertTrue(t.get("audio_text") and t.get("max_wer"), t["id"])


class Sanitized(unittest.TestCase):
    """Synthetic data only: example domains, TEST tag IDs, 555-01xx phones, example.com email."""
    PUBLIC_INFRA = {"www.googletagmanager.com", "schema.org"}

    def text(self):
        return "\n".join(p.read_text() for p in BANK_FILES)

    def test_domains_are_examples(self):
        for d in set(re.findall(r"\b((?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|co|dev|app|us|uk))\b", self.text(), re.I)):
            d = d.lower()
            self.assertTrue(re.search(r"(^|\.)example\.(com|org|net)$", d) or d in self.PUBLIC_INFRA or d.endswith(".md"), d)

    def test_tag_ids_are_test_ids(self):
        for tag in re.findall(r"\b(?:GTM|G|AW|UA|DC)-[A-Z0-9-]+", self.text()):
            self.assertIn("TEST", tag, tag)

    def test_emails_and_phones(self):
        for e in re.findall(r"[\w.+-]+@[\w-]+\.[\w.]+", self.text()):
            self.assertTrue(e.endswith("@example.com"), e)
        for p in re.findall(r"\+?1?[ -]?\(?\d{3}\)?[ -]\d{3}[ -]\d{4}\b", self.text()):
            self.assertRegex(p, r"555", p)


class Scorers(unittest.TestCase):
    def test_exact(self):
        t = {"type": "exact", "answer": "no"}
        self.assertTrue(B.score(t, "No.")[0])
        self.assertTrue(B.score(t, "No, the event name is case sensitive.")[0])
        self.assertTrue(B.score(t, "<think>maybe yes</think>\nno")[0])
        self.assertFalse(B.score(t, "Yes")[0])
        lst = {"type": "exact", "answer": ["41", "version 41"]}
        self.assertTrue(B.score(lst, "Answer: Version 41")[0])
        self.assertTrue(B.score({"type": "exact", "answer": "GA4 - purchase (old)"}, "`GA4 - purchase (old)`")[0])
        # a real run: models cite the file the way the notes do; it is the right answer
        self.assertEqual(B.score({"type": "exact", "answer": "dedupe-purchase-tag.md"}, "[dedupe-purchase-tag.md]")[:2], (True, 1.0))
        # a failed task never keeps a perfect score
        for t, out in [({"type": "exact", "answer": "no"}, "yes"), ({"type": "exact", "answer": "59.98"}, "59.99")]:
            ok, sc, _ = B.score(t, out)
            self.assertFalse(ok); self.assertLess(sc, 1.0)

    def test_exact_gives_no_credit_for_hedging(self):
        t = {"type": "exact", "answer": "no"}
        for hedge in ["Yes\n\nNo", "Yes.\nFinal answer: no", "No, wait, it does fire. Yes.", "yes or no"]:
            self.assertEqual(B.score(t, hedge)[:2], (False, 0.0), hedge)
        self.assertFalse(B.score({"type": "exact", "answer": "G-TEST0000"}, "G-TEST0000\nActually G-TEST0001")[0])   # last line wins
        self.assertTrue(B.score({"type": "exact", "answer": "G-TEST0000"}, "Looking at the table…\nAnswer: G-TEST0000\nThat's the default.")[0])

    def test_exact_wer_for_asr(self):
        t = {"type": "exact", "answer": "The purchase tag fires on the confirmation page.", "max_wer": 0.15}
        ok, sc, _ = B.score(t, " the purchase tag fires on the confirmation page")
        self.assertTrue(ok); self.assertEqual(sc, 1.0)
        ok, sc, _ = B.score(t, "The purchase tag fires on a confirmation page.")       # 1 of 8 words
        self.assertTrue(ok); self.assertAlmostEqual(sc, 0.875)
        ok, sc, why = B.score(t, "The tag fires.")
        self.assertFalse(ok); self.assertLess(sc, 0.5); self.assertIn("wer", why)

    def test_sql(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = B.sample_db(Path(tmp))
            daily = next(t for t in B.load_bank("sql-ga4") if t["id"] == "sql-daily")
            self.assertTrue(B.score(daily, "SELECT event_date, count(*) FROM events WHERE event_name = 'purchase' GROUP BY 1 ORDER BY 1", db)[0])
            ok, sc, why = B.score(daily, "SELECT event_date, count(*) FROM events GROUP BY 1 ORDER BY 1", db)
            self.assertEqual((ok, sc), (False, 0.25))
            ok, sc, why = B.score(daily, "SELECT nope FROM nowhere", db)
            self.assertEqual((ok, sc), (False, 0.0)); self.assertIn("sql error", why)
            self.assertEqual(B.score(daily, "I can't help with that.", db)[:2], (False, 0.0))
            prose = "Here is a query to select purchases per day:\nSELECT event_date, COUNT(*) FROM events WHERE event_name='purchase' GROUP BY 1 ORDER BY 1"
            self.assertTrue(B.score(daily, prose, db)[0])
            # unordered tasks accept any row order; ordered ones don't
            dev = next(t for t in B.load_bank("sql-ga4") if t["id"] == "sql-device")
            rev = "SELECT device_category, COUNT(*) FROM events WHERE event_name='purchase' GROUP BY 1 ORDER BY 1 DESC"
            self.assertFalse(B.score(dev, rev, db)[0])
            self.assertTrue(B.score({**dev, "ordered": False}, rev, db)[0])

    def test_sql_is_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = B.sample_db(Path(tmp))
            t = {"type": "sql_result", "gold_sql": "SELECT 1"}
            self.assertFalse(B.score(t, "```sql\nDELETE FROM events\n```", db)[0])
            self.assertEqual(B.run_sql(db, "SELECT COUNT(*) FROM events")[0][0], 607)

    def test_json_schema(self):
        t = next(t for t in B.load_bank("html-json") if t["id"] == "hj-product")
        good = '{"name": "Trail Mug", "sku": "SKU-TEST-001", "price": 18.0, "currency": "USD", "in_stock": true}'
        self.assertEqual(B.score(t, f"Here you go:\n```json\n{good}\n```")[:2], (True, 1.0))
        ok, sc, why = B.score(t, good.replace("true", "false"))
        self.assertFalse(ok); self.assertAlmostEqual(sc, 5 / 6, places=3)
        ok, sc, _ = B.score(t, '{"name": "Trail Mug"}')
        self.assertFalse(ok); self.assertLess(sc, 0.5)
        self.assertEqual(B.score(t, "no json here")[:2], (False, 0.0))

    def test_validate(self):
        s = {"type": "object", "required": ["a"], "additionalProperties": False,
             "properties": {"a": {"type": "integer", "minimum": 1}, "b": {"type": "array", "items": {"enum": ["x"]}, "maxItems": 1}}}
        self.assertEqual(B.validate(s, {"a": 2, "b": ["x"]}), [])
        self.assertTrue(B.validate(s, {"a": 0}))
        self.assertTrue(B.validate(s, {"a": True}))          # booleans aren't integers
        self.assertTrue(B.validate(s, {"a": 1, "b": ["x", "x"]}))
        self.assertTrue(B.validate(s, {"a": 1, "c": 1}))

    def test_click(self):
        t = {"type": "click_in_box", "box": [100, 100, 200, 150], "screen": [1440, 900]}
        self.assertEqual(B.score(t, "click(150, 120)")[:2], (True, 1.0))
        self.assertTrue(B.score(t, "I'd click at (150.5, 149)")[0])
        self.assertTrue(B.score(t, "click(x=150, y=120)")[0])
        ok, sc, why = B.score(t, "click(300, 120)")
        self.assertFalse(ok); self.assertAlmostEqual(sc, 0.25); self.assertIn("100px", why)
        self.assertEqual(B.score(t, "the green button")[:2], (False, 0.0))


class Machine(unittest.TestCase):
    def test_lab_ids(self):
        self.assertEqual(B.machine_id({}, "Apple M1 Pro", 16 * 2 ** 30), "m1")
        self.assertEqual(B.machine_id({}, "Apple M4", 16 * 2 ** 30), "m4")
        self.assertEqual(B.machine_id({}, "Apple M5 Pro", 64 * 2 ** 30), "m5p")
        self.assertEqual(B.machine_id({}, "Apple M3 Max", 36 * 2 ** 30), "m3-max-36gb")
        self.assertEqual(B.machine_id({"BENCH_MACHINE": "studio"}, "Apple M1 Pro", 16 * 2 ** 30), "studio")


def row(model, score, tok_s, **kw):
    return {"model": model, "model_path": f"models/mlx/{model}", "score": score, "tok_s": tok_s, "total": 8, "passed": 0,
            "peak_rss": 1e9, "error": None, **kw}


class ChooseBest(unittest.TestCase):
    def test_highest_score_wins_when_clear(self):
        best, why = B.choose_best([row("A", 0.9, 10), row("B", 0.7, 100)])
        self.assertEqual(best["model"], "A"); self.assertIn("highest score", why)

    def test_near_tie_goes_to_the_faster_model(self):
        best, why = B.choose_best([row("Slow", 0.90, 10), row("Fast", 0.87, 60), row("Fastest-but-bad", 0.5, 300)])
        self.assertEqual(best["model"], "Fast"); self.assertIn("Slow", why)

    def test_errors_never_win(self):
        best, _ = B.choose_best([row("Broken", 1.0, 99, error="load failed"), row("Ok", 0.2, 5)])
        self.assertEqual(best["model"], "Ok")
        self.assertEqual(B.choose_best([row("Broken", 1.0, 9, error="x")])[0], None)

    def test_screen_split_spreads_and_partitions(self):
        tasks = [{"id": str(i)} for i in range(10)]
        screen, rest = B.screen_split(tasks, 4)
        self.assertEqual([t["id"] for t in screen], ["0", "2", "5", "7"])
        self.assertEqual(len(screen) + len(rest), 10)
        self.assertEqual(B.screen_split(tasks, 20), (tasks, []))


class Agent(unittest.TestCase):
    """`agent.py bench` against a temp stash with two empty "models" and the fake runner."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.stash = self.tmp / "A1/stash"
        for name, size in [("Qwen3-4B-4bit", 3000), ("Qwen3-0.6B-4bit", 1000), ("Qwen3-Embedding-0.6B-4bit-DWQ", 500)]:
            d = self.stash / "models/mlx" / name
            d.mkdir(parents=True)
            (d / "config.json").write_text(json.dumps({"model_type": "qwen3"}))
            (d / "model.safetensors").write_bytes(b"\0" * size)
        w = self.stash / "models/mlx/whisper-large-v3-turbo"
        w.mkdir(parents=True); (w / "config.json").write_text("{}"); (w / "weights.npz").write_bytes(b"\0" * 10)
        self.state = self.tmp / "state"; self.state.mkdir()
        self.log = self.tmp / "runner.log"
        self.posted, self.fail_api, self.leaderboard, self.notes = [], False, {"rows": []}, []

        def api(path, method="GET", body=None, raw=False):
            if self.fail_api:
                raise OSError("offline")
            self.posted.append((path, method, body))
            return self.leaderboard if path.startswith("/api/bench/leaderboard") else {"ok": True}
        self.patches = [mock.patch.object(A, "STASH", self.stash), mock.patch.object(A, "STATE_DIR", self.state),
                        mock.patch.object(A, "LOCK", self.state / "scout.lock"), mock.patch.object(A, "api", api),
                        mock.patch.object(A, "notify", lambda title, text: self.notes.append(text)),
                        mock.patch.object(A, "activity", lambda **kw: None), mock.patch.object(A, "log", lambda m: None),
                        mock.patch.dict(A.ENV, {"BENCH_MACHINE": "m1"}),
                        mock.patch.dict(os.environ, {"FAKE_LOG": str(self.log)})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()

    def bench(self, *args):
        return B.main(list(args), A, runner_cmd=FAKE, ram_bytes=64 * 2 ** 30)

    def runner_log(self):
        return [json.loads(x) for x in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_models_run_one_at_a_time_smallest_first(self):
        rows = self.bench("rag-notes")
        self.assertEqual([r["model"] for r in rows], ["Qwen3-0.6B-4bit", "Qwen3-4B-4bit"])   # embedder skipped
        ev = self.runner_log()
        self.assertEqual([e["ev"] for e in ev], ["start", "end", "start", "end"])           # never two alive at once
        self.assertLessEqual(ev[1]["t"], ev[2]["t"])
        for e in ev:
            self.assertEqual(e["argv"].count("--model") if "argv" in e else 1, 1)
            self.assertTrue(e["model"].startswith(str(self.stash)))

    def test_records_metrics_and_posts_with_token_path(self):
        outs = self.tmp / "outs.json"
        outs.write_text(json.dumps({"rag-cmp": "ExampleCMP", "rag-medium": "email"}))
        with mock.patch.dict(os.environ, {"FAKE_OUTPUTS": str(outs)}):
            rows = self.bench("rag-notes", "--model", "models/mlx/Qwen3-0.6B-4bit")
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual((r["passed"], r["total"]), (2, 8))
        self.assertEqual((r["load_s"], r["runtime"], r["machine"]), (1.5, "fake", "m1"))
        self.assertEqual(r["ttft_ms"], 135.0)                       # median of 100..170
        self.assertEqual(r["tok_s"], 43.5)
        self.assertGreater(r["peak_rss"], 20e6)                     # the fake's 24 MB ballast, seen by wait4
        self.assertEqual(r["model_path"], "models/mlx/Qwen3-0.6B-4bit")
        self.assertAlmostEqual(r["score"], sum(x["score"] for x in r["results"]) / 8)
        self.assertEqual(self.posted[0][:2], ("/api/bench/runs", "POST"))
        for k in ("ttft_ms", "tok_s", "peak_rss", "load_s", "passed", "score", "bank", "results"):
            self.assertIn(k, self.posted[0][2])
        self.assertTrue((self.state / "bench/runs").glob("*.json"))

    def test_model_outside_stash_is_refused(self):
        outside = self.tmp / "elsewhere"; outside.mkdir()
        with self.assertRaises(SystemExit):
            self.bench("rag-notes", "--model", str(outside))
        with self.assertRaises(SystemExit):
            self.bench("rag-notes", "--model", "../../elsewhere")
        self.assertEqual(self.runner_log(), [])

    def test_offline_rows_queue_then_flush(self):
        self.fail_api = True
        self.bench("screen", "--model", "models/mlx/Qwen3-0.6B-4bit")
        q = self.state / "bench/pending.jsonl"
        self.assertEqual(len(q.read_text().splitlines()), 1)
        self.fail_api = False
        self.bench("screen", "--model", "models/mlx/Qwen3-0.6B-4bit")
        self.assertFalse(q.exists())
        self.assertEqual(len([p for p in self.posted if p[0] == "/api/bench/runs"]), 2)

    def test_rejected_rows_are_not_queued_forever(self):
        import urllib.error
        def reject(*a, **k):
            raise urllib.error.HTTPError("u", 400, "bad", {}, None)
        with mock.patch.object(A, "api", reject):
            self.bench("screen", "--model", "models/mlx/Qwen3-0.6B-4bit")
        self.assertFalse((self.state / "bench/pending.jsonl").exists())
        def down(*a, **k):
            raise urllib.error.HTTPError("u", 503, "busy", {}, None)
        with mock.patch.object(A, "api", down):
            self.bench("screen", "--model", "models/mlx/Qwen3-0.6B-4bit")
        self.assertTrue((self.state / "bench/pending.jsonl").exists())     # server errors are retried

    def test_rows_carry_a_uid(self):
        r = self.bench("screen", "--model", "models/mlx/Qwen3-0.6B-4bit")[0]
        self.assertRegex(r["uid"], r"^[0-9a-f]{32}$")

    def test_symlink_out_of_the_stash_is_never_loaded(self):
        outside = self.tmp / "outside-model"; outside.mkdir()
        (outside / "config.json").write_text("{}"); (outside / "model.safetensors").write_bytes(b"\0" * 10)
        (self.stash / "models/mlx/Sneaky-0.1B").symlink_to(outside)
        rows = self.bench("rag-notes")
        self.assertNotIn("Sneaky-0.1B", [r["model"] for r in rows])
        self.assertNotIn("outside-model", [r["model"] for r in rows])

    def test_missing_runner_python_is_recorded_and_the_next_model_still_runs(self):
        rows = B.main(["rag-notes"], A, runner_cmd=["/nonexistent/python", "x.py"], ram_bytes=64 * 2 ** 30)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all("did not start" in r["error"] for r in rows))

    def test_runner_gets_offline_env(self):
        outs = self.tmp / "o.json"; outs.write_text("{}")
        with mock.patch.dict(os.environ, {"FAKE_OUTPUTS": str(outs)}):
            got = B.run_model([sys.executable, "-c", "import os,json,sys; json.load(sys.stdin); print(json.dumps({'event':'loaded','load_s':0,'runtime':os.environ.get('HF_HUB_OFFLINE')}))"],
                              self.stash / "models/mlx/Qwen3-0.6B-4bit", "llm", [])
        self.assertEqual(got["runtime"], "1")

    def test_load_failure_is_recorded(self):
        with mock.patch.dict(os.environ, {"FAKE_LOAD_FAIL": "1"}):
            r = self.bench("gtm-debug", "--model", "models/mlx/Qwen3-0.6B-4bit")[0]
        self.assertEqual(r["passed"], 0)
        self.assertIn("load failed", r["error"])

    def test_asr_uses_whisper_and_spoken_audio(self):
        with mock.patch.object(B, "speak", lambda text, cache: (cache.mkdir(parents=True, exist_ok=True), cache / "a.wav")[1].write_bytes(b"RIFF") or cache / "a.wav"):
            rows = self.bench("asr")
        self.assertEqual([r["model"] for r in rows], ["whisper-large-v3-turbo"])
        self.assertEqual(self.runner_log()[0]["kind"], "asr")

    # ---- picking the best model for you

    def add_models(self, *names):
        for k, name in enumerate(names):
            d = self.stash / "models/mlx" / name
            d.mkdir(parents=True)
            (d / "config.json").write_text(json.dumps({"model_type": "qwen3"}))
            (d / "model.safetensors").write_bytes(b"\0" * (1100 + 100 * k))

    def outputs(self, per_model):
        f = self.tmp / "outs.json"; f.write_text(json.dumps(per_model))
        return mock.patch.dict(os.environ, {"FAKE_OUTPUTS": str(f)})

    def picks(self):
        return [b for p, m, b in self.posted if p == "/api/bench/best"]

    def test_finds_the_best_model_without_being_told_which(self):
        self.add_models("Alpha-1B", "Beta-2B", "Gamma-3B")           # 5 chat models: more than 3 finalists, so screening runs
        tasks = B.load_bank("rag-notes")
        right = {t["id"]: ideal(t) for t in tasks}
        half = {k: v for i, (k, v) in enumerate(right.items()) if i % 2}
        with self.outputs({"Gamma-3B": right, "Beta-2B": half}):
            rows = self.bench("rag-notes")
        pick = self.picks()[0]
        self.assertEqual(pick["model"], "Gamma-3B")
        self.assertEqual((pick["score"], pick["considered"], pick["ran"]), (1.0, 5, 3))
        self.assertEqual(len(pick["screened_out"]), 2)
        self.assertIn("Gamma-3B", self.notes[0])
        # finalists post one full-bank run each; screened-out models post nothing
        runs = [b for p, m, b in self.posted if p == "/api/bench/runs"]
        self.assertEqual(len(runs), 3)
        self.assertTrue(all(r["total"] == len(tasks) for r in runs))
        self.assertEqual({r["model"] for r in rows}, {r["model"] for r in runs})
        self.assertNotIn(pick["screened_out"][0]["model"], {r["model"] for r in runs})
        # still one model at a time; finalists load twice (screen, then the rest), the others once
        ev = self.runner_log()
        self.assertEqual([e["ev"] for e in ev], ["start", "end"] * 8)
        loads = {}
        for e in ev:
            if e["ev"] == "start":
                loads[Path(e["model"]).name] = loads.get(Path(e["model"]).name, 0) + 1
        self.assertEqual(sorted(loads.values()), [1, 1, 2, 2, 2])
        self.assertEqual(loads["Gamma-3B"], 2)

    def test_reuses_measured_runs_and_can_recommend_them(self):
        self.leaderboard = {"rows": [row("Qwen3-4B-4bit", 0.99, 30, bank=B.bank_hash("rag-notes"), machine="m1")]}
        self.bench("rag-notes")
        started = {Path(e["model"]).name for e in self.runner_log() if e["ev"] == "start"}
        self.assertEqual(started, {"Qwen3-0.6B-4bit"})               # 4B was already measured on this bank and Mac
        pick = self.picks()[0]
        self.assertEqual((pick["model"], pick["reused"], pick["ran"]), ("Qwen3-4B-4bit", 1, 1))

    def test_old_bank_or_fresh_means_run_again(self):
        self.leaderboard = {"rows": [row("Qwen3-4B-4bit", 0.99, 30, bank="oldbank00000", machine="m1")]}
        self.bench("rag-notes")
        self.assertEqual(len([e for e in self.runner_log() if e["ev"] == "start"]), 2)
        self.log.unlink()
        self.leaderboard = {"rows": [row("Qwen3-4B-4bit", 0.99, 30, bank=B.bank_hash("rag-notes"), machine="m1")]}
        self.bench("rag-notes", "--fresh")
        self.assertEqual(len([e for e in self.runner_log() if e["ev"] == "start"]), 2)

    def test_offline_search_still_picks_locally(self):
        self.fail_api = True
        rows = self.bench("rag-notes")
        self.assertEqual(len(rows), 2)
        self.assertTrue((self.state / "bench/pending.jsonl").exists())
        self.assertTrue(self.notes)                                   # you still hear which model won

    def test_named_model_is_measured_but_not_recommended(self):
        self.bench("rag-notes", "--model", "models/mlx/Qwen3-0.6B-4bit")
        self.assertEqual(self.picks(), [])
        self.assertEqual(self.notes, [])

    def test_agent_refuses_when_a1_absent(self):
        with mock.patch.object(A, "a1_present", lambda: False), mock.patch.object(sys, "argv", ["agent.py", "bench", "rag-notes"]):
            buf = io.StringIO()
            with redirect_stdout(buf):
                A.main()
        self.assertIn("A1 not present", buf.getvalue())
        self.assertEqual(self.runner_log(), [])

    def test_agent_refuses_while_a_run_holds_the_lock(self):
        holder = subprocess.Popen([sys.executable, "-c",
            "import fcntl,sys,time; f=open(sys.argv[1],'w'); fcntl.flock(f, fcntl.LOCK_EX); print('held', flush=True); time.sleep(30)",
            str(A.LOCK)], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), "held")
            with mock.patch.object(A, "a1_present", lambda: True), mock.patch.object(sys, "argv", ["agent.py", "bench", "rag-notes"]):
                buf = io.StringIO()
                with redirect_stdout(buf):
                    A.main()
            self.assertIn("another a1-scout run is active", buf.getvalue())
            self.assertEqual(self.runner_log(), [])
        finally:
            holder.kill(); holder.wait()

    def test_agent_runs_bench_when_mounted_and_free(self):
        with mock.patch.object(A, "a1_present", lambda: True), \
             mock.patch.object(B, "main", lambda argv, mod: self.posted.append(("bench", argv, mod is A))):
            with mock.patch.object(sys, "argv", ["agent.py", "bench", "screen", "--model", "x"]):
                A.main()
        self.assertIn(("bench", ["screen", "--model", "x"], True), self.posted)


if __name__ == "__main__":
    unittest.main()


class DecisionBench(unittest.TestCase):
    """gtm-gate: typed questions to decision models, scored on the probability put on the gold answers."""

    def test_bank_shape(self):
        for t in B.load_bank("gtm-gate"):
            self.assertEqual(t["type"], "decision")
            self.assertEqual(set(t["questions"]), set(t["gold"]), t["id"])
            for qid, q in t["questions"].items():
                g = t["gold"][qid]
                if q["type"] == "noul":
                    self.assertIsInstance(g, bool)
                elif q["type"] == "score":
                    self.assertIn(g, range(len(q["criteria"])))
                else:
                    self.assertIn(g, q["criteria"])
        golds = [t["gold"]["weakens"] for t in B.load_bank("gtm-gate")]
        self.assertTrue(4 <= sum(golds) <= len(golds) - 4, "the bank needs both safe and breaking changes")

    def test_score_rewards_confident_right_answers(self):
        t = B.load_bank("gtm-gate")[0]
        sure, unsure = B.score(t, json.dumps(perfect_answers(t, 0.95))), B.score(t, json.dumps(perfect_answers(t, 0.6)))
        self.assertTrue(sure[0] and unsure[0])
        self.assertGreater(sure[1], unsure[1])
        wrong = B.score(t, json.dumps(perfect_answers(t, 0.1)))
        self.assertFalse(wrong[0])
        self.assertIn("wrong:", wrong[2])
        self.assertLess(wrong[1], 0.2)

    def test_score_accepts_list_probabilities_and_rejects_junk(self):
        t = B.load_bank("gtm-gate")[0]
        a = perfect_answers(t, 0.9)
        a["risk"]["probabilities"] = [a["risk"]["probabilities"][str(i)] for i in range(3)]
        self.assertTrue(B.score(t, json.dumps(a))[0])
        self.assertEqual(B.score(t, "not json")[:2], (False, 0.0))
        self.assertFalse(B.score(t, json.dumps({"fires": "yes"}))[0])

    def test_runner_tasks_carry_state_and_questions(self):
        t = B.load_bank("gtm-gate")[0]
        rt = B.runner_tasks([t], Path(tempfile.mkdtemp()))[0]
        self.assertEqual(rt["state"], t["state"])
        self.assertEqual(rt["questions"], t["questions"])

    def test_families_and_discovery(self):
        tmp = Path(tempfile.mkdtemp()); stash = tmp / "A1/stash"
        def mk(rel, files):
            d = stash / rel; d.mkdir(parents=True)
            for f, body in files.items():
                (d / f).write_bytes(body if isinstance(body, bytes) else body.encode())
            return d
        clef = mk("models/mlx/clef-flash-4bit", {"clef_mlx.py": "", "joint_head.safetensors": b"\0" * 100, "config.json": "{}"})
        kev = mk("models/hf/kev-0.8b", {"head.pt": b"\0" * 10, "adapter_config.json": json.dumps({"base_model_name_or_path": "Qwen/Qwen3.5-0.8B-Base"})})
        orphan = mk("models/hf/kev-9b", {"head.pt": b"\0" * 10, "adapter_config.json": json.dumps({"base_model_name_or_path": "Qwen/Qwen3.5-9B-Base"})})
        merged = mk("models/mlx/kev-4b-mlx-8bit", {"head.pt": b"\0" * 10, "config.json": "{}", "model.safetensors": b"\0" * 50})
        mk("models/hf/Qwen3.5-0.8B-Base", {"config.json": "{}", "model.safetensors": b"\0" * 20})
        mk("models/mlx/Qwen3-0.6B-4bit", {"config.json": "{}", "model.safetensors": b"\0" * 20})
        self.assertEqual([B.decision_family(d) for d in (clef, kev, merged)], ["clef", "kev", "kev-mlx"])
        self.assertIsNone(B.decision_family(stash / "models/mlx/Qwen3-0.6B-4bit"))
        with mock.patch.object(A, "STASH", stash):
            found = [p.name for p in B.discover_models(A, "gtm-gate", 64 * 2 ** 30)]
        self.assertEqual(set(found), {"clef-flash-4bit", "kev-0.8b", "kev-4b-mlx-8bit"})   # kev-9b has no base on the drive
        self.assertNotIn(orphan.name, found)
        self.assertEqual(B.model_kind(kev, "gtm-gate"), "kev")
