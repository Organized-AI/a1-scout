// Company enrichment for waitlist sign-ups.
// Context.dev: brand profile + homepage markdown (runs in waitUntil right after sign-up).
// Apify: Website Content Crawler over a few pages; Apify calls /api/waitlist/apify-hook when done.
// One row per domain in `companies`; a domain is re-enriched at most every REFRESH_DAYS.

const CONTEXT = "https://api.context.dev/v1";
const APIFY = "https://api.apify.com/v2";
const ACTOR = "apify~website-content-crawler";
const REFRESH_DAYS = 30;
const MAX_PAGES = 5;
const FREE_MAIL = new Set(("gmail.com googlemail.com yahoo.com ymail.com outlook.com hotmail.com live.com msn.com icloud.com me.com mac.com " +
  "aol.com proton.me protonmail.com pm.me gmx.com gmx.net mail.com yandex.com zoho.com fastmail.com hey.com tutanota.com qq.com 163.com").split(" "));

export function normalizeDomain(input) {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("@")) s = s.split("@").pop();
  s = s.replace(/^[a-z]+:\/\//, "").split(/[/?#:\s]/)[0].replace(/^www\./, "").replace(/\.$/, "");
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(s)) return null;
  return s;
}
export const isFreeMail = (d) => FREE_MAIL.has(d);

let ready = null;
export async function enrichTables(env) {
  if (ready === env.DB) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS companies (
    domain TEXT PRIMARY KEY, status TEXT NOT NULL, brand TEXT, homepage TEXT, pages TEXT,
    apify_run TEXT, apify_status TEXT, errors TEXT, requested TEXT NOT NULL, updated TEXT NOT NULL)`).run();
  for (const col of ["company_domain TEXT", "domain_source TEXT"]) {
    try { await env.DB.prepare(`ALTER TABLE waitlist ADD COLUMN ${col}`).run(); } catch { /* already there */ }
  }
  ready = env.DB;
}

const now = () => new Date().toISOString();
const trim = (s, n) => (typeof s === "string" ? s.slice(0, n) : null);

async function contextCall(env, path, body) {
  const r = await fetch(`${CONTEXT}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CONTEXT_DEV_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`context.dev ${path} ${r.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

async function startApify(env, domain, origin) {
  const hook = `${origin}/api/waitlist/apify-hook?key=${encodeURIComponent(env.WAITLIST_HOOK_SECRET)}&domain=${encodeURIComponent(domain)}`;
  const webhooks = btoa(JSON.stringify([{
    eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.TIMED_OUT", "ACTOR.RUN.ABORTED"],
    requestUrl: hook,
  }]));
  const input = {
    startUrls: [{ url: `https://${domain}` }],
    crawlerType: "cheerio",
    maxCrawlPages: MAX_PAGES,
    maxCrawlDepth: 1,
    saveMarkdown: true,
  };
  const r = await fetch(`${APIFY}/acts/${ACTOR}/runs?timeout=300&memory=1024&webhooks=${webhooks}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.APIFY_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`apify start ${r.status}: ${JSON.stringify(d).slice(0, 160)}`);
  return d.data?.id || null;
}

// Runs inside ctx.waitUntil after the sign-up response has gone out.
export async function enrichDomain(env, domain, origin, { force = false } = {}) {
  await enrichTables(env);
  const row = await env.DB.prepare("SELECT status, requested FROM companies WHERE domain=?").bind(domain).first();
  const ok = row && !["failed", "partial"].includes(row.status);
  const stale = row && Date.now() - Date.parse(row.requested) > (row.status === "running" ? 6e5 : REFRESH_DAYS * 864e5);
  const fresh = ok && !stale;
  if (fresh && !force) return { domain, skipped: "enriched recently" };

  const errors = [];
  await env.DB.prepare(`INSERT INTO companies (domain,status,requested,updated) VALUES (?,?,?,?)
    ON CONFLICT(domain) DO UPDATE SET status=excluded.status, requested=excluded.requested, updated=excluded.updated, errors=NULL`)
    .bind(domain, "running", now(), now()).run();

  const jobs = [];
  if (env.CONTEXT_DEV_API_KEY) {
    jobs.push(contextCall(env, "/brand/retrieve", { type: "by_domain", domain })
      .then((d) => env.DB.prepare("UPDATE companies SET brand=?, updated=? WHERE domain=?").bind(JSON.stringify(d).slice(0, 60000), now(), domain).run())
      .catch((e) => errors.push(e.message)));
    jobs.push(contextCall(env, "/web/scrape", { url: `https://${domain}`, formats: { markdown: true }, sharedParams: { mainContentOnly: true } })
      .then((d) => {
        const md = d.markdown?.data ?? d.data?.markdown ?? d.markdown ?? null;
        const title = d.metadata?.data?.title ?? d.metadata?.title ?? null;
        return env.DB.prepare("UPDATE companies SET homepage=?, updated=? WHERE domain=?")
          .bind(JSON.stringify({ title, markdown: trim(typeof md === "string" ? md : JSON.stringify(md), 20000) }), now(), domain).run();
      })
      .catch((e) => errors.push(e.message)));
  } else errors.push("CONTEXT_DEV_API_KEY not set");

  if (env.APIFY_TOKEN && env.WAITLIST_HOOK_SECRET) {
    jobs.push(startApify(env, domain, origin)
      .then((run) => env.DB.prepare("UPDATE companies SET apify_run=?, apify_status='RUNNING', updated=? WHERE domain=?").bind(run, now(), domain).run())
      .catch((e) => errors.push(e.message)));
  } else errors.push("APIFY_TOKEN or WAITLIST_HOOK_SECRET not set");

  await Promise.all(jobs);
  const status = errors.length === 0 ? "context-done" : errors.length >= 3 ? "failed" : "partial";
  await env.DB.prepare("UPDATE companies SET status=?, errors=?, updated=? WHERE domain=?")
    .bind(status, errors.length ? JSON.stringify(errors) : null, now(), domain).run();
  return { domain, status, errors };
}

// Apify webhook: verify secret, pull the run's dataset, store page summaries.
export async function apifyHook(req, env, url) {
  const ok = env.WAITLIST_HOOK_SECRET && url.searchParams.get("key") === env.WAITLIST_HOOK_SECRET;
  if (!ok) return new Response("forbidden", { status: 403 });
  await enrichTables(env);
  const domain = normalizeDomain(url.searchParams.get("domain") || "");
  const b = await req.json().catch(() => ({}));
  const run = b.resource || {};
  if (!domain || !run.id) return new Response("bad hook", { status: 400 });
  const row = await env.DB.prepare("SELECT apify_run FROM companies WHERE domain=?").bind(domain).first();
  if (!row || row.apify_run !== run.id) return new Response("unknown run", { status: 404 });

  let pages = [];
  if (run.status === "SUCCEEDED" && run.defaultDatasetId) {
    const r = await fetch(`${APIFY}/datasets/${run.defaultDatasetId}/items?clean=1&limit=${MAX_PAGES}&format=json`, {
      headers: { authorization: `Bearer ${env.APIFY_TOKEN}` },
    });
    const items = r.ok ? await r.json() : [];
    pages = items.map((it) => ({
      url: it.url,
      title: it.metadata?.title || null,
      description: trim(it.metadata?.description, 400),
      text: trim(it.markdown || it.text, 6000),
    }));
  }
  await env.DB.prepare(`UPDATE companies SET pages=?, apify_status=?, status=CASE WHEN status='context-done' THEN 'done' ELSE status END, updated=? WHERE domain=?`)
    .bind(JSON.stringify(pages), run.status || "UNKNOWN", now(), domain).run();
  return new Response(JSON.stringify({ ok: true, pages: pages.length }), { headers: { "content-type": "application/json" } });
}

export async function companyRow(env, domain) {
  await enrichTables(env);
  const r = await env.DB.prepare("SELECT * FROM companies WHERE domain=?").bind(domain).first();
  if (!r) return null;
  const j = (v) => { try { return v ? JSON.parse(v) : null; } catch { return v; } };
  return { ...r, brand: j(r.brand), homepage: j(r.homepage), pages: j(r.pages), errors: j(r.errors) };
}
