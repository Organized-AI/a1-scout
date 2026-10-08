// Coding sessions: connect, upload, sync log, overview, heartbeat orders, privacy rejection and ranking boost.
// D1 is stood in for by Node's built-in SQLite, so the real SQL runs.
//   cd ~/nvme-stash/a1-scout && node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { workBoost, workIndex, weekOf, tokensOfName } from "../src/sessions.js";

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT, updated TEXT)");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => (db.prepare(sql).run(...args), {}),
  });
  return { prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); return []; } };
}
function env() {
  const r2 = new Map(), points = [];
  return { DB: d1(), SCOUT_TOKEN: "t", ASSETS: { fetch: () => new Response("") },
    SESSION_LOGS: { put: async (k, v) => r2.set(k, v) }, SESSION_METRICS: { writeDataPoint: p => points.push(p) }, r2, points };
}
const call = (e, path, body, method = body ? "POST" : "GET") => worker.fetch(new Request("https://x" + path,
  { method, headers: { authorization: "Bearer t", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), e).then(async r => ({ status: r.status, j: await r.json() }));

const h = c => c.repeat(64).slice(0, 64);
const session = (id, day, obs) => ({ source: "claude", native_session_digest: h(id), project_fingerprint: h("b"), first_event: `${day}T10:00:00.000Z`,
  last_event: `${day}T11:00:00.000Z`, evidence_quality: "full-transcript", event_count: 40, observations: obs });
const bundle = sessions => ({ bundle_schema_version: 1, environment: { id: "a".repeat(24), kind: "computer" }, collected_at: new Date().toISOString(),
  source_coverage: [], session_evidence: sessions });
const today = new Date().toISOString().slice(0, 10), lastWeek = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

test("connect, upload, sync log and overview", async () => {
  const e = env();
  assert.equal((await call(e, "/api/sessions/connect", { on: true })).j.connect.on, true);
  const obs = { app: "claude-code", model: "claude-opus-5-5", turns: 4, edits: 6, errors: 1, active_minutes: 45,
    tokens: { input: 1000, output: 500, cache_read: 90000, cache_write: 4000 }, tools: { Bash: 10, Edit: 6 }, languages: { python: 5 },
    packages: ["mlx-whisper"], imports: ["mlx_vlm", "os"], models: ["mlx-community/whisper-large-v3-turbo"] };
  const up = await call(e, "/api/sessions/upload", { host: "MacBookPro", run_id: "run-000001", part: 0,
    bundle: bundle([session("1", today, obs), session("2", lastWeek, { ...obs, packages: ["mlx-whisper", "transformers"] })]) });
  assert.equal(up.status, 200); assert.equal(up.j.stored, 2);
  assert.match(up.j.r2, /^sessions\/MacBookPro\/\d{4}-\d{2}-\d{2}\/run-000001-0\.json$/);
  assert.equal(e.points.length, 2);
  // the same session synced again updates, not duplicates
  await call(e, "/api/sessions/upload", { host: "MacBookPro", run_id: "run-000002", bundle: bundle([session("1", today, { ...obs, turns: 9 })]) });
  await call(e, "/api/sessions/run", { host: "MacBookPro", run_id: "run-000002", state: "done", sessions: 1, stored: 1, files_scanned: 3, trigger: "loop" });
  const o = (await call(e, "/api/sessions")).j;
  assert.equal(o.totals.sessions, 2);
  assert.equal(o.history.length, weekOf(today) === weekOf(lastWeek) ? 1 : 2);
  const w = o.history.at(-1);
  assert.equal(w.turns, 9); assert.equal(w.tokens_cache_read, 90000); assert.equal(w.tool_calls, 16);
  assert.equal(o.runs[0].state, "done");
  assert.deepEqual(o.profile.libraries.map(x => x.name), ["mlx_vlm"]); // stdlib dropped
  assert.equal(o.profile.packages[0].name, "mlx-whisper");
});

test("bundles with paths or keys are refused and logged nothing", async () => {
  const e = env();
  const bad = await call(e, "/api/sessions/upload", { host: "m", run_id: "run-000003", bundle: bundle([session("3", today, { tools: { Read: 1 }, note: "/Users/someone/client" })]) });
  assert.equal(bad.status, 400); assert.equal(bad.j.code, "BUNDLE_PRIVATE_DATA_DETECTED");
  assert.equal(e.r2.size, 0);
});

test("heartbeat tells every Mac whether to sync, and sync-now forces one", async () => {
  const e = env();
  const beat = host => call(e, "/api/activity", { kind: "presence", host, machine: host, present: false });
  assert.equal((await beat("mini")).j.sessions.on, false);
  await call(e, "/api/sessions/connect", { on: true });
  const a = (await beat("mini")).j.sessions, b = (await beat("MacBookPro")).j.sessions;
  assert.equal(a.on, true); assert.equal(b.on, true); assert.equal(a.every_min, 15); assert.ok(a.force_at);
  await call(e, "/api/sessions/connect", { on: false });
  assert.equal((await beat("mini")).j.sessions.on, false);
});

test("picks get a reason from your work", async () => {
  const e = env();
  await call(e, "/api/sessions/upload", { host: "m", run_id: "run-000004", bundle: bundle([1, 2, 3].map(i => session(String(i), today,
    { tools: {}, packages: ["mlx-whisper"], models: i === 1 ? ["mlx-community/Qwen3-4B-4bit"] : [] }))) });
  const work = await workIndex(e);
  const w1 = workBoost({ kind: "model", repo: "mlx-community/whisper-large-v3-turbo" }, work);
  assert.equal(w1.reason, "you used mlx-whisper in 3 sessions"); assert.ok(w1.points > 0 && w1.points <= 12);
  assert.equal(workBoost({ kind: "model", repo: "mlx-community/Qwen3-4B-4bit" }, work).reason, "you used mlx-community/Qwen3-4B-4bit in 1 session");
  assert.equal(workBoost({ kind: "model", repo: "org/unrelated-model" }, work), null);
  assert.ok(!tokensOfName("mlx-community/Llama-3-8B-Instruct-4bit").includes("mlx"));
});
