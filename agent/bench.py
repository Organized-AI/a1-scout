"""A1 Bench: offline benchmarks for the models on the A1.

    agent.py bench <suite|all> [--fresh] [--model PATH]

With no --model the bench picks the model for you: it searches every model on the A1 that fits this Mac,
screens new ones on a few tasks, runs the finalists on the whole bank, reuses runs already measured on this
bank and Mac (unless --fresh), and posts the winner per suite (find_best, choose_best). --model measures one
named model and recommends nothing.

agent.py checks the A1 is mounted and takes scout.lock before calling main() here, so a bench never runs
beside a download. Each model runs in its own subprocess (bench_runner.py in the MLX venv), strictly one after
another: the model loads, answers every task, exits, and its memory is gone before the next one starts.
Scoring happens here, in plain Python, so it is the same for every runtime and testable without a model.

Banks: tests/bench/<suite>.jsonl, synthetic only. Caches (spoken audio, the SQLite sample, unsent rows) live in
~/.nvme-stash/bench/; nothing is written to the A1.
"""
import hashlib, json, math, os, re, sqlite3, statistics, subprocess, sys, threading, time, urllib.error, uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BANKS = ROOT / "tests" / "bench"
RUNNER = Path(__file__).resolve().parent / "bench_runner.py"
DECISION_RUNNER = Path(__file__).resolve().parent / "decision_runner.py"
QUALITY_SUITES = ["gtm-debug", "sql-ga4", "html-json", "rag-notes", "asr", "screen", "gtm-gate", "skill-select", "stape-select"]
SUITES = QUALITY_SUITES + ["speed", "long-write"]
DECISION_SUITES = {"gtm-gate", "skill-select", "stape-select"}           # typed questions to decision models (decision_runner.py), not chat prompts
TYPES = {"exact", "sql_result", "json_schema", "click_in_box", "decision"}
MAX_TOKENS = {"exact": 64, "sql_result": 320, "json_schema": 400, "click_in_box": 32, "decision": 0}
# Chat models only: embedders, rerankers, routers, decision heads, OCR and speech models answer other questions.
NOT_CHAT = re.compile(r"embed|rerank|router|guard|jev|laya|clef|docling|ocr|tts|kokoro|harness|whisper", re.I)


# ---------------------------------------------------------------- banks

def load_bank(suite, root=BANKS):
    if suite == "speed":
        import speed_bank
        return speed_bank.load_bank(root)
    if suite not in SUITES:
        raise ValueError(f"unknown suite {suite!r}; one of {', '.join(SUITES)}")
    tasks = []
    for n, line in enumerate((root / f"{suite}.jsonl").read_text().splitlines(), 1):
        if not line.strip():
            continue
        t = json.loads(line)
        if t.get("type") not in TYPES or not t.get("id") or not t.get("prompt"):
            raise ValueError(f"{suite}.jsonl line {n}: needs id, prompt and a type in {sorted(TYPES)}")
        tasks.append(t)
    return tasks


def bank_hash(suite, root=BANKS):
    """Short content hash: leaderboards compare runs of the same bank."""
    if suite == "speed":
        import speed_bank
        return speed_bank.bank_hash(root)
    h = hashlib.sha256((root / f"{suite}.jsonl").read_bytes())
    if suite == "sql-ga4":
        h.update((root / "fixtures" / "ga4_sample.sql").read_bytes())
    return h.hexdigest()[:12]


# ---------------------------------------------------------------- scorers

def strip_think(s):
    """Drop <think>…</think> blocks (Qwen3 and friends) and anything before a dangling </think>."""
    s = re.sub(r"<think>.*?</think>", "", s or "", flags=re.S)
    return s.split("</think>")[-1].strip()


def norm(s):
    s = re.sub(r"\s+", " ", str(s)).strip().lower()
    s = re.sub(r"^(final answer|answer)\s*[:\-]\s*", "", s)
    return s.strip(" \t\"'`*.,;:![]()<>")      # "[dedupe-purchase-tag.md]" echoes how the notes cite files


def words(s):
    return re.sub(r"[^\w\s%-]", " ", str(s).lower()).split()


def wer(hyp, ref):
    h, r = words(hyp), words(ref)
    if not r:
        return 0.0 if not h else 1.0
    prev = list(range(len(h) + 1))
    for i, rw in enumerate(r, 1):
        cur = [i] + [0] * len(h)
        for j, hw in enumerate(h, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rw != hw))
        prev = cur
    return prev[-1] / len(r)


def score_exact(task, output):
    out = strip_think(output)
    answers = task["answer"] if isinstance(task["answer"], list) else [task["answer"]]
    targets = {norm(a) for a in answers}
    w = min(wer(out, a) for a in answers)
    # A yes/no question answered both ways ("Yes.\nFinal answer: no") gets no credit, whichever way it ends.
    if targets <= {"yes", "no"} and {"yes", "no"} <= set(words(out)):
        return False, 0.0, "hedged: says both yes and no"
    lines = [ln for ln in out.splitlines() if ln.strip()]
    cands = {norm(out)}
    if lines:
        cands.add(norm(lines[-1]))                                  # the answer comes last
        cands |= {norm(ln) for ln in lines if re.match(r"\s*(final answer|answer)\s*[:\-]", ln, re.I)}
    if targets <= {"yes", "no"} and words(out):
        cands.add(norm(words(out)[0]))       # "No, because the trigger…" answers "no" (never both: checked above)
    # the same words as an accepted answer, whatever the punctuation around them, is that answer
    if cands & targets or w == 0:
        return True, 1.0, None
    if task.get("max_wer") is not None and w <= task["max_wer"]:
        return True, round(1 - w, 4), None
    return False, round(max(0.0, 1 - w), 4), f"wer {w:.2f}"


def extract_sql(output):
    out = strip_think(output)
    m = re.search(r"```(?:sql|sqlite)?\s*\n?(.*?)```", out, re.S | re.I)
    body = m.group(1) if m else out
    # unfenced: the query starts a line ("Here is a query to select purchases:\nSELECT …")
    m = re.search(r"^\s*(with|select)\b.*", body, re.S | re.I | re.M) or re.search(r"\b(with|select)\b.*", body, re.S | re.I)
    if not m:
        return None
    return m.group(0).split(";")[0].strip()


def sample_db(cache: Path):
    """The GA4-shaped sample as a SQLite file, rebuilt when the fixture changes."""
    src = BANKS / "fixtures" / "ga4_sample.sql"
    tag = hashlib.sha256(src.read_bytes()).hexdigest()[:12]
    db = cache / f"ga4_sample-{tag}.sqlite"
    if not db.exists():
        cache.mkdir(parents=True, exist_ok=True)
        tmp = db.with_suffix(".tmp")
        tmp.unlink(missing_ok=True)
        con = sqlite3.connect(tmp)
        con.executescript(src.read_text())
        con.commit(); con.close()
        tmp.rename(db)
    return db


def run_sql(db: Path, sql, seconds=3.0):
    """Read-only, single statement, time-boxed. Returns rows or raises."""
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    deadline = time.monotonic() + seconds
    con.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
    try:
        return con.execute(sql).fetchmany(5000)
    finally:
        con.close()


def _cell(v):
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        return round(float(v), 2)
    return v.strip() if isinstance(v, str) else v


def same_rows(got, gold, ordered):
    g = [tuple(_cell(c) for c in r) for r in got]
    w = [tuple(_cell(c) for c in r) for r in gold]
    return g == w if ordered else sorted(g, key=repr) == sorted(w, key=repr)


def score_sql(task, output, db):
    sql = extract_sql(output)
    if not sql:
        return False, 0.0, "no SQL found"
    try:
        got = run_sql(db, sql)
    except Exception as e:
        return False, 0.0, f"sql error: {e}"[:200]
    gold = run_sql(db, task["gold_sql"])
    if same_rows(got, gold, task.get("ordered", False)):
        return True, 1.0, None
    return False, 0.25, f"{len(got)} rows, expected {len(gold)}"


def extract_json(output):
    out = strip_think(output)
    m = re.search(r"```(?:json)?\s*\n?(.*?)```", out, re.S | re.I)
    if m:
        try:
            return json.loads(m.group(1))
        except ValueError:
            pass
    dec = json.JSONDecoder()
    for i, ch in enumerate(out):
        if ch in "{[":
            try:
                return dec.raw_decode(out[i:])[0]
            except ValueError:
                continue
    raise ValueError("no JSON found")


_PY = {"object": dict, "array": list, "string": str, "boolean": bool}


def _is(v, t):
    if t == "null":
        return v is None
    if t == "integer":
        return isinstance(v, int) and not isinstance(v, bool) or isinstance(v, float) and v.is_integer()
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    return isinstance(v, _PY[t])


def validate(schema, v, path="$"):
    """The JSON Schema subset the banks use: type, enum, const, required, properties, additionalProperties,
    items, min/maxItems, pattern, min/maxLength, minimum, maximum. Returns a list of errors."""
    errs = []
    if "const" in schema and v != schema["const"]:
        errs.append(f"{path}: expected {schema['const']!r}")
    if "enum" in schema and v not in schema["enum"]:
        errs.append(f"{path}: not one of {schema['enum']}")
    t = schema.get("type")
    if t and not any(_is(v, x) for x in (t if isinstance(t, list) else [t])):
        return errs + [f"{path}: expected {t}"]
    if isinstance(v, dict):
        for k in schema.get("required", []):
            if k not in v:
                errs.append(f"{path}.{k}: required")
        props = schema.get("properties", {})
        for k, sub in props.items():
            if k in v:
                errs += validate(sub, v[k], f"{path}.{k}")
        if schema.get("additionalProperties") is False:
            errs += [f"{path}.{k}: not allowed" for k in v if k not in props]
    if isinstance(v, list):
        if len(v) < schema.get("minItems", 0):
            errs.append(f"{path}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(v) > schema["maxItems"]:
            errs.append(f"{path}: more than {schema['maxItems']} items")
        if "items" in schema:
            for i, x in enumerate(v):
                errs += validate(schema["items"], x, f"{path}[{i}]")
    if isinstance(v, str):
        if "pattern" in schema and not re.search(schema["pattern"], v):
            errs.append(f"{path}: does not match {schema['pattern']}")
        if len(v) < schema.get("minLength", 0) or len(v) > schema.get("maxLength", math.inf):
            errs.append(f"{path}: length")
    if _is(v, "number"):
        if v < schema.get("minimum", -math.inf) or v > schema.get("maximum", math.inf):
            errs.append(f"{path}: out of range")
    return errs


def _get(obj, dotted):
    for k in dotted.split("."):
        if isinstance(obj, list) and k.isdigit() and int(k) < len(obj):
            obj = obj[int(k)]
        elif isinstance(obj, dict) and k in obj:
            obj = obj[k]
        else:
            return KeyError
    return obj


def _match(got, want):
    if isinstance(want, bool) or isinstance(got, bool):
        return got is want
    if isinstance(want, (int, float)):
        return isinstance(got, (int, float)) and abs(got - want) < 1e-6
    if isinstance(want, str):
        return isinstance(got, str) and got.strip().lower() == want.strip().lower()
    if isinstance(want, list):
        return isinstance(got, list) and len(got) == len(want) and all(_match(g, w) for g, w in zip(got, want))
    return got == want


def score_json(task, output):
    try:
        obj = extract_json(output)
    except ValueError:
        return False, 0.0, "no JSON found"
    errs = validate(task["schema"], obj)
    expect = task.get("expect") or {}
    hits = sum(1 for k, w in expect.items() if _match(_get(obj, k), w))
    score = ((0 if errs else 1) + hits) / (1 + len(expect))
    ok = not errs and hits == len(expect)
    why = None if ok else "; ".join(errs[:3] + [f"{len(expect) - hits} of {len(expect)} fields wrong"] * (hits < len(expect)))
    return ok, round(score, 4), why


def parse_click(output):
    out = strip_think(output)
    m = re.search(r"click\s*\(\s*(?:x\s*=\s*)?(-?\d+(?:\.\d+)?)\s*,\s*(?:y\s*=\s*)?(-?\d+(?:\.\d+)?)\s*\)", out, re.I) \
        or re.search(r"(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)", out)
    return (float(m.group(1)), float(m.group(2))) if m else None


def score_click(task, output):
    pt = parse_click(output)
    if not pt:
        return False, 0.0, "no click(x, y) found"
    (x, y), (x0, y0, x1, y1) = pt, task["box"]
    if x0 <= x <= x1 and y0 <= y <= y1:
        return True, 1.0, None
    d = math.hypot(max(x0 - x, 0, x - x1), max(y0 - y, 0, y - y1))
    return False, round(max(0.0, 0.5 * (1 - d / 200)), 4), f"{d:.0f}px outside"


def _gold_prob(q, ans, gold):
    """(top answer correct?, probability the model put on the gold answer) for one typed question."""
    if q["type"] == "noul":
        try:
            p = float(ans.get("noul", ans.get("probability", 0.5)))
        except (TypeError, ValueError):
            return False, 0.0
        return (p >= 0.5) == bool(gold), (p if gold else 1 - p)
    probs = ans.get("probabilities") or {}
    if isinstance(probs, list):
        probs = {str(i): v for i, v in enumerate(probs)}
    try:
        probs = {str(k): float(v) for k, v in probs.items()}
    except (TypeError, ValueError, AttributeError):
        return False, 0.0
    if not probs:
        return False, 0.0
    best = max(probs, key=probs.get)
    return best == str(gold), probs.get(str(gold), 0.0)


SELECT_PICK, SELECT_SHORTLIST, SELECT_TIE = 0.75, 0.40, 0.05   # jev-gateway /v1/select-skill decision rule


def select_decision(probs):
    """The gateway's decision from one yes/no probability per skill: ('selected', id), ('top3', [ids]) or ('none', [])."""
    ranked = sorted(probs.items(), key=lambda kv: -kv[1])
    if not ranked:
        return "none", []
    (top, p1), p2 = ranked[0], (ranked[1][1] if len(ranked) > 1 else 0.0)
    if p1 >= SELECT_PICK and not (p2 >= SELECT_PICK and p1 - p2 < SELECT_TIE):
        return "selected", top
    if p1 >= SELECT_SHORTLIST:
        return "top3", [k for k, v in ranked[:3] if v >= SELECT_SHORTLIST]
    return "none", []


def score_select(task, output):
    """Skill selection, scored the way the gateway acts on it. Right skill picked outright: 1. Right skill only in a top-3
    shortlist (three bodies loaded instead of one): 0.5. Wrong skill picked, or a skill picked when none fits: 0, the
    failure the gateway's targets rule out. No pick when none fits: 1."""
    try:
        answers = json.loads(output) if isinstance(output, str) else output
        answers = answers.get("answers", answers)
        probs = {k: float(v.get("noul", 0)) for k, v in answers.items() if isinstance(v, dict)}
    except (ValueError, AttributeError, TypeError):
        return False, 0.0, "answers were not JSON"
    kind, pick = select_decision(probs)
    gold = task["select_gold"]
    shown = f"{kind}: {pick}" if pick else kind
    if gold is None:
        return (True, 1.0, None) if kind == "none" else (False, 0.5 if kind == "top3" else 0.0, f"no skill fits, but {shown}")
    if kind == "selected":
        return (True, 1.0, None) if pick == gold else (False, 0.0, f"false select: {pick} (wanted {gold})")
    if kind == "top3" and gold in pick:
        return False, 0.5, f"shortlisted {pick}, not decided"
    return False, 0.0, f"{shown} (wanted {gold})"


def score_decision(task, output):
    """Every question's top answer must match the gold one to pass. The score is the mean probability put on the gold
    answers, so a confident right answer beats a hesitant one and a confident wrong answer costs the most."""
    try:
        answers = json.loads(output) if isinstance(output, str) else output
        answers = answers.get("answers", answers)
    except (ValueError, AttributeError):
        return False, 0.0, "answers were not JSON"
    if not isinstance(answers, dict):
        return False, 0.0, "answers were not an object"
    wrong, probs = [], []
    for qid, q in task["questions"].items():
        a = answers.get(qid)
        ok, p = _gold_prob(q, a if isinstance(a, dict) else {}, task["gold"][qid])
        probs.append(p)
        if not ok:
            wrong.append(f"{qid} ({p:.2f} on the right answer)")
    sc = round(sum(probs) / max(1, len(probs)), 4)
    return not wrong, sc, ("wrong: " + ", ".join(wrong)) if wrong else None


def score(task, output, db=None):
    """(pass, score 0..1, why) for one task."""
    t = task["type"]
    if t == "speed":
        raise ValueError("speed tasks measure timing and have no quality score")
    if t == "decision":
        return score_select(task, output) if "select_gold" in task else score_decision(task, output)
    if t == "exact":
        return score_exact(task, output)
    if t == "sql_result":
        return score_sql(task, output, db)
    if t == "json_schema":
        return score_json(task, output)
    return score_click(task, output)


# ---------------------------------------------------------------- machine and models

KNOWN_MACHINES = {("M1", 16): "m1", ("M4", 16): "m4", ("M6", 32): "m6", ("M5 Pro", 64): "m5p"}  # the Lab's ids


def machine_id(env=None, chip=None, mem=None):
    env = env or {}
    if env.get("BENCH_MACHINE"):
        return env["BENCH_MACHINE"]
    if chip is None and sys.platform.startswith("linux"):
        try:
            chip = Path("/proc/device-tree/model").read_text().strip("\x00").strip()
        except Exception:
            chip = os.uname().machine
        mem = int(re.search(r"MemTotal:\s+(\d+)", Path("/proc/meminfo").read_text()).group(1)) * 1024
    if chip is None:
        chip = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip()
        mem = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout.strip() or 0)
    name, gib = chip.replace("Apple ", "").strip(), round(mem / 2 ** 30)
    for (c, g), mid in KNOWN_MACHINES.items():
        # the Lab's "m1" is the M1 Pro 16 GB
        if gib == g and (name == c or (c == "M1" and name.startswith("M1"))):
            return mid
    pi = re.match(r"Raspberry Pi (\d+)", name)
    if pi:  # "Raspberry Pi 5 Model B Rev 1.1" -> pi5-16gb
        return f"pi{pi.group(1)}-{gib}gb"
    return re.sub(r"[^a-z0-9]+", "-", f"{name}-{gib}gb".lower()).strip("-")


def decision_family(d: Path):
    """clef / kev / kev-mlx for a decision model folder this bench can run, else None."""
    d = Path(d)
    if (d / "clef_mlx.py").exists() and (d / "joint_head.safetensors").exists():
        return "clef"
    if (d / "head.pt").exists():
        if (d / "config.json").exists() and any(d.glob("model*.safetensors")):
            return "kev-mlx"
        if (d / "adapter_config.json").exists():
            return "kev"
    return None


def kev_base(d: Path, stash: Path):
    """The stash folder holding a Kev adapter's base model, or None (then it can't run offline)."""
    try:
        name = json.loads((Path(d) / "adapter_config.json").read_text()).get("base_model_name_or_path", "").split("/")[-1]
    except Exception:
        return None
    return next((stash / r / name for r in ("models/hf", "models/mlx", "models") if name and (stash / r / name).is_dir()), None)


def model_kind(d: Path, suite):
    if suite in DECISION_SUITES:
        return decision_family(d) or "clef"
    if suite == "asr":
        return "asr"
    try:
        cfg = json.loads((d / "config.json").read_text())
    except Exception:
        cfg = {}
    return "vlm" if cfg.get("vision_config") or (d / "preprocessor_config.json").exists() else "llm"


def discover_models(A, suite, ram_bytes, limit=None):
    """Every MLX model on the A1 that suits the suite and fits in 75% of this Mac's memory, smallest first."""
    roots = [A.STASH / "models" / "mlx", A.STASH / "models"]
    found = []
    if suite in DECISION_SUITES:
        for root in [A.STASH / "models" / "mlx", A.STASH / "models" / "hf"]:
            if not root.is_dir():
                continue
            for d in sorted(root.iterdir()):
                if not d.is_dir() or d.name.startswith(".") or not A.inside_stash(d):
                    continue
                fam = decision_family(d)
                base = kev_base(d, A.STASH) if fam == "kev" else None
                if not fam or (fam == "kev" and not base):
                    continue
                size = A.walk_size(d)[0] + (2 * A.walk_size(base)[0] if base else 0)   # an adapter is merged into a copy of its base
                if size * 1.2 <= ram_bytes * 0.75:
                    found.append((size, Path(os.path.realpath(d))))
        return [d for _, d in sorted(found)][:limit]
    for root in roots:
        if not root.is_dir():
            continue
        for d in sorted(root.iterdir()):
            if not d.is_dir() or d.name.startswith(".") or d.name in ("mlx", "hf", "gguf") or not A.inside_stash(d):
                continue                                     # a symlink out of the stash is never loaded
            if not ((d / "config.json").exists() or any(d.glob("*.safetensors")) or any(d.glob("*.npz"))):
                continue
            typ, _, _ = A.describe_model(d, str(d.relative_to(A.STASH)))
            if suite == "asr":
                if typ != "asr":
                    continue
            elif typ not in ("llm", "llm-code", "vlm") or NOT_CHAT.search(d.name):
                continue
            size = A.walk_size(d)[0]
            if size * 1.2 <= ram_bytes * 0.75:
                found.append((size, Path(os.path.realpath(d))))
    return [d for _, d in sorted(found)][:limit]


def resolve_model(A, arg):
    """--model PATH: absolute, or relative to the stash. Must be a folder inside /Volumes/A1/stash."""
    p = Path(arg)
    if not p.is_absolute():
        p = A.STASH / p
    if not p.is_dir() or not A.inside_stash(p):
        raise SystemExit(f"--model must be a model folder inside {A.STASH}: {arg}")
    return Path(os.path.realpath(p))


# ---------------------------------------------------------------- running a model

def speak(text, cache: Path):
    """Synthetic speech for the asr suite: macOS `say` to 16 kHz mono WAV, cached by text."""
    cache.mkdir(parents=True, exist_ok=True)
    f = cache / f"say-{hashlib.sha1(text.encode()).hexdigest()[:12]}.wav"
    if not f.exists():
        r = subprocess.run(["say", "-o", str(f), "--data-format=LEI16@16000", text], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise RuntimeError(f"say failed: {r.stderr.strip()[:200]}")
    return f


def runner_tasks(tasks, cache: Path):
    out = []
    for t in tasks:
        rt = {"id": t["id"], "prompt": t["prompt"], "max_tokens": MAX_TOKENS[t["type"]]}
        if t.get("audio_text"):
            rt["audio"] = str(speak(t["audio_text"], cache / "audio"))
        if t["type"] == "decision":
            rt.update(state=t["state"], questions=t["questions"])
        out.append(rt)
    return out


def run_model(cmd, model: Path, kind, rtasks, timeout=1800):
    """Start one runner subprocess for one model and collect its results. Peak RSS comes from wait4 on that child."""
    got = {"load_s": None, "runtime": None, "results": {}, "mlx_peak": None, "error": None, "peak_rss": None}
    env = dict(os.environ, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1")   # no network during a run
    try:
        cmd = cmd(model) if callable(cmd) else cmd
        proc = subprocess.Popen([*cmd, "--model", str(model), "--kind", kind], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, env=env)
    except OSError as e:
        got["error"] = f"runner did not start: {e}"[:300]
        return got
    killer = threading.Timer(timeout, proc.kill)
    killer.start()
    err_tail = []
    t_err = threading.Thread(target=lambda: err_tail.extend(proc.stderr.read().splitlines()[-20:]), daemon=True)
    t_err.start()
    try:
        try:
            proc.stdin.write(json.dumps({"tasks": rtasks}))
            proc.stdin.close()
        except BrokenPipeError:
            pass                                 # the runner died early; its exit code and stderr say why
        for line in proc.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("event") == "loaded":
                got["load_s"], got["runtime"] = ev.get("load_s"), ev.get("runtime")
            elif ev.get("event") == "result":
                got["results"][ev["id"]] = ev
            elif ev.get("event") == "done":
                got["mlx_peak"] = ev.get("mlx_peak")
            elif ev.get("event") == "error":
                got["error"] = ev.get("error")
    finally:
        _, status, ru = os.wait4(proc.pid, 0)
        proc.returncode = os.waitstatus_to_exitcode(status)
        killer.cancel()
        t_err.join(timeout=5)
        proc.stdout.close(); proc.stderr.close()
    # ru_maxrss is bytes on macOS, kilobytes on Linux
    rss = ru.ru_maxrss if sys.platform == "darwin" else ru.ru_maxrss * 1024
    got["peak_rss"] = max(rss, got["mlx_peak"] or 0)
    if proc.returncode != 0 and not got["error"]:
        got["error"] = f"runner exited {proc.returncode}: " + " | ".join(err_tail[-3:])[:300]
    return got


def _median(xs):
    xs = [x for x in xs if isinstance(x, (int, float)) and math.isfinite(x)]
    return round(statistics.median(xs), 2) if xs else None


def run_tasks(suite, tasks, model: Path, runner_cmd, cache: Path, timeout=1800):
    """Load the model once, answer these tasks, score them. One runner process, exited before this returns."""
    db = sample_db(cache) if suite == "sql-ga4" else None
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    got = run_model(runner_cmd, model, model_kind(model, suite), runner_tasks(tasks, cache), timeout)
    results = []
    for t in tasks:
        r = got["results"].get(t["id"]) or {}
        out = r.get("output")
        ok, sc, why = score(t, out, db) if out is not None else (False, 0.0, r.get("error") or "no output")
        shown = t["prompt"] + (f"\n\nReference: {t['audio_text']}" if t.get("audio_text") else "")
        results.append({"id": t["id"], "pass": bool(ok), "score": sc, "why": why, "ttft_ms": r.get("ttft_ms"), "tok_s": r.get("tok_s"),
                        "latency_ms": r.get("latency_ms"), "output": (out or "")[:2000], "prompt": shown[:3000]})
    return {"started": started, "runtime": got["runtime"], "load_s": got["load_s"], "peak_rss": got["peak_rss"] or None,
            "error": got["error"], "results": results}


def make_row(suite, model: Path, stash: Path, machine, parts):
    """One leaderboard row from one or more run_tasks parts (a finalist's screen plus the rest of the bank)."""
    results = [r for part in parts for r in part["results"]]
    return {
        "uid": uuid.uuid4().hex, "suite": suite, "machine": machine, "model": model.name, "model_path": str(model.relative_to(stash)),
        "runtime": next((p["runtime"] for p in parts if p["runtime"]), None), "bank": bank_hash(suite), "started": parts[0]["started"],
        "finished": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "load_s": parts[0]["load_s"], "peak_rss": max((p["peak_rss"] or 0 for p in parts), default=0) or None,
        "ttft_ms": _median(r["ttft_ms"] for r in results), "tok_s": _median(r["tok_s"] for r in results),
        "passed": sum(r["pass"] for r in results), "total": len(results),
        "score": round(sum(r["score"] for r in results) / max(1, len(results)), 4),
        "error": next((p["error"] for p in parts if p["error"]), None), "results": results,
    }


def bench_model(suite, tasks, model: Path, stash: Path, machine, runner_cmd, cache: Path, timeout=1800):
    return make_row(suite, model, stash, machine, [run_tasks(suite, tasks, model, runner_cmd, cache, timeout)])


# ---------------------------------------------------------------- picking the best model

def screen_split(tasks, n):
    """A small, spread-out subset for the screening round (every k-th task, so each task kind shows up), and the rest."""
    if n <= 0 or n >= len(tasks):
        return tasks, []
    step = len(tasks) / n
    idx = {int(i * step) for i in range(n)}
    return [t for i, t in enumerate(tasks) if i in idx], [t for i, t in enumerate(tasks) if i not in idx]


def choose_best(rows, margin=0.05):
    """The model to recommend for a suite on this Mac, and why.

    Quality first: only models whose score is within `margin` of the top score are in the running.
    Among those, the fastest wins (higher tok/s, then lower peak memory), since a near-tie on quality
    is better spent on speed. Runs that errored never win."""
    ok = [r for r in rows if not r.get("error") and r.get("total")]
    if not ok:
        return None, "no model finished the suite"
    top = max(r["score"] for r in ok)
    close = [r for r in ok if r["score"] >= top - margin]
    best = max(close, key=lambda r: (r.get("tok_s") or 0, -(r.get("peak_rss") or 0)))
    if len(close) == 1:
        why = f"highest score ({best['score'] * 100:.0f})"
    else:
        others = ", ".join(r["model"] for r in close if r is not best)
        why = f"fastest of the models within {margin * 100:.0f} points of the top score (tied with {others})"
    return best, why


def known_runs(api, suite, machine, bank):
    """Full runs already on the leaderboard for this suite, Mac and task bank, keyed by model_path. Empty when offline."""
    try:
        lb = api(f"/api/bench/leaderboard?suite={suite}&machine={machine}")
    except Exception:
        return {}
    return {r["model_path"]: r for r in (lb or {}).get("rows", []) if r.get("bank") == bank and not r.get("error") and r.get("model_path")}


def find_best(suite, tasks, models, A, machine, runner_cmd, cache, env, fresh=False, queue=None, recommend=True):
    """Search the candidates for the best model on this suite, loading one model at a time.

    1. Models already measured on this bank and Mac are reused (unless fresh).
    2. If there are more new candidates than BENCH_FINALISTS, each answers a small screening subset first and
       only the top finalists go on to the rest of the bank (their two parts merge into one full run).
    3. choose_best() picks from every full run; the pick is posted as the recommendation."""
    timeout = int(env.get("BENCH_TIMEOUT_S", "1800"))
    finalists_n = int(env.get("BENCH_FINALISTS", "3"))
    bank = bank_hash(suite)
    known = {} if fresh else known_runs(A.api, suite, machine, bank)
    rel = lambda m: str(m.relative_to(A.STASH))
    todo = [m for m in models if rel(m) not in known]
    reused = [known[rel(m)] for m in models if rel(m) in known]
    full, screened_out = [], []

    def finish(m, parts):
        row = make_row(suite, m, A.STASH, machine, parts)
        posted = post_or_queue(row, A.api, queue, A.log)
        (cache / "runs").mkdir(parents=True, exist_ok=True)
        (cache / "runs" / f"{row['started'][:19].replace(':', '')}-{suite}-{m.name}.json").write_text(json.dumps(row, indent=1))
        A.log(f"bench {suite}: {m.name} {row['passed']}/{row['total']} score {row['score']:.2f} tok/s {row['tok_s']} ttft {row['ttft_ms']} ms "
              f"load {row['load_s']} s peak {(row['peak_rss'] or 0) / 1e9:.1f} GB{'' if posted else ' (queued)'}"
              + (f" error: {row['error']}" if row["error"] else ""))
        full.append(row)

    def step(m, phase, ts):
        A.log(f"bench {suite}: {phase} {m.name} ({len(ts)} tasks)")
        A.activity(force=True, state="running", trigger="bench", phase=f"{phase.capitalize()}: {m.name} on {suite}", current=None)
        return run_tasks(suite, ts, m, runner_cmd, cache, timeout)

    screen, rest = screen_split(tasks, int(env.get("BENCH_SCREEN_TASKS", "4")))
    if len(todo) <= finalists_n or not rest:
        for m in todo:                                   # few enough to run everything in full
            finish(m, [step(m, "benchmarking", tasks)])
    else:
        first = []
        for m in todo:                                   # round 1: every new candidate, small subset
            part = step(m, "screening", screen)
            sc = sum(r["score"] for r in part["results"]) / max(1, len(part["results"]))
            tps = _median(r["tok_s"] for r in part["results"]) or 0
            first.append((-(sc if not part["error"] else -1), -tps, m.name, m, part))
        first.sort(key=lambda x: x[:3])
        for _, _, _, m, part in first[:finalists_n]:      # round 2: finalists answer the rest of the bank
            finish(m, [part, step(m, "finals", rest)])
        for neg, _, _, m, part in first[finalists_n:]:
            screened_out.append({"model": m.name, "model_path": rel(m), "screen_score": round(-neg, 4) if neg <= 0 else None,
                                 "screen_tasks": len(screen), "error": part["error"]})
    best, why = choose_best(full + reused)
    pick = None
    if best and recommend:
        pick = {"suite": suite, "machine": machine, "model": best["model"], "model_path": best["model_path"], "score": best["score"],
                "tok_s": best.get("tok_s"), "peak_rss": best.get("peak_rss"), "passed": best.get("passed"), "total": best.get("total"),
                "why": why, "bank": bank, "considered": len(models), "ran": len(full), "reused": len(reused),
                "screened_out": screened_out}
        try:
            A.api("/api/bench/best", "POST", pick)
        except Exception as e:
            A.log(f"bench {suite}: pick not sent ({type(e).__name__}); it is in the local log")
        A.log(f"bench {suite}: BEST on {machine}: {best['model']} score {best['score']:.2f}, {best.get('tok_s')} tok/s ({why}); "
              f"{len(models)} considered, {len(full)} run in full, {len(reused)} reused, {len(screened_out)} screened out")
    return pick, full


# ---------------------------------------------------------------- posting

def _post(row, api):
    """'sent', 'retry' (network down or server error: keep it) or 'rejected' (4xx: retrying won't help).
    Rows carry a uid, so a post that landed but timed out is ignored by the Worker when it's sent again."""
    try:
        api("/api/bench/runs", "POST", row)
        return "sent"
    except urllib.error.HTTPError as e:
        return "retry" if e.code >= 500 else "rejected"
    except (urllib.error.URLError, OSError, TimeoutError):
        return "retry"


def post_or_queue(row, api, queue: Path, log=print):
    r = _post(row, api)
    if r == "retry":
        queue.parent.mkdir(parents=True, exist_ok=True)
        with queue.open("a") as f:
            f.write(json.dumps(row) + "\n")
    elif r == "rejected":
        log(f"bench: the Worker rejected the {row['suite']} run for {row['model']}; kept in ~/.nvme-stash/bench/runs only")
    return r == "sent"


def flush_queue(api, queue: Path):
    """Post rows left over from an offline bench. Rows that still can't be sent stay queued; rejected ones are dropped."""
    if not queue.exists():
        return 0
    left, sent = [], 0
    for line in queue.read_text().splitlines():
        if not line.strip():
            continue
        r = _post(json.loads(line), api)
        if r == "sent":
            sent += 1
        elif r == "retry":
            left.append(line)
    if left:
        queue.write_text("\n".join(left) + "\n")
    else:
        queue.unlink()
    return sent


# ---------------------------------------------------------------- entry point

def parse_args(argv):
    suite, model, fresh = None, None, False
    it = iter(argv)
    for a in it:
        if a == "--model":
            model = next(it, None)
        elif a.startswith("--model="):
            model = a.split("=", 1)[1]
        elif a == "--fresh":
            fresh = True
        elif suite is None:
            suite = a
    if suite not in SUITES + ["all"]:
        raise SystemExit(f"usage: agent.py bench <{'|'.join(SUITES)}|all> [--fresh] [--model PATH]\n"
                         "  with no --model the bench searches every model on the A1 that fits this Mac and picks the best")
    return suite, model, fresh


def main(argv, A, runner_cmd=None, ram_bytes=None):
    """Called by agent.py with the A1 mounted and scout.lock held."""
    suite, model_arg, fresh = parse_args(argv)
    if suite in ("speed", "long-write"):
        raise SystemExit("Speed/long-write banks use the Speed Lab/hybrid runners rather than the quality runner")
    env = A.ENV
    cache = A.STATE_DIR / "bench"
    queue = cache / "pending.jsonl"
    # Text models run in the offline MLX venv (mlx_lm, mlx_vlm). Whisper in the mlx-examples layout (weights.safetensors /
    # weights.npz) runs where mlx_whisper is (the agent's Python); mlx-audio-converted Whisper runs in the offline venv,
    # which has mlx_audio.
    text_py = env.get("BENCH_PYTHON") or str(Path.home() / ".nvme-stash/offline-test/bin/python")
    asr_py = env.get("BENCH_PYTHON_ASR") or sys.executable
    def asr_cmd(model: Path):
        mlx_whisper_layout = (Path(model) / "weights.safetensors").exists() or (Path(model) / "weights.npz").exists()
        return [asr_py if mlx_whisper_layout else text_py, str(RUNNER)]
    venvs = Path.home() / ".nvme-stash" / "venvs"
    def decision_cmd(model: Path):
        fam = decision_family(model) or "clef"
        py = env.get(f"BENCH_PYTHON_{fam.upper().replace('-', '_')}") or str(venvs / ("clef" if fam == "clef" else "kev") / "bin" / "python")
        return [py, str(DECISION_RUNNER)]
    runners = {"text": runner_cmd or [text_py, str(RUNNER)], "asr": runner_cmd or asr_cmd, "decision": runner_cmd or decision_cmd}
    if ram_bytes is None:
        ram_bytes = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout.strip() or 16 * 2 ** 30)
    machine = machine_id(env)
    sent = flush_queue(A.api, queue)
    if sent:
        A.log(f"bench: posted {sent} queued run(s)")
    rows, picks = [], []
    for s in (QUALITY_SUITES if suite == "all" else [suite]):
        tasks = load_bank(s)
        cmd = runners["asr" if s == "asr" else "decision" if s in DECISION_SUITES else "text"]
        if model_arg:                # one named model, full bank, no pick
            m = resolve_model(A, model_arg)
            find = lambda: find_best(s, tasks, [m], A, machine, cmd, cache, env, fresh=True, queue=queue, recommend=False)
        else:
            models = discover_models(A, s, ram_bytes, int(env["BENCH_MAX_MODELS"]) if env.get("BENCH_MAX_MODELS") else None)
            if not models:
                A.log(f"bench {s}: no suitable model on the A1")
                continue
            A.log(f"bench {s}: searching {len(models)} model(s) that fit {machine}: {', '.join(m.name for m in models)}")
            find = lambda: find_best(s, tasks, models, A, machine, cmd, cache, env, fresh=fresh, queue=queue)
        pick, full = find()
        rows += full
        if pick and not model_arg:
            picks.append(pick)
    summary = " · ".join(f"{p['suite']}: {p['model']}" for p in picks) or f"{len(rows)} run(s)"
    A.activity(force=True, state="idle", phase="Finished", trigger="bench", current=None, summary=f"Best models: {summary}")
    if picks:
        A.notify("A1 Bench", f"Best on this Mac · {summary}")
    return rows
