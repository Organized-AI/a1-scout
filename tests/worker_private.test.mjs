// Private by default: no page, asset or API answer without Access, the Bearer token, or the signed-in cookie.
//   cd ~/nvme-stash/a1-scout && node --test tests/worker_private.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const env = { SCOUT_TOKEN: "secret-token", ASSETS: { fetch: () => new Response("<html>dashboard</html>", { headers: { "content-type": "text/html" } }) } };
const get = (path, headers = {}) => worker.fetch(new Request("https://scout.example" + path, { headers: { accept: "text/html", ...headers } }), env);
const signIn = (token) => worker.fetch(new Request("https://scout.example/login", { method: "POST", body: new URLSearchParams({ token }) }), env);

test("a stranger is sent to the sign-in page, never the dashboard", async () => {
  const r = await get("/");
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.get("location")).pathname, "/login");
  const page = await get("/login");
  assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), /dashboard/);
});
test("assets and API are closed to a stranger", async () => {
  assert.equal((await get("/bench.js", { accept: "*/*" })).status, 404);
  assert.equal((await get("/api/state", { accept: "application/json" })).status, 401);
});
test("health stays open for uptime checks", async () => {
  assert.equal((await get("/api/health", { accept: "application/json" })).status, 200);
});
test("a wrong token is refused and sets no cookie", async () => {
  const r = await signIn("nope");
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("set-cookie"), null);
});
test("the right token sets an HttpOnly cookie that opens the dashboard, and the cookie is not the token", async () => {
  const r = await signIn("secret-token");
  assert.equal(r.status, 303);
  const c = r.headers.get("set-cookie");
  assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Strict/);
  assert.doesNotMatch(c, /secret-token/);
  const session = c.split(";")[0];
  const page = await get("/", { cookie: session });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /dashboard/);
});
test("the Mac's Bearer token still works, and every answer is noindex and uncached", async () => {
  const r = await get("/", { authorization: "Bearer secret-token" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(r.headers.get("cache-control"), "private, no-store");
});
test("robots.txt disallows everything", async () => {
  assert.match(await (await get("/robots.txt")).text(), /Disallow: \//);
});
test("rotating SCOUT_TOKEN signs old cookies out", async () => {
  const session = (await signIn("secret-token")).headers.get("set-cookie").split(";")[0];
  const rotated = { ...env, SCOUT_TOKEN: "new-token" };
  const r = await worker.fetch(new Request("https://scout.example/", { headers: { accept: "text/html", cookie: session } }), rotated);
  assert.equal(r.status, 302);
});
