import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("phone worker clears legacy private caches and never intercepts requests", async () => {
  const handlers = new Map(), removed = [];
  let claimed = false, skipped = false, activation;
  vm.runInNewContext(readFileSync(new URL("../public/m/sw.js", import.meta.url), "utf8"), {
    self: {
      addEventListener: (name, handler) => handlers.set(name, handler),
      skipWaiting: () => { skipped = true; },
      clients: { claim: () => { claimed = true; } },
    },
    caches: { keys: async () => ["a1-shell-v1", "a1-shell-v2", "unrelated"], delete: async key => removed.push(key) },
  });
  handlers.get("install")();
  handlers.get("activate")({ waitUntil: promise => { activation = promise; } });
  await activation;
  assert.equal(skipped, true);
  assert.equal(claimed, true);
  assert.deepEqual(removed, ["a1-shell-v1", "a1-shell-v2"]);
  assert.equal(handlers.has("fetch"), false);
});

test("phone manifest launches the private mobile dashboard", () => {
  const manifest = JSON.parse(readFileSync(new URL("../public/m/manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.start_url, "/m");
  assert.equal(manifest.display, "standalone");
});
