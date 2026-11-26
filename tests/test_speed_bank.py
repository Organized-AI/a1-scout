"""Timing-only synthetic bank, including real Qwen3 length verification.

Portable runs verify checked-in counts bound to prompt hashes. On a machine
with the local Qwen3 tokenizer, or SPEED_TOKENIZER_JSON configured, the length
gate also runs the real tokenizer and rebuilds the bank without loading weights.
SPEED_TOKENIZER_PYTHON can select an installed tokenizers environment.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
import bench as B
import speed_bank as S


class SpeedBank(unittest.TestCase):
    def test_agent_lengths_and_chat_have_matched_read_write_probes(self):
        tasks = S.load_bank()
        self.assertEqual(len(tasks), 14)
        self.assertEqual(len({t["id"] for t in tasks}), len(tasks))
        agent = [t for t in tasks if t["workload"] == "agent"]
        self.assertEqual({t["target_prompt_tokens"] for t in agent}, {1000, 4000, 8000, 16000, 32000})
        self.assertEqual(sum(t["workload"] == "chat" for t in tasks), 4)
        pairs = {}
        for t in tasks:
            self.assertEqual(t["type"], "speed")
            self.assertEqual(t["tokenizer"], "Qwen3")
            self.assertEqual(t["max_tokens"], {"prefill": 1, "decode": 256}[t["phase"]])
            pairs.setdefault(t["prompt"], set()).add(t["phase"])
            self.assertFalse(set(t) & {"score", "answer", "gold", "schema"})
        self.assertEqual(len(pairs), 7)
        self.assertTrue(all(phases == {"prefill", "decode"} for phases in pairs.values()))

    def test_no_quality_score_and_quality_suites_unchanged(self):
        self.assertIn("speed", B.SUITES)
        self.assertNotIn("speed", B.QUALITY_SUITES)
        self.assertEqual(B.QUALITY_SUITES, ["gtm-debug", "sql-ga4", "html-json", "rag-notes", "asr", "screen", "gtm-gate", "skill-select", "stape-select"])
        self.assertEqual(B.load_bank("speed"), S.load_bank())
        with self.assertRaisesRegex(ValueError, "no quality score"):
            B.score(S.load_bank()[0], "any output")
        self.assertEqual(B.score({"type": "exact", "answer": "yes"}, "yes")[:2], (True, 1.0))

    def test_hash_is_deterministic_and_covers_jsonl_and_builder(self):
        self.assertEqual(S.bank_hash(), B.bank_hash("speed"))
        original = S.bank_hash()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bank = root / "speed.jsonl"
            bank.write_bytes(S.BANK.read_bytes())
            self.assertEqual(S.bank_hash(root), original)
            bank.write_bytes(bank.read_bytes() + b"\n")
            self.assertNotEqual(S.bank_hash(root), original)
            bank.write_bytes(S.BANK.read_bytes())
            builder = root / "speed_bank.py"
            builder.write_bytes(Path(S.__file__).read_bytes() + b"\n# changed builder\n")
            with mock.patch.object(S, "__file__", str(builder)):
                self.assertNotEqual(S.bank_hash(root), original)

    def test_prompt_builder_is_deterministic_and_validates_inputs(self):
        encode = lambda text: text.split()
        a = S.build_prompt(1000, encode)
        self.assertEqual(a, S.build_prompt(1000, encode))
        self.assertLessEqual(abs(len(encode(a)) - 1000), 20)
        self.assertIn("synthetic", a)
        for n in (None, True, 99, -1, "1000"):
            with self.subTest(n=n), self.assertRaises(ValueError):
                S.build_prompt(n, encode)
        for kwargs in ({"workload": "customer"}, {"topic": "private"}):
            with self.assertRaises(ValueError):
                S.build_prompt(1000, encode, **kwargs)

    def test_loader_rejects_bad_tasks_and_quality_fields(self):
        task = S.load_bank()[0]
        mutations = [{"type": "exact"}, {"id": ""}, {"prompt": ""}, {"phase": "load"},
                     {"workload": "private"}, {"target_prompt_tokens": True}, {"prompt_tokens": 0},
                     {"tokenizer": "guessed"}, {"max_tokens": 256}, {"score": None}, {"answer": "yes"}]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "speed.jsonl"
            for change in mutations:
                path.write_text(json.dumps({**task, **change}) + "\n")
                with self.subTest(change=change), self.assertRaises(ValueError):
                    S.load_bank(Path(tmp))
            for text in ("", json.dumps(task) + "\n" + json.dumps(task)):
                path.write_text(text)
                with self.assertRaises(ValueError):
                    S.load_bank(Path(tmp))

    def test_qwen3_token_counts_within_two_percent(self):
        fixture = json.loads((ROOT / "tests/fixtures/speed_qwen3_counts.json").read_text())
        tasks = S.load_bank()
        self.assertEqual(fixture["tokenizer"], "Qwen3-0.6B")
        self.assertEqual(fixture["encoding"], {"add_special_tokens": False, "chat_template": False})
        self.assertRegex(fixture["tokenizer_sha256"], r"^[a-f0-9]{64}$")
        cases = {c["id"]: c for c in fixture["cases"]}
        self.assertEqual(set(cases), {t["id"] for t in tasks})
        for t in tasks:
            case = cases[t["id"]]
            self.assertEqual(case["prompt_sha256"], hashlib.sha256(t["prompt"].encode()).hexdigest(), t["id"])
            self.assertEqual(case["tokens"], t["prompt_tokens"], t["id"])
            self.assertLessEqual(abs(case["tokens"] - t["target_prompt_tokens"]) / t["target_prompt_tokens"], .02, t["id"])

        tokenizer = Path(os.environ.get("SPEED_TOKENIZER_JSON", "/Volumes/A1/stash/models/mlx/Qwen3-0.6B-4bit/tokenizer.json"))
        if not tokenizer.exists() and "SPEED_TOKENIZER_JSON" not in os.environ:
            print("Speed bank length gate: verified Qwen3 count attestation; local tokenizer unavailable")
            return
        self.assertTrue(tokenizer.is_file(), "Configured tokenizer must exist")
        py = os.environ.get("SPEED_TOKENIZER_PYTHON")
        if not py:
            local = Path.home() / ".nvme-stash/offline-test/bin/python"
            py = str(local) if local.exists() else sys.executable
        script = """
import hashlib,json,sys
from pathlib import Path
from tokenizers import Tokenizer
sys.path.insert(0, sys.argv[1]); import speed_bank
p=Path(sys.argv[2]); tok=Tokenizer.from_file(str(p))
encode=lambda text: tok.encode(text,add_special_tokens=False).ids
tasks=speed_bank.load_bank()
assert speed_bank.build_bank(encode)==tasks, 'Bank differs from deterministic Qwen3 rebuild'
print(json.dumps({'sha':hashlib.sha256(p.read_bytes()).hexdigest(),'counts':{t['id']:len(encode(t['prompt'])) for t in tasks}}))
"""
        run = subprocess.run([py, "-c", script, str(ROOT / "agent"), str(tokenizer)], capture_output=True, text=True, timeout=120)
        self.assertEqual(run.returncode, 0, run.stderr)
        real = json.loads(run.stdout)
        self.assertEqual(real["sha"], fixture["tokenizer_sha256"])
        self.assertEqual(real["counts"], {c["id"]: c["tokens"] for c in fixture["cases"]})
        print(f"Speed bank length gate: real Qwen3 tokenizer verified {len(tasks)} prompts and deterministic rebuild")


if __name__ == "__main__":
    unittest.main()
