// Two Macs, one A1: each Mac posts its own presence, the Mac with the A1 is the active one, and dashboard requests go only to it.
//   cd ~/nvme-stash/a1-scout && node --test tests/worker_machines.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { activePresence } from "../src/index.js";

function fakeEnv(kv = {}) {
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
const call = (env, path, body) => worker.fetch(new Request("https://x" + path, { method: body ? "POST" : "GET",
  headers: { authorization: "Bearer t", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env).then(r => r.json());
const beat = (env, machine, p) => call(env, "/api/activity", { kind: "presence", machine, machine_label: `${machine} Mac · test`, ...p });

test("the Mac with the A1 mounted is active, whichever posted last", async () => {
  const { env, rows } = fakeEnv();
  await beat(env, "m4", { present: true, attached: true, busy: false });
  await beat(env, "m1", { present: false, attached: false, busy: false });
  assert.equal(JSON.parse(rows.presence).machine, "m4");
  const a = await call(env, "/api/activity");
  assert.deepEqual(a.machines.map(m => [m.machine, m.active, m.present]), [["m4", true, true], ["m1", false, false]]);
  assert.match(a.machines[0].label, /m4 Mac/);
});

test("requests are handed only to the active Mac", async () => {
  const { env } = fakeEnv();
  await beat(env, "m4", { present: true, attached: true, busy: false });
  assert.equal((await call(env, "/api/run-request", {})).ok, true);
  const other = await beat(env, "m1", { present: false });
  assert.equal(other.run_request, null);
  assert.equal(other.active, "m4");
  const mine = await beat(env, "m4", { present: true, attached: true, busy: false });
  assert.equal(mine.run_request.state, "pending");
});

test("when the A1 moves, the other Mac becomes active", async () => {
  const { env, rows } = fakeEnv();
  await beat(env, "m1", { present: true, attached: true });
  await beat(env, "m1", { present: false, attached: false });
  await beat(env, "m4", { present: true, attached: true });
  assert.equal(JSON.parse(rows.presence).machine, "m4");
});

test("a stale Mac never outranks a fresh one", () => {
  const old = new Date(Date.now() - 10 * 60e3).toISOString(), now = new Date().toISOString();
  assert.equal(activePresence([{ machine: "m1", present: true, at: old }, { machine: "m4", present: false, at: now }]).machine, "m4");
});
