"""Stand-in for agent/bench_runner.py in tests: same protocol, no model.

Answers come from FAKE_OUTPUTS (a JSON file {task id: output}); anything else answers "no".
Each start and end is appended to FAKE_LOG so tests can prove models ran one at a time.
FAKE_LOAD_FAIL=1 makes the load fail; it holds ~24 MB so peak RSS is visible to wait4.
"""
import argparse, json, os, sys, time

ap = argparse.ArgumentParser()
ap.add_argument("--model"); ap.add_argument("--kind")
a = ap.parse_args()
tasks = json.load(sys.stdin)["tasks"]
log = os.environ.get("FAKE_LOG")
outputs = json.load(open(os.environ["FAKE_OUTPUTS"])) if os.environ.get("FAKE_OUTPUTS") else {}


def note(**kw):
    if log:
        with open(log, "a") as f:
            f.write(json.dumps({"pid": os.getpid(), "model": a.model, "kind": a.kind, "t": time.time(), **kw}) + "\n")


note(ev="start", argv=sys.argv[1:])
ballast = bytearray(24 * 1024 * 1024)
for i in range(0, len(ballast), 4096):
    ballast[i] = 1
time.sleep(0.05)
if os.environ.get("FAKE_LOAD_FAIL"):
    print(json.dumps({"event": "error", "error": "load failed: fake"}), flush=True)
    note(ev="end"); sys.exit(3)
print(json.dumps({"event": "loaded", "load_s": 1.5, "runtime": "fake"}), flush=True)
for i, t in enumerate(tasks):
    if a.kind == "asr":
        assert os.path.exists(t["audio"]), t
    print(json.dumps({"event": "result", "id": t["id"], "output": outputs.get(t["id"], "no"),
                      "ttft_ms": 100.0 + 10 * i, "tok_s": 40.0 + i, "latency_ms": 300.0}), flush=True)
print(json.dumps({"event": "done", "mlx_peak": 1000}), flush=True)
note(ev="end")
