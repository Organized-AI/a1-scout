// POST /api/bench/consider: "would this Mac do my workflows better than the Macs I own?"
// The Worker side of Considering a Mac. The math is the shared core's (public/consider-core.js), the same file the
// browser's Bench → Simulate loads, so the two answers cannot drift apart.
//
// Auth: a Bearer token with the bench:consider scope. Only its SHA-256 is stored (secret A1_CONSIDER_TOKENS, a
// comma-separated list of hex hashes). The token opens this route and nothing else: every other /api route still
// needs SCOUT_TOKEN or a signed-in session. Tokens are never logged.
//
// Speeds are estimates: a measured tok/s on the nearest benched Mac, scaled by Apple's memory bandwidth. Nothing has
// run on the Mac being considered, so the response says measured:false.
import "../public/consider-core.js";
import { speedConsiderApi } from "./speed-consider.js";

const CORE = globalThis.ConsiderCore;
const SCOPE = "bench:consider";
const CACHE_TTL = 86400;                // 24 h, per machine and bank
const SESSION_DAYS = 90;
const DAY = 86400000;

export const CONSIDER_SUITES = ["gtm-debug", "sql-ga4", "html-json", "rag-notes", "asr", "screen", "gtm-gate", "skill-select", "stape-select"];

// Same D1 contract as bench_runs; created on first use, append-only.
let ready = null;
export async function considerTables(env) {
  if (ready === env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS bench_considers (id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL,
      bank_hash TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, created TEXT NOT NULL)`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS bench_considers_machine ON bench_considers(machine_id, id)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS bench_consider_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, consider_id INTEGER NOT NULL,
      machine_id TEXT NOT NULL, suite TEXT NOT NULL, model TEXT NOT NULL, est_tok_s REAL, measured_tok_s REAL, error_pct REAL, created TEXT NOT NULL)`),
  ]);
  ready = env.DB;
}

const enc = new TextEncoder();
async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const sameText = (a, b) => {               // equal length strings compared without an early exit
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
};

// The token is hashed once and compared to the stored hashes. Returns true only for a bench:consider token.
export async function considerAuthed(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  const stored = (env.A1_CONSIDER_TOKENS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!stored.length) return false;
  const digest = await sha256Hex(h.slice(7).trim());
  return stored.some(s => sameText(s, digest));
}

const str = (v, n) => (typeof v === "string" && v.length <= n ? v : null);
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

// Validate the request. Returns { spec, suites, owned } or { error }.
export function parseRequest(b) {
  if (!b || typeof b !== "object") return { error: "JSON body required" };
  const m = b.machine;
  if (!m || typeof m !== "object") return { error: "machine required: {chip, variant?, memory_gb, storage_gb?}" };
  const chip = str(m.chip, 24), variant = m.variant == null ? null : str(m.variant, 24);
  const gb = int(m.memory_gb, 8, 1024);
  if (!chip || gb == null) return { error: "machine.chip and machine.memory_gb (8–1024) are required" };
  const spec = { chip, variant, memory_gb: gb, storage_gb: m.storage_gb == null ? null : int(m.storage_gb, 1, 262144) };
  if (!CORE.chipName(chip, variant)) return { error: `chip ${chip}${variant ? " " + variant : ""} is not an Apple M-series name` };
  const suites = b.suites == null ? CONSIDER_SUITES : b.suites;
  if (!Array.isArray(suites) || !suites.length || suites.some(s => !CONSIDER_SUITES.includes(s))) return { error: `suites must be a list from ${CONSIDER_SUITES.join(", ")}` };
  const owned = b.owned == null ? null : b.owned;
  if (owned !== null && (!Array.isArray(owned) || owned.some(id => typeof id !== "string" || !/^[\w.\-]{1,40}$/.test(id)))) return { error: "owned must be a list of machine ids" };
  return { spec, suites: [...new Set(suites)], owned };
}

// Latest run per (suite, machine, model): the numbers the estimates are built from.
async function latestRuns(env, suites) {
  const marks = suites.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT id, suite, machine, model, model_path, tok_s, peak_rss, score, bank FROM bench_runs
    WHERE id IN (SELECT MAX(id) FROM bench_runs WHERE suite IN (${marks}) GROUP BY suite, machine, model)`).bind(...suites).all();
  return results || [];
}

// The sessions this user ran in the last 90 days (actor 'you' only). Missing table means no weights, not an error.
async function workSessions(env) {
  try {
    const since = new Date(Date.now() - SESSION_DAYS * DAY).toISOString();
    const { results } = await env.DB.prepare("SELECT app, model, tokens_in FROM sessions WHERE actor = 'you' AND first_event >= ?").bind(since).all();
    return results || [];
  } catch { return []; }
}

// Ownership: the Macs with A1 Bench runs, or the Lab's default pair. Only Macs with a known bandwidth can be scaled to.
function ownedMacs(runs, requested) {
  const known = Object.keys(CORE.LAB_SPECS);
  if (requested) return requested;
  const ran = [...new Set(runs.map(r => r.machine))].filter(id => known.includes(id));
  return ran.length ? ran : ["m1", "m4"];
}

const genOf = id => Number((String(id).match(/^m(\d+)/) || [])[1]) || 0;
const labelOf = id => (CORE.LAB_SPECS[id] ? `${CORE.LAB_SPECS[id].chip} ${CORE.LAB_SPECS[id].memory_gb}GB` : id);

// Build the answer. Pure apart from the inputs: runs, best picks (bench_best), sessions and the request.
export function considerResult({ spec, suites, owned }, { runs, best, sessions, bankHash, machineId }) {
  const cand = { id: machineId, memory_gb: spec.memory_gb, bw: CORE.bandwidthFor(spec) };
  const candLabel = `${CORE.chipName(spec.chip, spec.variant)} ${spec.memory_gb}GB`;
  const ownedIds = ownedMacs(runs, owned);
  const weights = CORE.weightsFor(suites, sessions);
  const p95Tokens = CORE.p95(sessions.map(s => s.tokens_in).filter(v => Number.isFinite(v)));
  const runOf = (suite, mid, model) => runs.find(r => r.suite === suite && r.machine === mid && r.model === model) || null;
  const ownedGb = mid => (CORE.LAB_SPECS[mid] ? CORE.LAB_SPECS[mid].memory_gb : null);

  const rows = suites.map(suite => {
    // Your best Mac today: the agent's recommendation on an owned Mac, the highest score first.
    const picks = ownedIds.map(mid => ({ mid, pick: best?.[suite]?.[mid] })).filter(x => x.pick?.model);
    picks.sort((a, b) => (b.pick.score ?? 0) - (a.pick.score ?? 0));
    const top = picks[0];
    if (!top) return { suite, weight: weights[suite].weight, signals: weights[suite].signals, na: true };
    const model = top.pick.model;
    const ownRun = runOf(suite, top.mid, model);
    // Memory need: the largest footprint measured for this model on any owned Mac, so a fit is never judged on the friendliest run.
    const peaks = ownedIds.map(mid => runOf(suite, mid, model)?.peak_rss).filter(Number.isFinite);
    const peak = peaks.length ? Math.max(...peaks) : null;
    const ctx = peak != null ? CORE.contextFits(peak, spec.memory_gb, p95Tokens) : { fits: false };
    const candFits = peak != null && CORE.fitsBytes(peak, spec.memory_gb) && ctx.fits;
    // Speed: the same model's measured tok/s on the benched Mac nearest in generation, scaled by bandwidth.
    const base = runs.filter(r => r.suite === suite && r.model === model && r.tok_s && CORE.bandwidthForMachine(r.machine).gbs)
      .sort((a, b) => Math.abs(genOf(a.machine) - genOf(cand.id)) - Math.abs(genOf(b.machine) - genOf(cand.id)) || b.tok_s - a.tok_s)[0];
    const tokEst = base && cand.bw.gbs ? CORE.scaleTokS(base.tok_s, cand.bw.gbs, CORE.bandwidthForMachine(base.machine).gbs) : null;
    const ownTok = ownRun?.tok_s ?? null;
    const ratio = tokEst && ownTok ? tokEst / ownTok : null;
    // Newly runnable: the best model that fits this Mac but not any owned Mac.
    const ownBudget = Math.max(...ownedIds.map(ownedGb).filter(Number.isFinite), 0);
    const bigger = runs.filter(r => r.suite === suite && r.peak_rss != null && CORE.fitsBytes(r.peak_rss, spec.memory_gb) && ctx.fits
      && !CORE.fitsBytes(r.peak_rss, ownBudget))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] || null;
    // Candidate best: the highest-scoring model that fits this Mac, with its own estimate.
    const fitting = runs.filter(r => r.suite === suite && r.peak_rss != null && CORE.fitsBytes(r.peak_rss, spec.memory_gb))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const bestHere = fitting[0] || null;
    const verdict = CORE.verdictOf({
      candFits, ownedFits: true, ownedLabel: labelOf(top.mid), noSpeed: !cand.bw.gbs,
      unlocks: bigger ? `Runs ${bigger.model} (${(bigger.peak_rss / 2 ** 30).toFixed(1)} GB), too big for your Macs` : undefined,
      ratio,
    });
    return {
      suite, weight: weights[suite].weight, signals: weights[suite].signals,
      best_model: bestHere?.model || null, score: bestHere?.score ?? null,
      score_delta_vs_owned: bestHere && top.pick.score != null ? Math.round((bestHere.score - top.pick.score) * 1000) / 1000 : null,
      tok_s_est: tokEst ? Math.round(tokEst * 10) / 10 : null,
      speedup_vs_owned: ratio ? Math.round(ratio * 100) / 100 : null,
      newly_runnable: fitting.filter(r => !CORE.fitsBytes(r.peak_rss, ownBudget)).map(r => r.model).slice(0, 10),
      owned_model: model, owned_machine: top.mid, fits: candFits, context: ctx,
      verdict: verdict.kind, text: verdict.text,
      _verdict: verdict, _est_base: base ? base.machine : null,
    };
  });

  const summary = CORE.summaryOf(rows.map(r => r._verdict || { kind: "na" }));
  const weighted = rows.filter(r => r.speedup_vs_owned).reduce((a, r) => a + r.weight * r.speedup_vs_owned, 0);
  // Weights over the workflows that have data; a suite with no run on any owned Mac says nothing either way.
  const dataW = rows.filter(r => !r.na).reduce((a, r) => a + r.weight, 0) || 1;
  const noFitShare = rows.filter(r => !r.na && !r.fits).reduce((a, r) => a + r.weight, 0) / dataW;
  let fit = "fits";
  if (noFitShare >= 0.5) fit = "doesnt_fit";
  else if (!summary.opens && !summary.faster) fit = "no_gain";
  const tone = { good: "opens up", mixed: "faster", bad: summary.worse ? "slower" : "about the same", none: "no estimate" }[summary.tone];
  const suitesOut = rows.map(({ _verdict, _est_base, ...r }) => r);
  return {
    machine_id: machineId,
    bandwidth: cand.bw.gbs ? { gbs: cand.bw.gbs, source: cand.bw.source, basis: cand.bw.basis, bin: cand.bw.bin } : { gbs: null, why: cand.bw.why },
    fit, verdict: tone, headline: `${candLabel}: ${summary.head}`,
    summary: { opens: summary.opens, faster: summary.faster, worse: summary.worse, n: summary.n, weighted_speedup: weighted ? Math.round(weighted * 100) / 100 : null },
    suites: suitesOut,
    measured: false,
    estimate_basis: cand.bw.gbs
      ? "Each speed is a measured tok/s for the same model on the nearest benched Mac, scaled by Apple's memory-bandwidth ratio. Nothing has run on this Mac."
      : `No Apple bandwidth for this Mac (${cand.bw.why}): fit and memory only, no speed estimate.`,
    owned: ownedIds,
    context: { p95_tokens: p95Tokens, kv_bytes_per_token: CORE.KV_BYTES_PER_TOKEN, sessions: sessions.length },
    bank_hash: bankHash,
  };
}

// Full handler: auth, validate, load, compute, cache (KV 24 h), keep an append-only record (D1).
export async function considerApi(req, env, { json, kvGet }) {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await considerAuthed(req, env))) return json({ error: "unauthorized" }, 401);
  await considerTables(env);
  const raw = await req.text();
  if (enc.encode(raw).length > 20000) return json({ error: "request too large" }, 413);
  let body = null;
  try { body = JSON.parse(raw); } catch { body = null; }
  if (body?.speed != null) return speedConsiderApi(body, env, { json });
  const parsed = parseRequest(body);
  if (parsed.error) return json({ error: parsed.error }, 400);

  const runs = await latestRuns(env, parsed.suites);
  const banks = [...new Set(runs.map(r => r.bank).filter(Boolean))].sort();
  const bankHash = (await sha256Hex(banks.join("|"))).slice(0, 16);
  const machineId = CORE.machineId(parsed.spec);
  const defaults = !parsed.owned && parsed.suites.length === CONSIDER_SUITES.length;
  const key = `consider:${machineId}:${bankHash}`;
  if (defaults && env.BENCH) {
    const hit = await env.BENCH.get(key, "json");
    if (hit) return json({ ...hit, cached: true });
  }
  const best = (await kvGet(env, "bench_best")) || {};
  const sessions = await workSessions(env);
  const result = considerResult(parsed, { runs, best, sessions, bankHash, machineId });
  const created = new Date().toISOString();
  const row = await env.DB.prepare("INSERT INTO bench_considers (machine_id, bank_hash, request, result, created) VALUES (?,?,?,?,?) RETURNING id")
    .bind(machineId, bankHash, JSON.stringify(parsed.spec), JSON.stringify(result), created).first();
  const out = { ...result, consider_id: row.id, cached: false };
  if (defaults && env.BENCH) await env.BENCH.put(key, JSON.stringify(out), { expirationTtl: CACHE_TTL });
  return json(out);
}

// A real run for a considered Mac arrives: record how far the estimate was from the measurement (append-only).
export async function recordConsiderCheck(env, run) {
  if (!run?.machine || !run.model || !(run.tok_s > 0)) return;
  try {
    await considerTables(env);
    const last = await env.DB.prepare("SELECT id, result FROM bench_considers WHERE machine_id = ? ORDER BY id DESC LIMIT 1").bind(run.machine).first();
    if (!last) return;
    const res = JSON.parse(last.result || "{}");
    const s = (res.suites || []).find(x => x.suite === run.suite && x.best_model === run.model && x.tok_s_est);
    if (!s) return;
    const err = Math.round(((s.tok_s_est - run.tok_s) / run.tok_s) * 1000) / 10;
    await env.DB.prepare("INSERT INTO bench_consider_checks (consider_id, machine_id, suite, model, est_tok_s, measured_tok_s, error_pct, created) VALUES (?,?,?,?,?,?,?,?)")
      .bind(last.id, run.machine, run.suite, run.model, s.tok_s_est, run.tok_s, err, new Date().toISOString()).run();
  } catch { /* the check is a record, never a reason to reject a bench run */ }
}
