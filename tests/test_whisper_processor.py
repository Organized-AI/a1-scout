"""Whisper repos converted with mlx-audio get their processor files from the base model, so they load offline.

    cd ~/nvme-stash/a1-scout && python3 -m unittest tests.test_whisper_processor -v
"""
import json, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
import agent as A  # noqa: E402

INFO = {"mlx-community/whisper-large-v3-turbo-4bit": {"cardData": {"base_model": ["openai/whisper-large-v3-turbo"]}},
        "openai/whisper-large-v3-turbo": {"sha": "41f01f3f"}}


class Processor(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.d = Path(self.tmp.name) / "whisper-large-v3-turbo-4bit"; self.d.mkdir()
        (self.d / "config.json").write_text(json.dumps({"model_type": "whisper"}))
        (self.d / "model.safetensors").write_bytes(b"w")
        self.urls = []

    def tearDown(self):
        self.tmp.cleanup()

    def get_json(self, url):
        return INFO.get(url.split("/api/models/")[1])

    def get_file(self, url, out):
        self.urls.append(url); out.write_text("{}"); return True

    def test_fetches_processor_files_from_the_pinned_base(self):
        base = A.complete_whisper_processor(self.d, "mlx-community/whisper-large-v3-turbo-4bit", self.get_json, self.get_file)
        self.assertEqual(base, "openai/whisper-large-v3-turbo")
        self.assertTrue((self.d / "preprocessor_config.json").exists())
        self.assertTrue(all("/openai/whisper-large-v3-turbo/resolve/41f01f3f/" in u for u in self.urls))
        self.assertEqual(json.loads((self.d / ".processor-source.json").read_text())["revision"], "41f01f3f")

    def test_never_overwrites_existing_files(self):
        (self.d / "tokenizer.json").write_text("mine")
        A.complete_whisper_processor(self.d, "mlx-community/whisper-large-v3-turbo-4bit", self.get_json, self.get_file)
        self.assertEqual((self.d / "tokenizer.json").read_text(), "mine")
        self.assertFalse(any(u.endswith("/tokenizer.json") for u in self.urls))

    def test_leaves_complete_and_mlx_whisper_layouts_alone(self):
        (self.d / "weights.safetensors").write_bytes(b"w")
        self.assertIsNone(A.complete_whisper_processor(self.d, "mlx-community/whisper-large-v3-turbo", self.get_json, self.get_file))
        self.assertEqual(self.urls, [])

    def test_non_whisper_models_are_untouched(self):
        (self.d / "config.json").write_text(json.dumps({"model_type": "qwen3"}))
        self.assertIsNone(A.complete_whisper_processor(self.d, "mlx-community/Qwen3-4B-4bit", self.get_json, self.get_file))
        self.assertEqual(self.urls, [])


if __name__ == "__main__":
    unittest.main()
