#!/usr/bin/env python3
"""a1-scout Mac agent.

Fires when any volume mounts (launchd StartOnMount) and once a week on a timer.
When the A1 drive (matched by volume UUID, not just name) is present it:
  1. sends the Organized-AI repo list and the stash inventory to the scout Worker,
  2. checks every stashed Hub item for a newer revision and downloads real updates beside the old copy
     (the old copy moves to stash/versions/<path>@<old sha>; nothing is overwritten or deleted),
  3. looks for newer releases in the same model families (Qwen3.8 -> Qwen3.9, same size and quant),
  4. runs a Hub scan for new complementary picks (on every mount; at most once an hour),
  5. downloads approved picks into /Volumes/A1/stash (never deletes, never writes outside it),
  6. rebuilds the drive catalog behind the map view, and
  7. shows a macOS notification with what changed.
When the A1 is not present on the weekly timer, it only reminds you to plug it in.

Usage: agent.py [mount|weekly|now|catalog|status|heartbeat|updates [--dry-run]|bench <suite|all> [--model PATH]]
`bench` runs the A1 Bench task banks (tests/bench) against stash models, one model at a time (see bench.py).
"""
import fcntl, fnmatch, hashlib, json, os, re, shutil, subprocess, sys, threading, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
STATE_DIR = HOME / ".nvme-stash"
ENV_FILE = STATE_DIR / "scout.env"
LOG = STATE_DIR / "scout.log"
STATE = STATE_DIR / "scout-state.json"
LOCK = STATE_DIR / "scout.lock"
PATH_EXTRA = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"


def load_env():
    env = {}
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"')
    env.setdefault("A1_MOUNT", "/Volumes/A1")
    env.setdefault("RUN_CAP_GB", "60")
    env.setdefault("FREE_FLOOR_GB", "150")
    env.setdefault("ORG", "Organized-AI")
    env.setdefault("AUTO_UPDATES", "on")        # download newer revisions of stashed items
    env.setdefault("AUTO_SUCCESSORS", "on")     # auto-approve like-for-like newer releases (same family, size, quant)
    env.setdefault("SCAN_MIN_HOURS", "1")       # scan on every mount, but not twice within this many hours
    env.setdefault("SETTLE_HOURS", "24")        # don't start an update until the repo has been quiet this long (mid-upload repos churn)
    return env


ENV = load_env()
MOUNT = Path(ENV["A1_MOUNT"])
STASH = MOUNT / "stash"


def log(msg):
    line = f"{datetime.now().isoformat(timespec='seconds')} {msg}"
    print(line)
    with LOG.open("a") as f:
        f.write(line + "\n")


def sh(args, timeout=None, **kw):
    e = dict(os.environ, PATH=PATH_EXTRA + ":" + os.environ.get("PATH", ""))
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=e, **kw)


def notify(title, text):
    t = text.replace('"', "'")[:240]
    sh(["osascript", "-e", f'display notification "{t}" with title "{title}" sound name "Glass"'])


def api(path, method="GET", body=None, raw=False):
    data = None if body is None else (body if raw else json.dumps(body)).encode()
    req = urllib.request.Request(ENV["SCOUT_URL"].rstrip("/") + path, data=data, method=method, headers={
        "authorization": f"Bearer {ENV['SCOUT_TOKEN']}", "content-type": "application/json", "user-agent": "a1-scout-agent"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read() or b"{}")


def hf_headers():
    h = {"user-agent": "a1-scout-agent"}
    tok = os.environ.get("HF_TOKEN")
    if not tok:
        try:
            tok = (HOME / ".cache/huggingface/token").read_text().strip()
        except OSError:
            tok = None
    if tok:
        h["authorization"] = f"Bearer {tok}"  # lets gated repos you've accepted show their files
    return h


def hub_raw(url):
    req = urllib.request.Request(url, headers=hf_headers())
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read()), r.headers.get("Link")


def hub(path):
    return hub_raw("https://huggingface.co/api" + path)[0]


def hub_tree(kind, repo, rev):
    """{path: (content id, size)} for every file at a revision. LFS files use their sha256, so unchanged weights compare equal."""
    url = f"https://huggingface.co/api/{kind}s/{repo}/tree/{rev}?recursive=true"
    files = {}
    while url:
        data, link = hub_raw(url)
        for e in data:
            if e.get("type") == "file":
                files[e["path"]] = ((e.get("lfs") or {}).get("oid") or e.get("oid"), e.get("size") or 0)
        m = re.search(r'<([^>]+)>;\s*rel="next"', link or "")
        url = m.group(1) if m else None
    return files


def load_state():
    try:
        return json.loads(STATE.read_text())
    except Exception:
        return {}


def save_state(s):
    STATE.write_text(json.dumps(s, indent=2))


def a1_present():
    """True only for the real A1: mounted at the expected path with the expected volume UUID."""
    if not MOUNT.is_dir():
        return False
    out = sh(["diskutil", "info", str(MOUNT)]).stdout
    m = re.search(r"Volume UUID:\s+([0-9A-F-]+)", out)
    return bool(m and m.group(1) == ENV["A1_UUID"] and STASH.is_dir())


def free_bytes():
    return shutil.disk_usage(MOUNT).free


def inside_stash(p: Path):
    rp = os.path.realpath(p)
    return rp.startswith(os.path.realpath(STASH) + os.sep)


# ---------------------------------------------------------------- catalog

def walk_size(p: Path):
    total = files = 0
    if p.is_file():
        return p.stat().st_size, 1
    for root, dirs, fs in os.walk(p):
        dirs[:] = [d for d in dirs if d not in (".git",)]
        for f in fs:
            if f.startswith("._"):
                continue
            try:
                total += os.lstat(os.path.join(root, f)).st_size
                files += 1
            except OSError:
                pass
    return total, files


def front_matter(readme: Path):
    """Pull the simple key: value pairs (and short lists) out of a Hub README's YAML header."""
    out = {}
    try:
        txt = readme.read_text(errors="ignore")
    except OSError:
        return out, ""
    m = re.match(r"^---\n(.*?)\n---\n?(.*)", txt, re.S)
    body = txt
    if m:
        body = m.group(2)
        key = None
        for line in m.group(1).splitlines():
            kv = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
            if kv:
                key, val = kv.group(1), kv.group(2).strip().strip("'\"")
                out[key] = val if val else []
            elif key and re.match(r"^\s*-\s+", line) and isinstance(out.get(key), list):
                out[key].append(line.split("-", 1)[1].strip().strip("'\""))
    para = ""
    for block in re.split(r"\n\s*\n", body):
        b = re.sub(r"<[^>]+>|!\[.*?\]\(.*?\)|\[([^\]]*)\]\([^)]*\)", r"\1", block).strip()
        if b and not b.startswith(("#", "|", "```", "---")) and len(b) > 40:
            para = re.sub(r"\s+", " ", b)[:320]
            break
    return out, para


def provenance():
    """Map stash-relative target paths to {repo, revision} from the existing fetch reports and pins."""
    prov = {}
    man = STASH / "manifests"
    for f in sorted(man.glob("hf_report*.json")):
        try:
            for repo, v in json.loads(f.read_text()).items():
                if isinstance(v, dict) and v.get("target"):
                    prov[v["target"].strip("/")] = {"repo": repo, "revision": v.get("revision")}
        except Exception:
            pass
    for f in (man / "pins.json", man / "scout-pins.json"):
        try:
            for p in json.loads(f.read_text()):
                tgt = p.get("path")
                key = (tgt or ("models/mlx/" if p.get("type") == "model" else "datasets/raw/") + p["repo"].split("/")[-1]).strip("/")
                rec = {"repo": p["repo"], "revision": p.get("revision"), "title": p.get("title"), "include": p.get("include")}
                if f.name == "scout-pins.json":
                    prov[key] = {**prov.get(key, {}), **{k: v for k, v in rec.items() if v}}  # newest entry wins
                else:
                    prov.setdefault(key, rec)
        except Exception:
            pass
    return prov


def model_type_of(name, cfg, d: Path):
    n = name.lower()
    if any(d.glob("*.gguf")):
        return "gguf"
    if "embedding" in n:
        return "embedding"
    if "rerank" in n:
        return "reranker"
    if "whisper" in n or cfg.get("model_type") == "whisper":
        return "asr"
    if "tts" in n or "kokoro" in n or "voice" in n:
        return "tts"
    if cfg.get("vision_config") or (d / "preprocessor_config.json").exists():
        return "vlm"
    if "coder" in n:
        return "llm-code"
    return "llm"


def describe_model(d: Path, rel):
    cfg = {}
    try:
        cfg = json.loads((d / "config.json").read_text())
    except Exception:
        pass
    fm, para = front_matter(d / "README.md")
    tc = cfg.get("text_config") or {}
    q = cfg.get("quantization") or cfg.get("quantization_config") or {}
    ctx = cfg.get("max_position_embeddings") or tc.get("max_position_embeddings")
    meta = {
        "architecture": (cfg.get("architectures") or [None])[0], "model_type": cfg.get("model_type"),
        "bits": q.get("bits"), "group_size": q.get("group_size"), "context_tokens": ctx,
        "layers": cfg.get("num_hidden_layers") or tc.get("num_hidden_layers"),
        "hidden_size": cfg.get("hidden_size") or tc.get("hidden_size"), "vocab": cfg.get("vocab_size") or tc.get("vocab_size"),
        "license": fm.get("license"), "base_model": fm.get("base_model"), "pipeline": fm.get("pipeline_tag"),
        "library": fm.get("library_name"), "verified": (d / ".verified").exists(),
        "gguf_files": [f.name for f in d.glob("*.gguf")][:6],
    }
    return model_type_of(d.name, cfg, d), {k: v for k, v in meta.items() if v not in (None, [], "")}, para


def describe_dataset(d: Path):
    fm, para = front_matter(d / "README.md")
    exts = {}
    for root, _, fs in os.walk(d):
        for f in fs:
            if f.startswith("._") or "." not in f:
                continue
            e = f.rsplit(".", 1)[1].lower()
            if e in ("parquet", "jsonl", "json", "arrow", "csv", "tsv", "txt", "zst", "gz"):
                exts[e] = exts.get(e, 0) + 1
    meta = {"formats": exts, "license": fm.get("license"), "tasks": fm.get("task_categories"),
            "size_category": fm.get("size_categories"), "pretty_name": fm.get("pretty_name")}
    return {k: v for k, v in meta.items() if v not in (None, [], "", {})}, para


def item(name, rel, typ, d, meta=None, summary="", group=None, prov=None):
    size, files = walk_size(d)
    it = {"name": name, "path": rel, "type": typ, "bytes": size, "files": files, "meta": meta or {}, "summary": summary}
    if group:
        it["group"] = group
    p = (prov or {}).get(rel.strip("/"))
    if p:
        it["source"] = p
    return it


def build_catalog():
    prov = provenance()
    cats = []

    def cat(cid, label, items):
        items = [i for i in items if i]
        cats.append({"id": cid, "label": label, "path": cid, "bytes": sum(i["bytes"] for i in items), "items": sorted(items, key=lambda i: -i["bytes"])})

    # Models: loose model folders plus the mlx/ gguf/ hf/ groups.
    models = []
    mroot = STASH / "models"
    for d in sorted(p for p in mroot.iterdir() if p.is_dir() and not p.name.startswith(".")) if mroot.is_dir() else []:
        if (d / "config.json").exists() or any(d.glob("*.gguf")) or any(d.glob("*.safetensors")):
            typ, meta, para = describe_model(d, f"models/{d.name}")
            models.append(item(d.name, f"models/{d.name}", typ, d, meta, para, "models", prov))
        else:
            for m in sorted(p for p in d.iterdir() if p.is_dir() and not p.name.startswith(".")):
                typ, meta, para = describe_model(m, f"models/{d.name}/{m.name}")
                models.append(item(m.name, f"models/{d.name}/{m.name}", typ, m, meta, para, d.name, prov))
    cat("models", "Models", models)

    ds = []
    droot = STASH / "datasets"
    for g in sorted(p for p in droot.iterdir() if p.is_dir()) if droot.is_dir() else []:
        for d in sorted(p for p in g.iterdir() if p.is_dir() and not p.name.startswith(".")):
            meta, para = describe_dataset(d)
            typ = "dataset-analytics" if "ga4" in (g.name + d.name).lower() else "dataset"
            ds.append(item(d.name, f"datasets/{g.name}/{d.name}", typ, d, meta, para, g.name, prov))
    cat("datasets", "Datasets", ds)

    sp = []
    for d in sorted(x for x in (STASH / "spaces").glob("*/") if not x.name.startswith(".")) if (STASH / "spaces").is_dir() else []:
        fm, para = front_matter(d / "README.md")
        sp.append(item(d.name, f"spaces/{d.name}", "space", d, {k: fm.get(k) for k in ("sdk", "title", "license", "app_file") if fm.get(k)}, para, None, prov))
    cat("spaces", "Spaces (apps)", sp)

    code = []
    croot = STASH / "code"
    for d in sorted(p for p in croot.iterdir() if p.is_dir() and not p.name.startswith(".")) if croot.is_dir() else []:
        commit = (croot / f"{d.name}.commit").read_text().strip() if (croot / f"{d.name}.commit").exists() else None
        lang = next((l for f, l in (("pyproject.toml", "Python"), ("setup.py", "Python"), ("package.json", "JavaScript/TypeScript"),
                                    ("go.mod", "Go"), ("CMakeLists.txt", "C/C++"), ("Cargo.toml", "Rust")) if (d / f).exists()), None)
        _, para = front_matter(d / "README.md")
        code.append(item(d.name, f"code/{d.name}", "code-repo", d, {k: v for k, v in {"commit": commit, "language": lang}.items() if v}, para))
    for f in sorted(x for x in croot.glob("*.md") if not x.name.startswith(".")) if croot.is_dir() else []:
        code.append(item(f.stem, f"code/{f.name}", "doc", f, {}, ""))
    cat("code", "Source code", code)

    papers = []
    for f in sorted(x for x in (STASH / "papers").glob("*.pdf") if not x.name.startswith(".")) if (STASH / "papers").is_dir() else []:
        p = prov.get(f"papers/{f.name}") or {}
        papers.append(item(f.stem, f"papers/{f.name}", "paper", f, {"arxiv": f.stem, "title": p.get("title")} if p.get("title") else {"arxiv": f.stem}, ""))
    cat("papers", "Papers", papers)

    runs = []
    for d in sorted(x for x in (STASH / "runs").glob("*/") if not x.name.startswith(".")) if (STASH / "runs").is_dir() else []:
        adapters = []
        for a in sorted(d.glob("adapters*")):
            try:
                ac = json.loads((a / "adapter_config.json").read_text())
                adapters.append({"name": a.name, "base": ac.get("model"), "rank": (ac.get("lora_parameters") or {}).get("rank"), "layers": ac.get("num_layers"), "iters": ac.get("iters")})
            except Exception:
                adapters.append({"name": a.name})
        runs.append(item(d.name, f"runs/{d.name}", "lora-run", d, {"adapters": adapters}, ""))
    cat("runs", "Fine-tuning runs", runs)

    wheels = []
    for d in sorted(x for x in (STASH / "wheels").glob("*/") if not x.name.startswith(".")) if (STASH / "wheels").is_dir() else []:
        whl = [f.name for f in d.glob("*.whl") if not f.name.startswith(".")]
        pys = sorted({m.group(1) for w in whl for m in [re.search(r"-(cp\d+)-", w)] if m})
        pkgs = sorted({w.split("-")[0].lower() for w in whl})
        wheels.append(item(d.name, f"wheels/{d.name}", "wheels", d, {"wheels": len(whl), "python": pys,
                           "highlights": [p for p in pkgs if p in ("mlx", "mlx_lm", "mlx_vlm", "mlx_audio", "mlx_embeddings", "datasets", "duckdb", "huggingface_hub", "mlx_lm_lora", "google_cloud_bigquery", "fastapi", "llguidance")]}, ""))
    cat("wheels", "Offline Python wheels", wheels)

    corp = []
    for d in sorted(p for p in (STASH / "corpora").glob("*/*") if not p.name.startswith(".") and (p.is_dir() or p.suffix == ".md")):
        corp.append(item(d.name, f"corpora/{d.parent.name}/{d.name}", "private-corpus", d, {}, ""))  # names and sizes only
    cat("corpora", "Your own corpora (private)", corp)

    vers = []
    vroot = STASH / "versions"
    for root, dirs, _ in os.walk(vroot) if vroot.is_dir() else []:
        for d in [x for x in dirs if "@" in x and not x.startswith(".")]:
            full = Path(root) / d
            rel = str(full.relative_to(STASH))
            vers.append(item(d, rel, "folder", full, {"replaced_by": str(full.relative_to(vroot)).rsplit("@", 1)[0]},
                             "Previous version, kept when a newer revision was downloaded.", full.relative_to(vroot).parts[0]))
        dirs[:] = [x for x in dirs if "@" not in x]
    cat("versions", "Previous versions", vers)

    misc = []
    if (STASH / "manifests").is_dir():
        misc.append(item("manifests", "manifests", "manifests", STASH / "manifests", {}, ""))
    scripts = [f for f in list((STASH / "scripts").glob("*.py")) + list(STASH.glob("*.py")) if not f.name.startswith(".")]
    for f in scripts:
        misc.append(item(f.name, str(f.relative_to(STASH)), "script", f, {}, ""))
    cat("tooling", "Manifests & scripts", misc)

    known = {"models", "datasets", "spaces", "code", "papers", "runs", "wheels", "corpora", "manifests", "scripts", "versions"}
    other = [p for p in STASH.iterdir() if p.is_dir() and p.name not in known and not p.name.startswith(".")]
    if other:
        cat("other", "Other", [item(p.name, p.name, "folder", p, {}, "") for p in other])

    cats = [c for c in cats if c["items"]]
    usage = shutil.disk_usage(MOUNT)
    stash_bytes = sum(c["bytes"] for c in cats)
    venvs = sorted(p.name for p in (STATE_DIR / "venvs").glob("*/")) if (STATE_DIR / "venvs").is_dir() else []
    return {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "machine": os.uname().nodename,
        "drive": {"total": usage.total, "free": usage.free, "stash": stash_bytes, "outside_stash": max(0, usage.used - stash_bytes)},
        "mount": str(MOUNT), "stash_root": str(STASH), "venvs": venvs, "categories": cats,
        "ram_bytes": int((sh(["sysctl", "-n", "hw.memsize"]).stdout or "0").strip() or 0),
    }


def inventory_from(catalog):
    inv = set()
    for c in catalog["categories"]:
        for i in c["items"]:
            inv.add(i["name"])
            if i.get("source", {}).get("repo"):
                inv.add(i["source"]["repo"])
    return sorted(inv)


# ---------------------------------------------------------------- downloads

def include_of(p):
    """Globs limiting a pick to part of its repo (hf download --include); empty means the whole repo."""
    inc = (p.get("extra") or {}).get("include") or p.get("include") or []
    return [g for g in inc if isinstance(g, str) and g and ".." not in g]


def dest_for(p):
    name = p["repo"].split("/")[-1]
    if p["kind"] == "model":
        if "gguf" in name.lower():
            return STASH / "models/gguf" / name
        mlx = p["repo"].startswith("mlx-community/") or "runs on MLX" in p.get("reasons", [])
        return STASH / ("models/mlx" if mlx else "models/hf") / name
    if p["kind"] == "dataset":
        return STASH / "datasets/raw" / name
    if p["kind"] == "space":
        return STASH / "spaces" / name
    if p["kind"] == "paper":
        return STASH / "papers" / f"{p['repo']}.pdf"
    return None


def hub_size(p):
    try:
        kind = {"model": "models", "dataset": "datasets", "space": "spaces"}[p["kind"]]
        return hub(f"/{kind}/{p['repo']}?expand[]=usedStorage").get("usedStorage")
    except Exception:
        return None


def sha256_lines(root: Path, rel_root: Path):
    lines = []
    files = [root] if root.is_file() else sorted(Path(r) / f for r, ds, fs in os.walk(root) for f in fs
                                                  if not f.startswith("._") and ".cache" not in Path(r).parts)
    for f in files:
        h = hashlib.sha256()
        with open(f, "rb") as fh:
            for chunk in iter(lambda: fh.read(8 << 20), b""):
                h.update(chunk)
        lines.append(f"{h.hexdigest()}  {f.relative_to(rel_root)}")
    return lines


# ---------------------------------------------------------------- live activity (drives the status bar on the site)

ACT = {}
_last_post = [0.0]


def activity(force=False, **kw):
    """Merge kw into the current run state and send it to the Worker (at most every ~8 s unless forced)."""
    ACT.update(kw)
    ACT["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if not force and time.time() - _last_post[0] < 8:
        return
    _last_post[0] = time.time()
    try:
        api("/api/activity", "POST", {"kind": "run", **ACT})
    except Exception:
        pass  # the status bar is nice-to-have; never let it break a run


def disk_size(p: Path):
    """Apparent bytes under p. `du -A` is far faster than a Python walk on exFAT folders with tens of thousands of files."""
    if not p.exists():
        return 0
    try:
        r = subprocess.run(["du", "-skA", str(p)], capture_output=True, text=True, timeout=300)
        if r.returncode == 0 and r.stdout:
            return int(r.stdout.split()[0]) * 1024
    except Exception:
        pass
    return walk_size(p)[0]


def hf_download(args, dest: Path, total: int):
    """Run `hf download` and report bytes on disk, speed and time left while it runs.
    Disk is measured in a background thread; the main loop posts every 15 s with the latest sample, so the
    dashboard stays live even when one measurement takes longer than its 90-second freshness window."""
    e = dict(os.environ, PATH=PATH_EXTRA + ":" + os.environ.get("PATH", ""))
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=e)
    samples, stop = [], threading.Event()

    def sampler():
        while not stop.is_set():
            samples.append((time.time(), disk_size(dest)))
            del samples[:-8]
            stop.wait(15)

    threading.Thread(target=sampler, daemon=True).start()
    try:
        while True:
            try:
                out, err = proc.communicate(timeout=15)
                break
            except subprocess.TimeoutExpired:
                if not samples:
                    activity(force=True); continue          # still measuring: keep the bar marked live
                cur = samples[-1][1]
                dt = samples[-1][0] - samples[0][0]
                rate = (samples[-1][1] - samples[0][1]) / dt if dt > 0 else 0
                eta = (total - cur) / rate if rate > 0 and total > cur else None
                activity(force=True, current={**(ACT.get("current") or {}), "done_bytes": cur, "rate": rate, "eta_s": eta,
                                              "sampled_at": datetime.fromtimestamp(samples[-1][0], timezone.utc).isoformat(timespec="seconds")})
    finally:
        stop.set()
    return subprocess.CompletedProcess(args, proc.returncode, out, err)


HF_SITE = "https://huggingface.co"


def hub_url(repo, kind="model"):
    return f"{HF_SITE}/{'' if kind == 'model' else kind + 's/'}{repo}"


def _hf_http(url, method="GET"):
    req = urllib.request.Request(url, method=method, headers=hf_headers())
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, (r.read() if method == "GET" else b"")
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception:
        return 0, b""


def hub_access(repo, kind="model", http=None):
    """'granted', 'blocked' or 'unknown': can this Mac's Hugging Face account download the repo's files?
    Gated repos show their file list and model card to anyone, so this asks for one real file (HEAD, no download)."""
    http = http or _hf_http
    st, body = http(f"{HF_SITE}/api/{kind}s/{repo}/tree/main", "GET")
    if st in (401, 403):
        return "blocked"
    if st != 200:
        return "unknown"
    try:
        files = [f["path"] for f in json.loads(body) if f.get("type") == "file"]
    except Exception:
        return "unknown"
    probe = [f for f in files if f not in ("README.md", ".gitattributes")] or files
    if not probe:
        return "unknown"
    st, _ = http(f"{hub_url(repo, kind)}/resolve/main/{urllib.parse.quote(probe[0])}", "HEAD")
    return "granted" if st in (200, 302, 307) else "blocked" if st in (401, 403) else "unknown"


def licenses():
    return load_state().get("licenses", {})


def record_license(repo, kind, gated, access, **extra):
    """Remember the latest access check (plus gate details and the last decision); returns the previous access value."""
    s = load_state()
    L = s.setdefault("licenses", {})
    old = L.get(repo) or {}
    prev = old.get("access")
    keep = {k: old[k] for k in ("gate", "decision") if k in old}
    L[repo] = {**keep, "kind": kind, "gated": gated, "access": access, "url": hub_url(repo, kind),
               "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **extra}
    save_state(s)
    return prev


def hf_user():
    """The Hugging Face account the Mac downloads with (cached for a day), so the dashboard can say which login to accept with."""
    s = load_state()
    u = s.get("hf_user") or {}
    if time.time() - u.get("at", 0) < 86400 and u.get("name"):
        return u["name"]
    st, body = _hf_http(f"{HF_SITE}/api/whoami-v2")
    try:
        name = json.loads(body).get("name") if st == 200 else None
    except Exception:
        name = None
    s = load_state(); s["hf_user"] = {"name": name, "at": time.time()}; save_state(s)
    return name


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def _hf_post(url, data):
    """Form POST with the Mac's Hugging Face token, without following redirects.
    Returns (status, body text, Location header or None)."""
    body = urllib.parse.urlencode(data or {}).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={**hf_headers(), "content-type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.build_opener(_NoRedirect).open(req, timeout=20) as r:
            return r.status, r.read(2000).decode("utf-8", "ignore"), None
    except urllib.error.HTTPError as e:
        return e.code, (e.read(2000) or b"").decode("utf-8", "ignore"), e.headers.get("location")
    except Exception as e:
        return 0, str(e), None


def _is_checkbox(v):
    return v == "checkbox" or (isinstance(v, dict) and v.get("type") == "checkbox")


def gate_form(repo, kind="model", http=None):
    """What the repo's access gate asks for, read from its model card.
    mode 'ack': only an acknowledgement (and maybe checkboxes), so the Mac can submit it for you.
    mode 'form': it asks for personal details (name, date of birth, ...), which the agent never types.
    mode 'open': not gated. mode 'unknown': Hugging Face didn't answer."""
    http = http or _hf_http
    st, body = http(f"{HF_SITE}/api/{kind}s/{repo}", "GET")
    if st != 200:
        return {"mode": "unknown"}
    try:
        d = json.loads(body)
    except Exception:
        return {"mode": "unknown"}
    c = d.get("cardData") or {}
    fields = c.get("extra_gated_fields") or {}
    asks = [k for k, v in fields.items() if not _is_checkbox(v) and v != "ip_location"]
    boxes = [k for k, v in fields.items() if _is_checkbox(v)]
    lic = c.get("license")
    gated = d.get("gated")
    mode = "open" if not gated else "form" if asks else "ack"
    return {"mode": mode, "gated": str(gated), "asks": asks[:10], "boxes": boxes,
            "button": c.get("extra_gated_button_content") or None,
            "license": ",".join(lic) if isinstance(lic, list) else lic}


def decide_license(gate, decision, access):
    """The decision model for a gated repo: your Yes/No plus what the gate asks for -> one action.
    Pure and table-driven so every branch is tested. Actions: none, skip, submit, open_page, recheck."""
    if access == "granted":
        return {"action": "none", "reason": "Already granted."}
    if decision == "no":
        return {"action": "skip", "reason": "You said no. The pick is skipped and nothing is sent to Hugging Face."}
    if decision != "yes":
        return {"action": "none", "reason": "No decision yet."}
    mode = (gate or {}).get("mode")
    if mode == "ack":
        return {"action": "submit", "reason": "The gate only asks you to acknowledge the license, so the Mac submits it with its own Hugging Face login."}
    if mode == "form":
        asks = ", ".join((gate.get("asks") or [])[:6]).lower()
        return {"action": "open_page", "reason": f"The form asks for {asks}. The agent never types personal details; open the page and fill it yourself."}
    if mode == "open":
        return {"action": "recheck", "reason": "Not gated any more; re-checking access."}
    return {"action": "open_page", "reason": "Couldn't read the gate from Hugging Face; open the page to accept it."}


def request_access(repo, kind, gate, post=None):
    """Submit the acknowledgement on the repo's gate as the Mac's account.
    Returns (state, detail, url): state is 'requested', 'external' (the author sends you to their own consent page,
    e.g. Google's Kaggle consent for Gemma, which only you can complete) or 'failed'."""
    post = post or _hf_post
    data = {b: "on" for b in (gate or {}).get("boxes") or []}
    st, text, loc = post(f"{hub_url(repo, kind)}/ask-access", data)
    if 200 <= st < 300:
        return "requested", f"Submitted ({st}).", None
    if st in (301, 302, 303, 307, 308) and loc:
        u = urllib.parse.urlparse(urllib.parse.urljoin(HF_SITE, loc))
        if u.netloc.endswith("huggingface.co"):
            if "login" in u.path:
                return "failed", "Hugging Face didn't accept the Mac's token for this; sign in on the page instead.", hub_url(repo, kind)
            return "requested", f"Submitted ({st}).", None
        return "external", f"{repo.split('/')[0]} asks you to accept on {u.netloc}; only you can do that step.", u.geturl()
    return "failed", f"Hugging Face answered {st or 'nothing'}" + (f": {text[:160]}" if text and st else ""), hub_url(repo, kind)


def apply_decisions(decisions, picks, http=None, post=None, api_call=None):
    """Carry out Yes/No decisions from the dashboard. Returns {repo: result} and the repos to re-check."""
    api_call = api_call or api
    out, recheck = {}, set()
    L = licenses()
    for repo, d in (decisions or {}).items():
        if (d or {}).get("state") != "pending":
            continue
        pk = picks.get(repo) or {}
        kind = d.get("kind") or pk.get("kind") or (L.get(repo) or {}).get("kind", "model")
        gate = gate_form(repo, kind, http=http)
        access = (L.get(repo) or {}).get("access")
        plan = decide_license(gate, d.get("decision"), access)
        res = {"decision": d.get("decision"), "action": plan["action"], "reason": plan["reason"], "gate": gate.get("mode"),
               "url": hub_url(repo, kind)}
        if plan["action"] == "skip":
            if pk.get("id") and pk.get("status") != "stashed":
                try:
                    api_call("/api/picks/status", "POST", {"id": pk["id"], "status": "skipped"})
                except Exception:
                    pass
            record_license(repo, kind, gate.get("gated", "manual"), "declined", gate=gate, decision="no")
            res["outcome"] = "skipped"
        elif plan["action"] == "submit":
            state, detail, url = request_access(repo, kind, gate, post=post)
            res["detail"] = detail
            if state == "external":
                gate = {**gate, "consent_url": url}
                res.update(outcome="needs_you", url=url, reason=f"{detail} Open it signed in, accept, then come back; the Mac re-checks every 15 minutes.")
            else:
                res["outcome"] = state
                if url:
                    res["url"] = url
            record_license(repo, kind, gate.get("gated", "manual"), access or "blocked", gate=gate, decision="yes")
            if state == "requested":
                recheck.add(repo)
        elif plan["action"] == "recheck":
            res["outcome"] = "rechecking"; recheck.add(repo)
        elif plan["action"] == "open_page":
            res["outcome"] = "needs_you"
            record_license(repo, kind, gate.get("gated", "manual"), access or "blocked", gate=gate, decision="yes")
        else:
            res["outcome"] = "nothing_to_do"
        log(f"license decision {repo}: {d.get('decision')} -> {plan['action']} ({res.get('outcome')})")
        out[repo] = res
    return out, recheck


def check_licenses(repos, kinds=None):
    """Re-check access for repos. kinds maps repo -> (kind, gated). Returns {repo: {access, was, kind, url}}."""
    kinds = kinds or {}
    L = licenses()
    out = {}
    for r in sorted(repos):
        kind, gated = kinds.get(r) or ((L.get(r) or {}).get("kind", "model"), (L.get(r) or {}).get("gated", "manual"))
        acc = hub_access(r, kind)
        extra = {}
        if acc != "granted" and not (L.get(r) or {}).get("gate"):
            extra["gate"] = gate_form(r, kind)
        was = record_license(r, kind, gated, acc, **extra)
        out[r] = {"access": acc, "was": was, "kind": kind, "url": hub_url(r, kind)}
    return out


LICENSE_RE = re.compile(r"Access denied|requires approval|gated repo|accept the (?:license|conditions)", re.I)


def needs_license(lines=None):
    """Repos whose latest download attempt in the log was refused because the Hugging Face license isn't accepted.
    A later successful download of the same repo clears it."""
    live = lines is None
    if live:
        try:
            lines = LOG.read_text(errors="ignore").splitlines()[-3000:]
        except OSError:
            lines = []
    blocked, cur = set(), None
    for l in lines:
        m = re.search(r" (?:downloading|updating) \w+ (\S+) ", l)
        if m:
            cur = m.group(1); continue
        if cur and LICENSE_RE.search(l):
            blocked.add(cur); cur = None
        elif cur and ("  stashed " in l or "  updated; previous" in l):
            blocked.discard(cur); cur = None
    if live:
        L = licenses()
        blocked = {r for r in blocked if (L.get(r) or {}).get("access") not in ("granted", "declined")}
        blocked |= {r for r, v in L.items() if v.get("access") == "blocked"}
    return blocked


def plan_queue(picks, spent, cap, blocked=None):
    """Mirror fetch_approved's ordering and cap so the site can show what downloads now and what waits.
    Picks that need a license accepted on the Hub are listed as such and don't count toward the run's total."""
    blocked = needs_license() if blocked is None else blocked
    q, s = [], spent
    for p in picks:
        size = p.get("size_bytes") or 0
        if p["repo"] in blocked:
            q.append({"repo": p["repo"], "kind": p["kind"], "bytes": size, "when": "needs license"}); continue
        now = not (s + size > cap and not (s == 0 and size > cap))
        if now:
            s += size
        q.append({"repo": p["repo"], "kind": p["kind"], "bytes": size, "when": "now" if now else "next plug-in"})
    return q


def run_from_log(busy, procs=None, disk=None):
    """Rebuild the current run's progress from scout.log: done items, the item downloading now (measured on disk), what's left."""
    try:
        lines = LOG.read_text(errors="ignore").splitlines()[-600:]
    except OSError:
        return None
    starts = [i for i, l in enumerate(lines) if " A1 present (" in l]
    if not starts:
        return None
    seg = lines[starts[-1]:]
    when = lambda l: datetime.fromisoformat(l[:19]).astimezone().isoformat(timespec="seconds")
    run = {"started_at": when(seg[0]), "phase": "Reading the drive", "done": [], "current": None, "dl_started_at": None, "finished": False}
    for l in seg:
        if "update check:" in l:
            run["phase"] = "Checking stashed items for updates"
        elif " scan" in l and ("scan:" in l or "scan skipped" in l):
            run["phase"] = "Scanning Hugging Face for new picks"
        m = re.search(r" downloading (\w+) (\S+) @ \S+ -> (\S+) \(~([\d.]+) GB\)", l)
        u = re.search(r" updating (\w+) (\S+) \w+ -> \w+: .*?~([\d.]+) GB to download(?:, ([\d.]+) GB in all)?", l)
        if m:
            run["phase"] = "Downloading approved picks"
            run["current"] = {"repo": m.group(2), "kind": m.group(1), "action": "Downloading", "dest": m.group(3),
                              "total_bytes": float(m.group(4)) * 1e9, "started_at": when(l)}
            run["dl_started_at"] = run["dl_started_at"] or when(l)
        elif u:
            run["phase"] = "Updating stashed items"
            run["current"] = {"repo": u.group(2), "kind": u.group(1), "action": "Updating",
                              "total_bytes": float(u.group(4) or u.group(3)) * 1e9, "started_at": when(l)}
            run["dl_started_at"] = run["dl_started_at"] or when(l)
        s2 = re.search(r"  stashed ([\d.]+) GB", l)
        if (s2 or "  updated; previous" in l) and run["current"]:
            c = run["current"]
            run["done"].append({"repo": c["repo"], "bytes": float(s2.group(1)) * 1e9 if s2 else c["total_bytes"],
                                "what": "added" if s2 else "updated", "started_at": c["started_at"], "finished_at": when(l)})
            run["current"] = None
        if "  waiting:" in l:
            run["finished"] = True
    c = run["current"]
    disk = disk or disk_size
    if c and busy:
        if c.get("dest"):
            c["done_bytes"] = disk(STASH / c["dest"])
        else:
            # Updates download into a hidden staging folder; read it off the running `hf download`.
            try:
                sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "gates"))
                from statusbar_probe import hf_downloads
                procs = hf_downloads() if procs is None else procs
            except Exception:
                procs = procs or []
            dl = next((x for x in procs if x["repo"] == c["repo"] and x.get("dest")), None)
            if dl:
                c["done_bytes"] = disk(Path(dl["dest"]))
                c["total_bytes"] = max(c.get("total_bytes") or 0, c["done_bytes"])
    if not busy:
        run["current"] = None
        run["finished"] = True
    return run


def queue_after(run, cap):
    """Approved picks still to come, split into this run (fits the cap) and the next plug-in."""
    try:
        picks = api("/api/picks?status=approved")
    except Exception:
        return []
    taken = {d["repo"] for d in run["done"]} | ({run["current"]["repo"]} if run.get("current") else set())
    spent = sum(d["bytes"] for d in run["done"]) + ((run.get("current") or {}).get("total_bytes") or 0)
    q, blocked = [], needs_license()
    for p in picks:
        if p["repo"] in taken:
            continue
        size = p.get("size_bytes") or 0
        if p["repo"] in blocked:
            q.append({"repo": p["repo"], "kind": p["kind"], "bytes": size, "when": "needs license"}); continue
        fits = spent + size <= cap
        if fits:
            spent += size
        q.append({"repo": p["repo"], "kind": p["kind"], "bytes": size, "when": "now" if fits else "next plug-in"})
    return q


def fetch_approved(spent=0):
    picks = api("/api/picks?status=approved&include_ok=1")
    who = sh(["hf", "auth", "whoami"])
    hf_logged_in = who.returncode == 0 and "Not logged in" not in (who.stdout + who.stderr)
    cap = float(ENV["RUN_CAP_GB"]) * 1e9
    floor = float(ENV["FREE_FLOOR_GB"]) * 1e9
    done, waiting = [], []
    # If nothing has downloaded yet this plug-in, let one over-cap item go first so it isn't starved forever.
    if spent == 0:
        big = [p for p in picks if (p.get("size_bytes") or 0) > cap]
        if big:
            picks = [big[0]] + [p for p in picks if p is not big[0]]
    today = datetime.now().strftime("%Y-%m-%d")
    pins_file = STASH / "manifests/scout-pins.json"
    activity(force=True, phase="Downloading approved picks", queue=plan_queue(picks, spent, cap))
    for p in picks:
        dest = dest_for(p)
        if not dest or not inside_stash(dest):
            waiting.append((p["repo"], "no safe destination")); continue
        if "gated" in p.get("flags", []) and not hf_logged_in:
            waiting.append((p["repo"], "gated: run `hf auth login` once, then it downloads next mount")); continue
        gated = str(p.get("gated") or "false").lower()
        if gated not in ("false", "none", "") and p["kind"] in ("model", "dataset"):
            acc = hub_access(p["repo"], p["kind"])
            record_license(p["repo"], p["kind"], gated, acc)
            if acc == "blocked":
                waiting.append((p["repo"], f"needs license: accept the terms at {hub_url(p['repo'], p['kind'])}, then it downloads automatically"))
                activity(force=True, needs_license=sorted(needs_license() | {p["repo"]}),
                         queue=[{**q, "when": "needs license"} if q["repo"] == p["repo"] else q for q in ACT.get("queue", [])])
                continue
        size = p.get("size_bytes") or hub_size(p) or 0
        # A single item bigger than the cap still downloads when it is the first download of a plug-in.
        if spent + size > cap and not (spent == 0 and size > cap):
            waiting.append((p["repo"], f"over this run's {ENV['RUN_CAP_GB']} GB cap")); continue
        if free_bytes() - size < floor:
            waiting.append((p["repo"], f"would leave under {ENV['FREE_FLOOR_GB']} GB free")); continue

        log(f"downloading {p['kind']} {p['repo']} @ {(p.get('sha') or 'latest')[:10]} -> {dest.relative_to(STASH)} (~{size/1e9:.2f} GB)")
        ACT.setdefault("dl_started_at", datetime.now(timezone.utc).isoformat(timespec="seconds"))
        activity(force=True, current={"repo": p["repo"], "kind": p["kind"], "action": "Downloading", "total_bytes": size,
                                      "done_bytes": 0, "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds")},
                 queue=[q for q in ACT.get("queue", []) if q["repo"] != p["repo"]])
        if p["kind"] == "paper":
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(".part")
            try:
                req = urllib.request.Request(f"https://arxiv.org/pdf/{p['repo']}", headers={"user-agent": "a1-scout-agent"})
                with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as fh:
                    shutil.copyfileobj(r, fh)
                tmp.rename(dest)
                ok = True
            except Exception as e:
                log(f"  paper failed: {e}"); ok = False
                if tmp.exists() and inside_stash(tmp):
                    tmp.unlink()  # our own partial file only
        else:
            args = ["caffeinate", "-i", "hf", "download", p["repo"], "--repo-type", p["kind"], "--local-dir", str(dest)]
            if p.get("sha"):
                args += ["--revision", p["sha"]]
            for g in include_of(p):
                args += ["--include", g]
            r = hf_download(args, dest, size)
            ok = r.returncode == 0
            if not ok:
                log(f"  hf download failed: {(r.stderr or r.stdout)[-400:]}")
        if not ok:
            refused = p["kind"] != "paper" and LICENSE_RE.search((r.stderr or "") + (r.stdout or ""))
            waiting.append((p["repo"], f"needs license: accept the terms at https://huggingface.co/{p['repo']}, then it downloads next mount"
                            if refused else "download failed; retries next mount"))
            if refused:
                activity(force=True, needs_license=sorted(needs_license() | {p["repo"]}),
                         queue=[{**q, "when": "needs license"} if q["repo"] == p["repo"] else q for q in ACT.get("queue", [])])
            continue

        got, _ = walk_size(dest)
        spent += got
        (dest.parent / f"{dest.name}.verified" if dest.is_file() else dest / ".verified").write_text(json.dumps(
            {"repo": p["repo"], "kind": p["kind"], "revision": p.get("sha"), "bytes": got, "at": datetime.now().isoformat(timespec="seconds"), "by": "a1-scout"}))
        with (STASH / f"manifests/scout-{today}.sha256").open("a") as fh:
            fh.write("\n".join(sha256_lines(dest, STASH)) + "\n")
        try:
            pins = json.loads(pins_file.read_text()) if pins_file.exists() else []
        except Exception:
            pins = []
        pins.append({"repo": p["repo"], "type": p["kind"], "revision": p.get("sha"), "path": str(dest.relative_to(STASH)),
                     "bytes": got, "title": p.get("title"), "added": today, "score": p.get("score"),
                     **({"include": include_of(p)} if include_of(p) else {})})
        pins_file.write_text(json.dumps(pins, indent=2))
        api("/api/stashed", "POST", {"id": p["id"], "sha": p.get("sha"), "path": str(dest.relative_to(STASH)), "size_bytes": got})
        done.append((p["repo"], got))
        log(f"  stashed {got/1e9:.2f} GB")
        activity(force=True, current=None, done=(ACT.get("done") or []) + [{"repo": p["repo"], "bytes": got, "what": "added"}])
    return done, waiting


def add_pin(entry):
    pins_file = STASH / "manifests/scout-pins.json"
    try:
        pins = json.loads(pins_file.read_text()) if pins_file.exists() else []
    except Exception:
        pins = []
    pins.append(entry)
    pins_file.write_text(json.dumps(pins, indent=2))


# ---------------------------------------------------------------- updates of what's already stashed

DOCS_ONLY = re.compile(r"(\.(md|txt|png|jpe?g|gif|svg|webp)$|^\.gitattributes$|(^|/)LICEN[CS]E)", re.I)
KIND_OF = {"models": "model", "datasets": "dataset", "spaces": "space"}


def cached_commit(d: Path):
    """The commit `hf download --local-dir` recorded for this folder (first line of each .metadata file)."""
    seen = {}
    for m in (d / ".cache/huggingface/download").rglob("*.metadata") if (d / ".cache/huggingface/download").is_dir() else []:
        try:
            c = m.read_text().splitlines()[0].strip()
            if re.fullmatch(r"[0-9a-f]{40}", c):
                seen[c] = seen.get(c, 0) + 1
        except Exception:
            pass
    return max(seen, key=seen.get) if seen else None


def guess_repo(d: Path, kind, sha):
    """For folders stashed by hand: find the Hub repo whose history contains the cached commit."""
    cands = []
    try:
        txt = (d / "README.md").read_text(errors="ignore")
        cands += re.findall(r"\b((?:mlx-community|lmstudio-community|unsloth|bartowski)/[\w.\-]+)", txt)
    except OSError:
        pass
    cands += [f"mlx-community/{d.name}"]
    for c in dict.fromkeys(cands):
        if c.split("/")[-1].lower() != d.name.lower():
            continue
        try:
            hub(f"/{kind}s/{c}/revision/{sha}")
            return c
        except Exception:
            continue
    return None


def tracked_items(catalog):
    prov = provenance()
    items, untracked, adopted = [], [], []
    for c in catalog["categories"]:
        for i in c["items"]:
            kind = KIND_OF.get(i["path"].split("/")[0])
            if not kind:
                continue
            d = STASH / i["path"]
            if not d.is_dir():
                continue
            p = prov.get(i["path"].strip("/")) or {}
            repo, rev = p.get("repo"), p.get("revision")
            if repo and "/" in repo and not rev:
                rev = cached_commit(d)
            if not repo:
                sha = cached_commit(d)
                repo = guess_repo(d, kind, sha) if sha else None
                if repo:
                    rev = sha
                    adopted.append({"repo": repo, "type": kind, "revision": sha, "path": i["path"], "added": datetime.now().strftime("%Y-%m-%d"), "adopted": True})
            if repo and rev:
                items.append({"repo": repo, "kind": kind, "revision": rev, "path": i["path"].strip("/"), "bytes": i["bytes"],
                              "include": include_of(p)})
            else:
                untracked.append(i["path"])
    return items, untracked, adopted


def check_updates(catalog):
    """Compare each stashed Hub item with the Hub's current revision. Returns (report, plans to download)."""
    items, untracked, adopted = tracked_items(catalog)
    for a in adopted:
        add_pin(a)  # remember hand-stashed folders we traced to a Hub repo, so they're tracked from now on
        log(f"update check: traced {a['path']} to {a['repo']} @ {a['revision'][:7]}")
    st = load_state()
    docs_seen = st.get("docs_only_seen", {})
    report = {"checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tracked": len(items), "current": 0,
              "untracked": len(untracked), "updated": [], "waiting": [], "docs_only": [], "successors": [], "errors": []}
    plans = []
    report["settling"] = []
    settle = float(ENV["SETTLE_HOURS"]) * 3600
    for i, it in enumerate(items):
        activity(check={"done": i, "total": len(items), "repo": it["repo"]})
        try:
            info = hub(f"/{it['kind']}s/{it['repo']}")
            new = info.get("sha")
        except Exception as e:
            report["errors"].append({"repo": it["repo"], "error": str(e)[:120]}); continue
        if not new or new == it["revision"] or docs_seen.get(it["path"]) == new:
            report["current"] += 1; continue
        # A repo that changed recently may be mid-release (dozens of upload commits in an hour). Wait for it to go quiet,
        # unless an update for this item is already staged, in which case finish it.
        try:
            age = time.time() - datetime.fromisoformat(str(info.get("lastModified")).replace("Z", "+00:00")).timestamp()
        except Exception:
            age = settle
        if age < settle and not staged_update(STASH / it["path"]):
            report["settling"].append({"repo": it["repo"], "to": new, "quiet_hours": round(age / 3600, 1), "needs_hours": float(ENV["SETTLE_HOURS"])})
            continue
        try:
            new_t = hub_tree(it["kind"], it["repo"], new)
        except Exception as e:
            report["errors"].append({"repo": it["repo"], "error": f"tree: {str(e)[:100]}"}); continue
        try:
            old_t = hub_tree(it["kind"], it["repo"], it["revision"])
        except Exception:
            old_t = {}  # old revision gone from history: treat every file as changed
        if it.get("include"):  # partial pins only care about the files they asked for
            keep = lambda t: {f: v for f, v in t.items() if any(fnmatch.fnmatch(f, g) for g in it["include"])}
            new_t, old_t = keep(new_t), keep(old_t)
        changed = [f for f, v in new_t.items() if old_t.get(f, (None,))[0] != v[0]]
        removed = [f for f in old_t if f not in new_t]
        if not changed and not removed:
            report["current"] += 1; docs_seen[it["path"]] = new; continue
        if all(DOCS_ONLY.search(f) for f in changed + removed):
            report["docs_only"].append({"repo": it["repo"], "from": it["revision"], "to": new, "files": (changed + removed)[:5]})
            docs_seen[it["path"]] = new; continue
        plans.append({**it, "new": new, "new_tree": new_t, "changed": changed,
                      "download_bytes": sum(new_t[f][1] for f in changed), "total_bytes": sum(v[1] for v in new_t.values())})
    st["docs_only_seen"] = docs_seen
    save_state(st)
    return report, plans


def staged_update(src):
    """An earlier, unfinished update download for this item (.<name>.updating-<sha7> beside it), if any."""
    found = sorted(src.parent.glob(f".{src.name}.updating-*"), key=lambda d: d.stat().st_mtime)
    return found[-1] if found and found[-1].is_dir() else None


def apply_update(pl, report, spent, cap, floor):
    """Download the new revision beside the old one, then move the old one to stash/versions/ and the new one into place."""
    src = STASH / pl["path"]
    new7, old7 = pl["new"][:7], pl["revision"][:7]
    wait = lambda why: report["waiting"].append({"repo": pl["repo"], "from": pl["revision"], "to": pl["new"], "why": why})
    if spent + pl["download_bytes"] > cap:
        wait(f"{pl['download_bytes']/1e9:.1f} GB to download; over this run's {ENV['RUN_CAP_GB']} GB cap"); return 0
    if free_bytes() - pl["total_bytes"] < floor:
        wait(f"would leave under {ENV['FREE_FLOOR_GB']} GB free"); return 0
    tmp = src.parent / f".{src.name}.updating-{new7}"
    prev = STASH / "versions" / src.parent.relative_to(STASH) / f"{src.name}@{old7}"
    if not (inside_stash(tmp) and inside_stash(prev)) or prev.exists():
        wait("no safe place for the old copy"); return 0
    log(f"updating {pl['kind']} {pl['repo']} {old7} -> {new7}: {len(pl['changed'])} changed files, ~{pl['download_bytes']/1e9:.2f} GB to download, {pl['total_bytes']/1e9:.2f} GB in all")
    staged = staged_update(src)
    if staged and staged != tmp and not tmp.exists() and inside_stash(staged):
        # Resume an interrupted download aimed at an older revision: hf keeps every file whose etag still matches.
        log(f"  resuming staged download {staged.name} ({walk_size(staged)[0]/1e9:.1f} GB already here)")
        os.rename(staged, tmp)
    tmp.mkdir(parents=True, exist_ok=True)
    # Seed unchanged files (and hf's download metadata) from the old copy so only changed files come over the network.
    for f, (oid, size) in pl["new_tree"].items():
        if f in pl["changed"]:
            continue
        a, b = src / f, tmp / f
        # Only large files are worth copying: on exFAT, thousands of small copies are slower than re-downloading them.
        if size >= 50e6 and a.is_file() and not b.exists() and a.stat().st_size == size:
            b.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(a, b)
            ma = src / ".cache/huggingface/download" / f"{f}.metadata"
            if ma.is_file():
                mb = tmp / ".cache/huggingface/download" / f"{f}.metadata"
                mb.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ma, mb)
    ACT.setdefault("dl_started_at", datetime.now(timezone.utc).isoformat(timespec="seconds"))
    activity(force=True, phase="Updating stashed items", current={"repo": pl["repo"], "kind": pl["kind"], "action": "Updating",
             "total_bytes": pl["total_bytes"], "done_bytes": walk_size(tmp)[0], "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    r = hf_download(["caffeinate", "-i", "hf", "download", pl["repo"], "--repo-type", pl["kind"], "--revision", pl["new"], "--local-dir", str(tmp)]
                    + [a for g in pl.get("include") or [] for a in ("--include", g)], tmp, pl["total_bytes"])
    if r.returncode != 0:
        log(f"  hf download failed: {(r.stderr or r.stdout)[-300:]}")
        wait("download failed; resumes next mount"); return 0
    missing = [f for f, (_, size) in pl["new_tree"].items() if not (tmp / f).is_file() or (tmp / f).stat().st_size != size]
    if missing:
        wait(f"{len(missing)} files incomplete; resumes next mount"); return 0
    prev.parent.mkdir(parents=True, exist_ok=True)
    os.rename(src, prev)     # keep the old version
    os.rename(tmp, src)      # new version takes the usual path, so scripts and the map keep working
    got, _ = walk_size(src)
    (src / ".verified").write_text(json.dumps({"repo": pl["repo"], "kind": pl["kind"], "revision": pl["new"], "bytes": got,
                                               "updated_from": pl["revision"], "at": datetime.now().isoformat(timespec="seconds"), "by": "a1-scout"}))
    today = datetime.now().strftime("%Y-%m-%d")
    with (STASH / f"manifests/scout-{today}.sha256").open("a") as fh:
        fh.write("\n".join(sha256_lines(src, STASH)) + "\n")
    add_pin({"repo": pl["repo"], "type": pl["kind"], "revision": pl["new"], "path": pl["path"], "bytes": got, "added": today,
             "updated_from": pl["revision"], "previous_path": str(prev.relative_to(STASH))})
    report["updated"].append({"repo": pl["repo"], "from": pl["revision"], "to": pl["new"], "bytes": got, "previous_path": str(prev.relative_to(STASH))})
    log(f"  updated; previous version kept at {prev.relative_to(STASH)}")
    activity(force=True, current=None, done=(ACT.get("done") or []) + [{"repo": pl["repo"], "bytes": got, "what": "updated"}])
    return pl["download_bytes"]


VER = re.compile(r"^([A-Za-z][A-Za-z_]*-?)(\d+(?:\.\d+)*)(-.+)$")


def vt(v):
    return tuple(int(x) for x in v.split("."))


def norm_rest(r):
    return re.sub(r"-mlx(?=-|$)", "", r.lower())  # "-4B-MLX-4bit" and "-4B-4bit" are the same model, two naming styles


def find_successors(items, report):
    """Newer releases of stashed model families: same author, family, size and quant, higher version number."""
    have = {}
    for it in items:
        if it["kind"] != "model":
            continue
        author, name = it["repo"].split("/", 1)
        m = VER.match(name)
        if m:
            key = (author, m.group(1).lower(), norm_rest(m.group(3)))
            have[key] = max(have.get(key, (0,)), vt(m.group(2)))
    for (author, fam, rest), best in have.items():
        try:
            q = urllib.parse.urlencode({"author": author, "search": rest.lstrip("-"), "sort": "createdAt", "direction": -1, "limit": 100})
            res = hub(f"/models?{q}")
        except Exception:
            continue
        top = None
        for r in res:
            m = VER.match(r["id"].split("/", 1)[1])
            if m and m.group(1).lower() == fam and norm_rest(m.group(3)) == rest and vt(m.group(2)) > best and (not top or vt(m.group(2)) > top[0]):
                top = (vt(m.group(2)), r["id"])
        if not top:
            continue
        of = next(it["repo"] for it in items if it["kind"] == "model" and it["repo"].lower().startswith(author.lower() + "/" + fam)
                  and norm_rest(it["repo"]).endswith(rest))
        approve = ENV["AUTO_SUCCESSORS"] == "on"
        try:
            res = api("/api/picks/add", "POST", {"repo": top[1], "kind": "model", "theme": "code" if "coder" in rest else "agents",
                                                  "source": "newer release", "note": f"successor of {of.split('/')[-1]}",
                                                  "status": "approved" if approve else "new"})
            if res.get("already") != "stashed":
                report["successors"].append({"repo": top[1], "of": of, "approved": approve})
                log(f"newer release: {top[1]} (successor of {of}){' - auto-approved' if approve else ''}")
        except Exception as e:
            report["errors"].append({"repo": top[1], "error": str(e)[:120]})


# ---------------------------------------------------------------- runs

def push_profile(catalog):
    r = sh(["gh", "repo", "list", ENV["ORG"], "--limit", "500", "--json", "name,description,pushedAt"], timeout=120)
    repos = json.loads(r.stdout) if r.returncode == 0 else []
    if not repos:
        log(f"gh repo list failed: {r.stderr.strip()[:200]}")
    res = api("/api/profile", "POST", {"repos": repos, "inventory": inventory_from(catalog), "free_bytes": free_bytes()})
    log(f"profile pushed: {res.get('repos')} repos, {res.get('inventory')} inventory names")


def push_catalog(catalog):
    res = api("/api/catalog", "POST", json.dumps(catalog), raw=True)
    log(f"catalog pushed: {sum(len(c['items']) for c in catalog['categories'])} items, {res.get('bytes')} bytes")


def run_updates(catalog, dry=False):
    report, plans = check_updates(catalog)
    log(f"update check: {report['tracked']} tracked, {report['current']} current, {len(plans)} with new files, "
        f"{len(report['docs_only'])} docs-only, {len(report.get('settling', []))} settling, {report['untracked']} untraceable")
    for st_ in report.get("settling", []):
        log(f"  settling: {st_['repo']} changed {st_['quiet_hours']} h ago; updates after {st_['needs_hours']:.0f} quiet hours")
    spent = 0
    cap, floor = float(ENV["RUN_CAP_GB"]) * 1e9, float(ENV["FREE_FLOOR_GB"]) * 1e9
    for pl in sorted(plans, key=lambda x: x["download_bytes"]):
        if dry or ENV["AUTO_UPDATES"] != "on":
            report["waiting"].append({"repo": pl["repo"], "from": pl["revision"], "to": pl["new"],
                                      "why": f"dry run: {len(pl['changed'])} files, {pl['download_bytes']/1e9:.2f} GB" if dry else "auto-updates off"})
            continue
        spent += apply_update(pl, report, spent, cap, floor)
    items, _, _ = tracked_items(catalog)
    if not dry:
        find_successors(items, report)
    return report, spent


def run_mounted(trigger):
    log(f"A1 present ({trigger}); stash at {STASH}")
    ACT.clear()
    activity(force=True, state="running", trigger=trigger, started_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
             phase="Reading the drive", current=None, queue=[], done=[], waiting=[], summary=None)
    catalog = build_catalog()
    push_catalog(catalog)
    push_profile(catalog)
    activity(force=True, phase="Checking stashed items for updates", needs_license=sorted(needs_license()))
    report, spent = run_updates(catalog)
    activity(force=True, phase="Scanning Hugging Face for new picks", current=None, check=None)
    scan = api(f"/api/scan?if_stale=1&min_hours={ENV['SCAN_MIN_HOURS']}&trigger={trigger}", "POST")
    if "skipped" in scan:
        log(f"scan skipped: {scan['skipped']}")
    else:
        log(f"scan: {scan.get('candidates')} candidates, {scan.get('new_picks')} new, {scan.get('auto_approved')} auto-approved, errors={len(scan.get('errors', []))}")
    done, waiting = fetch_approved(spent)
    if done or report["updated"]:
        catalog = build_catalog()
        push_catalog(catalog)
    try:
        api("/api/updates", "POST", report)
    except Exception as e:
        log(f"updates report not sent: {e}")
    st = api("/api/state")
    new = (st.get("counts") or {}).get("new", 0)
    parts = []
    if report["updated"]:
        parts.append(f"Updated {len(report['updated'])}: " + ", ".join(u["repo"].split("/")[-1] for u in report["updated"][:3]))
    if report["successors"]:
        parts.append(f"{len(report['successors'])} newer release(s) found")
    if done:
        parts.append(f"Added {len(done)} ({sum(b for _, b in done)/1e9:.1f} GB): " + ", ".join(r.split('/')[-1] for r, _ in done[:3]))
    if waiting:
        parts.append(f"{len(waiting)} approved waiting")
    parts.append(f"{new} new picks to review")
    notify("A1 Scout", " · ".join(parts))
    for r, why in waiting:
        log(f"  waiting: {r} ({why})")
    activity(force=True, state="idle", phase="Finished", current=None, queue=[],
             finished_at=datetime.now(timezone.utc).isoformat(timespec="seconds"), summary=" · ".join(parts),
             waiting=[{"repo": r, "why": why} for r, why in waiting])
    s = load_state(); s["last_mount_run"] = time.time(); save_state(s)


def license_heartbeat(resp, present, busy):
    """Re-check gated repos when the dashboard asks (Check access) or every 15 minutes while any is blocked.
    When access comes through, approve the pick (accepting the license is the intent) and start a run if the A1 is idle."""
    lc = (resp or {}).get("license_check")
    asked = bool(lc and lc.get("state") == "pending")
    decisions = {r: d for r, d in ((resp or {}).get("license_decisions") or {}).items() if (d or {}).get("state") == "pending"}
    blocked = needs_license()
    st = load_state()
    if not asked and not decisions and not (blocked and time.time() - st.get("license_checked_at", 0) > 900):
        return
    try:
        picks = {p["repo"]: p for p in api("/api/picks")}
    except Exception:
        picks = {}
    decided, recheck = apply_decisions(decisions, picks) if decisions else ({}, set())
    if recheck:
        time.sleep(3)   # gates that grant on acknowledgement take a moment to show up as access
    blocked = needs_license()
    repos = blocked | set((lc or {}).get("repos") or []) | recheck
    kinds = {r: (picks[r]["kind"], str(picks[r].get("gated"))) for r in repos if r in picks}
    res = check_licenses(repos, kinds)
    st = load_state(); st["license_checked_at"] = time.time(); save_state(st)
    newly = [r for r, v in res.items() if v["access"] == "granted" and v["was"] != "granted"]
    started = False
    for r in newly:
        pk = picks.get(r)
        if pk and pk.get("status") in ("new", "skipped"):
            try:
                api("/api/picks/status", "POST", {"id": pk["id"], "status": "approved"})
            except Exception:
                pass
    if newly:
        log(f"license granted: {', '.join(newly)}")
        if present and not busy:
            s2 = load_state(); s2.pop("last_mount_run", None); s2["next_trigger"] = "license"; save_state(s2)
            r = sh(["launchctl", "kickstart", f"gui/{os.getuid()}/com.organizedai.a1-scout.mount"], timeout=30)
            started = r.returncode == 0
        notify("A1 Scout", f"Access granted: {', '.join(x.split('/')[-1] for x in newly)} · "
               + ("downloading now" if started else "downloads on the next plug-in"))
    if asked:
        try:
            api("/api/license-check/ack", "POST", {"results": res, "started": started})
        except Exception:
            pass
    if decided:
        for r, v in decided.items():
            v["access"] = (res.get(r) or {}).get("access") or (licenses().get(r) or {}).get("access")
            if v.get("outcome") == "requested" and v["access"] == "granted":
                v["outcome"] = "granted"
        try:
            api("/api/license-decision/ack", "POST", {"results": decided, "started": started})
        except Exception:
            pass


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "now"
    STATE_DIR.mkdir(exist_ok=True)
    if mode == "heartbeat":
        # Every 2 minutes from launchd: tell the site whether the A1 is plugged in and whether a run is busy.
        present = a1_present()
        busy = False
        with open(LOCK, "a") as probe:
            try:
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB); fcntl.flock(probe, fcntl.LOCK_UN)
            except BlockingIOError:
                busy = True
        logrun = run_from_log(busy) if present else None
        if logrun and busy:
            logrun["queue"] = queue_after(logrun, float(ENV["RUN_CAP_GB"]) * 1e9)
        bar_check = None
        if present:
            try:
                sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "gates"))
                import statusbar_probe
                bar_check = statusbar_probe.probe(A=sys.modules[__name__])
                st = load_state()
                if bar_check["failed"] != st.get("bar_check_failed", []):
                    log(f"status bar gate: {'PASS' if bar_check['ok'] else 'FAIL ' + ', '.join(bar_check['failed'])}")
                    st["bar_check_failed"] = bar_check["failed"]; save_state(st)
            except Exception as e:
                bar_check = {"ok": None, "failed": [], "error": f"{type(e).__name__}: {e}"[:200]}
        resp = api("/api/activity", "POST", {"kind": "presence", "present": present, "busy": busy, "logrun": logrun,
                                             "free_bytes": free_bytes() if present else None, "cap_gb": float(ENV["RUN_CAP_GB"]),
                                             "needs_license": sorted(needs_license()), "bar_check": bar_check,
                                             "licenses": licenses(), "hf_user": hf_user()})
        rr = (resp or {}).get("run_request")
        if rr and rr.get("state") == "pending":
            # "Run now" from the dashboard: same run a plug-in starts, via the mount LaunchAgent, minus the 10-minute debounce.
            if not present:
                api("/api/run-request/ack", "POST", {"state": "absent", "note": "A1 not plugged in"})
            elif busy:
                api("/api/run-request/ack", "POST", {"state": "busy", "note": "a run was already going"})
            else:
                st = load_state(); st.pop("last_mount_run", None); st["next_trigger"] = "dashboard"; save_state(st)
                r = sh(["launchctl", "kickstart", f"gui/{os.getuid()}/com.organizedai.a1-scout.mount"], timeout=30)
                log(f"run requested from the dashboard: kickstart {'ok' if r.returncode == 0 else 'failed ' + (r.stderr or '')[-160:]}")
                api("/api/run-request/ack", "POST", {"state": "started" if r.returncode == 0 else "failed",
                                                     "note": None if r.returncode == 0 else (r.stderr or "")[-200:]})
        license_heartbeat(resp, present, busy)
        return
    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("another a1-scout run is active"); return
    present = a1_present()
    if mode == "bench":
        # Same gate as a download run: the real A1 mounted, and this process holds scout.lock for the whole bench.
        if not present:
            print("A1 not present"); return
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import bench
        bench.main(sys.argv[2:], sys.modules[__name__]); return
    if mode == "status":
        print(json.dumps({"a1_present": present, "state": load_state(), "server": api("/api/state")}, indent=2)); return
    if mode == "updates":
        if not present:
            print("A1 not present"); return
        report, _ = run_updates(build_catalog(), dry="--dry-run" in sys.argv)
        print(json.dumps(report, indent=2)); return
    if mode == "catalog":
        if not present:
            print("A1 not present"); return
        c = build_catalog(); push_catalog(c); print(json.dumps({c_["id"]: len(c_["items"]) for c_ in c["categories"]})); return
    if mode == "mount":
        # launchd fires this on every volume mount; only act for the A1, and not twice in 10 minutes.
        if not present:
            return
        st = load_state()
        if time.time() - st.get("last_mount_run", 0) < 600:
            return
        trigger = st.pop("next_trigger", None) or "mount"
        save_state(st)
        if trigger == "mount":
            time.sleep(5)  # let Spotlight and the filesystem settle after mount
        return run_mounted(trigger)
    if mode == "weekly":
        if present:
            return run_mounted("weekly")
        st = api("/api/state")
        c = st.get("counts") or {}
        if c.get("approved") or c.get("new"):
            notify("A1 Scout", f"Plug in the A1: {c.get('approved', 0)} approved, {c.get('new', 0)} new picks waiting.")
        return
    if present:
        return run_mounted("manual")
    print("A1 not present")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"ERROR {type(e).__name__}: {e}")
        raise
