// Worker contract for gated repos: Check access round trip and the granted list.
//   cd ~/nvme-stash/a1-scout && node --test tests/worker_licenses.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function fakeEnv(kv, picks = []) {
  const rows = Object.fromEntries(Object.entries(kv).map(([k, v]) => [k, JSON.stringify(v)]));
  const DB = { prepare(sql) { let args = [];
    const q = { bind(...a) { args = a; return q; },
      async first() { return /FROM kv WHERE k=\?/.test(sql) && rows[args[0]] ? { v: rows[args[0]] } : null; },
      async all() { return { results: /status='approved'/.test(sql) ? picks : [] }; },
      async run() { if (/INSERT INTO kv/.test(sql)) rows[args[0]] = args[1]; return {}; } };
    return q; } };
  return { env: { DB, SCOUT_TOKEN: "t", ASSETS: { fetch: () => new Response("") } }, rows };
}
const call = (env, path, method = "GET", body) => worker.fetch(new Request("https://x" + path,
  { method, headers: { authorization: "Bearer t", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env).then(r => r.json());

test("Check access is handed to the Mac on its next heartbeat, then acked", async () => {
  const { env } = fakeEnv({ presence: { present: true, at: new Date().toISOString() } });
  const r = await call(env, "/api/license-check", "POST", { repos: ["google/gemma-2-2b"] });
  assert.equal(r.license_check.state, "pending");
  assert.equal(r.mac_checking_in, true);
  const hb = await call(env, "/api/activity", "POST", { kind: "presence", present: true });
  assert.deepEqual(hb.license_check.repos, ["google/gemma-2-2b"]);
  await call(env, "/api/license-check/ack", "POST", { results: { "google/gemma-2-2b": { access: "granted" } }, started: true });
  const a = await call(env, "/api/activity");
  assert.equal(a.license_check.state, "done");
  assert.equal(a.license_check.started, true);
});

test("a granted repo is counted again even if an old refusal lingers", async () => {
  const { env } = fakeEnv({ presence: { present: true, at: new Date().toISOString(), cap_gb: 60,
    needs_license: ["google/gemma-2-2b"], licenses: { "google/gemma-2-2b": { access: "granted" } } } },
    [{ repo: "google/gemma-2-2b", kind: "model", size_bytes: 10.48e9 }]);
  const a = await call(env, "/api/activity");
  assert.equal(a.next[0].when, "next plug-in");
});

test("Yes/No decision goes to the Mac's next heartbeat, then shows the outcome", async () => {
  const { env } = fakeEnv({ presence: { present: true, at: new Date().toISOString() } });
  const bad = await worker.fetch(new Request("https://x/api/license-decision", { method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ repo: "x", decision: "maybe" }) }), env);
  assert.equal(bad.status, 400);
  const r = await call(env, "/api/license-decision", "POST", { repo: "google/gemma-2-2b", kind: "model", decision: "yes" });
  assert.equal(r.license_decisions["google/gemma-2-2b"].state, "pending");
  const hb = await call(env, "/api/activity", "POST", { kind: "presence", present: true });
  assert.equal(hb.license_decisions["google/gemma-2-2b"].decision, "yes");
  await call(env, "/api/license-decision/ack", "POST", { results: { "google/gemma-2-2b": { outcome: "granted", action: "submit" } } });
  const hb2 = await call(env, "/api/activity", "POST", { kind: "presence", present: true });
  assert.deepEqual(hb2.license_decisions, {});                 // done decisions aren't handed out again
  const a = await call(env, "/api/activity");
  assert.equal(a.license_decisions["google/gemma-2-2b"].outcome, "granted");
});
