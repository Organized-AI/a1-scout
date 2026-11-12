// "Delete" on the Drive map's old versions: the Worker queues only real old-version paths, hands them to the Mac's
// heartbeat, and takes deleted ones off the stored Drive map.
//   cd ~/nvme-stash/a1-scout && node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function fakeEnv(kv) {
  const rows = Object.fromEntries(Object.entries(kv).map(([k, v]) => [k, JSON.stringify(v)]));
  const DB = { prepare(sql) {
    let args = [];
    const q = { bind(...a) { args = a; return q; },
      async first() { if (/FROM kv WHERE k=\?/.test(sql)) return rows[args[0]] ? { v: rows[args[0]] } : null; return null; },
      async all() { return { results: [] }; },
      async run() { if (/INSERT INTO kv/.test(sql)) rows[args[0]] = args[1]; return {}; } };
    return q;
  } };
  return { env: { DB, SCOUT_TOKEN: "t", ASSETS: { fetch: () => new Response("") } }, rows };
}
const post = (env, path, body) => worker.fetch(new Request("https://x" + path, { method: "POST",
  headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body) }), env).then(async r => ({ status: r.status, ...(await r.json()) }));
const OLD = "versions/models/mlx/Qwen3.8-27B-8bit@815b83c", OLD2 = "versions/spaces/jev-style-v3@418e1d6";
const state = (p = {}) => ({ presence: { at: new Date().toISOString(), present: true, busy: false, machine: "m1", ...p },
  catalog: { categories: [{ id: "versions", items: [{ path: OLD, bytes: 29.5e9 }, { path: OLD2, bytes: 117e3 }] }, { id: "models", items: [{ path: "models/mlx/Qwen3.8-27B-8bit" }] }] } });

test("old versions on the Drive map are queued", async () => {
  const { env, rows } = fakeEnv(state());
  const r = await post(env, "/api/versions-delete", { paths: [OLD, OLD2] });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(rows.versions_delete).paths, [OLD, OLD2]);
  assert.equal(JSON.parse(rows.versions_delete).waiting_for_run, false);
});

test("a delete asked for mid-run is queued to wait for the run", async () => {
  const { env, rows } = fakeEnv(state({ busy: true }));
  assert.equal((await post(env, "/api/versions-delete", { paths: [OLD] })).ok, true);
  assert.equal(JSON.parse(rows.versions_delete).waiting_for_run, true);
});

test("anything that is not a listed old version is refused", async () => {
  for (const bad of [["models/mlx/Qwen3.8-27B-8bit"], ["versions/../models/mlx/x@815b83c"], ["versions/models/x"], ["/versions/a@815b83c"], [], "versions/a@815b83c", ["versions/a@815b83c; rm -rf /"]])
    assert.equal((await post(fakeEnv(state()).env, "/api/versions-delete", { paths: bad })).status, 400, JSON.stringify(bad));
  assert.equal((await post(fakeEnv(state()).env, "/api/versions-delete", { paths: ["versions/models/mlx/NotOnTheMap@815b83c"] })).status, 409);
});

test("refused when the A1 is not plugged in or the Mac is quiet", async () => {
  assert.equal((await post(fakeEnv(state({ present: false })).env, "/api/versions-delete", { paths: [OLD] })).status, 409);
  assert.equal((await post(fakeEnv(state({ at: new Date(Date.now() - 10 * 60e3).toISOString() })).env, "/api/versions-delete", { paths: [OLD] })).status, 409);
});

test("the heartbeat is handed the pending delete, and the ack clears deleted versions off the Drive map", async () => {
  const { env, rows } = fakeEnv(state());
  await post(env, "/api/versions-delete", { paths: [OLD, OLD2] });
  const hb = await post(env, "/api/activity", { kind: "presence", machine: "m1", present: true, busy: false });
  assert.deepEqual(hb.versions_delete.paths, [OLD, OLD2]);
  await post(env, "/api/versions-delete/ack", { state: "done", freed_bytes: 29.5e9, free_bytes: 1.1e12,
    results: [{ path: OLD, outcome: "deleted" }, { path: OLD2, outcome: "skipped", why: "current copy not verified" }] });
  const vd = JSON.parse(rows.versions_delete);
  assert.equal(vd.state, "done");
  assert.equal(vd.freed_bytes, 29.5e9);
  const cat = JSON.parse(rows.catalog);
  assert.deepEqual(cat.categories.find(c => c.id === "versions").items.map(i => i.path), [OLD2]);
  assert.equal(cat.categories.find(c => c.id === "models").items.length, 1);
  const hb2 = await post(env, "/api/activity", { kind: "presence", machine: "m1", present: true, busy: false });
  assert.equal(hb2.versions_delete, null);
});
