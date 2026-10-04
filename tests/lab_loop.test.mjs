// GTM autoresearch loop in the Lab and the gtm-gate suite in Bench: decision-model latency measured by the gate suite
// replaces the estimate, the gate's pass rate drives the quality test, and the new kinds (pii, forecaster) get stage times.
//   cd ~/nvme-stash/a1-scout && node --test tests/lab_loop.test.mjs
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
ctx.window.A1Classify = i => i.kind;          // the catalog fixture says each item's kind directly

const GATE = "models/mlx/clef-flash-4bit", PII = "models/mlx/openai-privacy-filter-8bit", TFM = "models/hf/timesfm-2.5-200m-pytorch", MUT = "models/mlx/Qwen2.5-Coder-7B-Instruct-4bit";
const catalog = { categories: [{ id: "models", items: [
  { name: "clef-flash-4bit", path: GATE, kind: "decision", bytes: 5.8e9, meta: { license: "apache-2.0" } },
  { name: "openai-privacy-filter-8bit", path: PII, kind: "pii", bytes: 1.5e9, meta: { license: "apache-2.0" } },
  { name: "timesfm-2.5-200m-pytorch", path: TFM, kind: "forecaster", bytes: 0.93e9, meta: { license: "apache-2.0" } },
  { name: "Qwen2.5-Coder-7B-Instruct-4bit", path: MUT, kind: "llm-code", bytes: 4.3e9, meta: { license: "apache-2.0" } }] }] };

test("the loop template exists, its gate slot is required and the rest optional", () => {
  const t = Lab.templates.loop;
  assert.ok(t);
  assert.equal(JSON.stringify(t.slots.filter(s => !s.optional).map(s => s.id)), JSON.stringify(["gate"]));
  for (const s of t.scenarios) assert.ok(s.budget > 0 && s.expect && s.risk, s.id);
});

test("without a gtm-gate run the gate is estimated and quality is pending", () => {
  Bench.setData({ rows: [] });
  Lab._setCatalog(catalog, []);
  const e = Lab.evaluate({ tpl: "loop", sc: "gate", mach: "m1", pick: { gate: GATE } });
  const g = e.stages.find(s => s.slot.id === "gate");
  assert.ok(!g.measured);
  assert.match(e.tests.find(t => t.id === "quality").why, /agent\.py bench gtm-gate/);
});

test("a gtm-gate run supplies latency per change and the pass rate", () => {
  Bench.setData({ rows: [{ id: 1, suite: "gtm-gate", machine: "m1", model: "clef-flash-4bit", model_path: GATE, tok_s: 8, ttft_ms: 500,
    load_s: 9, peak_rss: 6.5e9, passed: 17, total: 20, score: 0.82 }] });
  Lab._setCatalog(catalog, []);
  const e = Lab.evaluate({ tpl: "loop", sc: "round", mach: "m1", pick: { gate: GATE } });
  const g = e.stages.find(s => s.slot.id === "gate");
  assert.equal(g.measured, true);
  assert.ok(Math.abs(g.s - 12 / 4 * 0.5) < 1e-9);       // 12 questions = 3 changes at 500 ms each
  assert.equal(e.tests.find(t => t.id === "quality").st, "pass");   // 17 of 20
});

test("privacy filter and forecaster get their own stage times, and skip scenarios that don't use them", () => {
  Bench.setData({ rows: [] });
  Lab._setCatalog(catalog, []);
  const pii = Lab.evaluate({ tpl: "loop", sc: "pii", mach: "m1", pick: { gate: GATE, pii: PII, drift: TFM } });
  assert.match(pii.stages.find(s => s.slot.id === "pii").what, /scan 2 KB/);
  assert.match(pii.stages.find(s => s.slot.id === "drift").what, /skipped/);
  const drift = Lab.evaluate({ tpl: "loop", sc: "drift", mach: "m1", pick: { gate: GATE, drift: TFM } });
  assert.match(drift.stages.find(s => s.slot.id === "drift").what, /forecast 14 days from 180/);
});

test("Bench labels the gate suite in questions per second", () => {
  assert.equal(Bench.suites["gtm-gate"].speed, "q/s");
  Bench.setData({ rows: [{ id: 1, suite: "gtm-gate", machine: "m1", model: "clef-flash-4bit", model_path: GATE, tok_s: 8, ttft_ms: 500,
    passed: 17, total: 20, score: 0.82, created: "2026-10-04T18:00:00Z" }], suites: [], machines: [] });
  const r = Bench.suiteResult(GATE, "gtm-gate");
  assert.equal(r.passed, 17);
});
