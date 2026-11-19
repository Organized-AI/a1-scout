// Considering a Mac: Bench runs every simulated workflow on a Mac from RAM Scout as a hypothetical, next to the
// Macs you own, and says whether it opens up work, only speeds it up, or changes little.
//   cd ~/nvme-stash/a1-scout && node --test tests/consider.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = f => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const plain = x => JSON.parse(JSON.stringify(x));
const link = p => "#ram-scout-macs=" + Buffer.from(JSON.stringify(p)).toString("base64url");
const APPLE = "https://support.apple.com/en-us/122211";
const mac = (id, chip, gb, bw, price) => ({ id, label: `${chip} ${gb}GB`, chip, gb, bandwidth_gbs: bw, bandwidth_source: bw ? APPLE : null,
  variants: [{ storage_gb: 1024, condition_class: "used" }], lowest_observed: price ? { price, price_basis: "peer_asking_price", observed_at: "2026-11-16T17:00:00-06:00", item_url: "https://example.com/l/1" } : null });
const payload = macs => ({ schema: "ram-scout-a1-macs/v1", generated_at: "2026-11-17T12:00:00Z", macs });

function page(hash) {
  const ls = new Map();
  const ctx = {
    window: {}, console, atob, TextDecoder, Uint8Array, URLSearchParams,
    document: { head: { appendChild() {} }, createElement: () => ({}), querySelector: () => null, querySelectorAll: () => [] },
    matchMedia: () => ({ matches: true }),
    location: { hash, pathname: "/", search: "?view=bench" },
    history: { replaceState: () => { ctx.location.hash = ""; } },
    localStorage: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) },
  };
  ctx.window.window = ctx.window; ctx.window.addEventListener = () => {};
  Object.assign(ctx, ctx.window);
  vm.createContext(ctx);
  for (const f of ["public/consider-core.js", "public/ram-scout-macs.js", "public/map.js", "public/bench.js", "public/lab.js", "public/jobs.js", "public/consider.js"]) vm.runInContext(read(f), ctx);
  return ctx.window;
}

// A small and a mid model for "Answer from your docs", plus an embedder. MID needs 13.2 GB: more than the 12.9 GB a
// 16 GB Mac gives models, well within a 96 GB Mac.
const SMALL = "models/mlx/Qwen3-0.6B-4bit", BIG = "models/mlx/Qwen3-4B-4bit", MID = "models/mlx/Qwen3-Next-11B-4bit";
const catalog = { categories: [{ id: "models", items: [
  { name: "Qwen3-0.6B-4bit", path: SMALL, type: "llm", bytes: 0.34e9, meta: { license: "apache-2.0" } },
  { name: "Qwen3-4B-4bit", path: BIG, type: "llm", bytes: 2.26e9, meta: { license: "apache-2.0" } },
  { name: "Qwen3-Next-11B-4bit", path: MID, type: "llm", bytes: 11e9, meta: { license: "apache-2.0" } },
  { name: "Qwen3-Embedding-0.6B-4bit-DWQ", path: "models/mlx/Qwen3-Embedding-0.6B-4bit-DWQ", type: "embedding", bytes: 0.34e9, meta: {} }] }] };
const bench = { machines: [{ machine: "m1", n: 28 }, { machine: "m4", n: 21 }],
  rows: [{ id: 1, suite: "rag-notes", machine: "m1", model: "Qwen3-4B-4bit", model_path: BIG, tok_s: 31.5, ttft_ms: 400, load_s: 2.5, peak_rss: 3.1e9, passed: 7, total: 8, score: 0.9 }] };

test("the Macs you own are the ones with bench runs", () => {
  const w = page(link(payload([mac("m3-ultra-96gb", "M3 Ultra", 96, 819, 3899)])));
  w.BenchView.setData(bench);
  assert.deepEqual(plain(w.LabView.ownedIds()), ["m1", "m4"]);
  w.BenchView.setData({ machines: [{ machine: "m1", n: 3 }], rows: [] });
  assert.deepEqual(plain(w.LabView.ownedIds()), ["m1"]);
  w.BenchView.setData({ rows: [] });                       // bench not loaded: the two Macs Jordan owns
  assert.deepEqual(plain(w.LabView.ownedIds()), ["m1", "m4"]);
});

test("a weighed Mac's speed scales the measured run on a Mac you own by memory bandwidth", () => {
  const w = page(link(payload([mac("m3-ultra-96gb", "M3 Ultra", 96, 819, 3899)])));
  w.BenchView.setData(bench); w.LabView._setCatalog(catalog, []);
  const e = w.LabView.evaluate({ tpl: "rag", sc: "purch", mach: "m3-ultra-96gb", pick: { llm: BIG } });
  const llm = e.stages.find(s => s.slot.id === "llm");
  assert.equal(llm.measured, false);
  assert.equal(llm.scaled, true);
  assert.ok(Math.abs(llm.tps - 31.5 * 819 / 200) < 1e-6);   // measured on the M1 Pro (200 GB/s)
  assert.match(llm.what, /scaled from M1 16GB's measured run by memory bandwidth/);
  // a Mac you own still uses only its own runs
  const own = w.LabView.evaluate({ tpl: "rag", sc: "purch", mach: "m4", pick: { llm: BIG } }).stages.find(s => s.slot.id === "llm");
  assert.equal(own.scaled, false);
  assert.equal(own.measured, false);
});

test("Answer from your docs: the 96 GB Mac runs a model too big for your Macs, within the time target", () => {
  const w = page(link(payload([mac("m3-ultra-96gb", "M3 Ultra", 96, 819, 3899)])));
  w.BenchView.setData(bench);
  const rows = w.LabView.consider(catalog, [], "m3-ultra-96gb");
  const rag = rows.find(r => r.tplId === "rag");
  assert.equal(rag.title, "Answer from your docs");
  assert.equal(rag.bigger.item.name, "Qwen3-Next-11B-4bit");
  assert.deepEqual(plain(rag.bigger.fitsOwned), []);
  assert.equal(rag.bigger.e.tests.find(t => t.id === "budget").st, "pass");
  const v = w.ConsiderView.verdict(rag);
  assert.equal(v.kind, "unlock");
  assert.match(v.text, /Runs Qwen3-Next-11B-4bit \(13\.2 GB\), too big for your Macs/);
  const s = w.ConsiderView.summary(rows);
  assert.equal(s.tone, "good");
  assert.match(s.head, /^Worth a look: it opens up \d+ of \d+ workflows$/);
  assert.ok(rows.length >= 8, "every simulated workflow is run");
});

test("a Mac no bigger than yours changes little", () => {
  const w = page(link(payload([mac("m4-16gb-x", "M4", 16, 120, 599)])));
  w.BenchView.setData(bench);
  const rows = w.LabView.consider(catalog, [], "m4-16gb-x");
  const rag = rows.find(r => r.tplId === "rag");
  assert.ok(!rag.bigger || rag.bigger.fitsOwned.length > 0);   // nothing it runs that yours can't
  assert.notEqual(w.ConsiderView.verdict(rag).kind, "unlock");
  assert.notEqual(w.ConsiderView.summary(rows).tone, "good");
});

test("without Apple's bandwidth, a weighed Mac gets fit checks and no speed claims", () => {
  const w = page(link(payload([mac("m5-max-128gb", "M5 Max", 128, null, 4999)])));
  w.BenchView.setData(bench);
  const rows = w.LabView.consider(catalog, [], "m5-max-128gb");
  for (const r of rows) {
    const v = w.ConsiderView.verdict(r);
    assert.ok(!["faster", "slower", "budget"].includes(v.kind), `${r.tplId}: ${v.kind}`);
  }
  const rag = rows.find(r => r.tplId === "rag");
  assert.equal(rag.cand.noSpeed, true);
  assert.equal(w.ConsiderView.verdict(rag).kind, "unlock");   // it still fits the 11B model your Macs can't
});

test("verdict rules", () => {
  const w = page("");
  const V = w.ConsiderView.verdict;
  const ev = (o) => ({ stages: [{}], total: 2, noSpeed: false, mach: { label: "M1 16GB" }, tests: [{ id: "fit", st: "pass" }, { id: "budget", st: "pass" }], ...o });
  const fail = id => ({ tests: [{ id: "fit", st: id === "fit" ? "fail" : "pass" }, { id: "budget", st: id === "budget" ? "fail" : "pass" }] });
  assert.equal(V({ cand: ev(fail("fit")), bestOwned: ev() }).kind, "worse");
  assert.equal(V({ cand: ev(), bestOwned: null }).kind, "unlock");
  assert.equal(V({ cand: ev(), bestOwned: ev({ ...fail("budget"), total: 30 }), budget: 15 }).kind, "budget");
  assert.equal(V({ cand: ev({ total: 1 }), bestOwned: ev({ total: 3 }) }).kind, "faster");
  assert.match(V({ cand: ev({ total: 1 }), bestOwned: ev({ total: 3 }) }).text, /3\.0× faster than your M1 16GB/);
  assert.equal(V({ cand: ev({ total: 3 }), bestOwned: ev({ total: 1 }) }).kind, "slower");
  assert.equal(V({ cand: ev({ total: 2.1 }), bestOwned: ev({ total: 2 }) }).kind, "same");
  assert.equal(V({ cand: ev({ noSpeed: true }), bestOwned: ev() }).kind, "unknown");
  assert.equal(V({ cand: { stages: [] }, bestOwned: ev() }).kind, "na");
  const S = w.ConsiderView.summary;
  const rows = n => Array.from({ length: n }, () => ({ cand: ev({ total: 1 }), bestOwned: ev({ total: 2 }) }));
  assert.equal(S(rows(4)).tone, "mixed");
  assert.match(S(rows(4)).head, /Faster, nothing new: about 2\.0× on 4 of 4 workflows/);
  assert.equal(S([{ cand: ev(), bestOwned: ev() }]).tone, "bad");
});

test("Bench shows the panel, names the price, and a row opens Simulate on the weighed Mac", () => {
  const w = page(link(payload([mac("m3-ultra-96gb", "M3 Ultra", 96, 819, 3899)])));
  w.BenchView.setData(bench);
  const out = w.JobsView.html(catalog, []);
  assert.match(out, /Considering a Mac · from RAM Scout/);
  assert.match(out, /M3 Ultra 96GB: Worth a look/);
  assert.match(out, /Seen at <b>\$3,899<\/b> peer asking price/);
  assert.match(out, /819 GB\/s memory bandwidth \(Apple\)/);
  assert.match(out, /data-cz-job="rag"/);
  assert.match(out, /Hypothetical: nothing has run on this Mac/);
  w.LabView.focus("rag", "m3-ultra-96gb");
  assert.match(w.LabView.html(catalog, [], { tpl: "rag", embedded: true }), /aria-pressed="true">M3 Ultra 96GB/);
  // no RAM Scout Macs: no panel
  const none = page("");
  none.BenchView.setData(bench);
  assert.doesNotMatch(none.JobsView.html(catalog, []), /Considering a Mac/);
});

test("in the comparison your Macs borrow each other's measured runs (Simulate itself does not)", () => {
  const w = page(link(payload([mac("m3-ultra-96gb", "M3 Ultra", 96, 819, 3899)])));
  w.BenchView.setData(bench); w.LabView._setCatalog(catalog, []);
  const st = { tpl: "rag", sc: "purch", mach: "m4", pick: { llm: BIG } };
  const plainM4 = w.LabView.evaluate(st).stages.find(s => s.slot.id === "llm");
  const borrowed = w.LabView.evaluate({ ...st, borrow: true }).stages.find(s => s.slot.id === "llm");
  assert.equal(plainM4.scaled, false);
  assert.equal(borrowed.scaled, true);
  assert.ok(Math.abs(borrowed.tps - 31.5 * 120 / 200) < 1e-6);   // the M1 Pro's run, at the M4's 120 GB/s
});

test("the bigger model is the one with the most parameters, never an embedder in an answer slot", () => {
  const P = page("").LabView.paramsOf;
  assert.equal(P({ name: "Qwen3.8-27B-4bit" }), 27);
  assert.equal(P({ name: "Qwen3-Coder-30B-A3B-Instruct-4bit" }), 30);
  assert.equal(P({ name: "kev-4b-mlx-8bit" }), 4);
  assert.equal(P({ name: "Qwen3-0.6B-4bit" }), 0.6);
  assert.equal(P({ name: "whisper-large-v3-turbo" }), null);
  const w = page(link(payload([mac("m3-ultra-96gb", "M3 Ultra", 96, 819, 3899)])));
  w.BenchView.setData(bench);
  const more = { categories: [{ id: "models", items: catalog.categories[0].items.concat([
    { name: "e5-mistral-7b-instruct-mlx", path: "models/mlx/e5-mistral-7b-instruct-mlx", type: "llm", bytes: 12.5e9, meta: {} },
    { name: "K2-Horizon-7B-bf16", path: "models/mlx/K2-Horizon-7B-bf16", type: "llm", bytes: 12.6e9, meta: {} }]) }] };
  const rag = w.LabView.consider(more, [], "m3-ultra-96gb").find(r => r.tplId === "rag");
  assert.equal(rag.bigger.item.name, "Qwen3-Next-11B-4bit");   // 11B beats a larger 7B file; the e5 embedder is skipped
});
