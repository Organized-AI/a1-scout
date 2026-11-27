// Real SQLite exercises the append-only Speed Lab API; no remote database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import worker from "../src/index.js";

function d1() {
  const db = new DatabaseSync(":memory:");
  const plain = o => o ? { ...o } : null;
  return {
    _db: db,
    prepare(sql) {
      let args = [];
      const s = {
        bind(...values) { args = values; return s; },
        async first() { return plain(db.prepare(sql).get(...args)); },
        async all() { return { results: db.prepare(sql).all(...args).map(plain) }; },
        async run() { db.prepare(sql).run(...args); return { success: true }; },
      };
      return s;
    },
    async batch(stmts) { return Promise.all(stmts.map(s => s.run())); },
  };
}
const env = () => ({ DB: d1(), SCOUT_TOKEN: "speed-test", A1_CONSIDER_TOKENS: createHash("sha256").update("consider-test").digest("hex"), ASSETS: { fetch: () => new Response("") } });
const row = (over = {}) => ({ uid: "a".repeat(32), suite: "speed", machine: "m1", model: "Qwen3-0.6B-4bit", target: "omlx",
  bank: "abc123def456", task_id: "speed-agent-release-1000-prefill", phase: "prefill", workload: "agent", fit: true,
  tokenizer: "Qwen3", target_prompt_tokens: 1000, prompt_tokens: 1024, reply_tokens: 1, max_tokens: 1,
  ttft_ms: 1000, prompt_tok_s: 1024, write_tok_s: null, latency_ms: 1050, runtime: "omlx", engine_version: "0.8.3",
  started: "2026-11-26T01:00:00Z", finished: "2026-11-26T01:00:01Z", cache_state: "first-use-unconfirmed", cache_pair_uid: "b".repeat(32),
  usage: { prompt_tokens: 1024, completion_tokens: 1, total_tokens: 1025, prompt_tokens_details: { cached_tokens: 512 } },
  probes: { chip: "M1 Pro", bandwidth_gbs: 200, free_ram_bytes: 1000000000, peak_rss_bytes: 123000000, rss_scope: "client", cache_read_gbs: .5 }, ...over });
const request = (e, method = "GET", body, path = "/api/bench/speed", token = "speed-test") => worker.fetch(new Request("https://x" + path,
  { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }), e);
const post = async (e, body) => { const r = await request(e, "POST", body); assert.equal(r.status, 200); return r.json(); };
const get = async (e, path) => { const r = await request(e, "GET", undefined, path); assert.equal(r.status, 200); return r.json(); };

test("speed GET and POST use Bench auth, not scoped Consider token", async () => {
  const e = env();
  for (const method of ["GET", "POST"]) for (const token of ["", "wrong", "consider-test"])
    assert.equal((await request(e, method, method === "POST" ? row() : undefined, undefined, token)).status, 401);
  assert.equal((await request(e)).status, 200);
});

test("speed validates JSON, required identifiers, enums and bounded bodies", async () => {
  const e = env();
  assert.equal((await request(e, "POST", "{bad")).status, 400);
  assert.equal((await request(e, "POST", "x".repeat(1024 * 1024 + 1))).status, 413);
  for (const change of [{ uid: "" }, { machine: "../etc" }, { model: "../etc" }, { target: "cloud" },
    { phase: "quality" }, { workload: "client" }, { fit: "yes" }, { bank: "" }, { task_id: "" }])
    assert.equal((await request(e, "POST", row(change))).status, 400, JSON.stringify(change));
});

test("speed round-trips usage/probes and null metrics without retaining output or keys", async () => {
  const e = env();
  const saved = await post(e, row({ output: "private-output", prompt: "private-prompt", api_key: "private-key", authorization: "Bearer private", score: 1 }));
  assert.equal(saved.ok, true);
  const data = await get(e);
  assert.equal(data.rows.length, 1);
  const r = data.rows[0];
  assert.equal(r.uid, row().uid);
  assert.equal(r.write_tok_s, null);
  assert.equal(r.prompt_tok_s, 1024);
  assert.equal(r.usage.prompt_tokens_details.cached_tokens, 512);
  assert.equal(r.probes.free_ram_bytes, 1000000000);
  assert.equal(r.probes.rss_scope, "client");
  assert.equal(r.engine_version, "0.8.3");
  assert.doesNotMatch(JSON.stringify(data), /private-output|private-prompt|private-key|Bearer private/);
  assert.equal(r.score, undefined);
});

test("speed UID replay is append-only including concurrent duplicate submissions", async () => {
  const e = env();
  const first = await post(e, row());
  const again = await post(e, row({ prompt_tok_s: 99999 }));
  assert.equal(again.duplicate, true);
  assert.equal(first.id, again.id);
  const concurrent = await Promise.all([post(e, row({ uid: "c".repeat(32) })), post(e, row({ uid: "c".repeat(32) }))]);
  assert.equal(concurrent[0].id, concurrent[1].id);
  const data = await get(e);
  assert.equal(data.rows.length, 2);
  assert.equal(data.rows.find(x => x.uid === row().uid).prompt_tok_s, 1024);
});

test("speed filters machine/model and paginates in stable descending id order", async () => {
  const e = env();
  for (let i = 0; i < 5; i++) await post(e, row({ uid: String(i).repeat(32), machine: i === 4 ? "spark" : "m1", model: i === 3 ? "Other" : "Qwen3-0.6B-4bit" }));
  const first = await get(e, "/api/bench/speed?machine=m1&model=Qwen3-0.6B-4bit&limit=2");
  assert.equal(first.rows.length, 2);
  assert.equal(first.has_more, true);
  assert.ok(first.rows[0].id > first.rows[1].id);
  const second = await get(e, `/api/bench/speed?machine=m1&model=Qwen3-0.6B-4bit&limit=2&before=${first.next_before}`);
  assert.equal(second.rows.length, 1);
  assert.equal(second.has_more, false);
  assert.ok(second.rows[0].id < first.rows[1].id);
  assert.equal((await get(e, "/api/bench/speed?machine=absent")).rows.length, 0);
});

test("speed persists fit refusals separately from inference and transport errors", async () => {
  const e = env();
  await post(e, row({ fit: false, reason: "prefill memory guard", prompt_tokens: null, reply_tokens: null, ttft_ms: null, prompt_tok_s: null }));
  await post(e, row({ uid: "d".repeat(32), fit: null, error: "HTTP 503", prompt_tokens: null, reply_tokens: null, prompt_tok_s: null }));
  const data = await get(e);
  assert.equal(data.rows.find(r => r.fit === false).reason, "prefill memory guard");
  assert.equal(data.rows.find(r => r.fit === null).error, "HTTP 503");
});

test("speed normalizes invalid optional metrics and rejects invalid filters/methods", async () => {
  const e = env();
  await post(e, row({ prompt_tok_s: "fast", reply_tokens: -1, ttft_ms: -20,
    usage: { prompt_tokens: 12, secret: "private-key", bogus: -1 }, probes: { free_ram_bytes: "unknown", secret: "private-key" } }));
  const data = await get(e);
  assert.equal(data.rows[0].prompt_tok_s, null);
  assert.equal(data.rows[0].reply_tokens, null);
  assert.equal(data.rows[0].ttft_ms, null);
  assert.equal(data.rows[0].probes.free_ram_bytes, null);
  assert.deepEqual(data.rows[0].usage, { prompt_tokens: 12 });
  assert.doesNotMatch(JSON.stringify(data), /private-key/);
  for (const q of ["limit=0", "limit=201", "limit=abc", "before=0", "machine=..%2Fetc"])
    assert.equal((await request(e, "GET", undefined, `/api/bench/speed?${q}`)).status, 400);
  assert.equal((await request(e, "DELETE")).status, 405);
});

