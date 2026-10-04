"""A1 Bench runner: loads ONE model, answers every task on stdin, prints JSON lines, exits.

    <mlx venv>/bin/python bench_runner.py --model /Volumes/A1/stash/models/mlx/Qwen3-4B-4bit --kind llm|vlm|asr < tasks.json

stdin:  {"tasks": [{"id", "prompt", "max_tokens", "audio"?}]}
stdout: {"event": "loaded", "load_s", "runtime"}, then {"event": "result", "id", "output", "ttft_ms", "tok_s", "latency_ms"}
        per task, then {"event": "done", "mlx_peak"}; {"event": "error", "error"} if the model can't load.
Greedy decoding, thinking off where the chat template allows it. bench.py scores the outputs; this file only runs them.
"""
import argparse, json, sys, time


def emit(**ev):
    print(json.dumps(ev), flush=True)


def chat_prompt(tok, prompt):
    msgs = [{"role": "user", "content": prompt}]
    if not getattr(tok, "chat_template", None):
        return prompt
    try:
        return tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False, enable_thinking=False)
    except TypeError:
        return tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False)


def stream_timed(gen):
    """Run a streaming generator; return text, time to first token and the decode rate it reports."""
    t0 = time.perf_counter()
    ttft, text, last = None, "", None
    for r in gen:
        if ttft is None:
            ttft = (time.perf_counter() - t0) * 1000
        text += r.text or ""
        last = r
    return text, ttft, getattr(last, "generation_tps", None), (time.perf_counter() - t0) * 1000


def load_text(path, kind):
    """(runtime name, answer(prompt, max_tokens) -> (text, ttft_ms, tok_s, latency_ms)). VLMs try mlx_vlm first."""
    order = ["mlx_vlm", "mlx_lm"] if kind == "vlm" else ["mlx_lm", "mlx_vlm"]
    errors = []
    for rt in order:
        try:
            if rt == "mlx_lm":
                from mlx_lm import load, stream_generate
                model, tok = load(path)
                return rt, lambda p, n: stream_timed(stream_generate(model, tok, chat_prompt(tok, p), max_tokens=n))
            from mlx_vlm import load, stream_generate
            from mlx_vlm.prompt_utils import apply_chat_template
            model, proc = load(path)
            cfg = model.config

            def answer(p, n):
                try:
                    fp = apply_chat_template(proc, cfg, p, num_images=0, enable_thinking=False)
                except TypeError:
                    fp = apply_chat_template(proc, cfg, p, num_images=0)
                return stream_timed(stream_generate(model, proc, fp, max_tokens=n, temperature=0.0))
            return rt, answer
        except Exception as e:
            errors.append(f"{rt}: {type(e).__name__}: {e}"[:300])
    raise RuntimeError(" | ".join(errors))


def read_wav(path):
    import wave
    import numpy as np
    with wave.open(path) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def load_asr(path):
    """mlx_whisper for the mlx-examples layout (weights.safetensors or weights.npz), mlx_audio for everything else."""
    from pathlib import Path
    if (Path(path) / "weights.safetensors").exists() or (Path(path) / "weights.npz").exists():
        import mlx_whisper
        from mlx_whisper.transcribe import ModelHolder
        import mlx.core as mx
        ModelHolder.get_model(path, mx.float16)          # load now so load_s is the load, not the first transcription
        return "mlx_whisper", lambda audio: mlx_whisper.transcribe(read_wav(audio), path_or_hf_repo=path, language="en")["text"]
    from mlx_audio.stt.utils import load_model
    m = load_model(path)
    return "mlx_audio", lambda audio: m.generate(audio).text


def peak():
    try:
        import mlx.core as mx
        return int(mx.get_peak_memory())
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--kind", choices=["llm", "vlm", "asr"], default="llm")
    a = ap.parse_args()
    tasks = json.load(sys.stdin)["tasks"]
    t0 = time.perf_counter()
    try:
        if a.kind == "asr":
            runtime, transcribe = load_asr(a.model)
        else:
            runtime, answer = load_text(a.model, a.kind)
    except Exception as e:
        emit(event="error", error=f"load failed: {e}"[:500])
        return 3
    emit(event="loaded", load_s=round(time.perf_counter() - t0, 3), runtime=runtime)
    for t in tasks:
        try:
            if a.kind == "asr":
                s = time.perf_counter()
                text = transcribe(t["audio"])
                emit(event="result", id=t["id"], output=text.strip(), ttft_ms=None, tok_s=None,
                     latency_ms=round((time.perf_counter() - s) * 1000, 1))
            else:
                text, ttft, tps, lat = answer(t["prompt"], t.get("max_tokens", 256))
                emit(event="result", id=t["id"], output=text, ttft_ms=round(ttft, 1) if ttft is not None else None,
                     tok_s=round(tps, 2) if tps else None, latency_ms=round(lat, 1))
        except Exception as e:
            emit(event="result", id=t["id"], output=None, error=f"{type(e).__name__}: {e}"[:300])
    emit(event="done", mlx_peak=peak())
    return 0


if __name__ == "__main__":
    sys.exit(main())
