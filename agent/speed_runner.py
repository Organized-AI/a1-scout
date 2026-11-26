"""Speed Lab: streamed prompt-reading and writing measurements, without quality scores.

Normally called by agent.py bench speed while scout.lock is held. Standalone
execution takes that same lock. No server settings or cache contents are changed.
"""
import argparse
import fcntl
import importlib.metadata
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

import bench
import speed_bank

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OMLX_URL = "http://127.0.0.1:8000/v1"
DEFAULT_CACHE = Path("/Volumes/A1/omlx-cache")
MARGIN_BYTES = 512 * 2 ** 20


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def count(value):
    return value if type(value) is int and value >= 0 else None


def measure_stream(events, *, clock=time.perf_counter, started=None):
    """Consume normalized text/reasoning/usage events. Never infer tokens from text.

    TTFT includes transport and queue time. It is an observed prefill proxy, not
    pure device compute. Empty/role chunks do not count as generated tokens.
    """
    start = clock() if started is None else started
    first, output, usage, error = None, [], {}, None
    try:
        for event in events:
            text = event.get("text") if isinstance(event.get("text"), str) else ""
            reasoning = event.get("reasoning") if isinstance(event.get("reasoning"), str) else ""
            if text or reasoning or event.get("generated"):
                if first is None:
                    first = clock()
                output.append(text)
            if isinstance(event.get("usage"), dict):
                usage = event["usage"]
            if event.get("error"):
                raise ValueError("server stream reported an error")
    except Exception as exc:
        error = f"stream failed ({type(exc).__name__})"
    end = clock()
    prompt = count(usage.get("prompt_tokens"))
    reply = count(usage.get("completion_tokens"))
    ttft = first - start if first is not None else None
    decode = end - first if first is not None else None
    return {"output": "".join(output), "usage": usage, "prompt_tokens": prompt,
            "reply_tokens": reply, "ttft_ms": ttft * 1000 if ttft is not None else None,
            "latency_ms": max(0, end - start) * 1000,
            "prompt_tok_s": prompt / ttft if not error and prompt and ttft and ttft > 0 else None,
            "write_tok_s": reply / decode if not error and reply is not None and reply > 1 and decode and decode > 0 else None,
            "fit": None if error else True, "reason": None, "error": error}


def sse_events(response):
    """Parse SSE framing (including multiline data), not TCP chunk boundaries."""
    data = []
    finished = False
    def decode(lines):
        payload = "\n".join(lines)
        if payload == "[DONE]":
            return None
        nonlocal finished
        obj = json.loads(payload)
        if any(c.get("finish_reason") is not None for c in obj.get("choices", [])):
            finished = True
        delta = ((obj.get("choices") or [{}])[0].get("delta") or {})
        return {"text": delta.get("content"), "reasoning": delta.get("reasoning_content") or delta.get("reasoning"),
                "usage": obj.get("usage"), "error": obj.get("error")}
    for raw in response:
        line = raw.decode("utf-8").rstrip("\r\n") if isinstance(raw, bytes) else raw.rstrip("\r\n")
        if not line:
            if data:
                event = decode(data)
                data = []
                if event is None:
                    return
                yield event
        elif line.startswith("data:"):
            data.append(line[5:].lstrip(" "))
    if data:
        event = decode(data)
        if event is not None:
            yield event
        else:
            return
    if not finished:
        raise ValueError("stream ended without completion marker")


def safe_reason(body):
    """Retain bounded diagnostic text without leaking credential-shaped strings."""
    text = body.decode("utf-8", errors="replace") if isinstance(body, bytes) else str(body)
    try:
        obj = json.loads(text)
        err = obj.get("error", obj)
        text = err.get("message", str(err)) if isinstance(err, dict) else str(err)
    except (ValueError, AttributeError):
        pass
    text = re.sub(r"(?i)(bearer\s+|(?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s,}\"]+", r"\1[redacted]", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]+", "[redacted]", text)
    return text[:500]


def measure_endpoint(base_url, model, prompt, max_tokens, *, target="endpoint", opener=None,
                     clock=time.perf_counter, headers=None, timeout=180):
    opener = opener or urllib.request.urlopen
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("endpoint must be an http(s) URL without credentials, query or fragment")
    body = {"model": model, "messages": [{"role": "user", "content": prompt}], "stream": True,
            "stream_options": {"include_usage": True}, "max_tokens": max_tokens, "temperature": 0}
    req = urllib.request.Request(base_url.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json", **(headers or {})}, method="POST")
    start = clock()
    try:
        with opener(req, timeout=timeout) as response:
            result = measure_stream(sse_events(response), clock=clock, started=start)
            response_headers = getattr(response, "headers", {})
            result.update(runtime=target, engine_version=response_headers.get("x-engine-version"))
            return result
    except urllib.error.HTTPError as exc:
        try:
            reason = safe_reason(exc.read(4096))
        finally:
            exc.close()
        refused = target == "omlx" and (exc.code == 507 or exc.code == 400 and bool(re.search(r"prefill.{0,80}(?:memory|guard)|(?:memory|guard).{0,80}prefill", reason, re.I)))
        return {"fit": False if refused else None, "reason": reason if refused else None,
                "error": None if refused else f"HTTP {exc.code}", "usage": {}, "runtime": target,
                "engine_version": None, "latency_ms": (clock() - start) * 1000}
    except (OSError, TimeoutError) as exc:
        return {"fit": None, "reason": None, "error": f"request failed ({type(exc).__name__})",
                "usage": {}, "runtime": target, "engine_version": None, "latency_ms": (clock() - start) * 1000}



def engine_version_probe(base_url, *, opener=None):
    """Read-only version discovery. A web server name is not an engine version."""
    opener = opener or urllib.request.urlopen
    root = base_url.rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3]
    try:
        with opener(root + "/version", timeout=2) as response:
            data = json.loads(response.read(4096))
        version = data.get("version")
        return version[:80] if isinstance(version, str) else None
    except (OSError, ValueError, AttributeError):
        return None


def active_weight_bytes(model):
    """Only explicit metadata is sufficient, especially for sparse MoE models."""
    try:
        data = json.loads((Path(model) / "config.json").read_text())
        value = data.get("active_weight_bytes")
        return value if type(value) is int and value > 0 else None
    except (OSError, ValueError):
        return None


def free_ram_bytes():
    """Conservative free pages only; inactive/reclaimable pages are not promised."""
    try:
        if sys.platform == "darwin":
            out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=10, check=True).stdout
            page = int(re.search(r"page size of (\d+) bytes", out).group(1))
            pages = int(re.search(r"Pages free:\s+(\d+)", out).group(1))
            return page * pages
        text = Path("/proc/meminfo").read_text()
        return int(re.search(r"MemFree:\s+(\d+)", text).group(1)) * 1024
    except (OSError, ValueError, AttributeError, subprocess.SubprocessError):
        return None


def peak_rss_bytes():
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(rss if sys.platform == "darwin" else rss * 1024)


def machine_probe():
    chip, memory = None, None
    try:
        if sys.platform == "darwin":
            chip = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True, timeout=10, check=True).stdout.strip().replace("Apple ", "")
            memory = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=10, check=True).stdout)
        else:
            chip = os.uname().machine
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    bandwidth = {}
    # Read RAM Scout's shared table through its public API, rather than a drifting
    # Python copy. Failure (including Node absent) leaves bandwidth unknown.
    try:
        script = "require('./public/consider-core.js');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(globalThis.ConsiderCore.bandwidthFor(JSON.parse(s)))));"
        out = subprocess.run(["node", "-e", script], input=json.dumps({"chip": chip, "memory_gb": memory / 2 ** 30 if memory else None}),
                             cwd=ROOT, capture_output=True, text=True, timeout=10, check=True)
        bandwidth = json.loads(out.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return {"chip": chip, "memory_bytes": memory, "bandwidth_gbs": bandwidth.get("gbs"), "bandwidth_source": bandwidth.get("source")}


def cache_read_probe(cache_dir=DEFAULT_CACHE, *, max_bytes=16 * 2 ** 20, clock=time.perf_counter):
    """Bounded read of an existing file, never creates or evicts cache entries."""
    result = {"cache_drive": str(cache_dir), "cache_read_gbs": None,
              "cache_read_basis": "read-only existing file; filesystem cache may apply"}
    root = Path(cache_dir)
    try:
        # Limit enumeration too: a large cache must not become a benchmark scan.
        candidates = []
        with os.scandir(root) as entries:
            for i, entry in enumerate(entries):
                if i >= 100:
                    break
                if entry.is_file(follow_symlinks=False) and entry.stat().st_size:
                    candidates.append(Path(entry.path))
        if not candidates:
            return result
        start = clock()
        with candidates[0].open("rb") as source:
            data = source.read(max_bytes)
        elapsed = clock() - start
        if data and elapsed > 0:
            result["cache_read_gbs"] = len(data) / elapsed / 1e9
        result["cache_read_bytes"] = len(data)
    except OSError:
        pass
    return result


def model_size_bytes(model):
    path = Path(model)
    if not path.is_dir():
        return None
    return sum(p.stat().st_size for p in path.rglob("*.safetensors") if p.is_file()) or None


def memory_guard(model, free_bytes, margin=MARGIN_BYTES):
    size = model_size_bytes(model)
    if free_bytes is None or size is None:
        return "local fit unknown: free RAM or model weight size unavailable"
    if free_bytes < size + margin:
        return f"free RAM {free_bytes} bytes below model weights {size} + margin {margin} bytes"
    return None


class MLXAdapter:
    def __init__(self, model, *, clock=time.perf_counter):
        from mlx_lm import load, stream_generate
        self.clock, self.stream_generate = clock, stream_generate
        start = clock()
        self.model, self.tokenizer = load(str(model))
        self.load_s = clock() - start
        self.version = importlib.metadata.version("mlx-lm")

    def __call__(self, prompt, maximum):
        from bench_runner import chat_prompt
        formatted = chat_prompt(self.tokenizer, prompt)
        def events():
            for event in self.stream_generate(self.model, self.tokenizer, formatted, max_tokens=maximum):
                yield {"text": event.text, "usage": {"prompt_tokens": event.prompt_tokens,
                       "completion_tokens": event.generation_tokens}, "reasoning": None, "generated": event.generation_tokens > 0}
        result = measure_stream(events(), clock=self.clock)
        result.update(runtime="mlx_lm", engine_version=self.version, load_s=self.load_s)
        return result


def run_tasks(tasks, model, target, *, endpoint=None, machine=None, env=None, adapter=None,
              probe=None, free_probe=None, rss_probe=None, cache_dir=DEFAULT_CACHE, cache_pair=True):
    """Return one row per measurement. Inject adapters/probes for offline tests."""
    env = env or {}
    probe = probe or machine_probe
    free_probe = free_probe or free_ram_bytes
    rss_probe = rss_probe or peak_rss_bytes
    info = probe()
    info.update(cache_read_probe(cache_dir) if target == "omlx" else {})
    rows = []
    local = target in ("mlx", "omlx")
    base_url = endpoint if target == "endpoint" else env.get("OMLX_URL", DEFAULT_OMLX_URL)
    if target not in ("mlx", "omlx", "endpoint") or target == "endpoint" and not endpoint:
        raise ValueError("target requires mlx, omlx or endpoint with URL")
    version = engine_version_probe(base_url) if target == "omlx" and adapter is None else None
    active_bytes = active_weight_bytes(model) if local else None
    headers = {"authorization": "Bearer " + env["SPEED_ENDPOINT_TOKEN"]} if target == "endpoint" and env.get("SPEED_ENDPOINT_TOKEN") else {}
    for task in tasks:
        pair_uid = uuid.uuid4().hex
        # A distinct prefix per task avoids prefill warming decode first-use.
        prefix = f"Synthetic measurement {pair_uid}.\n"
        repeats = ("first-use-unconfirmed", "warm-repeat") if target == "omlx" and cache_pair else ("not_applicable",)
        prompt = prefix + task["prompt"] if len(repeats) == 2 else task["prompt"]
        for cache_state in repeats:
            available = free_probe()
            started = utcnow()
            reason = memory_guard(model, available) if local and adapter is None else None
            if reason:
                measured = {"fit": False, "reason": reason, "error": None, "usage": {}, "runtime": target}
            else:
                try:
                    if target == "mlx" and adapter is None:
                        adapter = MLXAdapter(model)
                    measured = adapter(prompt, task["max_tokens"]) if adapter else measure_endpoint(base_url, str(model) if target == "endpoint" else Path(model).name, prompt, task["max_tokens"], target=target, headers=headers)
                except Exception as exc:
                    measured = {"fit": None, "reason": None, "error": f"adapter failed ({type(exc).__name__})", "usage": {}, "runtime": target}
            if version and not measured.get("engine_version"):
                measured["engine_version"] = version
            measured["active_weight_bytes"] = active_bytes
            rate = measured.get("write_tok_s")
            measured["bandwidth_used_gbs"] = rate * active_bytes / 1e9 if rate and active_bytes else None
            rows.append({"uid": uuid.uuid4().hex, "suite": "speed", "machine": machine or bench.machine_id(env),
                         "model": str(model) if target == "endpoint" else Path(model).name, "target": target, "bank": speed_bank.bank_hash(),
                         **{key: task[key] for key in ("workload", "phase", "target_prompt_tokens", "max_tokens", "tokenizer")},
                         "task_id": task["id"], "started": started, "finished": utcnow(),
                         "cache_state": cache_state, "cache_pair_uid": pair_uid if len(repeats) == 2 else None,
                         "timing_basis": "client TTFT includes transport/queue; write interval ends at stream completion",
                         **measured, "probes": {**info, "free_ram_bytes": available, "free_ram_basis": "free pages only",
                                                 "peak_rss_bytes": rss_probe(), "rss_scope": "model-process" if target == "mlx" else "client",
                                                 "probe_scope": "client" if target == "endpoint" else "local-machine"}})
    return rows


def main(argv, A):
    """Caller owns scout.lock; results are written locally before any upload."""
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--target", choices=("mlx", "omlx", "endpoint"), default="omlx")
    ap.add_argument("--endpoint")
    ap.add_argument("--model", required=True)
    ap.add_argument("--machine", help="target machine identity; remote hardware probes remain client-scoped")
    ap.add_argument("--smoke", action="store_true", help="one 1k reading request, no cache pair")
    args = ap.parse_args(argv)
    if args.target == "endpoint" and not args.endpoint:
        ap.error("--endpoint is required for endpoint target")
    model = bench.resolve_model(A, args.model) if args.target in ("mlx", "omlx") else args.model
    tasks = speed_bank.load_bank()
    if args.smoke:
        tasks = [next(t for t in tasks if t["phase"] == "prefill" and t["target_prompt_tokens"] == 1000)]
    rows = run_tasks(tasks, model, args.target, endpoint=args.endpoint, env=A.ENV,
                     machine=args.machine or bench.machine_id(A.ENV), cache_pair=not args.smoke)
    destination = A.STATE_DIR / "bench" / "speed"
    destination.mkdir(parents=True, exist_ok=True)
    for row in rows:
        # Responses need not be retained for timing; avoid writing arbitrary data.
        row.pop("output", None)
        (destination / f"{row['uid']}.json").write_text(json.dumps(row, indent=2, allow_nan=False))
    return rows


if __name__ == "__main__":
    import agent as A
    A.STATE_DIR.mkdir(parents=True, exist_ok=True)
    with A.LOCK.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("another a1-scout run is active")
        main(sys.argv[1:], A)
