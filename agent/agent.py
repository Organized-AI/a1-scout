#!/usr/bin/env python3
"""a1-scout Mac agent.

Fires when any volume mounts (launchd StartOnMount) and once a week on a timer.
When the A1 drive (matched by volume UUID, not just name) is present it:
  1. sends the Organized-AI repo list and the stash inventory to the scout Worker,
  2. asks for a fresh Hub scan if the last one is older than 6 days,
  3. downloads approved picks into /Volumes/A1/stash (never deletes, never writes outside it),
  4. rebuilds the drive catalog behind the map view, and
  5. shows a macOS notification with what changed.
When the A1 is not present on the weekly timer, it only reminds you to plug it in.

Usage: agent.py [mount|weekly|now|catalog|status]
"""
import fcntl, hashlib, json, os, re, shutil, subprocess, sys, time, urllib.request
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


def hub(path):
    req = urllib.request.Request("https://huggingface.co/api" + path, headers={"user-agent": "a1-scout-agent"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


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
                key = tgt or ("models/mlx/" if p.get("type") == "model" else "datasets/raw/") + p["repo"].split("/")[-1]
                prov.setdefault(key.strip("/"), {"repo": p["repo"], "revision": p.get("revision"), "title": p.get("title")})
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

    misc = []
    if (STASH / "manifests").is_dir():
        misc.append(item("manifests", "manifests", "manifests", STASH / "manifests", {}, ""))
    scripts = [f for f in list((STASH / "scripts").glob("*.py")) + list(STASH.glob("*.py")) if not f.name.startswith(".")]
    for f in scripts:
        misc.append(item(f.name, str(f.relative_to(STASH)), "script", f, {}, ""))
    cat("tooling", "Manifests & scripts", misc)

    known = {"models", "datasets", "spaces", "code", "papers", "runs", "wheels", "corpora", "manifests", "scripts"}
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


def fetch_approved():
    picks = api("/api/picks?status=approved")
    who = sh(["hf", "auth", "whoami"])
    hf_logged_in = who.returncode == 0 and "Not logged in" not in (who.stdout + who.stderr)
    cap = float(ENV["RUN_CAP_GB"]) * 1e9
    floor = float(ENV["FREE_FLOOR_GB"]) * 1e9
    spent, done, waiting = 0, [], []
    today = datetime.now().strftime("%Y-%m-%d")
    pins_file = STASH / "manifests/scout-pins.json"
    for p in picks:
        dest = dest_for(p)
        if not dest or not inside_stash(dest):
            waiting.append((p["repo"], "no safe destination")); continue
        if "gated" in p.get("flags", []) and not hf_logged_in:
            waiting.append((p["repo"], "gated: run `hf auth login` once, then it downloads next mount")); continue
        size = p.get("size_bytes") or hub_size(p) or 0
        if spent + size > cap:
            waiting.append((p["repo"], f"over this run's {ENV['RUN_CAP_GB']} GB cap")); continue
        if free_bytes() - size < floor:
            waiting.append((p["repo"], f"would leave under {ENV['FREE_FLOOR_GB']} GB free")); continue

        log(f"downloading {p['kind']} {p['repo']} @ {(p.get('sha') or 'latest')[:10]} -> {dest.relative_to(STASH)} (~{size/1e9:.2f} GB)")
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
            r = sh(args)
            ok = r.returncode == 0
            if not ok:
                log(f"  hf download failed: {(r.stderr or r.stdout)[-400:]}")
        if not ok:
            waiting.append((p["repo"], "download failed; retries next mount")); continue

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
                     "bytes": got, "title": p.get("title"), "added": today, "score": p.get("score")})
        pins_file.write_text(json.dumps(pins, indent=2))
        api("/api/stashed", "POST", {"id": p["id"], "sha": p.get("sha"), "path": str(dest.relative_to(STASH)), "size_bytes": got})
        done.append((p["repo"], got))
        log(f"  stashed {got/1e9:.2f} GB")
    return done, waiting


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


def run_mounted(trigger):
    log(f"A1 present ({trigger}); stash at {STASH}")
    catalog = build_catalog()
    push_catalog(catalog)
    push_profile(catalog)
    scan = api("/api/scan?if_stale=1&trigger=mount", "POST")
    if "skipped" in scan:
        log(f"scan skipped: {scan['skipped']}")
    else:
        log(f"scan: {scan.get('candidates')} candidates, {scan.get('new_picks')} new, {scan.get('auto_approved')} auto-approved, errors={len(scan.get('errors', []))}")
    done, waiting = fetch_approved()
    if done:
        catalog = build_catalog()
        push_catalog(catalog)
    st = api("/api/state")
    new = (st.get("counts") or {}).get("new", 0)
    parts = []
    if done:
        parts.append(f"Added {len(done)} ({sum(b for _, b in done)/1e9:.1f} GB): " + ", ".join(r.split('/')[-1] for r, _ in done[:3]))
    if waiting:
        parts.append(f"{len(waiting)} approved waiting")
    parts.append(f"{new} new picks to review")
    notify("A1 Scout", " · ".join(parts))
    for r, why in waiting:
        log(f"  waiting: {r} ({why})")
    s = load_state(); s["last_mount_run"] = time.time(); save_state(s)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "now"
    STATE_DIR.mkdir(exist_ok=True)
    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("another a1-scout run is active"); return
    present = a1_present()
    if mode == "status":
        print(json.dumps({"a1_present": present, "state": load_state(), "server": api("/api/state")}, indent=2)); return
    if mode == "catalog":
        if not present:
            print("A1 not present"); return
        c = build_catalog(); push_catalog(c); print(json.dumps({c_["id"]: len(c_["items"]) for c_ in c["categories"]})); return
    if mode == "mount":
        # launchd fires this on every volume mount; only act for the A1, and not twice in 10 minutes.
        if not present:
            return
        if time.time() - load_state().get("last_mount_run", 0) < 600:
            return
        time.sleep(5)  # let Spotlight and the filesystem settle after mount
        return run_mounted("mount")
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
