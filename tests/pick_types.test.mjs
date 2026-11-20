// Picks by type: type chips under the status chips, and sort by score or type, on the Scout tab.
//   cd ~/nvme-stash/a1-scout && node --test tests/pick_types.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = f => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const plain = x => JSON.parse(JSON.stringify(x));

function load(stored = null) {
  const ls = new Map(stored ? [["a1-scout-pick-view", stored]] : []);
  const ctx = { window: {}, URLSearchParams, localStorage: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)) } };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(read("public/pick-types.js"), ctx);
  return { T: ctx.window.PickTypes, ls };
}

// Server order: approved, new, stashed, then the rest; best score first within each.
const PICKS = [
  { id: "paper:1", kind: "paper", status: "new", score: 91 },
  { id: "model:a", kind: "model", status: "new", score: 80 },
  { id: "space:s", kind: "space", status: "new", score: 77 },
  { id: "dataset:d", kind: "dataset", status: "new", score: 60 },
  { id: "model:b", kind: "model", status: "new", score: 88 },
  { id: "model:c", kind: "model", status: "stashed", score: 70 },
  { id: "collection:x", kind: "collection", status: "skipped", score: 50 },
];

test("a type chip keeps only that type, inside the status chip", () => {
  const { T } = load();
  assert.deepEqual(plain(T.view(PICKS, { status: "new", type: "model" }).rows.map(p => p.id)), ["model:a", "model:b"]);
  assert.deepEqual(plain(T.view(PICKS, { status: "all", type: "model" }).rows.map(p => p.id)), ["model:a", "model:b", "model:c"]);
  assert.equal(T.view(PICKS, { status: "approved", type: "model" }).rows.length, 0);
});

test("all types with sort by score keeps the server's order", () => {
  const { T } = load();
  const v = T.view(PICKS, { status: "new", type: "all", sort: "score" });
  assert.equal(v.groups, null);
  assert.deepEqual(plain(v.rows.map(p => p.id)), ["paper:1", "model:a", "space:s", "dataset:d", "model:b"]);
});

test("sort by type groups models, datasets, Spaces before papers, best score first in each", () => {
  const { T } = load();
  const v = T.view(PICKS, { status: "new", type: "all", sort: "type" });
  assert.deepEqual(plain(v.rows.map(p => p.id)), ["model:b", "model:a", "dataset:d", "space:s", "paper:1"]);
  assert.deepEqual(plain(v.groups.map(g => [g.label, g.rows.length])), [["models", 2], ["datasets", 1], ["Spaces", 1], ["papers", 1]]);
});

test("chips show the types present in the status, plus the selected one at zero", () => {
  const { T } = load();
  assert.deepEqual(plain(T.chips(PICKS, "new", "all")).map(c => `${c.label} ${c.n}`), ["all types 5", "models 2", "datasets 1", "Spaces 1", "papers 1"]);
  assert.deepEqual(plain(T.chips(PICKS, "stashed", "space")).map(c => `${c.label} ${c.n}`), ["all types 1", "models 1", "Spaces 0"]);
});

test("status chip counts follow the type chip", () => {
  const { T } = load();
  assert.deepEqual(plain(T.statusCounts(PICKS, "model")), { new: 2, stashed: 1 });
});

test("the choice is remembered, and ?type= / ?sort= win over it; junk falls back to all + score", () => {
  const { T, ls } = load();
  assert.deepEqual(plain(T.load("")), { type: "all", sort: "score" });
  T.save({ type: "dataset", sort: "type" });
  assert.deepEqual(JSON.parse(ls.get("a1-scout-pick-view")), { type: "dataset", sort: "type" });
  assert.deepEqual(plain(T.load("")), { type: "dataset", sort: "type" });
  assert.deepEqual(plain(T.load("?view=scout&type=space")), { type: "space", sort: "type" });
  assert.deepEqual(plain(load("not json").T.load("?type=<b>&sort=up")), { type: "all", sort: "score" });
});
