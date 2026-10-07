// Public waitlist and follow-up survey for the docs at /docs.
// Everything else on scout.organizedai.vip stays behind sign-in.

import { normalizeDomain, isFreeMail, enrichDomain, enrichTables, apifyHook, companyRow } from "./enrich.js";

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
export async function waitlistApi(req, env, url, ctx) {
  const p = url.pathname;
  if (p === "/api/waitlist/apify-hook" && req.method === "POST") return apifyHook(req, env, url);
  if (p === "/api/waitlist/typeform-hook" && req.method === "POST") return typeformHook(req, env, url);
  if (p === "/api/waitlist/config" && req.method === "GET") return out(waitlistConfig(env));

  if (p === "/api/waitlist" && req.method === "POST") {
    await tables(env);
    await enrichTables(env);
    const b = await req.json().catch(() => ({}));
    if (clean(b.website, 200)) return out({ ok: true, id: "ok", token: "ok" }); // honeypot: pretend success
    const name = clean(b.name, 120);
    const email = clean(b.email, 254).toLowerCase();
    if (!name) return out({ error: "Add your name." }, 400);
    if (!EMAIL.test(email)) return out({ error: "That email address doesn't look right." }, 400);
    const typed = clean(b.company, 300);
    let domain = typed ? normalizeDomain(typed) : null;
    if (typed && !domain) return out({ error: "That company website doesn't look right. Try something like acme.com." }, 400);
    let domainSource = domain ? "form" : null;
    if (!domain) { const d = normalizeDomain(email); if (d && !isFreeMail(d)) { domain = d; domainSource = "email"; } }

    const ip = req.headers.get("cf-connecting-ip") || "unknown";
    const ipHash = await sha(`${env.WAITLIST_SALT || "a1-scout"}:${ip}`);
    const hourAgo = new Date(Date.now() - 36e5).toISOString();
    const recent = (await env.DB.prepare("SELECT COUNT(*) n FROM waitlist WHERE ip_hash=? AND created>=?").bind(ipHash, hourAgo).first()).n;
    if (recent >= PER_IP_PER_HOUR) return out({ error: "Too many sign-ups from this network. Try again in an hour." }, 429);

    const existing = await env.DB.prepare("SELECT id, token, survey_at FROM waitlist WHERE email=?").bind(email).first();
    const kick = () => { if (domain && ctx) ctx.waitUntil(enrichDomain(env, domain, url.origin).catch(() => {})); };
    if (existing) {
      if (domain) await env.DB.prepare("UPDATE waitlist SET company_domain=COALESCE(company_domain,?), domain_source=COALESCE(domain_source,?) WHERE id=?").bind(domain, domainSource, existing.id).run();
      kick();
      return out({ ok: true, id: existing.id, token: existing.token, already: true, surveyed: !!existing.survey_at, company: domain, ...waitlistConfig(env) });
    }

    const id = crypto.randomUUID();
    const token = crypto.randomUUID().replace(/-/g, "");
    await env.DB.prepare(`INSERT INTO waitlist (id,name,email,token,source,referrer,ip_hash,country,company_domain,domain_source,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, name, email, token, clean(b.source, 80) || "docs", clean(req.headers.get("referer"), 300), ipHash,
        req.cf?.country || null, domain, domainSource, new Date().toISOString()).run();
    kick();
    return out({ ok: true, id, token, company: domain, ...waitlistConfig(env) });
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
  await enrichTables(env);
  const rows = (await env.DB.prepare(`SELECT w.id,w.name,w.email,w.source,w.country,w.company_domain,w.domain_source,w.survey,w.survey_at,w.created,
      c.status AS company_status, c.apify_status, json_array_length(COALESCE(c.pages,'[]')) AS pages
    FROM waitlist w LEFT JOIN companies c ON c.domain=w.company_domain ORDER BY w.created DESC LIMIT 2000`).all()).results;
  return out({ count: rows.length, surveyed: rows.filter((r) => r.survey_at).length,
    rows: rows.map((r) => ({ ...r, survey: r.survey ? JSON.parse(r.survey) : null })) });
}

// Owner-only: one company's full enrichment, or re-run it.
export async function waitlistOwner(req, env, url, ctx) {
  const p = url.pathname;
  const domain = normalizeDomain(url.searchParams.get("domain") || "");
  if (p === "/api/waitlist/company" && req.method === "GET") {
    if (!domain) return out({ error: "domain required" }, 400);
    return out((await companyRow(env, domain)) || { error: "not enriched yet" }, 200);
  }
  if (p === "/api/waitlist/enrich" && req.method === "POST") {
    if (!domain) return out({ error: "domain required" }, 400);
    ctx?.waitUntil(enrichDomain(env, domain, url.origin, { force: true }).catch(() => {}));
    return out({ ok: true, domain, started: true });
  }
  return null;
}

// Typeform webhook (automation step): store the Typeform answers on the sign-up via hidden waitlist_id.
async function typeformHook(req, env, url) {
  if (!env.WAITLIST_HOOK_SECRET || url.searchParams.get("key") !== env.WAITLIST_HOOK_SECRET) return new Response("forbidden", { status: 403 });
  await tables(env);
  const b = await req.json().catch(() => ({}));
  const fr = b.form_response || b;
  const id = fr.hidden?.waitlist_id;
  if (!id) return out({ ok: true, ignored: "no waitlist_id" });
  const fields = Object.fromEntries((fr.definition?.fields || []).map((f) => [f.id, f.ref || f.title]));
  const answers = {};
  for (const a of fr.answers || []) {
    const k = a.field?.ref || fields[a.field?.id] || a.field?.id;
    answers[k] = a.choice?.label ?? a.choices?.labels ?? a.text ?? a.email ?? a.url ?? a.number ?? a.boolean ?? a[a.type] ?? null;
  }
  const r = await env.DB.prepare("UPDATE waitlist SET survey=?, survey_at=? WHERE id=?")
    .bind(JSON.stringify({ via: "typeform", response_id: fr.token || null, ...answers }).slice(0, SURVEY_MAX), new Date().toISOString(), id).run();
  return out({ ok: true, matched: r.meta.changes });
}
