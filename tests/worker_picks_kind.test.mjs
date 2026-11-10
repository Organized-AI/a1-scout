// Worker contract for Scout picks by asset type: GET /api/picks filters by status and kind and pages with limit/offset,
// while the Mac agent's unpaged calls keep their 300/400 caps and include-list hold-back; GET /api/picks/counts gives exact
// numbers per status x kind. D1 is a node:sqlite shim loaded with schema.sql, so the real SQL runs against the real table.
//   cd ~/nvme-stash/a1-scout && node --test tests/worker_picks_kind.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const plain = o => (o ? { ...o } : null);
  const prep = sql => { let args = [];
    const s = { bind(...a) { args = a; return s; },
      async first() { return plain(db.prepare(sql).get(...args)); },
      async all() { return { results: db.prepare(sql).all(...args).map(plain) }; },
      async run() { db.prepare(sql).run(...args); return { success: true }; } };
    return s; };
  return { prepare: prep, async batch(stmts) { return Promise.all(stmts.map(s => s.run())); }, _db: db };
}
const mkEnv = () => ({ DB: d1(), SCOUT_TOKEN: "t", ASSETS: { fetch: () => new Response("") } });
const req = (env, path, { method = "GET", body, token = "t" } = {}) => worker.fetch(new Request("https://x" + path, { method,
  headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
  body: body && JSON.stringify(body) }), env);
const get = (env, path) => req(env, path).then(r => r.json());
const ids = list => list.map(r => r.id);
const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
const KINDS = ["model", "dataset", "space", "paper", "collection", "code"];

// The brief's real-world case: 625 new picks, 350 of them models, so the old 300 cap visibly cuts both lists.
const MIX = {
  new:     { model: 350, dataset: 120, space: 80, paper: 50, collection: 25 },
  stashed: { model: 20, dataset: 10, space: 5, paper: 1, collection: 3, code: 1 },
  skipped: { model: 15, dataset: 8, space: 4, paper: 3 },
};
// Approved by hand: two carry an include list (a model and a dataset); 88, 75 and 66 are each shared by two picks.
const APPROVED = [
  ["model", "mlx-community/Qwen3-4B-4bit", 88], ["model", "google/gemma-scope-2b-pt-res", 88, ["layer_12/width_16k/average_l0_82/*"]],
  ["model", "mlx-community/whisper-large-v3-turbo", 72], ["dataset", "glaiveai/glaive-function-calling-v2", 75, ["data/train-*.parquet"]],
  ["dataset", "org/clickstream-events", 75], ["space", "gradio/text-to-sql", 66], ["space", "org/static-demo", 66],
  ["paper", "2510.01234", 50], ["code", "huggingface/OpenEnv", 61],
];
// Everything else shares nine scores, so runs of equal scores cross every cap and page boundary.
const SCORES = [92.5, 81, 74.5, 66, 58.5, 50, 43, 35.5, 27];
const T = "2026-11-01T00:00:00.000Z";
function seedRows() {
  const rows = APPROVED.map(([kind, repo, score, include]) => ({ id: `${kind}:${repo}`, kind, repo, score, status: "approved", extra: include ? { include } : {} }));
  for (const [status, kinds] of Object.entries(MIX)) for (const [kind, n] of Object.entries(kinds))
    for (let i = 0; i < n; i++) { const repo = `org/${status}-${kind}-${String(i).padStart(3, "0")}`;
      rows.push({ id: `${kind}:${repo}`, kind, repo, score: SCORES[i % SCORES.length], status, extra: {} }); }
  return rows;
}
// Rows go in shuffled (fixed seed), so rowid order says nothing about id order: only the id tiebreak keeps ties in order.
function insert(env, rows) {
  const order = [...rows]; let s = 7;
  for (let i = order.length - 1; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  const ins = env.DB._db.prepare(`INSERT INTO picks (id, kind, title, extra, repo, score, theme, reasons, matched_repos, flags, status, first_seen, last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of order) ins.run(r.id, r.kind, r.title ?? null, JSON.stringify(r.extra), r.repo, r.score, "agents", "[]", "[]", "[]", r.status, T, T);
}
function seeded() { const env = mkEnv(), rows = seedRows(); insert(env, rows); return { env, rows }; }

// The order the spec promises: with a status, score desc; without, approved, new, stashed, then the rest; ties by id.
const RANK = { approved: 0, new: 1, stashed: 2 };
const byScore = (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byStatus = (a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3) || byScore(a, b);
const want = (rows, { status, kind } = {}) =>
  rows.filter(r => (!status || r.status === status) && (!kind || r.kind === kind)).sort(status ? byScore : byStatus);
function tally(rows) {
  const t = { total: rows.length, by_status: {}, by_kind: {}, by_status_kind: {} };
  for (const { status, kind } of rows) {
    t.by_status[status] = (t.by_status[status] || 0) + 1;
    t.by_kind[kind] = (t.by_kind[kind] || 0) + 1;
    t.by_status_kind[status] = { ...t.by_status_kind[status], [kind]: (t.by_status_kind[status]?.[kind] || 0) + 1 };
  }
  return t;
}

test("K1 · kind=model lists only models from every status: approved, new, stashed, skipped, each best score first", async () => {
  const { env, rows } = seeded();
  const got = await get(env, "/api/picks?kind=model");
  assert.ok(got.every(r => r.kind === "model"));
  assert.deepEqual([...new Set(got.map(r => r.status))], ["approved", "new", "stashed", "skipped"]);
  assert.equal(got.length, 388);                                   // every model, include-list ones too (no status, no hold-back)
  assert.deepEqual(ids(got), ids(want(rows, { kind: "model" })));
  for (const kind of KINDS.slice(1))
    assert.deepEqual(ids(await get(env, `/api/picks?kind=${kind}&limit=1000`)), ids(want(rows, { kind })), kind);
  assert.deepEqual(await get(mkEnv(), "/api/picks?kind=model"), []);  // an empty table is an empty list
});

test("K2 · status=new&kind=dataset lists only the new datasets, best score first", async () => {
  const { env, rows } = seeded();
  const got = await get(env, "/api/picks?status=new&kind=dataset");
  assert.ok(got.every(r => r.status === "new" && r.kind === "dataset"));
  assert.ok(got.every((r, i) => i === 0 || got[i - 1].score >= r.score));
  assert.deepEqual(ids(got), ids(want(rows, { status: "new", kind: "dataset" })));   // all 120, equal scores in id order
  assert.equal(got.length, 120);
  assert.ok(Array.isArray(got[0].reasons) && Array.isArray(got[0].flags) && typeof got[0].extra === "object");   // still shaped picks
});

test("K3 · limit=1000 returns all 350 new models and all 625 new picks that the old 300 cap cut off", async () => {
  const { env, rows } = seeded();
  const models = await get(env, "/api/picks?status=new&kind=model&limit=1000");
  assert.equal(models.length, 350);
  assert.deepEqual(ids(models), ids(want(rows, { status: "new", kind: "model" })));
  const fresh = await get(env, "/api/picks?status=new&limit=1000");
  assert.equal(fresh.length, 625);
  assert.deepEqual(ids(fresh), ids(want(rows, { status: "new" })));
  // without limit the old cap still applies, to a kind-filtered list too
  assert.deepEqual(ids(await get(env, "/api/picks?status=new&kind=model")), ids(want(rows, { status: "new", kind: "model" }).slice(0, 300)));
});

test("K4 · the agent's calls are unchanged: 300 and 400 caps, status priority, include-list picks held back unless include_ok=1", async () => {
  const { env, rows } = seeded();
  // Equal scores may come in either order here (main broke ties by rowid), so compare status+score sequences and id sets.
  const rank = list => list.map(r => [r.status, r.score]);
  const set = list => ids(list).sort();
  const fresh = await get(env, "/api/picks?status=new");
  assert.equal(fresh.length, 300);
  assert.equal(new Set(ids(fresh)).size, 300);
  assert.deepEqual(rank(fresh), rank(want(rows, { status: "new" }).slice(0, 300)));
  const all = await get(env, "/api/picks");
  assert.equal(all.length, 400);
  assert.equal(new Set(ids(all)).size, 400);
  assert.deepEqual(rank(all), rank(want(rows).slice(0, 400)));
  const approved = want(rows, { status: "approved" }), plain = approved.filter(r => !r.extra.include);
  assert.deepEqual(set(all.slice(0, approved.length)), set(approved));     // no hold-back without a status filter
  const held = await get(env, "/api/picks?status=approved");
  assert.deepEqual(set(held), set(plain));
  assert.deepEqual(rank(held), rank(plain));
  const ok = await get(env, "/api/picks?status=approved&include_ok=1");
  assert.deepEqual(set(ok), set(approved));
  assert.deepEqual(rank(ok), rank(approved));
  // the same with kind=model: one approved model has an include list, two don't
  const models = approved.filter(r => r.kind === "model");
  assert.deepEqual(set(await get(env, "/api/picks?status=approved&kind=model")), set(models.filter(r => !r.extra.include)), "approved models");
  assert.deepEqual(set(await get(env, "/api/picks?status=approved&kind=model&include_ok=1")), set(models), "approved models, include_ok=1");
});

test("K5 · two pages of 500 give all 625 new picks once each, in the same order as one limit=1000 call", async () => {
  const { env, rows } = seeded();
  const order = want(rows, { status: "new" });
  assert.equal(order[499].score, order[500].score);                // the page boundary splits a run of equal scores
  const p1 = ids(await get(env, "/api/picks?status=new&limit=500&offset=0"));
  const p2 = ids(await get(env, "/api/picks?status=new&limit=500&offset=500"));
  assert.equal(p1.length, 500);
  assert.equal(p2.length, 125);
  assert.deepEqual(p1.filter(id => p2.includes(id)), []);           // no overlap
  assert.equal(new Set([...p1, ...p2]).size, 625);
  assert.deepEqual([...p1, ...p2].sort(), ids(order).sort());       // nothing missing
  const one = ids(await get(env, "/api/picks?status=new&limit=1000"));
  assert.deepEqual([...p1, ...p2], one);
  assert.deepEqual(one, ids(order));
  assert.deepEqual(await get(env, "/api/picks?status=new&limit=500&offset=625"), []);       // past the end: empty, not an error
  assert.deepEqual(await get(env, "/api/picks?status=new&offset=99999999999999999999"), []);
  // without a status filter (status priority order) pages of 150 stitch together the same way
  const everything = ids(want(rows)), paged = [];
  for (let off = 0; off < everything.length; off += 150) paged.push(...ids(await get(env, `/api/picks?limit=150&offset=${off}`)));
  assert.deepEqual(paged, everything);
});

test("K6 · a misspelt kind or a bad limit or offset is a 400 with an error; all or empty means no filter", async () => {
  const { env, rows } = seeded();
  const KIND = "kind must be one of model|dataset|space|paper|collection|code", LIMIT = "limit must be 1-1000", OFFSET = "offset must be 0 or more";
  for (const [q, error] of [["kind=models", KIND], ["status=new&kind=Model", KIND], ["status=new&kind=models&limit=1000&offset=0&include_ok=1", KIND],
    ["limit=0", LIMIT], ["limit=1001", LIMIT], ["limit=abc", LIMIT], ["limit=2.5", LIMIT], ["offset=-1", OFFSET], ["offset=abc", OFFSET]]) {
    const r = await req(env, `/api/picks?${q}`);
    assert.equal(r.status, 400, q);
    assert.deepEqual(await r.json(), { error }, q);
  }
  const none = await get(env, "/api/picks");
  for (const q of ["kind=all", "status=all", "status=all&kind=all", "status=&kind="]) assert.deepEqual(await get(env, `/api/picks?${q}`), none, q);
  assert.deepEqual(await get(env, "/api/picks?status=all&kind=model"), await get(env, "/api/picks?kind=model"));
  assert.deepEqual(await get(env, "/api/picks?status=new&kind=all"), await get(env, "/api/picks?status=new"));
  assert.deepEqual(ids(await get(env, "/api/picks?status=new&limit=1")), ids(want(rows, { status: "new" }).slice(0, 1)));   // the lower bound
  // any other status is a filter as before: bound, never spliced into the SQL
  assert.deepEqual(await get(env, `/api/picks?status=${encodeURIComponent("new' OR '1'='1")}`), []);
});

test("K7 · counts are exact per status x kind, add up to the totals, and are empty for an empty table", async () => {
  const { env, rows } = seeded();
  const c = await get(env, "/api/picks/counts");
  assert.deepEqual(c, tally(rows));
  assert.equal(c.by_status.new, 625);
  assert.equal(c.by_status_kind.new.model, 350);
  assert.equal("code" in c.by_status_kind.new, false);             // zero combinations are absent
  for (const [s, kinds] of Object.entries(c.by_status_kind)) assert.equal(sum(kinds), c.by_status[s], s);
  for (const k of Object.keys(c.by_kind)) assert.equal(sum(Object.values(c.by_status_kind).map(x => x[k] || 0)), c.by_kind[k], k);
  assert.equal(sum(c.by_status), c.total);
  assert.equal(sum(c.by_kind), c.total);
  assert.equal(c.total, env.DB._db.prepare("SELECT COUNT(*) n FROM picks").get().n);
  // raw counts: include-list picks are counted even though a plain ?status=approved holds them back
  assert.ok((await get(env, "/api/picks?status=approved")).length < c.by_status.approved);
  // every list the dashboard asks for is exactly as long as its chip count
  for (const s of Object.keys(c.by_status)) for (const k of KINDS)
    assert.equal((await get(env, `/api/picks?status=${s}&kind=${k}&include_ok=1&limit=1000`)).length, c.by_status_kind[s][k] ?? 0, `${s} x ${k}`);
  assert.deepEqual(await get(mkEnv(), "/api/picks/counts"), { total: 0, by_status: {}, by_kind: {}, by_status_kind: {} });
});

test("K8 · counts and kind-filtered lists answer 401 with no token or a wrong one", async () => {
  const { env } = seeded(), paths = ["/api/picks/counts", "/api/picks?kind=model"];
  for (const path of paths) for (const token of [null, "wrong", ""]) {
    const r = await req(env, path, { token });
    assert.equal(r.status, 401, `${path} with token ${JSON.stringify(token)}`);
    assert.deepEqual(await r.json(), { error: "unauthorized" });
  }
  for (const path of paths) assert.equal((await req(env, path)).status, 200, `${path} with the right token`);
});

test("C3 · approving a collection queues its model, dataset and Space as new picks that the counts and the model list show", async () => {
  const env = mkEnv();
  const items = [{ type: "model", id: "mlx-community/Qwen3-1.7B-4bit" }, { type: "dataset", id: "Salesforce/xlam-function-calling-60k" },
    { type: "space", id: "smolagents/computer-agent" }];
  const coll = { id: "collection:mlx-community/agents-starter-68e1", kind: "collection", repo: "mlx-community/agents-starter-68e1",
    title: "Agents starter", score: 64, status: "new", extra: { items, owner: "mlx-community" } };
  insert(env, [coll]);
  const hub = {   // what the Hub answers for each item; any other URL fails the test
    [`models/${items[0].id}`]: { sha: "a1b2c3", usedStorage: 1.1e9, gated: false, cardData: { license: "apache-2.0" }, likes: 42,
      lastModified: "2026-10-28T00:00:00.000Z", library_name: "mlx", tags: ["mlx", "safetensors"], pipeline_tag: "text-generation" },
    [`datasets/${items[1].id}`]: { sha: "d4e5f6", usedStorage: 2.3e8, gated: false, cardData: { license: "cc-by-4.0" }, likes: 310,
      lastModified: "2026-09-12T00:00:00.000Z" },
    [`spaces/${items[2].id}`]: { sha: "0a9b8c", cardData: { title: "Computer agent", short_description: "An agent that drives a desktop",
      license: "apache-2.0" }, likes: 120, lastModified: "2026-10-02T00:00:00.000Z", sdk: "gradio" },
  };
  const real = globalThis.fetch, seen = [], unexpected = [];
  globalThis.fetch = async u => {
    const url = String(u instanceof Request ? u.url : u), key = url.match(/^https:\/\/huggingface\.co\/api\/([^?]+)(?:\?|$)/)?.[1];
    if (!hub[key]) { unexpected.push(url); throw new Error(`unexpected fetch: ${url}`); }
    seen.push(key);
    return new Response(JSON.stringify({ id: key.split("/").slice(1).join("/"), ...hub[key] }), { headers: { "content-type": "application/json" } });
  };
  try {
    const r = await req(env, "/api/picks/status", { method: "POST", body: { id: coll.id, status: "approved" } }).then(r => r.json());
    assert.deepEqual(unexpected, []);                                // expandCollection swallows fetch errors, so check what it asked for
    assert.deepEqual(seen.sort(), Object.keys(hub).sort());          // one Hub lookup per item
    assert.equal(r.ok, true);
    assert.equal(r.expanded, 3);
    assert.deepEqual(await get(env, "/api/picks/counts"), { total: 4, by_status: { new: 3, stashed: 1 },
      by_kind: { model: 1, dataset: 1, space: 1, collection: 1 }, by_status_kind: { new: { model: 1, dataset: 1, space: 1 }, stashed: { collection: 1 } } });
    const models = await get(env, "/api/picks?status=new&kind=model");
    assert.deepEqual(ids(models), [`model:${items[0].id}`]);
    assert.equal(models[0].sha, "a1b2c3");                           // sized from the (stubbed) Hub answer
    assert.equal(models[0].extra.from_collection, coll.repo);
    assert.deepEqual(ids(await get(env, "/api/picks?status=new&kind=dataset")), [`dataset:${items[1].id}`]);
    assert.deepEqual(ids(await get(env, "/api/picks?status=new&kind=space")), [`space:${items[2].id}`]);
    assert.deepEqual(ids(await get(env, "/api/picks?status=stashed&kind=collection")), [coll.id]);
    assert.deepEqual(unexpected, []);
  } finally { globalThis.fetch = real; }
});
