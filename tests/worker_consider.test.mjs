// POST /api/bench/consider: the Worker contract for Considering a Mac. D1 and KV are the same shims worker_bench uses.
//   cd ~/nvme-stash/a1-scout && node --test tests/worker_consider.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const CONSIDER = "c0nsider-test-token";
const hashOf = t => createHash("sha256").update(t).digest("hex");
const mkEnv = (over = {}) => ({ DB: d1(), BENCH: kv(), SCOUT_TOKEN: "t", A1_CONSIDER_TOKENS: hashOf(CONSIDER), ASSETS: { fetch: () => new Response("") }, ...over });
const req = (env, path, method = "GET", body, token = "t") => worker.fetch(new Request("https://x" + path,
  { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
const call = (...a) => req(...a).then(r => r.json());
const GiB = 2 ** 30;

const run = (machine, model, over = {}) => ({
  suite: "rag-notes", machine, model, model_path: `models/mlx/${model}`, runtime: "mlx_lm", bank: "abc123def456",
  ttft_ms: 210, tok_s: 50, peak_rss: 5 * GiB, load_s: 3.2, passed: 6, total: 8, score: 0.8, started: "2026-11-10T01:00:00Z", results: [], ...over });

// Owned: M1 Pro 16GB (m1) and M4 16GB (m4), each with an agent-picked model for rag-notes.
async function seeded(extraRuns = []) {
  const env = mkEnv();
  await req(env, "/api/bench/runs", "POST", run("m1", "Qwen-7B", { tok_s: 50 }));
  await req(env, "/api/bench/runs", "POST", run("m4", "Qwen-7B", { tok_s: 90 }));
  await req(env, "/api/bench/runs", "POST", run("m4", "Qwen-32B", { tok_s: 20, peak_rss: 20 * GiB, score: 0.9 }));
  for (const r of extraRuns) await req(env, "/api/bench/runs", "POST", r);
  await req(env, "/api/bench/best", "POST", { suite: "rag-notes", machine: "m1", model: "Qwen-7B", model_path: "models/mlx/Qwen-7B", score: 0.8, tok_s: 50, peak_rss: 5 * GiB });
  await req(env, "/api/bench/best", "POST", { suite: "rag-notes", machine: "m4", model: "Qwen-7B", model_path: "models/mlx/Qwen-7B", score: 0.8, tok_s: 90, peak_rss: 5 * GiB });
  return env;
}
const consider = (env, body, token = CONSIDER) => req(env, "/api/bench/consider", "POST", body, token);

test("the consider token opens only this route; SCOUT_TOKEN does not open it", async () => {
  const env = await seeded();
  const body = { machine: { chip: "M1 Pro", memory_gb: 16 } };
  assert.equal((await consider(env, body, "wrong")).status, 401);
  assert.equal((await consider(env, body, "t")).status, 401);
  assert.equal((await req(env, "/api/bench/leaderboard", "GET", null, CONSIDER)).status, 401);
  assert.equal((await req(env, "/api/bench/runs", "POST", run("m1", "x"), CONSIDER)).status, 401);
  assert.equal((await consider(env, body)).status, 200);
});

test("the token is stored hashed; no plaintext is accepted from the secret", async () => {
  const env = mkEnv({ A1_CONSIDER_TOKENS: hashOf("other") });
  assert.equal((await consider(env, { machine: { chip: "M4", memory_gb: 16 } })).status, 401);
  assert.equal((await consider(mkEnv({ A1_CONSIDER_TOKENS: CONSIDER }), { machine: { chip: "M4", memory_gb: 16 } })).status, 401);
});

test("Mac Studio M4 Max 64GB: fits, has suites and a headline, and is labelled as an estimate", async () => {
  const env = await seeded();
  const out = await consider(env, { machine: { chip: "M4", variant: "Max", memory_gb: 64 } }).then(r => r.json());
  assert.equal(out.machine_id, "m4-max-64gb");
  assert.equal(out.fit, "fits");
  assert.equal(out.measured, false);
  assert.equal(out.bandwidth.gbs, 546);
  assert.ok(out.suites.length >= 1);
  assert.match(out.headline, /^M4 Max 64GB: /);
  assert.match(out.estimate_basis, /Nothing has run on this Mac/);
  const rag = out.suites.find(s => s.suite === "rag-notes");
  assert.equal(rag.owned_model, "Qwen-7B");
  assert.ok(rag.speedup_vs_owned > 4, `speedup ${rag.speedup_vs_owned}`);   // 546 / 120 on the M4 run
  // The M4 Max also runs Qwen-32B, which none of the owned Macs can hold: that is the headline, not the speed.
  assert.equal(rag.verdict, "unlock");
  assert.match(rag.text, /^Runs Qwen-32B \(/);
  assert.equal(out.verdict, "opens up");
});

test("m1 considered against itself is no gain", async () => {
  const env = await seeded();
  const out = await consider(env, { machine: { chip: "M1 Pro", memory_gb: 16 } }).then(r => r.json());
  assert.equal(out.machine_id, "m1");
  assert.equal(out.fit, "no_gain");
  assert.equal(out.verdict, "about the same");
  assert.equal(out.bandwidth.gbs, 200);
});

test("a Mac too small for your models doesn't fit", async () => {
  const env = await seeded([run("m1", "Qwen-7B", { peak_rss: 7 * GiB })]);   // the owned stack now needs 7 GB; an 8 GB Mac has 6 GB usable
  const out = await consider(env, { machine: { chip: "M4", memory_gb: 8 } }).then(r => r.json());
  assert.equal(out.fit, "doesnt_fit");
});

test("a base M1 has no Apple bandwidth figure: fit only, no speed", async () => {
  const env = await seeded();
  const out = await consider(env, { machine: { chip: "M1", memory_gb: 8 } }).then(r => r.json());
  assert.equal(out.bandwidth.gbs, null);
  assert.match(out.estimate_basis, /fit and memory only/);
  assert.ok(out.suites.every(s => s.speedup_vs_owned == null));
});

test("input is validated", async () => {
  const env = await seeded();
  assert.equal((await consider(env, { machine: { chip: "Intel Core", memory_gb: 16 } })).status, 400);
  assert.equal((await consider(env, { machine: { chip: "M4", memory_gb: 4 } })).status, 400);
  assert.equal((await consider(env, { machine: { chip: "M4", memory_gb: 16 }, suites: ["nope"] })).status, 400);
  assert.equal((await consider(env, { machine: { chip: "M4", memory_gb: 16 }, owned: "m1" })).status, 400);
});

test("answers are cached for a day per machine and bank; every request leaves a record", async () => {
  const env = await seeded();
  const body = { machine: { chip: "M4", variant: "Max", memory_gb: 64 } };
  const first = await consider(env, body).then(r => r.json());
  assert.equal(first.cached, false);
  const second = await consider(env, body).then(r => r.json());
  assert.equal(second.cached, true);
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM bench_considers").get().n, 1);
  assert.equal(env.BENCH.m.has(`consider:m4-max-64gb:${first.bank_hash}`), true);
  await consider(env, { ...body, owned: ["m1"] });                       // not the default: not cached, still recorded
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM bench_considers").get().n, 2);
});

test("a real run on a considered Mac records the estimate error", async () => {
  const env = await seeded();
  const out = await consider(env, { machine: { chip: "M1 Pro", memory_gb: 16 } }).then(r => r.json());
  const est = out.suites.find(s => s.best_model === "Qwen-7B" && s.tok_s_est).tok_s_est;
  await req(env, "/api/bench/runs", "POST", run("m1", "Qwen-7B", { suite: "rag-notes", tok_s: est * 1.1 }));
  const row = env.DB._db.prepare("SELECT machine_id, model, est_tok_s, measured_tok_s, error_pct FROM bench_consider_checks").get();
  assert.equal(row.machine_id, "m1");
  assert.equal(row.model, "Qwen-7B");
  assert.ok(Math.abs(row.error_pct - (-9.1)) < 0.2, `error ${row.error_pct}`);
});
