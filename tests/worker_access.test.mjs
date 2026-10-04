// Cloudflare Access JWT check: only a correctly signed, unexpired token for this app and this email gets in.
//   cd ~/nvme-stash/a1-scout && node --test tests/worker_access.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessOk, _resetAccessKeys } from "../src/index.js";

const ENV = { ACCESS_TEAM: "organized", ACCESS_AUD: "aud123", ACCESS_EMAIL: "Jordan@Example.com" };
const enc = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
const certs = async () => new Response(JSON.stringify({ keys: [jwk] }));
async function jwt(claims, key = privateKey, kid = "k1") {
  const h = enc({ alg: "RS256", kid }), p = enc(claims);
  const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`))).toString("base64url");
  return `${h}.${p}.${sig}`;
}
const good = () => ({ iss: "https://organized.cloudflareaccess.com", aud: ["aud123"], email: "jordan@example.com", exp: Math.floor(Date.now() / 1000) + 600 });
const req = t => new Request("https://x/api/state", { headers: t ? { "cf-access-jwt-assertion": t } : {} });

test("valid Access token for the owner is accepted", async () => {
  _resetAccessKeys();
  assert.equal(await accessOk(req(await jwt(good())), ENV, certs), true);
});
test("wrong email, audience, issuer, expired, missing, or forged tokens are refused", async () => {
  for (const bad of [{ email: "someone@else.com" }, { aud: ["other"] }, { iss: "https://evil.cloudflareaccess.com" }, { exp: 1 }, { email: undefined }]) {
    _resetAccessKeys();
    assert.equal(await accessOk(req(await jwt({ ...good(), ...bad })), ENV, certs), false, JSON.stringify(bad));
  }
  assert.equal(await accessOk(req(null), ENV, certs), false);
  const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  assert.equal(await accessOk(req(await jwt(good(), other.privateKey)), ENV, certs), false);
});
test("off until all three settings exist", async () => {
  assert.equal(await accessOk(req(await jwt(good())), { ACCESS_TEAM: "organized", ACCESS_AUD: "aud123" }, certs), false);
});
