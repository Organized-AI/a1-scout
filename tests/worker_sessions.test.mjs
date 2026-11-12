// Coding sessions: connect, upload, sync log, overview, heartbeat orders, privacy rejection and ranking boost.
// D1 is stood in for by Node's built-in SQLite, so the real SQL runs.
//   cd ~/nvme-stash/a1-scout && node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { workBoost, workIndex, weekOf, tokensOfName, appGroup } from "../src/sessions.js";

test("Desktop Code and Cowork share a distinct application group", () => {
  assert.equal(appGroup("claude-desktop"), "Claude Desktop");
  assert.equal(appGroup("claude-cowork"), "Claude Desktop");
  assert.equal(appGroup("claude-code"), "Claude Code");
  assert.equal(appGroup("codex-cli"), "Codex");
});

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

// ---------- weekly alerts and long series ----------
const day = (week, n = 2) => new Date(Date.parse(week + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const trailing = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"], latest = "2026-09-28";
const steady = { turns: 10, errors: 1, tools: { Bash: 20 }, llms: { "claude-opus-5-5": 3 }, tokens: { input: 1000, output: 1000, cache_read: 8000, cache_write: 0 } };
const busy = { turns: 10, errors: 5, tools: { Bash: 10, WebFetch: 10 }, llms: { "claude-opus-5-5": 1, "gpt-5.5-codex": 2 }, tokens: { input: 10000, output: 10000, cache_read: 5000, cache_write: 5000 } };
async function seedWeeks(e) {
  await call(e, "/api/sessions/upload", { host: "m", run_id: "run-000010", bundle: bundle([
    ...trailing.map((w, i) => session(`a${i}`, day(w), steady)), session("cc", day(latest), busy)]) });
}

test("weekly alerts: last week against the 4-week average", async () => {
  const e = env();
  await seedWeeks(e);
  const r = (await call(e, `/api/sessions/alerts/run?week=${latest}`, {})).j;
  assert.equal(r.week, latest); assert.equal(r.baseline_weeks, 4);
  const by = Object.fromEntries(r.alerts.map(a => [a.metric, a]));
  assert.deepEqual(Object.keys(by), ["tokens", "cache_hit", "error_rate", "tokens_per_prompt", "new_tools", "new_llms"]);
  assert.equal(by.tokens.value, 30000); assert.equal(by.tokens.baseline, 10000); assert.equal(by.tokens.change, 2); assert.equal(by.tokens.flag, true);
  assert.equal(by.cache_hit.value, 0.25); assert.equal(by.cache_hit.baseline, 0.889); assert.equal(by.cache_hit.tone, "bad");
  assert.equal(by.error_rate.value, 0.25); assert.equal(by.error_rate.baseline, 0.05); assert.equal(by.error_rate.tone, "bad");
  assert.equal(by.tokens_per_prompt.value, 3000); assert.equal(by.tokens_per_prompt.baseline, 1000); assert.equal(by.tokens_per_prompt.tone, "bad");
  assert.deepEqual(by.new_tools.detail, ["WebFetch"]); assert.equal(by.new_tools.value, 1);
  assert.deepEqual(by.new_llms.detail, ["gpt-5.5-codex"]);
  // re-run replaces, and the overview carries the latest week
  await call(e, `/api/sessions/alerts/run?week=${day(latest, 5)}`, {});
  const o = (await call(e, "/api/sessions")).j;
  assert.equal(o.alerts.week, latest); assert.equal(o.alerts.rows.length, 6);
  assert.equal(o.alerts.rows.find(x => x.metric === "new_tools").detail[0], "WebFetch");
  assert.equal(o.alerts.rows.find(x => x.metric === "cache_hit").flag, true);
});

test("weekly alerts: steady week flags nothing, empty week stores nothing", async () => {
  const e = env();
  await call(e, "/api/sessions/upload", { host: "m", run_id: "run-000011", bundle: bundle([...trailing, latest].map((w, i) => session(`b${i}`, day(w), steady))) });
  const r = (await call(e, `/api/sessions/alerts/run?week=${latest}`, {})).j;
  assert.deepEqual(r.alerts.filter(a => a.flag), []);
  const none = (await call(e, "/api/sessions/alerts/run?week=2026-08-17", {})).j;
  assert.deepEqual(none.alerts, []);
  assert.equal((await call(e, "/api/sessions")).j.alerts.week, latest);
  // first week of data: no baseline, nothing called new
  const f = env();
  await call(f, "/api/sessions/upload", { host: "m", run_id: "run-000012", bundle: bundle([session("dd", day(latest), busy)]) });
  const fr = (await call(f, `/api/sessions/alerts/run?week=${latest}`, {})).j;
  assert.equal(fr.baseline_weeks, 0); assert.ok(fr.alerts.every(a => !a.flag && a.baseline == null));
  // the current (incomplete) week and bad dates are refused
  assert.equal((await call(f, `/api/sessions/alerts/run?week=${today}`, {})).status, 400);
  assert.equal((await call(f, "/api/sessions/alerts/run?week=2026-13-45", {})).status, 400);
});

test("alert flags: a 0 baseline is real for rates", async () => {
  const { alertFlag } = await import("../src/sessions.js");
  assert.deepEqual(alertFlag("error_rate", 0.4, 0, null), { flag: true, tone: "bad" });
  assert.deepEqual(alertFlag("cache_hit", 0, 0.8, -1), { flag: true, tone: "bad" });
  assert.deepEqual(alertFlag("error_rate", 0.06, 0.05, 0.2), { flag: false, tone: "info" });
  assert.deepEqual(alertFlag("tokens", 100, 0, null), { flag: false, tone: "info" });
  // a week with tokens but no cache reads reports 0%, not nothing
  const e = env(), noCache = { ...steady, tokens: { input: 5000, output: 1000, cache_read: 0, cache_write: 0 } };
  await call(e, "/api/sessions/upload", { host: "m", run_id: "run-000015", bundle: bundle([...trailing.map((w, i) => session(`c${i}`, day(w), steady)), session("cf", day(latest), noCache)]) });
  const ch = (await call(e, `/api/sessions/alerts/run?week=${latest}`, {})).j.alerts.find(a => a.metric === "cache_hit");
  assert.equal(ch.value, 0); assert.equal(ch.flag, true); assert.equal(ch.tone, "bad");
});

test("series: AE for its window (deduped per session), D1 before it, D1 when AE fails", async () => {
  const { sessionSeries } = await import("../src/sessions.js");
  const e = { ...env(), CF_ACCOUNT_ID: "acct", CF_AE_TOKEN: "tok" };
  const old = new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10);
  await call(e, "/api/sessions/upload", { host: "m", run_id: "run-000013", bundle: bundle([session("e1", old, steady), session("e2", old, steady), session("f1", today, steady)]) });
  assert.equal(e.points[0].blobs[6], h("e1").slice(0, 16)); // AE points carry the session digest
  const real = globalThis.fetch, sent = [];
  try {
    globalThis.fetch = async (u, init) => { sent.push({ u, init }); return new Response(JSON.stringify({ data: [{ day: today, sessions: "1", turns: 10, tokens_in: "1000" }] })); };
    const s = await sessionSeries(e, 365, { aeSince: "2000-01-01" });
    assert.match(sent[0].u, /accounts\/acct\/analytics_engine\/sql$/); assert.equal(sent[0].init.headers.authorization, "Bearer tok");
    assert.match(sent[0].init.body, /max\(double1\) AS turns/); assert.match(sent[0].init.body, /GROUP BY day, sid/); assert.match(sent[0].init.body, /blob7 != ''/);
    assert.deepEqual(s.series.map(x => [x.day, x.source, x.sessions]), [[old, "d1", 2], [today, "ae", 1]]);
    assert.equal(s.series[1].tokens_in, 1000); assert.equal(s.series[0].turns, 20);
    // AE short of D1 for a day (write limit, pre-blob7 sessions): D1 wins that day
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ day: today, sessions: "0", turns: 0 }] }));
    const short = await sessionSeries(e, 365, { aeSince: "2000-01-01" });
    assert.equal(short.series.at(-1).source, "d1"); assert.equal(short.sources.ae.replaced_by_d1, 1);
    globalThis.fetch = async () => new Response("no", { status: 403 });
    const f = await sessionSeries(e, 365, { aeSince: "2000-01-01" });
    assert.match(f.sources.ae.error, /403/);
    assert.deepEqual(f.series.map(x => [x.day, x.source]), [[old, "d1"], [today, "d1"]]);
  } finally { globalThis.fetch = real; }
  // no secrets: D1 only, over HTTP too
  const plain = env();
  await call(plain, "/api/sessions/upload", { host: "m", run_id: "run-000014", bundle: bundle([session("f2", today, steady)]) });
  const r = (await call(plain, "/api/sessions/series?days=30")).j;
  assert.equal(r.days, 30); assert.match(r.sources.ae.off, /not set/); assert.equal(r.series[0].source, "d1");
});

test("scripted runs are agents, kept out of your numbers, with a failing-since streak", async () => {
  const { classify } = await import("../src/sessions.js");
  assert.equal(classify({ app: "codex-cli", launch: "headless" }).actor, "agent");
  assert.equal(classify({ app: "codex-desktop", launch: "interactive" }).actor, "you");
  assert.equal(classify({ app: "codex-cli", launch: "interactive", harness: "paperclip" }).actor, "agent");
  assert.equal(classify({ app: "codex-cli", turns: 1, tokens: {} }).actor, "agent");          // older rows: one prompt, no tokens
  assert.equal(classify({ app: "codex-cli", launch: "headless", failure: "<b>x</b>" }).failure, null); // only short categories
  const e = env();
  const run = (id, day, failure) => session(id, day, { app: "codex-cli", launch: "headless", harness: "paperclip", turns: 1, tools: {}, ...(failure ? { failure } : { tokens: { input: 5, output: 5 } }) });
  const old = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10), mid = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
  await call(e, "/api/sessions/upload", { host: "pi5-dev", run_id: "run-000005", bundle: bundle([run("a", old), run("b", mid, "model_not_supported"), run("c", today, "model_not_supported"),
    session("d", today, { app: "codex-desktop", launch: "interactive", turns: 3, tools: { exec_command: 4 }, tokens: { input: 100, output: 50, cache_read: 900 } })]) });
  const o = (await call(e, "/api/sessions")).j;
  assert.equal(o.totals.sessions, 1); assert.equal(o.lite.rows.length, 1); assert.equal(o.lite.rows[0][11], 4);
  const g = o.agents.groups[0];
  assert.equal(g.harness, "paperclip"); assert.equal(g.runs, 3); assert.equal(g.failed, 2);
  assert.equal(g.failing_since.slice(0, 10), mid); assert.equal(g.failures[0].kind, "model_not_supported");
});

test("full transcripts: scrubbed on the Mac, stored in R2, read back decompressed", async () => {
  const { scrub, packTranscript } = await import("../agent/scout-connect/transcripts.mjs");
  const { gunzipSync } = await import("node:zlib");
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const raw = JSON.stringify({ type: "user", message: { content: "use key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ and hf_abcdefghijklmnopqrstuvwxyz0123456789 in /Users/jordan/proj" } })
    + "\n" + JSON.stringify({ k: "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----" });
  const s = scrub(raw);
  assert.equal(s.redacted, 3); assert.ok(!/sk-ant|hf_abc|MIIabc/.test(s.text)); assert.ok(s.text.includes("/Users/jordan/proj")); // paths stay
  for (const l of s.text.split("\n")) JSON.parse(l); // still valid JSONL
  const dir = mkdtempSync(join(tmpdir(), "tx-")), f = join(dir, "s.jsonl"); writeFileSync(f, raw);
  const t = packTranscript({ source: "claude", digest: h("1"), file: f }, join(dir, "out"));
  assert.equal(t.redacted, 3); assert.equal(gunzipSync(readFileSync(t.path)).toString(), s.text);

  const e = env(); const store = new Map();
  e.SESSION_LOGS = { put: async (k, v) => { store.set(k, new Uint8Array(await new Response(v).arrayBuffer())); return { size: store.get(k).length }; },
    get: async k => store.has(k) ? { body: new Response(store.get(k)).body } : null };
  const put = (digest) => worker.fetch(new Request(`https://x/api/sessions/transcript?source=claude&digest=${digest}&host=m&bytes=${s.text.length}&redacted=3`,
    { method: "PUT", headers: { authorization: "Bearer t" }, body: readFileSync(t.path) }), e).then(async r => ({ status: r.status, j: await r.json() }));
  assert.equal((await put(h("1"))).status, 409); // summary first
  await call(e, "/api/sessions/upload", { host: "m", run_id: "run-000006", bundle: bundle([session("1", today, { app: "claude-code", launch: "interactive", tools: {} })]) });
  assert.equal((await put(h("1"))).status, 200);
  const back = await worker.fetch(new Request(`https://x/api/sessions/transcript?source=claude&digest=${h("1")}`, { headers: { authorization: "Bearer t" } }), e).then(r => r.text());
  assert.equal(back, s.text);
  const list = (await call(e, "/api/sessions/list?actor=you")).j.sessions;
  assert.equal(list[0].transcript_bytes, s.text.length); assert.equal(list[0].transcript_redacted, 3);
  assert.equal((await call(e, "/api/sessions/transcripts", { on: true })).j.connect.transcripts, true);
  assert.equal((await call(e, "/api/sessions")).j.transcripts.n, 1);
});
