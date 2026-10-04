// Eject / mount from the dashboard: the Worker only queues a request the Mac can actually carry out.
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
const fresh = (p) => ({ presence: { at: new Date().toISOString(), ...p } });

test("eject is queued when the A1 is mounted and idle", async () => {
  const { env, rows } = fakeEnv(fresh({ present: true, attached: true, busy: false }));
  const r = await post(env, "/api/drive-request", { action: "eject" });
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(rows.drive_request).action, "eject");
});

test("eject is refused mid-run and when not mounted", async () => {
  assert.equal((await post(fakeEnv(fresh({ present: true, busy: true })).env, "/api/drive-request", { action: "eject" })).status, 409);
  assert.equal((await post(fakeEnv(fresh({ present: false, attached: true })).env, "/api/drive-request", { action: "eject" })).status, 409);
});

test("mount needs the drive connected but unmounted", async () => {
  assert.equal((await post(fakeEnv(fresh({ present: false, attached: true })).env, "/api/drive-request", { action: "mount" })).ok, true);
  assert.equal((await post(fakeEnv(fresh({ present: false, attached: false })).env, "/api/drive-request", { action: "mount" })).status, 409);
  assert.equal((await post(fakeEnv(fresh({ present: true, attached: true })).env, "/api/drive-request", { action: "mount" })).status, 409);
});

test("nothing is queued when the Mac hasn't checked in", async () => {
  const { env } = fakeEnv({ presence: { present: true, at: new Date(Date.now() - 10 * 60e3).toISOString() } });
  assert.equal((await post(env, "/api/drive-request", { action: "eject" })).status, 409);
});

test("the heartbeat receives the pending request, then the ack closes it", async () => {
  const { env, rows } = fakeEnv(fresh({ present: true, attached: true, busy: false }));
  await post(env, "/api/drive-request", { action: "eject" });
  const hb = await post(env, "/api/activity", { kind: "presence", present: true, attached: true, busy: false });
  assert.equal(hb.drive_request.action, "eject");
  await post(env, "/api/drive-request/ack", { state: "done" });
  assert.equal(JSON.parse(rows.drive_request).state, "done");
  const hb2 = await post(env, "/api/activity", { kind: "presence", present: false, attached: true, busy: false });
  assert.equal(hb2.drive_request, null);
});

test("unknown actions are rejected", async () => {
  assert.equal((await post(fakeEnv(fresh({ present: true })).env, "/api/drive-request", { action: "format" })).status, 400);
});
