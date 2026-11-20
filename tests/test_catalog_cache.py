"""Reading the drive: build_catalog measures an item only when it changed, keeping sizes on the A1 (stash/.a1scout/sizes.json).

    cd ~/nvme-stash/a1-scout && python3 -m unittest tests.test_catalog_cache -v

A temporary folder stands in for the A1; walk_stats is wrapped to count which items get walked.
"""
import json, os, sys, tempfile, time, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import agent as A  # noqa: E402


def write(p: Path, data="x"):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(data)


def bump(p: Path, secs=5):
    """Move p's mtime forward, as a write would (exFAT keeps 10 ms steps, so tests don't rely on two writes differing)."""
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + secs * 1_000_000_000))


class ReadTheDrive(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self._g = (A.MOUNT, A.STASH, A.STATE_DIR, A.log, A.walk_stats)
        A.MOUNT, A.STASH, A.STATE_DIR = root, root / "stash", root / "state"
        A.log = lambda *a, **k: None
        s = A.STASH
        write(s / "models/mlx/Qwen3-4B-4bit/config.json", json.dumps({"model_type": "qwen3"}))
        write(s / "models/mlx/Qwen3-4B-4bit/model.safetensors", "w" * 4000)
        write(s / "models/mlx/Qwen3-4B-4bit/.verified", json.dumps({"revision": "aaa"}))
        for i in range(30):
            write(s / f"datasets/raw/traces/data/part-{i:03d}.jsonl", "{}\n" * 10)
        write(s / "datasets/raw/traces/data/schema.parquet", "p" * 100)
        write(s / "datasets/raw/traces/README.md", "---\nlicense: mit\n---\nAgent traces.\n")
        write(s / "datasets/raw/traces/._README.md", "appledouble")       # exFAT sidecars never count
        write(s / "spaces/trace-viewer/app.py", "print(1)")
        write(s / "papers/2611.00001.pdf", "%PDF" * 10)
        write(s / "manifests/scout-2026-11-20.sha256", "abc  x\n")
        self.walked = []
        real = self._g[4]
        A.walk_stats = lambda p, tick=None: (self.walked.append(str(Path(p).relative_to(A.STASH))), real(p, tick))[1]

    def tearDown(self):
        A.MOUNT, A.STASH, A.STATE_DIR, A.log, A.walk_stats = self._g
        self.tmp.cleanup()

    def items(self, c):
        return {i["path"]: i for cat in c["categories"] for i in cat["items"]}

    def read(self, **kw):
        self.walked = []
        return A.build_catalog(**kw)

    def test_first_read_measures_everything_then_the_cache_answers(self):
        first = self.read()
        dirs = {"models/mlx/Qwen3-4B-4bit", "datasets/raw/traces", "spaces/trace-viewer", "manifests"}
        self.assertTrue(dirs <= set(self.walked))
        self.assertEqual(first["read"]["cached"], 0)
        self.assertTrue((A.STASH / ".a1scout/sizes.json").is_file())

        second = self.read()
        # Only manifests (appended to in place) and single files (one stat each) are looked at again.
        self.assertEqual(set(self.walked), {"manifests", "papers/2611.00001.pdf"})
        self.assertEqual(second["read"]["measured"], 1)
        self.assertEqual(second["read"]["cached"], 3)
        a, b = self.items(first), self.items(second)
        for p in a:
            self.assertEqual((a[p]["bytes"], a[p]["files"], a[p]["meta"]), (b[p]["bytes"], b[p]["files"], b[p]["meta"]), p)

    def test_a_dataset_is_walked_once_and_its_formats_survive_the_cache(self):
        c = self.read()
        self.assertEqual(self.walked.count("datasets/raw/traces"), 1)
        ds = self.items(c)["datasets/raw/traces"]
        self.assertEqual(ds["meta"]["formats"], {"jsonl": 30, "parquet": 1})
        self.assertEqual(ds["files"], 32)                                   # 30 jsonl + parquet + README, not ._README
        self.assertEqual(self.items(self.read())["datasets/raw/traces"]["meta"]["formats"], {"jsonl": 30, "parquet": 1})

    def test_a_download_or_update_rewrites_verified_so_that_item_is_measured_again(self):
        self.read()
        m = A.STASH / "models/mlx/Qwen3-4B-4bit"
        write(m / "model.safetensors", "w" * 9000)
        write(m / ".verified", json.dumps({"revision": "bbb", "updated_from": "aaa"}))
        bump(m / ".verified")
        c = self.read()
        self.assertIn("models/mlx/Qwen3-4B-4bit", self.walked)
        self.assertNotIn("datasets/raw/traces", self.walked)
        self.assertEqual(self.items(c)["models/mlx/Qwen3-4B-4bit"]["bytes"], 9000 + len(json.dumps({"revision": "bbb", "updated_from": "aaa"})) + len(json.dumps({"model_type": "qwen3"})))

    def test_a_changed_folder_is_measured_again(self):
        self.read()
        d = A.STASH / "spaces/trace-viewer"
        write(d / "requirements.txt", "gradio")
        bump(d)
        c = self.read()
        self.assertIn("spaces/trace-viewer", self.walked)
        self.assertEqual(self.items(c)["spaces/trace-viewer"]["files"], 2)

    def test_new_items_are_measured_and_deleted_ones_leave_the_cache(self):
        self.read()
        write(A.STASH / "spaces/new-app/app.py", "print(2)")
        import shutil
        shutil.rmtree(A.STASH / "datasets/raw/traces")
        c = self.read()
        self.assertIn("spaces/new-app", self.walked)
        self.assertNotIn("datasets/raw/traces", self.items(c))
        cached = json.loads((A.STASH / ".a1scout/sizes.json").read_text())["items"]
        self.assertIn("spaces/new-app", cached)
        self.assertNotIn("datasets/raw/traces", cached)

    def test_entries_expire_after_about_a_week_spread_by_path(self):
        self.read()
        f = A.STASH / ".a1scout/sizes.json"
        d = json.loads(f.read_text())
        d["items"]["datasets/raw/traces"]["at"] = time.time() - 11 * 86400     # past 7 + up to 3 days
        d["items"]["spaces/trace-viewer"]["at"] = time.time() - 6 * 86400      # not yet
        f.write_text(json.dumps(d))
        self.read()
        self.assertIn("datasets/raw/traces", self.walked)
        self.assertNotIn("spaces/trace-viewer", self.walked)
        ttls = {A.Sizes(f).ttl(p) for p in ("a", "b", "c", "d", "e")}
        self.assertTrue(all(7 * 86400 <= t < 10 * 86400 for t in ttls) and len(ttls) > 1)

    def test_full_re_measures_everything(self):
        self.read()
        c = self.read(full=True)
        self.assertEqual(c["read"]["cached"], 0)
        self.assertTrue(c["read"]["full"])
        self.assertIn("datasets/raw/traces", self.walked)

    def test_a_broken_or_unwritable_cache_never_stops_the_read(self):
        (A.STASH / ".a1scout").mkdir(parents=True)
        (A.STASH / ".a1scout/sizes.json").write_text("{not json")
        c = self.read()
        self.assertEqual(c["read"]["cached"], 0)
        (A.STASH / ".a1scout/sizes.json").unlink()
        (A.STASH / ".a1scout").rmdir()
        (A.STASH / ".a1scout").write_text("a file where the folder should be")
        c = self.read()
        self.assertIn("datasets/raw/traces", self.items(c))

    def test_the_cache_folder_is_not_on_the_drive_map(self):
        self.read()
        c = self.read()
        self.assertFalse(any(".a1scout" in p for p in self.items(c)))

    def test_progress_names_each_section_and_long_walks_report_files(self):
        seen = []
        self.read(progress=lambda s, i, n, files: seen.append((s, i, n, files)))
        self.assertIn(("datasets", 1, 1, None), seen)
        self.assertIn(("models", 1, 1, None), seen)
        ticks = []
        real = self._g[4]
        real(A.STASH / "datasets/raw/traces", tick=ticks.append)
        self.assertEqual(ticks, [])                                         # under 5,000 files: no ticks
        for i in range(5000):
            (A.STASH / f"datasets/raw/big/f{i}.json").parent.mkdir(parents=True, exist_ok=True)
            (A.STASH / f"datasets/raw/big/f{i}.json").write_text("{}")
        real(A.STASH / "datasets/raw/big", tick=ticks.append)
        self.assertEqual(ticks, [5000])


if __name__ == "__main__":
    unittest.main()
