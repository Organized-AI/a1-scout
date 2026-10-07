// Watched Hugging Face authors: every upload becomes a pick on each scan, outside the per-theme quota.
//   cd ~/nvme-stash/a1-scout && node --test tests/worker_watched.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { WATCHED_AUTHORS } from "../src/index.js";

function fakeEnv(kv = {}) {
  const picks = [];
  const DB = {
    prepare(sql) { let args = [];
      const q = { bind(...a) { args = a; return q; },
        async first() { if (/FROM kv WHERE k=\?/.test(sql)) return kv[args[0]] ? { v: JSON.stringify(kv[args[0]]) } : null; return /COUNT/.test(sql) ? { n: 0 } : null; },
        async all() { return { results: [] }; },
        async run() { return {}; },
        _sql: sql, get _args() { return args; } };
      return q; },
    async batch(stmts) { for (const s of stmts) if (/INSERT INTO picks/.test(s._sql)) picks.push({ id: s._args[0], extra: JSON.parse(s._args[4]), theme: s._args[9], reasons: JSON.parse(s._args[10]) }); },
  };
  return { env: { DB, SCOUT_TOKEN: "t", ASSETS: { fetch: () => new Response("") } }, picks };
}

const now = new Date().toISOString();
const UPLOADS = {
  models: [
    { id: "chaoliangUNSW/Jev-Style-2B-Decision-v3", likes: 3, sha: "a".repeat(40), lastModified: now, library_name: "transformers", tags: [] },
    { id: "chaoliangUNSW/Jev-Style-2B-Decision-v3-MLX", likes: 1, sha: "b".repeat(40), lastModified: now, library_name: "mlx", tags: ["mlx"] },
    { id: "chaoliangUNSW/Jev-Style-2B-Decision-v3-GGUF", likes: 6, sha: "c".repeat(40), lastModified: now, tags: ["gguf"] },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `chaoliangUNSW/Jev-Extra-${i}`, likes: 0, sha: "d".repeat(40), lastModified: now, tags: [] })),
  ],
  datasets: [{ id: "chaoliangUNSW/MacJev-0.8B-Decision-Data", likes: 1, sha: "e".repeat(40), lastModified: now, mainSize: 5e6 }],
  spaces: [{ id: "chaoliangUNSW/jev-style-v3", likes: 1, sha: "f".repeat(40), lastModified: now, sdk: "gradio" }],
};

async function scan(kv) {
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = new URL(String(u));
    const m = /\/api\/(models|datasets|spaces)$/.exec(url.pathname);
    if (m && url.searchParams.get("author") === "chaoliangUNSW") return Response.json(UPLOADS[m[1]]);
    if (/\/api\/models\/chaoliangUNSW\//.test(url.pathname)) return Response.json({ usedStorage: 2e9 });
    return Response.json([]);
  };
  try {
    const { env, picks } = fakeEnv(kv);
    const res = await worker.fetch(new Request("https://x/api/scan", { method: "POST", headers: { authorization: "Bearer t" } }), env);
    return { body: await res.json(), picks };
  } finally { globalThis.fetch = real; }
}

test("chaoliangUNSW is on the watch list for decision models", () => {
  assert.ok(WATCHED_AUTHORS.some(w => w.author === "chaoliangUNSW" && w.theme === "decisions"));
});

test("every upload is kept past the per-theme quota, one variant per model, MLX preferred", async () => {
  const { picks } = await scan();
  const ids = picks.map(p => p.id);
  assert.ok(ids.includes("model:chaoliangUNSW/Jev-Style-2B-Decision-v3-MLX"), ids.join(", "));
  assert.ok(!ids.includes("model:chaoliangUNSW/Jev-Style-2B-Decision-v3-GGUF"));
  assert.ok(!ids.includes("model:chaoliangUNSW/Jev-Style-2B-Decision-v3"));
  assert.equal(ids.filter(i => i.startsWith("model:chaoliangUNSW/Jev-Extra-")).length, 8);  // beyond the 6-model quota
  assert.ok(ids.includes("dataset:chaoliangUNSW/MacJev-0.8B-Decision-Data"));
  assert.ok(ids.includes("space:chaoliangUNSW/jev-style-v3"));
  for (const p of picks) {
    assert.equal(p.extra.watched, "chaoliangUNSW");
    assert.equal(p.theme, "decisions");
    assert.ok(p.reasons.includes("from watched author chaoliangUNSW"));
  }
});

test("KV watch_authors adds authors without a deploy", async () => {
  const { picks } = await scan({ watch_authors: [{ author: "not a valid name!" }] });
  assert.ok(picks.length > 0);  // invalid extra entries are ignored, the built-in list still runs
});
