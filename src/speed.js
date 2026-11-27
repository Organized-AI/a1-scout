// Speed Lab storage. Caller applies the same signedIn gate as /api/bench/runs.
// Rows are append-only. INSERT OR IGNORE makes concurrent UID retransmits safe.
export const SPEED_BODY_LIMIT = 1_000_000;
const enc = new TextEncoder();
const ready = new WeakSet();
const text = (v, max) => typeof v === "string" && v.length <= max ? v : null;
const metric = v => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const integer = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const identifier = (v, max = 80) => text(v, max) && /^[\w.\-]+$/.test(v) ? v : null;
const modelName = v => text(v, 200) && /^[\w.\-/:@+]+$/.test(v)
  && !v.split("/").some(part => !part || part === "." || part === "..") ? v : null;
const oneOf = (v, choices) => choices.includes(v) ? v : null;

export async function speedTables(env) {
  if (ready.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS bench_speed_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE,
      machine TEXT NOT NULL, model TEXT NOT NULL, target TEXT NOT NULL, phase TEXT NOT NULL, bank TEXT NOT NULL,
      fit INTEGER, ttft_ms REAL, prompt_tok_s REAL, write_tok_s REAL, prompt_tokens INTEGER, reply_tokens INTEGER,
      free_ram_bytes INTEGER, peak_rss_bytes INTEGER, payload TEXT NOT NULL, started TEXT, created TEXT NOT NULL)`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS bench_speed_runs_key ON bench_speed_runs(machine, model, phase, bank, id)"),
  ]);
  ready.add(env.DB);
}

// Usage counts can be provider-specific and nested. Keep bounded numeric counts,
// including cache details, while excluding arbitrary text/credentials/output.
function usageCounts(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4) return {};
  const out = {};
  for (const [key, v] of Object.entries(value).slice(0, 50)) {
    if (!/^[a-zA-Z][\w]{0,79}$/.test(key)) continue;
    if (metric(v) !== null) out[key] = v;
    else if (v && typeof v === "object" && !Array.isArray(v) && depth < 4) {
      const nested = usageCounts(v, depth + 1);
      if (Object.keys(nested).length) out[key] = nested;
    }
  }
  return out;
}

function probesOf(value) {
  const p = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const out = {};
  for (const key of ["free_ram_bytes", "peak_rss_bytes", "memory_bytes", "cache_read_bytes"]) out[key] = integer(p[key]);
  for (const key of ["bandwidth_gbs", "cache_read_gbs"]) out[key] = metric(p[key]);
  for (const key of ["chip", "free_ram_basis", "cache_read_basis"]) out[key] = text(p[key], 200);
  for (const key of ["bandwidth_source", "cache_drive"]) out[key] = text(p[key], 500);
  out.rss_scope = oneOf(p.rss_scope, ["client", "model-process"]);
  out.probe_scope = oneOf(p.probe_scope, ["client", "local-machine"]);
  return out;
}

export function cleanSpeedRun(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "JSON object required" };
  const uid = identifier(b.uid, 128), machine = identifier(b.machine), model = modelName(b.model);
  const bank = identifier(b.bank), taskId = identifier(b.task_id, 160);
  const target = oneOf(b.target, ["mlx", "omlx", "endpoint"]);
  const phase = oneOf(b.phase, ["prefill", "decode"]), workload = oneOf(b.workload, ["agent", "chat"]);
  if (!uid || !machine || !model || !bank || !taskId || !target || !phase || !workload)
    return { error: "uid, machine, model, bank, task_id, target, phase and workload required" };
  if (!(b.fit === true || b.fit === false || b.fit === null)) return { error: "fit must be true, false or null" };
  if (b.suite != null && b.suite !== "speed") return { error: "suite must be speed" };
  const reason = text(b.reason, 500), error = text(b.error, 500);
  if (b.fit === false && !reason) return { error: "fit:false requires a reason" };
  const row = { uid, suite: "speed", machine, model, bank, task_id: taskId, target, phase, workload,
    fit: b.fit, reason, error, usage: usageCounts(b.usage), probes: probesOf(b.probes) };
  for (const key of ["ttft_ms", "latency_ms", "prompt_tok_s", "write_tok_s", "load_s", "bandwidth_used_gbs"]) row[key] = metric(b[key]);
  for (const key of ["prompt_tokens", "reply_tokens", "target_prompt_tokens", "max_tokens", "active_weight_bytes"]) row[key] = integer(b[key]);
  for (const key of ["started", "finished"]) row[key] = text(b[key], 40);
  for (const key of ["runtime", "engine_version", "tokenizer", "bank_tokenizer", "precision"]) row[key] = text(b[key], 80);
  row.timing_basis = text(b.timing_basis, 200);
  row.cache_state = oneOf(b.cache_state, ["not_applicable", "first-use-unconfirmed", "warm-repeat"]);
  row.cache_pair_uid = identifier(b.cache_pair_uid, 128);
  return { row };
}

export async function speedApi(req, env, url, { json, recordSpeedCheck }) {
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "GET or POST only" }, 405);
  if (req.method === "POST") {
    const raw = await req.text();
    if (enc.encode(raw).length > SPEED_BODY_LIMIT) return json({ error: "speed run too large" }, 413);
    let body; try { body = JSON.parse(raw); } catch { return json({ error: "JSON object required" }, 400); }
    const { row, error } = cleanSpeedRun(body);
    if (error) return json({ error }, 400);
    await speedTables(env);
    const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO bench_speed_runs
      (uid, machine, model, target, phase, bank, fit, ttft_ms, prompt_tok_s, write_tok_s, prompt_tokens, reply_tokens,
       free_ram_bytes, peak_rss_bytes, payload, started, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
      .bind(row.uid, row.machine, row.model, row.target, row.phase, row.bank, row.fit == null ? null : Number(row.fit),
        row.ttft_ms, row.prompt_tok_s, row.write_tok_s, row.prompt_tokens, row.reply_tokens,
        row.probes.free_ram_bytes, row.probes.peak_rss_bytes, JSON.stringify(row), row.started, new Date().toISOString()).first();
    if (inserted) {
      if (recordSpeedCheck) await recordSpeedCheck(env, row);
      return json({ ok: true, id: inserted.id, duplicate: false });
    }
    const existing = await env.DB.prepare("SELECT id FROM bench_speed_runs WHERE uid=?").bind(row.uid).first();
    return json({ ok: true, id: existing.id, duplicate: true });
  }
  const q = url.searchParams;
  const machine = q.has("machine") ? identifier(q.get("machine")) : null;
  const model = q.has("model") ? modelName(q.get("model")) : null;
  if (q.has("machine") && !machine || q.has("model") && !model) return json({ error: "invalid machine or model filter" }, 400);
  const parse = (name, fallback) => q.has(name) && /^\d+$/.test(q.get(name)) ? Number(q.get(name)) : q.has(name) ? NaN : fallback;
  const limit = parse("limit", 100), before = parse("before", null);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || before !== null && (!Number.isSafeInteger(before) || before < 1))
    return json({ error: "limit must be 1–200; before must be a positive row id" }, 400);
  const where = [], args = [];
  if (machine) { where.push("machine=?"); args.push(machine); }
  if (model) { where.push("model=?"); args.push(model); }
  if (before !== null) { where.push("id<?"); args.push(before); }
  await speedTables(env);
  const found = (await env.DB.prepare(`SELECT id, payload, created FROM bench_speed_runs
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).bind(...args, limit + 1).all()).results || [];
  const hasMore = found.length > limit;
  const rows = found.slice(0, limit).map(r => ({ ...JSON.parse(r.payload), id: r.id, created: r.created }));
  return json({ rows, has_more: hasMore, next_before: hasMore ? rows.at(-1).id : null });
}
