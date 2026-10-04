// Lab x Bench: measured numbers replace estimates when a model has bench runs, and estimates stay otherwise.
//   cd ~/nvme-stash/a1-scout && node --test tests/lab_bench.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = f => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const ctx = { window: {}, document: { head: { appendChild() {} }, createElement: () => ({}), querySelector: () => null, querySelectorAll: () => [] },
  matchMedia: () => ({ matches: true }), console };
ctx.window.window = ctx.window; Object.assign(ctx, ctx.window);
vm.createContext(ctx);
vm.runInContext(read("public/bench.js"), ctx);
vm.runInContext(read("public/lab.js"), ctx);
const { LabView: Lab, BenchView: Bench } = ctx.window;

const SMALL = "models/mlx/Qwen3-0.6B-4bit", BIG = "models/mlx/Qwen3-4B-4bit";
const catalog = { categories: [{ id: "models", items: [
  { name: "Qwen3-0.6B-4bit", path: SMALL, type: "llm", bytes: 0.34e9, meta: {} },
  { name: "Qwen3-4B-4bit", path: BIG, type: "llm", bytes: 2.26e9, meta: {} },
  { name: "Qwen3-Embedding-0.6B-4bit-DWQ", path: "models/mlx/Qwen3-Embedding-0.6B-4bit-DWQ", type: "embedding", bytes: 0.34e9, meta: {} }] }] };
const row = (over) => ({ id: 1, suite: "rag-notes", machine: "m1", model: "Qwen3-4B-4bit", model_path: BIG, tok_s: 31.5, ttft_ms: 400,
  load_s: 2.5, peak_rss: 3.1e9, passed: 7, total: 8, score: 0.9, ...over });

test("without bench runs, the Lab keeps its estimates", () => {
  Bench.setData({ rows: [] });
  Lab._setCatalog(catalog, []);
  const e = Lab.evaluate({ tpl: "rag", sc: "purch", mach: "m1", pick: { llm: BIG } });
  const llm = e.stages.find(s => s.slot.id === "llm");
  assert.equal(llm.measured, false);
  assert.ok(Math.abs(llm.tps - Math.min(150, 0.6 * 200e9 / 2.26e9)) < 1e-6);
  assert.equal(llm.load, 2.26e9 / 0.9e9);
  assert.equal(e.tests.find(t => t.id === "quality").st, "pending");
  assert.match(e.tests.find(t => t.id === "quality").why, /agent\.py bench rag-notes/);
});

test("measured tok/s, load time, memory and pass rate replace the estimates on the same Mac", () => {
  Bench.setData({ rows: [row(), row({ id: 2, suite: "sql-ga4", tok_s: 33.5, passed: 2, total: 10, score: 0.3 })] });
  Lab._setCatalog(catalog, []);
  const e = Lab.evaluate({ tpl: "rag", sc: "purch", mach: "m1", pick: { llm: BIG } });
  const llm = e.stages.find(s => s.slot.id === "llm");
  assert.equal(llm.measured, true);
  assert.equal(llm.tps, 31.5);                          // median across this model's suites on m1
  assert.match(llm.what, /measured/);
  assert.equal(llm.load, 2.5);
  assert.ok(Math.abs(e.peak - 3.1e9) < 1);             // measured RSS already includes the runtime
  const q = e.tests.find(t => t.id === "quality");
  assert.equal(q.st, "pass");                           // 7 of 8 on rag-notes
  assert.match(q.why, /7 of 8/);
  assert.match(q.why, /M1 16GB|M1 Pro 16GB/);
  const sql = Lab.evaluate({ tpl: "sql", sc: "daily", mach: "m1", pick: { sqlm: BIG } });
  assert.equal(sql.tests.find(t => t.id === "quality").st, "fail");   // 2 of 10 on sql-ga4
});

test("speed measured on another Mac is not borrowed; memory is", () => {
  Bench.setData({ rows: [row({ machine: "m5p", tok_s: 120 })] });
  Lab._setCatalog(catalog, []);
  const e = Lab.evaluate({ tpl: "rag", sc: "purch", mach: "m1", pick: { llm: BIG } });
  const llm = e.stages.find(s => s.slot.id === "llm");
  assert.equal(llm.measured, false);
  assert.ok(Math.abs(e.peak - 3.1e9) < 1);
});

test("Bench view renders an empty state and a leaderboard", () => {
  Bench.setData({ rows: [], suites: [], machines: [] });
  assert.match(Bench.html(), /No .* runs/);
  Bench.setData({ rows: [row(), row({ id: 3, model: "Qwen3-0.6B-4bit", model_path: SMALL, score: 0.5, passed: 4 })],
    suites: [{ id: "rag-notes", models: 2 }], machines: [{ machine: "m1", n: 2 }] });
  const h = Bench.html();
  assert.ok(h.indexOf("Qwen3-4B-4bit") < h.indexOf("Qwen3-0.6B-4bit"));
  assert.match(h, /7\/8 pass/);
  assert.match(h, /M1 Pro 16GB/);
});

test("the Lab's default part is the bench's pick for that job; without one it guesses smallest-that-fits", () => {
  Bench.setData({ rows: [], best: {} });
  Lab._setCatalog(catalog, []);
  assert.equal(Lab._defaults("rag").pick.llm, SMALL);
  Bench.setData({ rows: [row()], best: { "rag-notes": { m1: { model: "Qwen3-4B-4bit", model_path: BIG, score: 0.9 } } } });
  assert.equal(Lab._defaults("rag").pick.llm, BIG);
  assert.equal(Lab._defaults("route").pick.work, SMALL);          // no suite covers routing: unchanged
  // a pick for another Mac, or for a model no longer on the A1, is ignored
  Bench.setData({ rows: [], best: { "rag-notes": { m5p: { model: "X", model_path: BIG } } } });
  assert.equal(Lab._defaults("rag").pick.llm, SMALL);
  Bench.setData({ rows: [], best: { "rag-notes": { m1: { model: "Gone", model_path: "models/mlx/Gone" } } } });
  assert.equal(Lab._defaults("rag").pick.llm, SMALL);
});

test("Bench view shows the pick and stars its row", () => {
  Bench.setData({ rows: [row(), row({ id: 3, model: "Qwen3-0.6B-4bit", model_path: SMALL, score: 0.5 })], suites: [], machines: [],
    best: { "rag-notes": { m1: { model: "Qwen3-4B-4bit", model_path: BIG, score: 0.9, tok_s: 31.5, passed: 7, total: 8,
      why: "highest score (90)", considered: 5, ran: 3, reused: 0, screened_out: [{ model: "Tiny<b>" }], at: "2026-10-04T00:00:00Z" } } } });
  const h = Bench.html();
  assert.match(h, /Best for you · M1 Pro 16GB/);
  assert.match(h, /Searched 5 models/);
  assert.match(h, /Tiny&lt;b&gt;/);                                   // escaped
  assert.equal((h.match(/★ best/g) || []).length, 1);
});
