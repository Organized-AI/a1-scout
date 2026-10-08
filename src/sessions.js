// Coding sessions: privacy-safe summaries of the Claude and Codex sessions on every Mac running the A1 agent,
// synced on a loop once "Connect coding sessions" is on, and kept for history and trends.
//
// Observability layout (Cloudflare only):
//   D1  sessions        one row per session, the system of record (latest summary wins; versions counts re-syncs)
//   D1  session_syncs   one row per sync run per Mac: the sync log
//   R2  SESSION_LOGS    every accepted bundle, sessions/<host>/<day>/<run>-<n>.json, kept past Workers Logs' 7 days
//   AE  SESSION_METRICS one data point per changed session per sync, for time-series queries outside the dashboard
//   Workers Logs        one structured line per upload and per run (event: sessions.upload / sessions.run)
// Bundles are re-checked here with the same rules.mjs the Mac ran (no prompts, code, paths, URLs, emails or keys).
import { validateBundle, BundleError } from "./rules.mjs";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const now = () => new Date().toISOString();
const DAY = 864e5;
export const SYNC_EVERY_MIN = 15;
const AE_MAX_POINTS = 250;
const okHost = v => typeof v === "string" && /^[\w-]{1,40}$/.test(v);
const okRun = v => typeof v === "string" && /^[\w-]{6,64}$/.test(v);

const ready = new WeakMap(); // per database, once per isolate
export function sessionTables(env) {
  if (ready.has(env.DB)) return ready.get(env.DB);
  const p = env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (source TEXT NOT NULL, digest TEXT NOT NULL, environment_id TEXT NOT NULL, host TEXT,
      project_fp TEXT NOT NULL, app TEXT, model TEXT, first_event TEXT NOT NULL, last_event TEXT NOT NULL, event_count INTEGER NOT NULL,
      turns INTEGER, edits INTEGER, errors INTEGER, active_minutes INTEGER, subagents INTEGER,
      tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
      observations TEXT NOT NULL, first_seen TEXT NOT NULL, updated_at TEXT NOT NULL, versions INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (source, digest))`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS sessions_first ON sessions (first_event)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS session_syncs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, host TEXT NOT NULL,
      started TEXT, finished TEXT NOT NULL, state TEXT NOT NULL, trigger TEXT, sessions INTEGER, stored INTEGER, files_scanned INTEGER,
      skipped TEXT, note TEXT, duration_ms INTEGER, r2_keys INTEGER)`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS session_syncs_time ON session_syncs (finished)"),
  ]).catch(e => { ready.delete(env.DB); throw e; });
  ready.set(env.DB, p);
  return p;
}

// What the heartbeat tells every Mac: is the loop on, how often, and a pending "sync now".
export async function sessionOrders(env, kvGet) {
  const c = await kvGet(env, "sessions_connect");
  if (!c?.on) return { on: false };
  const n = await kvGet(env, "sessions_now");
  return { on: true, every_min: c.every_min || SYNC_EVERY_MIN, force_at: n?.at && Date.now() - Date.parse(n.at) < 30 * 60e3 ? n.at : null };
}

const num = v => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);

export async function sessionsApi(req, env, url, p, { kvGet, kvSet }) {
  if (!p.startsWith("/api/sessions")) return null;
  await sessionTables(env);

  if (p === "/api/sessions/connect" && req.method === "POST") {
    const { on } = await req.json().catch(() => ({}));
    const c = { on: on !== false, every_min: SYNC_EVERY_MIN, at: now() };
    await kvSet(env, "sessions_connect", c);
    if (c.on) await kvSet(env, "sessions_now", { at: now() }); // first sync right away, not in 15 minutes
    console.log(JSON.stringify({ event: "sessions.connect", on: c.on }));
    return json({ ok: true, connect: c });
  }
  if (p === "/api/sessions/sync-now" && req.method === "POST") {
    const at = now();
    await kvSet(env, "sessions_now", { at });
    return json({ ok: true, at });
  }

  // From a Mac: one bundle of session summaries.
  if (p === "/api/sessions/upload" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || !okHost(body.host) || !okRun(body.run_id)) return json({ error: "host, run_id and bundle required" }, 400);
    let b;
    try { b = validateBundle(body.bundle); }
    catch (e) {
      console.log(JSON.stringify({ event: "sessions.rejected", host: body.host, run_id: body.run_id, code: e.code || "BUNDLE_INVALID" }));
      return json({ error: e instanceof BundleError ? e.message : "Send a JSON evidence bundle.", code: e.code }, 400);
    }
    const t = now(), part = num(body.part);
    const stmts = [], points = [];
    for (const s of b.session_evidence) {
      const o = s.observations || {}, tk = o.tokens || {};
      const row = { turns: num(o.turns), edits: num(o.edits), errors: num(o.errors), active: num(o.active_minutes), sub: num(o.subagents),
        tin: num(tk.input), tout: num(tk.output), tcr: num(tk.cache_read), tcw: num(tk.cache_write) };
      stmts.push(env.DB.prepare(`INSERT INTO sessions (source, digest, environment_id, host, project_fp, app, model, first_event, last_event, event_count,
          turns, edits, errors, active_minutes, subagents, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, observations, first_seen, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source, digest) DO UPDATE SET host=excluded.host, environment_id=excluded.environment_id, app=excluded.app, model=excluded.model,
          last_event=excluded.last_event, event_count=excluded.event_count, turns=excluded.turns, edits=excluded.edits, errors=excluded.errors,
          active_minutes=excluded.active_minutes, subagents=excluded.subagents, tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out,
          tokens_cache_read=excluded.tokens_cache_read, tokens_cache_write=excluded.tokens_cache_write, observations=excluded.observations,
          updated_at=excluded.updated_at, versions=sessions.versions+1`)
        .bind(s.source, s.native_session_digest || s.fallback_fingerprint, b.environment.id, body.host, s.project_fingerprint,
          String(o.app || "").slice(0, 30) || null, String(o.model || "").slice(0, 41) || null, s.first_event, s.last_event, s.event_count,
          row.turns, row.edits, row.errors, row.active, row.sub, row.tin, row.tout, row.tcr, row.tcw, JSON.stringify(o), t, t));
      points.push({ indexes: [body.host], blobs: [body.host, s.source, String(o.app || ""), String(o.model || ""), s.project_fingerprint.slice(0, 12), s.first_event.slice(0, 10),
          String(s.native_session_digest || s.fallback_fingerprint).slice(0, 16)],
        doubles: [row.turns, row.edits, row.errors, row.active, row.tin, row.tout, row.tcr, row.tcw, s.event_count, row.sub] });
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    let r2 = null;
    if (env.SESSION_LOGS) {
      r2 = `sessions/${body.host}/${t.slice(0, 10)}/${body.run_id}-${part}.json`;
      await env.SESSION_LOGS.put(r2, JSON.stringify({ host: body.host, run_id: body.run_id, received_at: t, bundle: b }), { httpMetadata: { contentType: "application/json" } });
    }
    // Analytics Engine takes 250 points per invocation; the rest are counted and logged (D1 still has them, and the
    // series falls back to D1 for any day AE undercounts).
    const aeSkipped = Math.max(0, points.length - AE_MAX_POINTS);
    if (env.SESSION_METRICS) for (const pt of points.slice(0, AE_MAX_POINTS)) { try { env.SESSION_METRICS.writeDataPoint(pt); } catch {} }
    console.log(JSON.stringify({ event: "sessions.upload", host: body.host, run_id: body.run_id, part, sessions: stmts.length, r2, ae_skipped: aeSkipped || undefined }));
    return json({ ok: true, stored: stmts.length, r2 });
  }

  // From a Mac: how a sync went (also failures, so the log shows them).
  if (p === "/api/sessions/run" && req.method === "POST") {
    const r = await req.json().catch(() => ({}));
    if (!okHost(r.host) || !okRun(r.run_id)) return json({ error: "host and run_id required" }, 400);
    const state = ["done", "up_to_date", "failed"].includes(r.state) ? r.state : "failed";
    const row = { run_id: r.run_id, host: r.host, started: r.started || null, finished: now(), state, trigger: String(r.trigger || "loop").slice(0, 20),
      sessions: num(r.sessions), stored: num(r.stored), files_scanned: num(r.files_scanned), skipped: JSON.stringify(r.skipped || {}).slice(0, 400),
      note: r.note ? String(r.note).slice(0, 300) : null, duration_ms: num(r.duration_ms), r2_keys: num(r.parts) };
    await env.DB.prepare(`INSERT INTO session_syncs (run_id, host, started, finished, state, trigger, sessions, stored, files_scanned, skipped, note, duration_ms, r2_keys)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...Object.values(row)).run();
    await kvSet(env, `sessions_sync:${r.host}`, row);
    console.log(JSON.stringify({ event: "sessions.run", ...row, skipped: undefined }));
    return json({ ok: true });
  }

  if (p === "/api/sessions/alerts/run" && req.method === "POST") {
    const week = url.searchParams.get("week");
    if (week && !(/^\d{4}-\d{2}-\d{2}$/.test(week) && Date.parse(week) && weekOf(week) < weekOf(now())))
      return json({ error: "week must be a YYYY-MM-DD day in a complete week" }, 400);
    return json(await sessionAlerts(env, week ? { week } : {}));
  }
  if (p === "/api/sessions/series" && req.method === "GET") return json(await sessionSeries(env, Number(url.searchParams.get("days")) || 365));
  if (p === "/api/sessions" && req.method === "GET") return json(await overview(env, kvGet));
  return json({ error: "not found" }, 404);
}

// ---------- reading it back ----------
const STDLIB = new Set("os sys re json time datetime pathlib typing subprocess collections argparse shutil hashlib itertools functools math random string io csv urllib logging tempfile glob copy textwrap uuid base64 struct threading asyncio dataclasses enum abc contextlib traceback inspect html http socket signal platform getpass unittest pprint __future__ assert type fs path child_process util crypto url events stream readline zlib".split(" "));
const add = (m, k, n = 1) => { if (k) m[k] = (m[k] || 0) + n; };
const top = (m, n) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
// Monday of the ISO week, as a date: the bucket for trends.
export const weekOf = iso => { const d = new Date(String(iso).slice(0, 10) + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

const WEEK_SUMS = ["turns", "edits", "errors", "active_minutes", "subagents", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write"];
const emptyWeek = () => ({ sessions: 0, ...Object.fromEntries(WEEK_SUMS.map(k => [k, 0])), tool_calls: 0, tools: {}, apps: {}, llms: {} });
function addToWeek(w, r, o) {
  w.sessions += r.sessions ?? 1;
  for (const k of WEEK_SUMS) w[k] += r[k] || 0;
  if (r.app) add(w.apps, r.app);
  for (const [n, c] of Object.entries(o.tools || {})) { add(w.tools, n, c); w.tool_calls += c; }
  for (const [n, c] of Object.entries(o.llms || (r.model ? { [r.model]: 1 } : {}))) add(w.llms, n, c);
}
const r3 = v => Math.round(v * 1000) / 1000;
const tokensTotal = w => w.tokens_in + w.tokens_out + w.tokens_cache_read + w.tokens_cache_write;
const cacheHit = w => { const d = w.tokens_cache_read + w.tokens_in + w.tokens_cache_write; return d ? r3(w.tokens_cache_read / d) : null; };
const errorRate = w => w.tool_calls ? r3(w.errors / w.tool_calls) : null;
const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);

async function overview(env, kvGet) {
  const connect = (await kvGet(env, "sessions_connect")) || { on: false };
  const index = (await kvGet(env, "machines")) || {};
  const since = new Date(Date.now() - 26 * 7 * DAY).toISOString();
  const { results } = await env.DB.prepare(`SELECT host, source, project_fp, app, model, first_event, last_event, turns, edits, errors, active_minutes, subagents,
    tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, observations FROM sessions WHERE first_event >= ? ORDER BY first_event`).bind(since).all();
  const total = await env.DB.prepare("SELECT COUNT(*) n, MIN(first_event) first, MAX(last_event) last, COUNT(DISTINCT host) hosts, COUNT(DISTINCT project_fp) projects FROM sessions").first();
  const runs = (await env.DB.prepare("SELECT * FROM session_syncs ORDER BY id DESC LIMIT 30").all()).results;

  // Weekly history: behavior, tool usage and token usage over time.
  const weeks = {}, agg = { apps: {}, llms: {}, tools: {}, languages: {}, packages: {}, libraries: {}, models: {} }, recent = Date.now() - 90 * DAY;
  for (const r of results) {
    let o = {}; try { o = JSON.parse(r.observations); } catch {}
    addToWeek(weeks[weekOf(r.first_event)] ||= emptyWeek(), r, o);
    if (Date.parse(r.first_event) < recent) continue;
    add(agg.apps, r.app);
    for (const [n, c] of Object.entries(o.llms || (r.model ? { [r.model]: 1 } : {}))) add(agg.llms, n, c);
    for (const [n, c] of Object.entries(o.tools || {})) add(agg.tools, n, c);
    for (const [n, c] of Object.entries(o.languages || {})) add(agg.languages, n, c);
    for (const x of new Set(o.packages || [])) add(agg.packages, x);
    for (const x of new Set(o.imports || [])) if (!STDLIB.has(x)) add(agg.libraries, x);
    for (const x of new Set(o.models || [])) add(agg.models, x);
  }
  const history = Object.entries(weeks).sort(([a], [b]) => a.localeCompare(b)).map(([week, w]) => ({
    week, ...w, tools: top(w.tools, 8), apps: w.apps, llms: undefined,
    tokens_total: tokensTotal(w), cache_hit: cacheHit(w), error_rate: errorRate(w),
  }));
  const hosts = await Promise.all(Object.entries(index).map(async ([host, v]) => ({ host, label: v.label, seen: v.at, last_sync: await kvGet(env, `sessions_sync:${host}`) })));
  return { connect, every_min: connect.every_min || SYNC_EVERY_MIN,
    totals: { sessions: total?.n || 0, first: total?.first || null, last: total?.last || null, macs: total?.hosts || 0, projects: total?.projects || 0 },
    hosts, history, runs, alerts: await latestAlerts(env),
    profile: { window_days: 90, apps: top(agg.apps, 6), llms: top(agg.llms, 8), tools: top(agg.tools, 12), languages: top(agg.languages, 10),
      packages: top(agg.packages, 15), libraries: top(agg.libraries, 15), models: top(agg.models, 10) } };
}

// ---------- weekly alerts ----------
// Monday cron: the last complete week against the 4 before it. One row per (week, metric) in session_alerts, so a re-run
// replaces. Baselines average the trailing weeks that had sessions; rates are pooled across them, so one quiet week
// can't swing the baseline.
export const ALERT_WEEKS = 4;
export const ALERT_METRICS = ["tokens", "cache_hit", "error_rate", "tokens_per_prompt", "new_tools", "new_llms"];

// Which changes deserve a highlight. change = (value - baseline) / baseline; rates also compare in points (value - baseline).
export function alertFlag(metric, value, baseline, change) {
  if (value == null) return { flag: false, tone: "info" };
  if (metric === "new_tools" || metric === "new_llms") return { flag: value > 0, tone: "info" };
  if (baseline == null) return { flag: false, tone: "info" };
  const pts = value - baseline; // rates: a 0 baseline is real (no errors, no cache), so compare in points first
  if (metric === "cache_hit") return pts <= -0.1 ? { flag: true, tone: "bad" } : pts >= 0.1 ? { flag: true, tone: "good" } : { flag: false, tone: "info" };
  if (metric === "error_rate") return pts >= 0.05 && (change == null || change >= 0.5) ? { flag: true, tone: "bad" } : pts <= -0.05 ? { flag: true, tone: "good" } : { flag: false, tone: "info" };
  if (change == null) return { flag: false, tone: "info" };
  if (metric === "tokens") return { flag: Math.abs(change) >= 0.5, tone: "info" };
  if (metric === "tokens_per_prompt") return change >= 0.5 ? { flag: true, tone: "bad" } : change <= -0.3 ? { flag: true, tone: "good" } : { flag: false, tone: "info" };
  return { flag: false, tone: "info" };
}

const alertsReady = new WeakMap();
function alertTables(env) {
  if (alertsReady.has(env.DB)) return alertsReady.get(env.DB);
  const p = env.DB.prepare(`CREATE TABLE IF NOT EXISTS session_alerts (week TEXT NOT NULL, metric TEXT NOT NULL, value REAL, baseline REAL, change REAL,
    baseline_weeks INTEGER NOT NULL, flag INTEGER NOT NULL, tone TEXT NOT NULL, detail TEXT, created TEXT NOT NULL, PRIMARY KEY (week, metric))`).run()
    .catch(e => { alertsReady.delete(env.DB); throw e; });
  alertsReady.set(env.DB, p);
  return p;
}

// week: any day in the week to report (default: last complete week).
export async function sessionAlerts(env, { at = Date.now(), week } = {}) {
  await sessionTables(env); await alertTables(env);
  const latest = weekOf(week || new Date(at - 7 * DAY).toISOString());
  const from = addDays(latest, -7 * ALERT_WEEKS), to = addDays(latest, 7);
  const { results } = await env.DB.prepare(`SELECT first_event, app, model, turns, edits, errors, active_minutes, subagents,
    tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, observations FROM sessions WHERE first_event >= ? AND first_event < ?`).bind(from, to).all();
  const weeks = {};
  for (const r of results) { let o = {}; try { o = JSON.parse(r.observations); } catch {} addToWeek(weeks[weekOf(r.first_event)] ||= emptyWeek(), r, o); }
  const cur = weeks[latest];
  if (!cur) { console.log(JSON.stringify({ event: "sessions.alerts", week: latest, rows: 0 })); return { week: latest, baseline_weeks: 0, alerts: [] }; }
  const trail = Object.entries(weeks).filter(([w]) => w < latest).map(([, w]) => w), n = trail.length;
  const pool = emptyWeek();
  for (const w of trail) addToWeek(pool, w, { tools: w.tools, llms: w.llms });
  const perPrompt = w => w.turns ? Math.round(tokensTotal(w) / w.turns) : null;
  const fresh = (now, before) => Object.entries(now).filter(([k]) => !before[k]).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const newTools = n ? fresh(cur.tools, pool.tools) : null, newLlms = n ? fresh(cur.llms, pool.llms) : null;
  const vals = {
    tokens: [tokensTotal(cur), n ? Math.round(tokensTotal(pool) / n) : null],
    cache_hit: [cacheHit(cur), n ? cacheHit(pool) : null],
    error_rate: [errorRate(cur), n ? errorRate(pool) : null],
    tokens_per_prompt: [perPrompt(cur), n ? perPrompt(pool) : null],
    new_tools: [newTools && newTools.length, null, newTools],
    new_llms: [newLlms && newLlms.length, null, newLlms],
  };
  const t = now();
  const alerts = ALERT_METRICS.map(metric => {
    const [value, baseline, names] = vals[metric];
    const change = value != null && baseline ? r3((value - baseline) / baseline) : null;
    const { flag, tone } = alertFlag(metric, value, baseline, change);
    return { week: latest, metric, value, baseline, change, baseline_weeks: n, flag, tone, detail: names ? names.slice(0, 12) : null };
  });
  await env.DB.batch(alerts.map(a => env.DB.prepare(`INSERT INTO session_alerts (week, metric, value, baseline, change, baseline_weeks, flag, tone, detail, created)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(week, metric) DO UPDATE SET value=excluded.value, baseline=excluded.baseline, change=excluded.change,
    baseline_weeks=excluded.baseline_weeks, flag=excluded.flag, tone=excluded.tone, detail=excluded.detail, created=excluded.created`)
    .bind(a.week, a.metric, a.value, a.baseline, a.change, n, a.flag ? 1 : 0, a.tone, a.detail ? JSON.stringify(a.detail) : null, t)));
  console.log(JSON.stringify({ event: "sessions.alerts", week: latest, baseline_weeks: n, flagged: alerts.filter(a => a.flag).map(a => a.metric) }));
  return { week: latest, baseline_weeks: n, alerts };
}

async function latestAlerts(env) {
  await alertTables(env);
  const { results } = await env.DB.prepare("SELECT * FROM session_alerts WHERE week = (SELECT MAX(week) FROM session_alerts)").all();
  if (!results.length) return null;
  const rows = results.map(r => ({ ...r, flag: !!r.flag, detail: r.detail ? JSON.parse(r.detail) : null }))
    .sort((a, b) => ALERT_METRICS.indexOf(a.metric) - ALERT_METRICS.indexOf(b.metric));
  return { week: rows[0].week, baseline_weeks: rows[0].baseline_weeks, created: rows[0].created, rows };
}

// ---------- daily series past the 26-week overview ----------
// Analytics Engine keeps 3 months, D1 keeps everything. Days inside the AE window come from the AE SQL API, older days
// (and all days when AE is unset or fails) from D1. AE gets a point per session per sync carrying cumulative totals, so
// it takes max() per session (blob7) and day before summing. AE_SINCE: first session start day whose every point has
// blob7 (sessions that ended before blob7 shipped are never re-sent, so AE can't see them).
export const AE_DAYS = 85, AE_SINCE = "2026-10-09"; // AE keeps "3 months": 85 days leaves margin
const SERIES_SUMS = ["turns", "edits", "errors", "active_minutes", "subagents", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write"];

function seriesD1(env, from, to) {
  return env.DB.prepare(`SELECT substr(first_event, 1, 10) day, COUNT(*) sessions, ${SERIES_SUMS.map(k => `COALESCE(SUM(${k}), 0) ${k}`).join(", ")}
    FROM sessions WHERE first_event >= ? AND first_event < ? GROUP BY day ORDER BY day`).bind(from, to).all().then(r => r.results);
}

async function seriesAE(env, from, to) {
  const d = ["turns", "edits", "errors", "active_minutes", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write", null, "subagents"];
  const inner = d.map((k, i) => k && `max(double${i + 1}) AS ${k}`).filter(Boolean).join(", ");
  const sql = `SELECT day, count() AS sessions, ${SERIES_SUMS.map(k => `sum(${k}) AS ${k}`).join(", ")} FROM (
    SELECT blob6 AS day, blob7 AS sid, ${inner} FROM a1_scout_sessions
    WHERE timestamp > NOW() - INTERVAL '${AE_DAYS + 1}' DAY AND blob7 != '' AND blob6 >= '${from}' AND blob6 < '${to}' GROUP BY day, sid)
    GROUP BY day ORDER BY day FORMAT JSON`;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    { method: "POST", headers: { authorization: `Bearer ${env.CF_AE_TOKEN}` }, body: sql });
  if (!r.ok) throw new Error(`Analytics Engine ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).data || [];
}

export async function sessionSeries(env, days = 365, { at = Date.now(), aeSince = AE_SINCE } = {}) {
  await sessionTables(env);
  days = Math.min(3650, Math.max(1, Math.trunc(days) || 365));
  const to = addDays(new Date(at).toISOString().slice(0, 10), 1), from = addDays(to, -days);
  const aeFrom = [addDays(to, -AE_DAYS), aeSince, from].sort().at(-1);
  const sources = {};
  let ae = null;
  if (env.CF_ACCOUNT_ID && env.CF_AE_TOKEN && aeFrom < to) {
    try { ae = await seriesAE(env, aeFrom, to); sources.ae = { from: aeFrom, to, days: ae.length }; }
    catch (e) { sources.ae = { error: e.message }; console.log(JSON.stringify({ event: "sessions.series.ae_failed", error: e.message })); }
  } else sources.ae = { off: env.CF_ACCOUNT_ID && env.CF_AE_TOKEN ? "outside window" : "CF_ACCOUNT_ID / CF_AE_TOKEN not set" };
  // D1 is the system of record: inside the AE window it only checks counts, and replaces any day AE undercounts
  // (points past AE's per-invocation limit, or sessions that predate blob7).
  const d1 = await seriesD1(env, from, to);
  const row = (r, source) => ({ day: r.day, sessions: num(r.sessions), ...Object.fromEntries(SERIES_SUMS.map(k => [k, num(r[k])])), source });
  const aeBy = new Map((ae || []).map(r => [r.day, row(r, "ae")]));
  const series = d1.map(r => { const a = ae && r.day >= aeFrom ? aeBy.get(r.day) : null; return a && a.sessions >= num(r.sessions) ? a : row(r, "d1"); });
  if (ae) sources.ae.replaced_by_d1 = series.filter(r => r.day >= aeFrom && r.source === "d1").length;
  sources.d1 = { from, to, days: series.filter(r => r.source === "d1").length };
  return { days, from, to, sources, series };
}

// ---------- ranking against your work ----------
// Session counts per package, library and Hugging Face model over the last 180 days, plus the name tokens they contain,
// so "mlx-whisper" in 6 sessions lifts mlx-community/whisper-large-v3-turbo.
const STOP = new Set("mlx python node core cli server client tools tool utils util types plugin model models base instruct chat large small mini community data test tests dev lite fast open next react eslint prettier typescript wrangler cloudflare worker workers google api sdk http json yaml with the and for web app run new hub lib main init config bit 4bit 8bit 6bit gguf v1 v2 v3 py js ts".split(" "));
export function tokensOfName(s) { return String(s || "").toLowerCase().split(/[\s/_.:@+-]+/).filter(t => t.length >= 3 && /[a-z]/.test(t) && !STOP.has(t)); }

export async function workIndex(env) {
  try { await sessionTables(env); } catch { return null; }
  const since = new Date(Date.now() - 180 * DAY).toISOString();
  const { results } = await env.DB.prepare("SELECT observations FROM sessions WHERE first_event >= ? LIMIT 20000").bind(since).all();
  if (!results.length) return null;
  const terms = {}, models = {};
  for (const r of results) {
    let o = {}; try { o = JSON.parse(r.observations); } catch { continue; }
    for (const x of new Set([...(o.packages || []), ...(o.imports || []).filter(i => !STDLIB.has(i))])) add(terms, x.replace(/\[.*$/, ""));
    for (const x of new Set(o.models || [])) add(models, x.toLowerCase());
  }
  const byToken = {};
  for (const [term, n] of Object.entries(terms)) for (const t of tokensOfName(term)) if (!byToken[t] || byToken[t].n < n) byToken[t] = { term, n };
  return { sessions: results.length, models, byToken };
}

const plural = n => `${n} session${n === 1 ? "" : "s"}`;
export function workBoost(c, work) {
  if (!work) return null;
  const repo = String(c.repo || "").toLowerCase();
  if (work.models[repo]) { const n = work.models[repo]; return { points: Math.min(15, 6 + 3 * Math.log2(n + 1)), reason: `you used ${c.repo} in ${plural(n)}` }; }
  const words = c.kind === "paper" ? tokensOfName(`${c.title} ${String(c.summary || "").slice(0, 400)}`) : tokensOfName(repo.split("/").pop());
  let best = null;
  for (const t of new Set(words)) { const h = work.byToken[t]; if (h && h.n >= 2 && (!best || h.n > best.n)) best = h; }
  if (!best) return null;
  const cap = c.kind === "paper" ? 8 : 12;
  return { points: Math.min(cap, 3 + 2 * Math.log2(best.n + 1)), reason: `you used ${best.term} in ${plural(best.n)}` };
}
