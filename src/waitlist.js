// Public waitlist and follow-up survey for the docs at /docs.
// Everything else on scout.organizedai.vip stays behind sign-in.

const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,24}$/i;
const PER_IP_PER_HOUR = 6;
const SURVEY_MAX = 8000;

const out = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

let ready = null;
async function tables(env) {
  if (ready === env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS waitlist (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, token TEXT NOT NULL,
      source TEXT, referrer TEXT, ip_hash TEXT, country TEXT, survey TEXT, survey_at TEXT, created TEXT NOT NULL)`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS waitlist_ip ON waitlist(ip_hash, created)"),
  ]);
  ready = env.DB;
}

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
const clean = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n) : "");

export function waitlistConfig(env) {
  return { typeform_form_id: env.TYPEFORM_FORM_ID || null, gtm_id: env.DOCS_GTM_ID || null };
}

// Returns a Response for public waitlist routes, or null to fall through.
export async function waitlistApi(req, env, url) {
  const p = url.pathname;
  if (p === "/api/waitlist/config" && req.method === "GET") return out(waitlistConfig(env));

  if (p === "/api/waitlist" && req.method === "POST") {
    await tables(env);
    const b = await req.json().catch(() => ({}));
    if (clean(b.website, 200)) return out({ ok: true, id: "ok", token: "ok" }); // honeypot: pretend success
    const name = clean(b.name, 120);
    const email = clean(b.email, 254).toLowerCase();
    if (!name) return out({ error: "Add your name." }, 400);
    if (!EMAIL.test(email)) return out({ error: "That email address doesn't look right." }, 400);

    const ip = req.headers.get("cf-connecting-ip") || "unknown";
    const ipHash = await sha(`${env.WAITLIST_SALT || "a1-scout"}:${ip}`);
    const hourAgo = new Date(Date.now() - 36e5).toISOString();
    const recent = (await env.DB.prepare("SELECT COUNT(*) n FROM waitlist WHERE ip_hash=? AND created>=?").bind(ipHash, hourAgo).first()).n;
    if (recent >= PER_IP_PER_HOUR) return out({ error: "Too many sign-ups from this network. Try again in an hour." }, 429);

    const existing = await env.DB.prepare("SELECT id, token, survey_at FROM waitlist WHERE email=?").bind(email).first();
    if (existing) return out({ ok: true, id: existing.id, token: existing.token, already: true, surveyed: !!existing.survey_at, ...waitlistConfig(env) });

    const id = crypto.randomUUID();
    const token = crypto.randomUUID().replace(/-/g, "");
    await env.DB.prepare(`INSERT INTO waitlist (id,name,email,token,source,referrer,ip_hash,country,created) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(id, name, email, token, clean(b.source, 80) || "docs", clean(req.headers.get("referer"), 300), ipHash,
        req.cf?.country || null, new Date().toISOString()).run();
    return out({ ok: true, id, token, ...waitlistConfig(env) });
  }

  if (p === "/api/waitlist/survey" && req.method === "POST") {
    await tables(env);
    const b = await req.json().catch(() => ({}));
    if (typeof b.id !== "string" || typeof b.token !== "string") return out({ error: "Missing sign-up id." }, 400);
    const answers = JSON.stringify(b.answers && typeof b.answers === "object" ? b.answers : {});
    if (answers.length > SURVEY_MAX) return out({ error: "Answers are too long." }, 413);
    const r = await env.DB.prepare("UPDATE waitlist SET survey=?, survey_at=? WHERE id=? AND token=?")
      .bind(answers, new Date().toISOString(), b.id, b.token).run();
    if (!r.meta.changes) return out({ error: "We couldn't find that sign-up. Join the waitlist again." }, 404);
    return out({ ok: true });
  }
  return null;
}

// Owner-only (called after sign-in check).
export async function waitlistList(env) {
  await tables(env);
  const rows = (await env.DB.prepare("SELECT id,name,email,source,country,survey,survey_at,created FROM waitlist ORDER BY created DESC LIMIT 2000").all()).results;
  return out({ count: rows.length, surveyed: rows.filter((r) => r.survey_at).length,
    rows: rows.map((r) => ({ ...r, survey: r.survey ? JSON.parse(r.survey) : null })) });
}
