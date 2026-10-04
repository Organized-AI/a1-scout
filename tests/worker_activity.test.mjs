// Worker contract for the status bar: GET /api/activity must not count picks that need a license.
//   cd ~/nvme-stash/a1-scout && node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function fakeEnv(kv, picks) {
  const rows = { ...Object.fromEntries(Object.entries(kv).map(([k, v]) => [k, JSON.stringify(v)])) };
  const DB = { prepare(sql) {
    let args = [];
    const q = { bind(...a) { args = a; return q; },
      async first() { if (/FROM kv WHERE k=\?/.test(sql)) return rows[args[0]] ? { v: rows[args[0]] } : null; return null; },
      async all() { if (/FROM picks WHERE status='approved'/.test(sql)) return { results: picks }; return { results: [] }; },
      async run() { if (/INSERT INTO kv/.test(sql)) rows[args[0]] = args[1]; return {}; } };
    return q;
  } };
  return { DB, SCOUT_TOKEN: "t", ASSETS: { fetch: () => new Response("") } };
}
const get = (env) => worker.fetch(new Request("https://x/api/activity", { headers: { authorization: "Bearer t" } }), env).then(r => r.json());

const PICKS = [
  { repo: "google/gemma-2-2b", kind: "model", size_bytes: 10.48e9 },
  { repo: "org/small-model", kind: "model", size_bytes: 2e9 },
  { repo: "meta-llama/Llama-Prompt-Guard-2-86M", kind: "model", size_bytes: 1.13e9 },
];

test("needs-license picks are labeled and don't use the cap", async () => {
  const env = fakeEnv({ presence: { present: true, at: new Date().toISOString(), cap_gb: 3,
    needs_license: ["google/gemma-2-2b", "meta-llama/Llama-Prompt-Guard-2-86M"] } }, PICKS);
  const d = await get(env);
  const when = Object.fromEntries(d.next.map(n => [n.repo, n.when]));
  assert.deepEqual(when, { "google/gemma-2-2b": "needs license", "org/small-model": "next plug-in",
    "meta-llama/Llama-Prompt-Guard-2-86M": "needs license" });
});

test("without a needs-license list, the queue is unchanged", async () => {
  const env = fakeEnv({ presence: { present: true, at: new Date().toISOString(), cap_gb: 60 } }, PICKS);
  const d = await get(env);
  assert.ok(d.next.every(n => n.when === "next plug-in"));
});
