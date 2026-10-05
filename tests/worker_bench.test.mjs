// Worker contract for A1 Bench: runs in, leaderboards out, blind battles with Elo in KV.
// D1 is a shim over node:sqlite so the real SQL runs (RETURNING included); KV is an in-memory map.
//   cd ~/nvme-stash/a1-scout && node --test tests/worker_bench.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";

function d1() {
  const db = new DatabaseSync(":memory:");
  const plain = o => (o ? { ...o } : null);
  const prep = sql => { let args = [];
    const s = { bind(...a) { args = a; return s; },
      async first() { return plain(db.prepare(sql).get(...args)); },
      async all() { return { results: db.prepare(sql).all(...args).map(plain) }; },
      async run() { db.prepare(sql).run(...args); return { success: true }; } };
    return s; };
  return { prepare: prep, async batch(stmts) { return Promise.all(stmts.map(s => s.run())); }, _db: db };
}
function kv() {
  const m = new Map();
  return { m,
    async get(k, type) { const e = m.get(k); if (!e || (e.exp && e.exp < Date.now())) return null; return type === "json" ? JSON.parse(e.v) : e.v; },
    async put(k, v, o = {}) { m.set(k, { v, exp: o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : 0, ttl: o.expirationTtl }); },
    async delete(k) { m.delete(k); } };
}
const mkEnv = (over = {}) => ({ DB: d1(), BENCH: kv(), SCOUT_TOKEN: "t", ASSETS: { fetch: () => new Response("") }, ...over });
const req = (env, path, method = "GET", body, token = "t") => worker.fetch(new Request("https://x" + path,
  { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
const call = (...a) => req(...a).then(r => r.json());

const run = (model, over = {}) => ({
  suite: "rag-notes", machine: "m1", model, model_path: `models/mlx/${model}`, runtime: "mlx_lm", bank: "abc123def456",
  ttft_ms: 210, tok_s: 55.5, peak_rss: 2.1e9, load_s: 3.2, passed: 6, total: 8, score: 0.8, started: "2026-10-04T01:00:00Z",
  results: [{ id: "rag-cmp", pass: true, score: 1, output: `${model} says ExampleCMP`, prompt: "Which consent platform?" },
            { id: "rag-medium", pass: false, score: 0, output: "email", prompt: "What medium?" }], ...over });

test("runs need the token and a known suite", async () => {
  const env = mkEnv();
  assert.equal((await req(env, "/api/bench/runs", "POST", run("A"), "wrong")).status, 401);
  assert.equal((await req(env, "/api/bench/leaderboard", "GET", null, "")).status, 401);
  const bad = await req(env, "/api/bench/runs", "POST", run("A", { suite: "client-x" }));
  assert.equal(bad.status, 400);
  const bad2 = await req(env, "/api/bench/runs", "POST", run("../etc"));
  assert.equal(bad2.status, 400);
  const ok = await call(env, "/api/bench/runs", "POST", run("Qwen3-0.6B-4bit"));
  assert.equal(ok.ok, true);
  assert.ok(ok.id > 0);
});

test("posted rows are cleaned: non-finite metrics dropped, outputs and task counts capped", async () => {
  const env = mkEnv();
  const huge = Array.from({ length: 250 }, (_, i) => ({ id: `t${i}`, pass: 1, score: 1, output: "x".repeat(2500) }));
  const { id } = await call(env, "/api/bench/runs", "POST", run("M", { tok_s: "fast", ttft_ms: null, passed: 99, total: 8, score: 4, results: huge }));
  const r = await call(env, `/api/bench/run?id=${id}`);
  assert.equal(r.tok_s, null);
  assert.equal(r.passed, 8);              // never more than total
  assert.equal(r.score, 1);               // clamped to 0..1
  assert.equal(r.results.length, 200);
  assert.equal(r.results[0].output.length, 2000);
  assert.equal(r.results[0].pass, true);
  const tooBig = await req(env, "/api/bench/runs", "POST", run("M", { results: [{ id: "t", output: "x".repeat(1_100_000) }] }));
  assert.equal(tooBig.status, 413);
});

test("leaderboard: latest run per model, filtered by suite and machine, best score first", async () => {
  const env = mkEnv();
  await call(env, "/api/bench/runs", "POST", run("Small", { score: 0.5 }));
  await call(env, "/api/bench/runs", "POST", run("Small", { score: 0.7, tok_s: 90 }));     // newer run replaces the old one
  await call(env, "/api/bench/runs", "POST", run("Big", { score: 0.9, tok_s: 20 }));
  await call(env, "/api/bench/runs", "POST", run("Big", { machine: "m5p", score: 0.95 }));
  await call(env, "/api/bench/runs", "POST", run("Big", { suite: "sql-ga4", score: 0.3 }));
  const lb = await call(env, "/api/bench/leaderboard?suite=rag-notes&machine=m1");
  assert.deepEqual(lb.rows.map(r => [r.model, r.score]), [["Big", 0.9], ["Small", 0.7]]);
  assert.equal(lb.rows[1].tok_s, 90);
  assert.equal(lb.rows[0].results, undefined);            // per-task outputs stay out of the list
  assert.equal(lb.rows[0].elo, null);
  const all = await call(env, "/api/bench/leaderboard");
  assert.equal(all.rows.length, 4);
  assert.deepEqual(all.machines.map(m => m.machine).sort(), ["m1", "m5p"]);
  assert.equal(all.suites.find(s => s.id === "rag-notes").models, 2);
  assert.equal(all.suites.find(s => s.id === "asr").models, 0);
});

test("battle is blind, then one vote moves Elo in KV and logs to D1", async () => {
  const env = mkEnv();
  const none = await req(env, "/api/bench/battle?suite=rag-notes");
  assert.equal(none.status, 409);                                       // one model can't battle
  await call(env, "/api/bench/runs", "POST", run("Alpha"));
  await call(env, "/api/bench/runs", "POST", run("Beta"));
  const b = await call(env, "/api/bench/battle?suite=rag-notes");
  assert.equal(b.task.id, "rag-cmp");                                   // the task where answers differ
  assert.ok(!JSON.stringify(b).includes("Alpha\"") && !("model" in b.a) && !("model" in b.b));
  const pending = env.DB._db.prepare("SELECT expires FROM bench_battles WHERE id=?").get(b.id);
  assert.ok(Math.abs(pending.expires - (Date.now() + 3600e3)) < 5000);   // waits an hour for a vote
  const winner = b.a.output.startsWith("Alpha") ? "Alpha" : "Beta";
  const v = await call(env, "/api/bench/battle", "POST", { id: b.id, vote: "a" });
  assert.equal(v.a.model, winner);
  assert.equal(v.a.elo_before, 1000);
  assert.equal(v.a.elo_after, 1016);
  assert.equal(v.b.elo_after, 984);
  const again = await req(env, "/api/bench/battle", "POST", { id: b.id, vote: "b" });
  assert.equal(again.status, 404);                                      // one vote per battle
  const elo = JSON.parse(env.BENCH.m.get("elo:rag-notes").v);
  assert.equal(elo[winner].w, 1);
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM bench_votes").get().n, 1);
  const lb = await call(env, "/api/bench/leaderboard?suite=rag-notes");
  assert.equal(lb.rows.find(r => r.model === winner).elo, 1016);
  assert.equal(lb.rows.find(r => r.model === winner).battles, 1);
});

test("ties move ratings toward each other; bad votes and expired battles are refused", async () => {
  const env = mkEnv();
  // Hi has won five earlier battles against Mid (in the D1 log; KV is rebuilt from it)
  await call(env, "/api/bench/leaderboard");                                // creates the tables
  const ins = env.DB._db.prepare("INSERT INTO bench_votes (suite, task_id, model_a, model_b, vote, created) VALUES ('screen','t','Hi','Mid','a','x')");
  for (let i = 0; i < 5; i++) ins.run();
  await call(env, "/api/bench/runs", "POST", run("Hi", { suite: "screen" }));
  await call(env, "/api/bench/runs", "POST", run("Lo", { suite: "screen" }));
  const b = await call(env, "/api/bench/battle?suite=screen");
  assert.equal((await req(env, "/api/bench/battle", "POST", { id: b.id, vote: "maybe" })).status, 400);
  const v = await call(env, "/api/bench/battle", "POST", { id: b.id, vote: "tie" });
  const hi = v.a.model === "Hi" ? v.a : v.b, lo = v.a.model === "Hi" ? v.b : v.a;
  assert.ok(hi.elo_before > 1050 && hi.elo_after < hi.elo_before && lo.elo_after > 1000);
  assert.equal(hi.record.t, 1);
  const b2 = await call(env, "/api/bench/battle?suite=screen");
  env.DB._db.prepare("UPDATE bench_battles SET expires=? WHERE id=?").run(Date.now() - 1, b2.id);   // an hour later
  assert.equal((await req(env, "/api/bench/battle", "POST", { id: b2.id, vote: "a" })).status, 404);
});

test("battles report 503 without the KV binding; the leaderboard still works", async () => {
  const env = mkEnv({ BENCH: undefined });
  await call(env, "/api/bench/runs", "POST", run("A"));
  assert.equal((await req(env, "/api/bench/battle?suite=rag-notes")).status, 503);
  assert.equal((await call(env, "/api/bench/leaderboard")).rows.length, 1);
});

test("a re-sent run (same uid) is stored once; bad JSON is a 400", async () => {
  const env = mkEnv();
  const a = await call(env, "/api/bench/runs", "POST", run("A", { uid: "u-1" }));
  const b = await call(env, "/api/bench/runs", "POST", run("A", { uid: "u-1" }));
  assert.equal(b.id, a.id);
  assert.equal(b.duplicate, true);
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM bench_runs").get().n, 1);
  const bad = await worker.fetch(new Request("https://x/api/bench/runs", { method: "POST", headers: { authorization: "Bearer t" }, body: "{nope" }), env);
  assert.equal(bad.status, 400);
});

test("Elo comes from the vote log: a stale or wiped KV copy can't lose votes", async () => {
  const env = mkEnv();
  await call(env, "/api/bench/runs", "POST", run("Alpha"));
  await call(env, "/api/bench/runs", "POST", run("Beta"));
  const b1 = await call(env, "/api/bench/battle?suite=rag-notes");
  const b2 = await call(env, "/api/bench/battle?suite=rag-notes");
  const v1 = await call(env, "/api/bench/battle", "POST", { id: b1.id, vote: "tie" });
  env.BENCH.m.delete("elo:rag-notes");                                     // as if KV served an old copy
  const v2 = await call(env, "/api/bench/battle", "POST", { id: b2.id, vote: "tie" });
  assert.equal(v1.a.record.t + v2.a.record.t, 3);                           // 1 after the first vote, 2 after the second
  const elo = JSON.parse(env.BENCH.m.get("elo:rag-notes").v);
  assert.equal(elo.Alpha.n, 2);
  assert.equal(elo.Beta.n, 2);
});

test("battles only pair runs of the current task bank", async () => {
  const env = mkEnv();
  await call(env, "/api/bench/runs", "POST", run("Old", { bank: "old000000000" }));
  await call(env, "/api/bench/runs", "POST", run("New", { bank: "new000000000" }));
  assert.equal((await req(env, "/api/bench/battle?suite=rag-notes")).status, 409);
  await call(env, "/api/bench/runs", "POST", run("Old", { bank: "new000000000" }));
  assert.equal((await req(env, "/api/bench/battle?suite=rag-notes")).status, 200);
});

test("the agent's pick is stored per suite and Mac and comes back with the leaderboard", async () => {
  const env = mkEnv();
  const pick = { suite: "rag-notes", machine: "m1", model: "Qwen3-4B-4bit", model_path: "models/mlx/Qwen3-4B-4bit", score: 0.9, tok_s: 31,
    why: "highest score (90)", considered: 6, ran: 3, reused: 1, screened_out: [{ model: "Tiny", screen_score: 0.2 }, { nope: 1 }] };
  assert.equal((await req(env, "/api/bench/best", "POST", pick, "wrong")).status, 401);
  assert.equal((await req(env, "/api/bench/best", "POST", { ...pick, suite: "x" })).status, 400);
  assert.equal((await req(env, "/api/bench/best", "POST", { ...pick, model: "../x" })).status, 400);
  await call(env, "/api/bench/best", "POST", pick);
  await call(env, "/api/bench/best", "POST", { ...pick, machine: "m5p", model: "Qwen3.8-27B-4bit" });
  const lb = await call(env, "/api/bench/leaderboard?suite=rag-notes");
  assert.equal(lb.best["rag-notes"].m1.model, "Qwen3-4B-4bit");
  assert.equal(lb.best["rag-notes"].m5p.model, "Qwen3.8-27B-4bit");
  assert.deepEqual(lb.best["rag-notes"].m1.screened_out.map(x => x.model), ["Tiny"]);
  await call(env, "/api/bench/best", "POST", { ...pick, model: "Qwen3-1.7B-4bit" });       // a newer search replaces the pick
  assert.equal((await call(env, "/api/bench/leaderboard")).best["rag-notes"].m1.model, "Qwen3-1.7B-4bit");
});

test("gtm-gate runs are accepted like any other suite", async () => {
  const env = mkEnv();
  const ok = await call(env, "/api/bench/runs", "POST", run("clef-flash-4bit", { suite: "gtm-gate", runtime: "clef_mlx", tok_s: 8, ttft_ms: 500 }));
  assert.equal(ok.ok, true);
  const lb = await call(env, "/api/bench/leaderboard?suite=gtm-gate");
  assert.equal(lb.rows[0].model, "clef-flash-4bit");
  assert.ok(lb.suites.some(s => s.id === "gtm-gate"));
  assert.equal((await call(env, "/api/bench/runs", "POST", run("clef-flash-4bit", { suite: "skill-select", uid: "s1" }))).ok, true);
});

test("leaderboard devices: Tailnet devices joined to agents and their hardware's runs", async () => {
  const env = mkEnv();
  env.DB._db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, updated TEXT)");
  await call(env, "/api/bench/runs", "POST", run("Qwen3-0.6B-4bit", { machine: "m4", uid: "d1" }));
  await call(env, "/api/activity", "POST", { kind: "presence", host: "claws-mac-mini", ts_name: "claws-mac-mini", machine: "m4",
    machine_label: "Claw's Mac mini · M4 16 GB", present: true,
    tailnet: [{ name: "claws-mac-mini", label: "Claw's Mac mini", os: "macOS", online: true }, { name: "pi5-dev", label: "pi5-dev", os: "linux", online: false }] });
  const lb = await call(env, "/api/bench/leaderboard");
  const by = Object.fromEntries(lb.devices.map(d => [d.name, d]));
  assert.equal(by["claws-mac-mini"].hw, "m4");
  assert.equal(by["claws-mac-mini"].runs, 1);
  assert.equal(by["pi5-dev"].agent, false);
  assert.equal(lb.devices[0].name, "claws-mac-mini");
});
