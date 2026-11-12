const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
const ready = new WeakMap();
function table(env) {
  if (!ready.has(env.DB)) ready.set(env.DB, env.DB.prepare("CREATE TABLE IF NOT EXISTS phone_links (code_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, expires INTEGER NOT NULL)").run());
  return ready.get(env.DB);
}
export async function mintPhoneLink(env, origin, session) {
  await table(env);
  const code = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const expires = Date.now() + 600000;
  await env.DB.prepare("DELETE FROM phone_links WHERE expires <= ?").bind(Date.now()).run();
  await env.DB.prepare("INSERT INTO phone_links (code_hash,session_hash,expires) VALUES (?,?,?)").bind(await hash(code), session, expires).run();
  return { url: `${origin}/login/link?code=${code}`, expires_at: new Date(expires).toISOString() };
}
export async function burnPhoneLink(env, code, session) {
  if (!/^[a-f0-9]{64}$/.test(code || "")) return false;
  await table(env);
  const found = await env.DB.prepare("DELETE FROM phone_links WHERE code_hash=? AND expires>? AND session_hash=? RETURNING code_hash")
    .bind(await hash(code), Date.now(), session).first();
  return Boolean(found);
}
