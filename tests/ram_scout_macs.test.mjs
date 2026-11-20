// Macs from RAM Scout: a "Test in A1 Scout" link (or JSON file) adds watched Macs to fit chips, the Lab and bench labels.
//   cd ~/nvme-stash/a1-scout && node --test tests/ram_scout_macs.test.mjs
// tests/fixtures/ram-scout-macs.json is what RAM Scout's runner/a1-handoff.js builds from five watched combinations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = f => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const FIXTURE = JSON.parse(read("tests/fixtures/ram-scout-macs.json"));
const plain = x => JSON.parse(JSON.stringify(x));   // values from the vm realm
const link = p => "#ram-scout-macs=" + Buffer.from(JSON.stringify(p)).toString("base64url");

function page({ hash = "", stored = null } = {}) {
  const ls = new Map(stored ? [["a1-ram-scout-macs", JSON.stringify(stored)]] : []);
  const replaced = [];
  const ctx = {
    window: {}, console, atob, TextDecoder, Uint8Array,
    document: { head: { appendChild() {} }, createElement: () => ({}), querySelector: () => null, querySelectorAll: () => [] },
    matchMedia: () => ({ matches: true }),
    location: { hash, pathname: "/", search: "" },
    history: { replaceState: (_s, _t, url) => { replaced.push(url); ctx.location.hash = ""; } },
    localStorage: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) },
  };
  ctx.window.window = ctx.window; ctx.window.addEventListener = () => {};
  Object.assign(ctx, ctx.window);
  vm.createContext(ctx);
  for (const f of ["public/consider-core.js", "public/ram-scout-macs.js", "public/map.js", "public/bench.js", "public/lab.js"]) vm.runInContext(read(f), ctx);
  return { w: ctx.window, ls, replaced, ctx };
}

test("a RAM Scout link adds its Macs, is stored in this browser, and leaves the address bar", () => {
  const { w, ls, replaced } = page({ hash: link(FIXTURE) });
  assert.deepEqual(plain(w.RamScoutMacs.list().map(m => m.id)), ["m4", "m6-24gb", "m2-pro-32gb", "m4-pro-48gb", "m5-max-128gb"]);
  assert.deepEqual(replaced, ["/"]);
  assert.ok(JSON.parse(ls.get("a1-ram-scout-macs")).macs.length === 5);
  assert.match(w.RamScoutMacs.notice().text, /Added 5 Macs from RAM Scout/);
  // M4 16GB is already one of the Lab's Macs: it is not repeated.
  const ids = w.MachineFit(1e9, "").map(m => m.id);
  assert.deepEqual(plain(ids), ["m1", "m4", "m6", "m5p", "m6-24gb", "m2-pro-32gb", "m4-pro-48gb", "m5-max-128gb"]);
});

test("fit chips use each watched Mac's memory", () => {
  const { w } = page({ hash: link(FIXTURE) });
  const fit = Object.fromEntries(w.MachineFit(30e9, "").map(m => [m.id, m.fits]));   // needs 36 GB
  assert.equal(fit["m4-pro-48gb"], true);                  // 48 GB x 0.75 = 38.7 GB usable (GiB)
  assert.equal(fit["m6-24gb"], false);
  assert.equal(fit["m5-max-128gb"], true);
  assert.equal(w.MachineFit(30e9, "").find(m => m.id === "m4-pro-48gb").label, "M4 Pro 48GB");
});

test("the Lab estimates speed from Apple's bandwidth, and only where it has one", () => {
  const { w } = page({ hash: link(FIXTURE) });
  const Lab = w.LabView, BIG = "models/mlx/Qwen3-4B-4bit";
  w.BenchView.setData({ rows: [] });
  Lab._setCatalog({ categories: [{ id: "models", items: [{ name: "Qwen3-4B-4bit", path: BIG, type: "llm", bytes: 2.26e9, meta: {} }] }] }, []);
  const pro = Lab.evaluate({ tpl: "rag", sc: "purch", mach: "m4-pro-48gb", pick: { llm: BIG } });
  assert.equal(pro.mach.label, "M4 Pro 48GB");
  const llm = pro.stages.find(s => s.slot.id === "llm");
  assert.ok(Math.abs(llm.tps - Math.min(150, 0.6 * 273e9 / 2.26e9)) < 1e-6);
  assert.equal(pro.noSpeed, false);
  assert.equal(pro.tests.find(t => t.id === "fit").st, "pass");

  const m2 = Lab.evaluate({ tpl: "rag", sc: "purch", mach: "m2-pro-32gb", pick: { llm: BIG } });
  assert.equal(m2.noSpeed, true);
  assert.match(m2.stages.find(s => s.slot.id === "llm").what, /no speed estimate/);
  const budget = m2.tests.find(t => t.id === "budget");
  assert.equal(budget.st, "pending");
  assert.match(budget.why, /M2 Pro 32GB/);
  assert.equal(m2.tests.find(t => t.id === "fit").st, "pass");
  assert.equal(Lab.grade(m2).parts[0][0], "Speed (no estimate)");
  assert.ok(!Lab.missions.find(m => m.id === "sub1").test(m2), "no speed badge without a speed");
});

test("the Lab's own Macs use Apple's published bandwidth", () => {
  const { w } = page();
  const Lab = w.LabView, BIG = "models/mlx/Qwen3-4B-4bit";
  w.BenchView.setData({ rows: [] });
  Lab._setCatalog({ categories: [{ id: "models", items: [{ name: "Qwen3-4B-4bit", path: BIG, type: "llm", bytes: 2.26e9, meta: {} }] }] }, []);
  const tpsOn = mach => Lab.evaluate({ tpl: "rag", sc: "purch", mach, pick: { llm: BIG } }).stages.find(s => s.slot.id === "llm").tps;
  assert.ok(Math.abs(tpsOn("m6") - 0.6 * 170e9 / 2.26e9) < 1e-6);
  assert.ok(Math.abs(tpsOn("m5p") - 0.6 * 307e9 / 2.26e9) < 1e-6);
  assert.ok(Math.abs(tpsOn("m1") - 0.6 * 200e9 / 2.26e9) < 1e-6);
});

test("bench rows on a watched Mac get its name", () => {
  const { w } = page({ hash: link(FIXTURE) });
  assert.equal(w.BenchView.machLabel("m4-pro-48gb"), "M4 Pro 48GB");
  assert.equal(w.BenchView.machLabel("m5p"), "M5 Pro 64GB");
  assert.equal(w.BenchView.machLabel("pi5-16gb"), "pi5-16gb");
});

test("only checked fields are kept: bad ids, foreign bandwidth sources and labels are rebuilt or dropped", () => {
  const evil = { schema: "ram-scout-a1-macs/v1", macs: [
    { id: "<img src=x onerror=alert(1)>", chip: "M4", gb: 16 },
    { id: "m4-pro-48gb", chip: "M4 Pro", gb: 48, label: "<b>pwn</b>", bandwidth_gbs: 9999, bandwidth_source: "https://evil.example/apple.com/" , extra: "x" },
    { id: "m4-pro-48gb", chip: "M4 Pro", gb: 48 },
    { id: "m3-max-36gb", chip: "M3 Max", gb: 36.5 },
    { id: "m9-x-16gb", chip: "M9 Turbo", gb: 16 }] };
  const { w } = page({ hash: link(evil) });
  const ms = w.RamScoutMacs.list();
  assert.equal(ms.length, 1);
  assert.equal(ms[0].label, "M4 Pro 48GB");
  assert.equal(ms[0].bandwidth_gbs, null);
  assert.equal(ms[0].extra, undefined);
  assert.equal(w.RamScoutMacs.bandwidth("m4-pro-48gb"), null);
});

test("a broken or foreign link changes nothing and says so", () => {
  const before = { received_at: "2026-11-15T00:00:00Z", via: "link", generated_at: null, macs: [{ id: "m4-pro-48gb", chip: "M4 Pro", gb: 48 }] };
  for (const hash of ["#ram-scout-macs=%%%", link({ schema: "something-else/v1", macs: [] }), link({ schema: "ram-scout-a1-macs/v1", macs: Array(51).fill({}) })]) {
    const { w, replaced } = page({ hash, stored: before });
    assert.deepEqual(plain(w.RamScoutMacs.list().map(m => m.id)), ["m4-pro-48gb"]);
    assert.equal(w.RamScoutMacs.notice().ok, false);
    assert.match(w.RamScoutMacs.notice().text, /not applied/);
    assert.deepEqual(replaced, ["/"]);
  }
});

test("other hashes are left alone, and removing the list keeps the Lab's Macs", () => {
  const { w, replaced, ls } = page({ hash: "#somewhere", stored: { macs: FIXTURE.macs } });
  assert.deepEqual(plain(replaced), []);
  assert.equal(w.RamScoutMacs.list().length, 5);
  assert.equal(w.RamScoutMacs.notice(), null);
  w.RamScoutMacs.clear();
  assert.equal(ls.has("a1-ram-scout-macs"), false);
  assert.deepEqual(plain(w.MachineFit(1, "").map(m => m.id)), ["m1", "m4", "m6", "m5p"]);
  assert.match(w.RamScoutMacs.noteHtml(), /Test in A1 Scout/);
});

test("?view= in the address opens that tab; simulate opens Bench → Simulate (RAM Scout's link lands there)", () => {
  const html = read("public/index.html");
  const iife = html.match(/const START_VIEW = (\(\(\) => \{[\s\S]*?\}\)\(\));/);
  assert.ok(iife, "START_VIEW not found in public/index.html");
  assert.match(html, /let view = START_VIEW,/);
  assert.match(html, /if \(view === "lab"\) \{ JobsView\.openLab\(\); view = "bench"; \}/);
  const start = search => vm.runInNewContext(iife[1], { location: { search }, URLSearchParams });
  assert.equal(start("?view=simulate"), "lab");
  assert.equal(start("?view=bench"), "bench");
  assert.equal(start("?view=scout"), "scout");
  assert.equal(start(""), "map");
  assert.equal(start("?view=admin"), "map");
});
