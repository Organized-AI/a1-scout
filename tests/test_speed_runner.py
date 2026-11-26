"""Speed Lab timing and fit behavior with fake servers/models, never inference."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
import speed_runner as S


class Clock:
    def __init__(self, *times):
        self.times = iter(times)

    def __call__(self):
        return next(self.times)


class Response:
    def __init__(self, events):
        self.lines = []
        for event in events:
            body = event if isinstance(event, str) else json.dumps(event)
            self.lines.extend([("data: " + body + "\n").encode(), b"\n"])
        self.headers = {"server": "http-framework/1.0", "x-engine-version": "fake-engine/1.0"}

    def __iter__(self):
        return iter(self.lines)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def delta(content=None, **fields):
    return {"choices": [{"delta": {**({"content": content} if content is not None else {}), **fields}}]}


class SpeedTiming(unittest.TestCase):
    def test_clock_separates_reading_writing_and_ignores_empty_deltas(self):
        events = [{}, {"text": ""}, {"text": "A"}, {"text": "B"},
                  {"usage": {"prompt_tokens": 100, "completion_tokens": 4, "total_tokens": 104}}]
        row = S.measure_stream(events, clock=Clock(0, 2, 6))
        self.assertEqual(row["output"], "AB")
        self.assertEqual(row["ttft_ms"], 2000)
        self.assertEqual(row["latency_ms"], 6000)
        self.assertEqual(row["prompt_tok_s"], 50)
        self.assertEqual(row["write_tok_s"], 1)
        self.assertEqual(row["usage"]["total_tokens"], 104)
        self.assertTrue(row["fit"])

    def test_reasoning_counts_as_first_generated_token(self):
        row = S.measure_stream([{"reasoning": "thinking"}, {"text": "answer"}], clock=Clock(0, 1, 3))
        self.assertEqual(row["ttft_ms"], 1000)
        self.assertEqual(row["output"], "answer")

    def test_missing_or_invalid_counts_never_use_character_estimates(self):
        for usage in ({}, {"prompt_tokens": True, "completion_tokens": "100"},
                      {"prompt_tokens": -1, "completion_tokens": -3}):
            with self.subTest(usage=usage):
                row = S.measure_stream([{"text": "a long response", "usage": usage}], clock=Clock(0, 1, 2))
                self.assertIsNone(row["prompt_tokens"])
                self.assertIsNone(row["reply_tokens"])
                self.assertIsNone(row["prompt_tok_s"])
                self.assertIsNone(row["write_tok_s"])

    def test_one_token_and_no_content_have_no_write_rate(self):
        row = S.measure_stream([{"text": "x", "usage": {"prompt_tokens": 10, "completion_tokens": 1}}], clock=Clock(0, 1, 2))
        self.assertIsNone(row["write_tok_s"])
        empty = S.measure_stream([{"usage": {"prompt_tokens": 10, "completion_tokens": 0}}], clock=Clock(0, 2))
        self.assertIsNone(empty["ttft_ms"])
        self.assertIsNone(empty["prompt_tok_s"])

    def test_broken_stream_preserves_partial_text_but_invalidates_rates(self):
        def events():
            yield {"text": "partial", "usage": {"prompt_tokens": 50, "completion_tokens": 4}}
            raise OSError("secret exception body")
        row = S.measure_stream(events(), clock=Clock(0, 1, 3))
        self.assertEqual(row["output"], "partial")
        self.assertIsNone(row["fit"])
        self.assertIn("OSError", row["error"])
        self.assertNotIn("secret", row["error"])
        self.assertIsNone(row["prompt_tok_s"])
        self.assertIsNone(row["write_tok_s"])

    def test_server_stream_error_invalidates_measurement(self):
        row = S.measure_stream([{"error": {"message": "failure"}}], clock=Clock(0, 2))
        self.assertIsNotNone(row["error"])
        self.assertIsNone(row["fit"])


class SpeedEndpoint(unittest.TestCase):
    def good_events(self):
        return [delta(role="assistant"), delta(""), delta("first"), delta("second"),
                {"choices": [], "usage": {"prompt_tokens": 200, "completion_tokens": 4}}, "[DONE]"]

    def test_request_streams_usage_and_records_engine_version(self):
        requests = []
        def open_(req, **kwargs):
            requests.append((req, kwargs))
            return Response(self.good_events())
        row = S.measure_endpoint("http://127.0.0.1:9999/v1/", "fake", "synthetic", 256,
                                 opener=open_, clock=Clock(0, 2, 6), headers={"authorization": "Bearer fake"})
        req, kwargs = requests[0]
        body = json.loads(req.data)
        self.assertEqual(req.full_url, "http://127.0.0.1:9999/v1/chat/completions")
        self.assertTrue(body["stream"])
        self.assertEqual(body["stream_options"], {"include_usage": True})
        self.assertEqual(body["max_tokens"], 256)
        self.assertEqual(body["messages"], [{"role": "user", "content": "synthetic"}])
        self.assertEqual(row["ttft_ms"], 2000)
        self.assertEqual(row["prompt_tok_s"], 100)
        self.assertEqual(row["engine_version"], "fake-engine/1.0")
        self.assertNotIn("Bearer", json.dumps(row))

    def test_omlx_fit_refusals_are_distinct_from_http_errors(self):
        for target, status, message, fit in [
            ("omlx", 507, "model does not fit", False),
            ("omlx", 400, "prefill memory guard: insufficient memory", False),
            ("omlx", 400, "invalid model argument", None),
            ("endpoint", 507, "remote insufficient storage", None),
        ]:
            def open_(req, **kwargs):
                raise urllib.error.HTTPError(req.full_url, status, "error", {}, io.BytesIO(json.dumps({"error": {"message": message}}).encode()))
            with self.subTest(target=target, status=status, message=message):
                row = S.measure_endpoint("http://localhost/v1", "fake", "prompt", 1, target=target, opener=open_, clock=Clock(0, 1))
                self.assertIs(row["fit"], fit)
                if fit is False:
                    self.assertEqual(row["reason"], message)
                    self.assertIsNone(row["error"])
                else:
                    self.assertEqual(row["error"], f"HTTP {status}")

    def test_diagnostics_redact_credentials(self):
        reason = S.safe_reason('{"error":{"message":"prefill memory guard api_key=sk-secret Bearer private-token"}}')
        self.assertNotIn("sk-secret", reason)
        self.assertNotIn("private-token", reason)
        self.assertLessEqual(len(S.safe_reason("x" * 1000)), 500)

    def test_url_credentials_and_non_http_endpoints_refused(self):
        for url in ("file:///tmp/a", "http://user:pass@localhost/v1", "http://localhost/v1?key=secret", "http://localhost/v1#fragment"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                S.measure_endpoint(url, "fake", "p", 1)

    def test_malformed_and_truncated_sse_fail(self):
        for events in ([delta("partial"), "not-json"], self.good_events()[:-1]):
            with self.subTest(events=events):
                row = S.measure_endpoint("http://localhost/v1", "fake", "p", 1,
                                         opener=lambda *a, **k: Response(events), clock=Clock(0, 1, 3))
                self.assertIsNotNone(row["error"])
                self.assertIsNone(row["write_tok_s"])

    def test_real_loopback_http_sse_works_without_remote_calls(self):
        events = self.good_events()
        received = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append((self.path, json.loads(self.rfile.read(int(self.headers["content-length"])))))
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("x-engine-version", "fake/2")
                self.end_headers()
                for line in Response(events).lines:
                    self.wfile.write(line)
                self.wfile.flush()
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            row = S.measure_endpoint(f"http://127.0.0.1:{server.server_port}/v1", "fake", "synthetic", 4)
            self.assertTrue(row["fit"])
            self.assertEqual(row["prompt_tokens"], 200)
            self.assertEqual(row["reply_tokens"], 4)
            self.assertEqual(row["engine_version"], "fake/2")
            self.assertEqual(received[0][0], "/v1/chat/completions")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class SpeedRuns(unittest.TestCase):
    def task(self):
        return {"id": "synthetic", "prompt": "synthetic context", "workload": "agent", "phase": "prefill",
                "target_prompt_tokens": 1000, "max_tokens": 1, "tokenizer": "Qwen3"}

    def probes(self):
        return {"chip": "M1 Pro", "bandwidth_gbs": 200, "bandwidth_source": "https://support.apple.com/"}

    def test_omlx_cache_pair_has_identical_prefix_and_measured_probes(self):
        calls = []
        def answer(prompt, max_tokens):
            calls.append((prompt, max_tokens))
            return {"fit": True, "usage": {}, "ttft_ms": 1}
        with tempfile.TemporaryDirectory() as tmp:
            tasks = [self.task(), {**self.task(), "id": "decode", "phase": "decode", "max_tokens": 256}]
            rows = S.run_tasks(tasks, "fake", "omlx", machine="m1", adapter=answer,
                               probe=self.probes, free_probe=lambda: 123, rss_probe=lambda: 456, cache_dir=Path(tmp))
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(calls[2], calls[3])
        self.assertNotEqual(calls[0][0], calls[2][0])
        self.assertIn(self.task()["prompt"], calls[0][0])
        self.assertEqual([r["cache_state"] for r in rows], ["first-use-unconfirmed", "warm-repeat"] * 2)
        self.assertEqual(rows[0]["cache_pair_uid"], rows[1]["cache_pair_uid"])
        self.assertNotEqual(rows[0]["cache_pair_uid"], rows[2]["cache_pair_uid"])
        self.assertNotEqual(rows[0]["uid"], rows[1]["uid"])
        self.assertEqual(rows[0]["probes"]["free_ram_bytes"], 123)
        self.assertEqual(rows[0]["probes"]["peak_rss_bytes"], 456)
        self.assertEqual(rows[0]["probes"]["rss_scope"], "client")
        self.assertNotIn("score", rows[0])

    def test_low_ram_refuses_local_model_before_loading(self):
        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp) / "model"
            model.mkdir()
            (model / "model.safetensors").write_bytes(b"x" * 100)
            self.assertIsNotNone(S.memory_guard(model, 100, margin=1))
            self.assertIsNone(S.memory_guard(model, 101, margin=1))
            self.assertIsNotNone(S.memory_guard(model, None))
            with mock.patch.object(S, "MLXAdapter") as load:
                rows = S.run_tasks([self.task()], model, "mlx", machine="fake", probe=self.probes,
                                   free_probe=lambda: 1, rss_probe=lambda: 2)
            load.assert_not_called()
        self.assertFalse(rows[0]["fit"])
        self.assertIn("free RAM", rows[0]["reason"])

    def test_remote_target_does_not_apply_local_memory_guard(self):
        with mock.patch.object(S, "measure_endpoint", return_value={"fit": True, "usage": {}}) as call:
            rows = S.run_tasks([self.task()], "org/remote-model", "endpoint", endpoint="https://example.com/v1",
                               machine="remote", env={"SPEED_ENDPOINT_TOKEN": "fake-secret"}, probe=self.probes, free_probe=lambda: 0, rss_probe=lambda: 2)
        call.assert_called_once()
        self.assertEqual(call.call_args.args[1], "org/remote-model")
        self.assertEqual(call.call_args.kwargs["headers"], {"authorization": "Bearer fake-secret"})
        self.assertNotIn("fake-secret", json.dumps(rows))
        self.assertTrue(rows[0]["fit"])
        self.assertEqual(rows[0]["cache_state"], "not_applicable")

    def test_omlx_custom_url_and_endpoint_token_used_without_persisting(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(S, "memory_guard", return_value=None), mock.patch.object(S, "measure_endpoint", return_value={"fit": True, "usage": {}}) as call:
                rows = S.run_tasks([self.task()], "model", "omlx", machine="m1", env={"OMLX_URL": "http://localhost:9000/v1", "SPEED_ENDPOINT_TOKEN": "fake-secret"},
                                   probe=self.probes, free_probe=lambda: 1, rss_probe=lambda: 2, cache_dir=tmp, cache_pair=False)
        self.assertEqual(call.call_args.args[0], "http://localhost:9000/v1")
        self.assertEqual(call.call_args.kwargs["headers"], {})
        self.assertNotIn("fake-secret", json.dumps(rows))

    def test_cache_probe_reads_existing_file_without_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cache.bin"
            path.write_bytes(b"x" * 1000)
            before = path.stat().st_mtime_ns
            result = S.cache_read_probe(tmp, max_bytes=100, clock=Clock(0, 2))
            self.assertEqual(result["cache_read_bytes"], 100)
            self.assertEqual(result["cache_read_gbs"], 50 / 1e9)
            self.assertEqual(path.stat().st_mtime_ns, before)
            self.assertEqual(path.read_bytes(), b"x" * 1000)
        self.assertIsNone(S.cache_read_probe("/nonexistent-cache")["cache_read_gbs"])

    def test_free_ram_probe_is_conservative(self):
        text = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 99999.\n"
        with mock.patch.object(S.sys, "platform", "darwin"), mock.patch.object(S.subprocess, "run", return_value=SimpleNamespace(stdout=text)):
            self.assertEqual(S.free_ram_bytes(), 10 * 16384)
        with mock.patch.object(S.subprocess, "run", side_effect=OSError()), mock.patch.object(S.sys, "platform", "darwin"):
            self.assertIsNone(S.free_ram_bytes())

    def test_mlx_adapter_streams_actual_token_usage_without_real_model(self):
        fake_tok = SimpleNamespace(chat_template=None)
        fake = SimpleNamespace(load=lambda path: (object(), fake_tok),
                               stream_generate=lambda *args, **kwargs: iter([SimpleNamespace(text="a", prompt_tokens=10, generation_tokens=1),
                                                                            SimpleNamespace(text="b", prompt_tokens=10, generation_tokens=2)]))
        with mock.patch.dict(sys.modules, {"mlx_lm": fake}), mock.patch.object(S.importlib.metadata, "version", return_value="fake-1"):
            adapter = S.MLXAdapter("fake", clock=Clock(0, 1, 2, 4, 6))
            row = adapter("synthetic", 2)
        self.assertEqual(row["prompt_tokens"], 10)
        self.assertEqual(row["reply_tokens"], 2)
        self.assertEqual(row["runtime"], "mlx_lm")
        self.assertEqual(row["engine_version"], "fake-1")
        self.assertEqual(row["load_s"], 1)


if __name__ == "__main__":
    unittest.main()

