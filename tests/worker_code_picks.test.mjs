// Worker contract for GitHub repos queued for the A1's code/ folder.
//   cd ~/nvme-stash/a1-scout && node --test tests/worker_code_picks.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function fakeEnv() {
  const writes = [];
  const DB = { prepare(sql) { let args = [];
    const q = { bind(...a) { args = a; return q; }, async first() { return null; }, async all() { return { results: [] }; },
      async run() { writes.push({ sql, args }); return {}; } };
    return q; } };
  return { env: { DB, SCOUT_TOKEN: "t", ASSETS: { fetch: () => new Response("") } }, writes };
}
const call = (env, path, body) => worker.fetch(new Request("https://x" + path, { method: "POST",
  headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body) }), env).then(r => r.json());

test("a GitHub repo is queued as kind code with its head commit, size and license", async () => {
  const real = globalThis.fetch, seen = [];
  globalThis.fetch = async u => { seen.push(String(u));
    return new Response(JSON.stringify(String(u).includes("/commits/")
      ? { sha: "abc123" }
      : { full_name: "huggingface/OpenEnv", default_branch: "main", size: 95983, stargazers_count: 10, pushed_at: new Date().toISOString(),
          description: "Agentic RL environments", language: "Python", license: { spdx_id: "BSD-3-Clause" } })); };
  try {
    const { env, writes } = fakeEnv();
    const r = await call(env, "/api/picks/add", { repo: "huggingface/OpenEnv", kind: "code", status: "approved" });
    assert.equal(r.id, "code:huggingface/OpenEnv");
    assert.equal(r.license, "BSD-3-Clause");
    assert.equal(r.size_bytes, 95983 * 1024);
    assert.ok(seen.every(u => u.startsWith("https://api.github.com/repos/huggingface/OpenEnv")));
    assert.ok(writes.some(w => /status='approved'/.test(w.sql) && w.args.includes("code:huggingface/OpenEnv")));
  } finally { globalThis.fetch = real; }
});

test("a code repo must be owner/name", async () => {
  const { env } = fakeEnv();
  const r = await call(env, "/api/picks/add", { repo: "https://github.com/x/y", kind: "code" });
  assert.match(r.error, /owner\/name/);
});
