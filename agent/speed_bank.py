"""Synthetic Speed Lab prompts; timing only, never a quality leaderboard.

Rebuild with an already installed Qwen3 tokenizer (no downloads):
  python agent/speed_bank.py --tokenizer /path/to/Qwen3/tokenizer.json
Stored token lengths count prompt text without a chat template. Runtime/server
usage is authoritative for the actual templated request and other tokenizers.
"""
import argparse
import hashlib
import json
from pathlib import Path

BANK = Path(__file__).resolve().parents[1] / "tests" / "bench" / "speed.jsonl"
TOKENIZER = "Qwen3"
AGENT_LENGTHS = (1000, 4000, 8000, 16000, 32000)


def build_prompt(target_tokens, encode, workload="agent", topic="release"):
    """Deterministic synthetic context, calibrated with the supplied tokenizer.

    Add complete synthetic records, then a short neutral tail. Binary search
    bounds tokenizer work at large lengths; exact counts are not guessed from
    characters or words. `encode` returns a sequence of token IDs.
    """
    if not isinstance(target_tokens, int) or isinstance(target_tokens, bool) or target_tokens < 100:
        raise ValueError("target_tokens must be an integer of at least 100")
    if workload not in ("agent", "chat") or topic not in ("release", "garden"):
        raise ValueError("unknown synthetic workload or topic")
    if workload == "agent":
        head = ("You are reviewing a synthetic software release. Read the project notes, test results and change records.\n"
                "Write a practical release checklist. All names, files and records below are invented.\n\n")
        record = ("Module example: validate input, preserve existing output, document the public interface. "
                  "Test fixture: accepted input returns a stable JSON object; invalid input reports a clear error. "
                  "Release note: check dependencies, run the tests, review the diff and record remaining work.\n")
    else:
        head = f"Discuss this fictional {'community garden' if topic == 'garden' else 'weekend project'} with a friend.\n\n"
        record = ("We have a small team, a limited budget and a few free afternoons. "
                  "Our plan should be easy to explain, leave room for questions and include useful next steps.\n")
    tail = "\nNow write your response from these notes. /no_think"
    count = lambda text: len(encode(text))
    if count(head + tail) > target_tokens:
        raise ValueError("target too short for prompt instructions")
    lo, hi = 0, target_tokens
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if count(head + record * mid + tail) <= target_tokens:
            lo = mid
        else:
            hi = mid - 1
    body = head + record * lo
    # Qwen3 tokenizes each neutral padding word independently; other encoders
    # may differ, so validate the result rather than assuming that behavior.
    padding = ""
    while count(body + padding + " detail" + tail) <= target_tokens:
        padding += " detail"
        if len(padding) > target_tokens * 10:
            raise ValueError("tokenizer does not advance on padding")
    prompt = body + padding + tail
    if abs(count(prompt) - target_tokens) / target_tokens > 0.02:
        raise ValueError("tokenizer cannot calibrate this prompt within 2 percent")
    return prompt


def build_bank(encode):
    """One-token reading probes and 256-token writing probes on identical text."""
    tasks = []
    cases = [("agent", "release", n) for n in AGENT_LENGTHS]
    cases += [("chat", topic, 500) for topic in ("release", "garden")]
    for workload, topic, n in cases:
        prompt = build_prompt(n, encode, workload, topic)
        for phase, maximum in (("prefill", 1), ("decode", 256)):
            tasks.append({"id": f"speed-{workload}-{topic}-{n}-{phase}", "type": "speed",
                          "workload": workload, "phase": phase, "target_prompt_tokens": n,
                          "prompt_tokens": len(encode(prompt)), "tokenizer": TOKENIZER,
                          "max_tokens": maximum, "prompt": prompt})
    return tasks


def load_bank(root=None):
    path = BANK if root is None else Path(root) / "speed.jsonl"
    tasks, seen = [], set()
    for n, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        t = json.loads(line)
        if (not isinstance(t, dict) or t.get("type") != "speed" or not isinstance(t.get("id"), str)
                or not t["id"] or t["id"] in seen or not isinstance(t.get("prompt"), str) or not t["prompt"]
                or t.get("phase") not in ("prefill", "decode") or t.get("workload") not in ("agent", "chat")
                or type(t.get("target_prompt_tokens")) is not int or t["target_prompt_tokens"] <= 0
                or type(t.get("prompt_tokens")) is not int or t["prompt_tokens"] <= 0
                or t.get("tokenizer") != TOKENIZER
                or type(t.get("max_tokens")) is not int
                or t["max_tokens"] != (1 if t["phase"] == "prefill" else 256)
                or any(k in t for k in ("score", "answer", "gold", "schema"))):
            raise ValueError(f"speed.jsonl line {n}: invalid timing-only task")
        seen.add(t["id"])
        tasks.append(t)
    if not tasks:
        raise ValueError("speed.jsonl has no tasks")
    return tasks


def bank_hash(root=None):
    """Prompt-builder changes invalidate measurements even if JSONL is unchanged."""
    path = BANK if root is None else Path(root) / "speed.jsonl"
    h = hashlib.sha256(path.read_bytes())
    h.update(Path(__file__).read_bytes())
    return h.hexdigest()[:12]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tokenizer", required=True, type=Path)
    ap.add_argument("--output", type=Path, default=BANK)
    args = ap.parse_args()
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(str(args.tokenizer))
    tasks = build_bank(lambda text: tok.encode(text, add_special_tokens=False).ids)
    args.output.write_text("".join(json.dumps(t, ensure_ascii=False) + "\n" for t in tasks))
    print(f"Wrote {len(tasks)} timing-only tasks to {args.output}")


if __name__ == "__main__":
    main()
