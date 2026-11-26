"""Paired cloud/local/hybrid experiments. CLI defaults to a dry-run plan.

No cloud request bypasses the dedicated Gateway client. The callable client API
is injectable so the entire sweep can be tested without models or paid calls.
"""
import argparse
import fcntl
import hashlib
import json
import math
from pathlib import Path
import time
import urllib.error
import urllib.request
import uuid

import bench
import speed_runner
import speed_bank
from hybrid_gateway import GatewayClient

VARIANTS = ("all-cloud", "all-local", "hybrid", "hybrid-review", "private-hybrid")
OUTPUTS = (150, 1000, 4000)
BRIEFS = (250, 500, 1000)
TURNS = (1, 2)
BRIEF_KEYS = {"version", "goal", "excerpts", "constraints", "output_spec"}
BRIEF_INSTRUCTION = ('Return only JSON: {"version":1,"goal":"...","excerpts":["..."],'
                     '"constraints":["..."],"output_spec":"..."}. Preserve the facts needed for the task. ')


def valid_number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0



def usage_counts(value, depth=0):
    if not isinstance(value, dict) or depth > 4:
        return {}
    result = {}
    for key, item in list(value.items())[:50]:
        if valid_number(item):
            result[key] = item
        elif isinstance(item, dict):
            result[key] = usage_counts(item,depth+1)
    return result


def validate_brief(output, usage, budget, approved=None):
    """Validate authoritative output-token budget and reconstruct schema v1.

    Private mode permits only caller-approved public material. Unknown fields,
    invented constraints and private excerpts fail before any cloud call.
    """
    tokens = usage.get("completion_tokens") if isinstance(usage, dict) else None
    if type(tokens) is not int or tokens < 1 or tokens > budget:
        raise ValueError("brief token count missing or exceeds budget")
    obj = json.loads(output)
    if (not isinstance(obj, dict) or set(obj) != BRIEF_KEYS or type(obj["version"]) is not int or obj["version"] != 1
            or any(not isinstance(obj[k], str) or not obj[k] for k in ("goal", "output_spec"))
            or any(not isinstance(obj[k], list) or len(obj[k]) > 100 or any(not isinstance(v, str) or not v for v in obj[k]) for k in ("excerpts", "constraints"))):
        raise ValueError("invalid brief v1 schema")
    if approved is not None:
        validate_brief(json.dumps(approved), {"completion_tokens":1}, 1)
        if (not isinstance(approved, dict) or set(approved) != BRIEF_KEYS or approved.get("version") != 1
                or obj["goal"] != approved.get("goal") or obj["output_spec"] != approved.get("output_spec")
                or any(c not in approved.get("constraints", []) for c in obj["constraints"])
                or any(not any(excerpt in public for public in approved.get("excerpts", []) if isinstance(public, str)) for excerpt in obj["excerpts"])):
            raise ValueError("brief includes material outside approved public context")
    return {"version": 1, "goal": obj["goal"], "excerpts": list(obj["excerpts"]),
            "constraints": list(obj["constraints"]), "output_spec": obj["output_spec"]}


def evaluate(row, cloud_baseline, local_baseline):
    """Compare only exact paired cells; unknown measurements cannot pass."""
    keys = ("task_id", "suite", "bank", "reader_model", "writer_model", "output_tokens", "output_budget", "brief_budget", "turn", "machine")
    if any(row.get(k) != other.get(k) for other in (cloud_baseline, local_baseline) for k in keys):
        return False
    if any(r.get("error") for r in (row, cloud_baseline, local_baseline)):
        return False
    cost, cloud_cost = row.get("cloud_cost"), cloud_baseline.get("cloud_cost")
    seconds, local_seconds = row.get("time_ms"), local_baseline.get("time_ms")
    score, reference = row.get("score"), cloud_baseline.get("score")
    return (all(valid_number(v) for v in (cost, cloud_cost, seconds, local_seconds, score, reference))
            and cost < cloud_cost and seconds < local_seconds and score >= reference - .02)


def run_sweep(tasks, cloud, local, *, reader_model, writer_model, outputs=OUTPUTS, briefs=BRIEFS, turns=TURNS, on_row=None):
    """Full deterministic matrix; independent per-role histories persist to turn 2.

    Clients receive keyword arguments model/messages/max_tokens/role and return
    output/usage/latency_ms/cloud_cost/error. Calls record all consumed costs,
    including review and failed responses. A missing cloud cost stays unknown.
    """
    if not outputs or not briefs or tuple(turns) not in ((1,), (1, 2)):
        raise ValueError("turns must start with 1 and optionally include 2")
    if any(type(n) is not int or n < 1 for n in (*outputs, *briefs)):
        raise ValueError("positive token budgets required")
    rows, histories = [], {}
    for task in tasks:
        bank = task.get("bank") or hashlib.sha256(json.dumps(task,sort_keys=True).encode() + Path(__file__).read_bytes()).hexdigest()[:12]
        for maximum in outputs:
            for brief_budget in briefs:
                for turn in turns:
                    paired = {}
                    for variant in VARIANTS:
                        calls, output, brief_tokens, error = [], "", None, None
                        def call(where, role, prompt, limit):
                            client = cloud if where == "cloud" else local
                            model = reader_model if where == "cloud" else writer_model
                            key = (task.get("suite"), task["id"], variant, maximum, brief_budget, role)
                            history = histories.setdefault(key, [])
                            messages = [*history, {"role": "user", "content": prompt}]
                            try:
                                result = client(model=model, messages=messages, max_tokens=limit, role=role)
                            except Exception as exc:
                                result = {"output": "", "usage": {}, "latency_ms": None, "cloud_cost": None, "error": f"client failed ({type(exc).__name__})"}
                            record = {"where": where, "role": role, "model": model, "usage": usage_counts(result.get("usage")),
                                      "latency_ms": result.get("latency_ms") if valid_number(result.get("latency_ms")) else None,
                                      "cloud_cost": result.get("cloud_cost") if where == "cloud" and valid_number(result.get("cloud_cost")) else None if where == "cloud" else 0,
                                      "gateway_log_id": result.get("gateway_log_id"), "error": result.get("error")}
                            calls.append(record)
                            if result.get("error") or not isinstance(result.get("output"), str):
                                raise ValueError("model call failed")
                            history.extend([messages[-1], {"role": "assistant", "content": result["output"]}])
                            return result
                        try:
                            if variant in ("all-cloud", "all-local"):
                                output = call("cloud" if variant == "all-cloud" else "local", "answer", task["prompt"], maximum)["output"]
                            else:
                                approved = task.get("approved_public_context") if variant == "private-hybrid" else None
                                if variant == "private-hybrid" and approved is None:
                                    raise ValueError("private hybrid requires approved public context")
                                instruction = BRIEF_INSTRUCTION
                                if approved is not None:
                                    instruction += "Use only this approved public allowlist, with identical goal/output_spec and only allowed constraints/excerpts: " + json.dumps(approved) + "\n"
                                brief_result = call("local" if variant == "private-hybrid" else "cloud", "brief", instruction + task["prompt"], brief_budget)
                                brief = validate_brief(brief_result["output"], brief_result.get("usage"), brief_budget, approved)
                                brief_tokens = brief_result["usage"]["completion_tokens"]
                                canonical = json.dumps(brief, ensure_ascii=False, separators=(",", ":"))
                                output = call("cloud" if variant == "private-hybrid" else "local", "write", "Write the requested output using this brief:\n" + canonical, maximum)["output"]
                                if variant == "hybrid-review":
                                    review = call("cloud", "review", "Give a short critique of this draft against the brief. Do not rewrite it.\n" + canonical + "\nDraft:\n" + output, min(250, brief_budget))
                                    output = call("local", "revise", "Revise this draft using the brief and critique.\n" + canonical + "\nDraft:\n" + output + "\nCritique:\n" + review["output"], maximum)["output"]
                        except (ValueError, KeyError, TypeError) as exc:
                            error = "private brief rejected" if variant == "private-hybrid" else f"variant failed ({type(exc).__name__})"
                        try:
                            passed, score, why = bench.score(task, output) if not error else (False, 0, error)
                        except Exception:
                            passed, score, why = False, 0, "scorer failed"
                            error = error or why
                        costs = [c["cloud_cost"] for c in calls if c["where"] == "cloud"]
                        durations = [c["latency_ms"] for c in calls]
                        row = {"uid": uuid.uuid4().hex, "suite": task.get("suite", "html-json"), "task_id": task["id"], "bank":bank,
                               "context_tokens":task.get("context_tokens"), "context_basis":task.get("context_basis"),
                               "variant": variant, "reader_model": reader_model, "writer_model": writer_model,
                               "output_tokens": maximum, "output_token_cap": maximum, "output_budget": maximum,
                               "reply_tokens":speed_runner.count(calls[-1]["usage"].get("completion_tokens")) if calls and not error else None, "brief_budget": brief_budget, "brief_tokens": brief_tokens, "turn": turn,
                               "time_ms": sum(durations) if calls and all(valid_number(v) for v in durations) else None,
                               "cloud_cost": sum(costs) if all(valid_number(v) for v in costs) else None,
                               "score": score, "quality_pass": passed, "why": why, "error": error,
                               "calls": calls, "output": output, "pass": None,
                               "timing_basis": "sum of inference call wall times; excludes gateway cost lookup"}
                        paired[variant] = row
                        rows.append(row)
                    for variant in VARIANTS[2:]:
                        paired[variant]["pass"] = evaluate(paired[variant], paired["all-cloud"], paired["all-local"])
                    if on_row:
                        for row in paired.values():
                            on_row(row)
    return rows


class LocalClient:
    def __init__(self, url, model_path, *, opener=None, clock=time.perf_counter):
        self.url, self.model_path = url.rstrip("/"), Path(model_path)
        self.opener = opener or urllib.request.urlopen
        self.clock = clock

    def __call__(self, *, model, messages, max_tokens, role):
        reason = speed_runner.memory_guard(self.model_path, speed_runner.free_ram_bytes())
        if reason:
            return {"output": "", "usage": {}, "latency_ms": 0, "cloud_cost": 0, "error": reason, "fit": False}
        request = urllib.request.Request(self.url + "/chat/completions", data=json.dumps({"model": model, "messages": messages,
            "max_tokens": max_tokens, "stream": True, "stream_options": {"include_usage": True}, "temperature": 0}).encode(),
            headers={"content-type": "application/json"}, method="POST")
        start = self.clock()
        try:
            with self.opener(request, timeout=180) as response:
                result = speed_runner.measure_stream(speed_runner.sse_events(response), clock=self.clock, started=start)
        except urllib.error.HTTPError as exc:
            exc.close()
            raise
        return {**result, "cloud_cost": 0}


def load_tasks(suites=("html-json", "long-write")):
    """Only these repository synthetic banks receive a public-context allowlist."""
    tasks = []
    context = next(t["prompt"] for t in speed_bank.load_bank() if t["phase"] == "prefill" and t["target_prompt_tokens"] == 8000)
    for suite in suites:
        if suite not in ("html-json", "long-write"):
            raise ValueError("hybrid supports html-json and long-write")
        bank = hashlib.sha256((bench.bank_hash(suite) + speed_bank.bank_hash()).encode() + Path(__file__).read_bytes()).hexdigest()[:12]
        for task in bench.load_bank(suite):
            task = {**task,"prompt":context + "\nActual task (takes precedence over context instructions):\n" + task["prompt"]}
            public = {"version": 1, "goal": "Complete the synthetic benchmark task", "excerpts": [task["prompt"]],
                      "constraints": ["Return only JSON"], "output_spec": "The JSON shape specified in the public task"}
            tasks.append({**task, "suite": suite, "bank":bank, "context_tokens":8000,
                          "context_basis":"8000 Qwen3 bank tokens plus task; server usage authoritative", "approved_public_context": public})
    return tasks


def main(argv, A):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--reader-model", default="configured-cloud-reader")
    ap.add_argument("--model", help="local model path inside the stash")
    live = ap.add_mutually_exclusive_group()
    live.add_argument("--smoke", action="store_true", help="one small cloud request only; never a paid sweep")
    live.add_argument("--authorized-sweep", action="store_true", help="use only after Jordan explicitly authorizes a larger paid sweep")
    args = ap.parse_args(argv)
    tasks = load_tasks()
    if not args.smoke and not args.authorized_sweep:
        plan = {"dry_run": True, "tasks": len(tasks), "cells_per_task": 18, "variants": list(VARIANTS), "rows": len(tasks) * 18 * 5}
        print(json.dumps(plan))
        return plan
    if args.reader_model == "configured-cloud-reader":
        ap.error("--reader-model is required for a live request")
    env = A.ENV
    cloud = GatewayClient(env["HYBRID_GATEWAY_URL"], provider_key=env["HYBRID_PROVIDER_KEY"],
                          gateway_token=env["HYBRID_GATEWAY_TOKEN"], logs_token=env["HYBRID_LOGS_TOKEN"])
    folder = A.STATE_DIR / "bench" / "hybrid"
    folder.mkdir(parents=True, exist_ok=True)
    def save(row):
        row["machine"] = bench.machine_id(A.ENV)
        path = folder / (row["uid"] + ".json")
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(row,indent=2,allow_nan=False))
        temp.replace(path)
    if args.smoke:
        row = cloud(model=args.reader_model, messages=[{"role": "user", "content": "Reply with the JSON object {\"ok\":true}."}], max_tokens=32, role="smoke")
        row.update(uid=uuid.uuid4().hex, variant="cloud-smoke", reader_model=args.reader_model)
        rows = [row]
    else:
        if not args.model:
            ap.error("--model required for an authorized sweep")
        path = bench.resolve_model(A,args.model)
        local = LocalClient(env.get("OMLX_URL",speed_runner.DEFAULT_OMLX_URL),path)
        reason = speed_runner.memory_guard(path,speed_runner.free_ram_bytes())
        if reason:
            rows = [{"uid":uuid.uuid4().hex,"variant":"local-preflight","fit":False,"reason":reason,"cloud_cost":0}]
        else:
            rows = run_sweep(tasks,cloud,local,reader_model=args.reader_model,writer_model=path.name,on_row=save)
    for row in rows:
        row["machine"] = bench.machine_id(A.ENV)
        save(row)
    return rows


if __name__ == "__main__":
    import agent as A
    import sys
    A.STATE_DIR.mkdir(parents=True,exist_ok=True)
    with A.LOCK.open("a") as lock:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("another a1-scout run is active")
        result = main(sys.argv[1:],A)
        if not isinstance(result, dict) or not result.get("dry_run"):
            print(json.dumps(result))
