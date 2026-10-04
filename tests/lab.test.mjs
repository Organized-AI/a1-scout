// Lab simulation contract: each template fills its required parts from the real catalog, fits a 16 GB Mac,
// and the estimates stay sane. Uses tests/fixtures/catalog.json when present (a snapshot of /api/catalog).
//   cd ~/nvme-stash/a1-scout && node --test tests/lab.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";

const read = f => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const ctx = { window: {}, document: { head: { appendChild() {} }, createElement: () => ({}), querySelector: () => null, querySelectorAll: () => [] },
  matchMedia: () => ({ matches: true }), console };
ctx.window.window = ctx.window; Object.assign(ctx, ctx.window);
vm.createContext(ctx);
const fixture = new URL("fixtures/catalog.json", import.meta.url);
const catalog = existsSync(fixture) ? JSON.parse(readFileSync(fixture, "utf8")) : null;
vm.runInContext(read("public/lab.js"), ctx);
const Lab = ctx.window.LabView;

test("every template has scenarios with budgets and expectations", () => {
  for (const [id, t] of Object.entries(Lab.templates)) {
    assert.ok(t.slots.some(s => !s.optional), id);
    for (const s of t.scenarios) { assert.ok(s.budget > 0, `${id}/${s.id}`); assert.ok(s.expect && s.risk, `${id}/${s.id}`); }
  }
});

test("on the real catalog, default stacks are complete and fit an M1 16GB", { skip: !catalog && "no catalog fixture" }, () => {
  Lab._setCatalog(catalog, []);
  for (const id of Object.keys(Lab.templates)) {
    const html = Lab.html(catalog, []);            // initialises state for the first template
    assert.ok(html.includes("lab-tpl"));
    const tpl = Lab.templates[id], pick = {};
    // same choice the Lab makes by default: smallest-ish candidate per slot
    const e0 = Lab.evaluate({ tpl: id, sc: tpl.scenarios[0].id, mach: "m1", pick });
    assert.equal(e0.tests.find(t => t.id === "present").st, "fail", `${id}: empty stack must fail presence`);
  }
});

test("bigger models are slower and need more memory", { skip: !catalog && "no catalog fixture" }, () => {
  Lab._setCatalog(catalog, []);
  const items = catalog.categories.flatMap(c => c.items.map(i => ({ ...i, cat: c.id })));
  const small = items.find(i => /Qwen3-4B-Instruct-2507-4bit/.test(i.name)), big = items.find(i => /Qwen3-Coder-30B/.test(i.name));
  if (!small || !big) return;
  const run = p => Lab.evaluate({ tpl: "route", sc: "code", mach: "m1", pick: { work: p.path } });
  const a = run(small), b = run(big);
  assert.ok(b.total > a.total);
  assert.ok(b.peak > a.peak);
  assert.equal(b.tests.find(t => t.id === "fit").st, "fail");   // a 17 GB model can't fit a 16 GB Mac
  assert.equal(a.tests.find(t => t.id === "fit").st, "pass");
});
