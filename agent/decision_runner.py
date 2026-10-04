"""A1 Bench runner for decision models: loads ONE model, answers every /v1/systemone request on stdin, exits.

    <venv>/bin/python decision_runner.py --model /Volumes/A1/stash/models/mlx/clef-flash-4bit --kind clef|kev|kev-mlx < tasks.json

Same protocol as bench_runner.py. Each task carries "state" and "questions"; the output is the JSON of the answers.
Families:
  clef     Cloudflare Clef / Clef-flash MLX repos (clef_mlx.py inside the model folder). Venv: ~/.nvme-stash/venvs/clef
  kev      Jared Palmer's Kev adapters (head.pt + adapter). The Qwen3.5 base is read from the stash, never the network.
           Venv: ~/.nvme-stash/venvs/kev, code from /Volumes/A1/stash/code/kev
  kev-mlx  A Kev checkpoint already merged and quantized for MLX (config.json + model.safetensors + head.pt)
tok_s in each result carries questions per second, ttft_ms the time for the whole request (one change, all its questions).
bench.py scores the answers; this file only runs them.
"""
import argparse, json, os, sys, time
from pathlib import Path

STASH = Path(os.environ.get("A1_STASH", "/Volumes/A1/stash"))


def emit(**ev):
    print(json.dumps(ev), flush=True)


def local_hub(repo):
    """A Hub id like Qwen/Qwen3.5-0.8B-Base[@rev] -> its copy in the stash, or None."""
    name = str(repo).split("@")[0].split("/")[-1]
    for root in ("models/hf", "models/mlx", "models"):
        p = STASH / root / name
        if name and p.is_dir():
            return str(p)
    return None


def load_clef(path):
    sys.path.insert(0, path)
    import clef_mlx
    m = clef_mlx.load(path)
    return "clef_mlx", lambda req: m.systemone({"model": Path(path).name, **req})


def _kev_imports():
    """Kev's code from the stash, with Hub lookups for the base model and tokenizer pointed at the stash copies."""
    sys.path.insert(0, str(STASH / "code" / "kev"))
    import kev.checkpoint as C, kev.model as M
    orig_resolve, orig_tok = C.resolve_run, M.load_tokenizer

    def resolve(run):
        return run if os.path.isdir(str(run)) else (local_hub(run) or orig_resolve(run))

    def tokenizer(name, revision=None):
        p = local_hub(name) if not os.path.isdir(str(name)) else str(name)
        return orig_tok(p) if p else orig_tok(name, revision=revision)
    C.resolve_run, C.load_tokenizer, M.load_tokenizer = resolve, tokenizer, tokenizer
    return C, M


def _kev_answer(tok, model, run, device):
    from kev.serve import Server
    from kev.api import SystemOneRequest
    import kev.checkpoint as C
    srv = Server(C.Checkpoint(run), tok, model, device, release_date="local")
    return lambda req: srv.answer(SystemOneRequest(model="kev-latest", **req))


def load_kev(path):
    C, M = _kev_imports()
    from kev.device import default_device
    device = default_device()
    tok, model = C.Checkpoint(path).load(device)
    return "kev", _kev_answer(tok, model, path, device)


def load_kev_mlx(path):
    """Merged + quantized Kev (e.g. RoderickQiu/kev-4b-mlx-8bit): the weights load with Kev's own MLX model class, the
    pointer head and temperature come from the head.pt shipped beside them, the tokenizer from the same folder."""
    C, M = _kev_imports()
    from kev.mlx_model import MLXDecisionModel
    from kev.model import PointerHead
    meta = C.read_meta(path)
    tok = M.load_tokenizer(path) if (Path(path) / "tokenizer.json").exists() else M.load_tokenizer(meta.base, meta.base_revision)
    model = MLXDecisionModel(path, M.pad_id(tok), head_dim=meta.head_dim)
    model.head = PointerHead(model.text.embed_tokens.dims, dp=meta.head_dim).eval()
    model.head.load_state_dict(meta.head)
    model.head.temperature = meta.temperature
    return "kev-mlx", _kev_answer(tok, model, path, "mps")


LOADERS = {"clef": load_clef, "kev": load_kev, "kev-mlx": load_kev_mlx}


def peak():
    try:
        import mlx.core as mx
        return int(mx.get_peak_memory())
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--kind", choices=sorted(LOADERS), required=True)
    a = ap.parse_args()
    tasks = json.load(sys.stdin)["tasks"]
    t0 = time.perf_counter()
    try:
        runtime, answer = LOADERS[a.kind](a.model)
    except Exception as e:
        emit(event="error", error=f"load failed: {type(e).__name__}: {e}"[:500])
        return 3
    emit(event="loaded", load_s=round(time.perf_counter() - t0, 3), runtime=runtime)
    for t in tasks:
        try:
            s = time.perf_counter()
            body = answer({"state": t["state"], "questions": t["questions"]})
            lat = (time.perf_counter() - s) * 1000
            n = max(1, len(t["questions"]))
            emit(event="result", id=t["id"], output=json.dumps(body.get("answers", body)), ttft_ms=round(lat, 1),
                 tok_s=round(n / (lat / 1000), 2) if lat > 0 else None, latency_ms=round(lat, 1))
        except Exception as e:
            emit(event="result", id=t["id"], output=None, error=f"{type(e).__name__}: {e}"[:300])
    emit(event="done", mlx_peak=peak())
    return 0


if __name__ == "__main__":
    sys.exit(main())
