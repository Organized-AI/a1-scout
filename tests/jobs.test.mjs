// Bench tab = jobs: every Lab stack and every Bench suite shows up as exactly one job, paired where they measure the same thing.
//   cd ~/nvme-stash/a1-scout && node --test tests/jobs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = f => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const ctx = { window: {}, document: { head: { appendChild() {} }, createElement: () => ({}), querySelector: () => null, querySelectorAll: () => [] },
  matchMedia: () => ({ matches: true }), console };
ctx.window.window = ctx.window; Object.assign(ctx, ctx.window);
vm.createContext(ctx);
vm.runInContext(read("public/consider-core.js"), ctx);
for (const f of ["public/bench.js", "public/lab.js", "public/jobs.js"]) vm.runInContext(read(f), ctx);
const { JobsView: Jobs, LabView: Lab, BenchView: Bench } = ctx.window;
const catalog = { categories: [{ id: "models", items: [] }] };

test("each stack and each suite is one job; paired jobs carry both", () => {
  const J = Jobs.jobs();
  assert.equal(new Set(J.map(j => j.id)).size, J.length);
  for (const t of Object.keys(Lab.templates)) assert.equal(J.filter(j => j.tpl === t).length, 1, t);
  for (const s of Object.keys(Bench.suites)) assert.equal(J.filter(j => j.suite === s).length, 1, s);
  assert.equal(J.find(j => j.tpl === "loop").suite, "gtm-gate");
  assert.equal(J.find(j => j.tpl === "skills").suite, "skill-select");
  assert.equal(J.find(j => j.suite === "gtm-debug").tpl, null);          // a suite with no stack yet
  assert.equal(J[0].id, "loop");
});

test("measured view embeds the job's leaderboard without the suite chips; simulate embeds the job's stack", () => {
  Bench.setData({ rows: [], suites: [], machines: [] });
  ctx.window.__a1store = (() => { const m = { "a1-job": "skills", "a1-job-mode": "measured" }; return { get: (k, d) => m[k] ?? d, set: (k, v) => { m[k] = v; } }; })();
  // the module read its saved job at load; re-run it so it sees this store
  vm.runInContext(read("public/jobs.js"), ctx);
  const h = ctx.window.JobsView.html(catalog, []);
  assert.match(h, /bn-embed/);
  assert.doesNotMatch(h, /class="bn-suites"/);
  assert.match(h, /Skill selection|skill-select/);
  ctx.window.__a1store.set("a1-job-mode", "simulate");
  vm.runInContext(read("public/jobs.js"), ctx);
  const s = ctx.window.JobsView.html(catalog, []);
  assert.match(s, /lab-embed/);
  assert.doesNotMatch(s, /class="lab-tpls"/);
  assert.match(s, /Pick a skill before loading it|select-skill/);
});

test("a job with only a suite falls back to Measured; one with only a stack to Simulate", () => {
  const store = (job, mode) => { const m = { "a1-job": job, "a1-job-mode": mode }; return { get: (k, d) => m[k] ?? d, set: (k, v) => { m[k] = v; } }; };
  ctx.window.__a1store = store("gtm-debug", "simulate");
  vm.runInContext(read("public/jobs.js"), ctx);
  assert.match(ctx.window.JobsView.html(catalog, []), /bn-embed/);
  ctx.window.__a1store = store("inside", "measured");
  vm.runInContext(read("public/jobs.js"), ctx);
  assert.match(ctx.window.JobsView.html(catalog, []), /lab-embed/);
});
