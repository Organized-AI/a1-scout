// Standalone schema and arrival checks: no import of route/storage modules.
const ready = new WeakSet();
export async function speedCheckTables(env) {
  if (ready.has(env.DB)) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS bench_consider_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, consider_id INTEGER NOT NULL,
    machine_id TEXT NOT NULL, suite TEXT NOT NULL, model TEXT NOT NULL, est_tok_s REAL, measured_tok_s REAL, error_pct REAL, created TEXT NOT NULL)`).run();
  const columns = (await env.DB.prepare("PRAGMA table_info(bench_consider_checks)").all()).results || [];
  for (const [name, type] of [["phase","TEXT"],["bank","TEXT"],["tokenizer","TEXT"],["target_prompt_tokens","INTEGER"],["cache_state","TEXT"],["target","TEXT"],["engine_version","TEXT"],["peak_rss_bytes","INTEGER"],["free_ram_bytes","INTEGER"],["run_uid","TEXT"]]) {
    if (!columns.some(c => c.name === name)) {
      try { await env.DB.prepare(`ALTER TABLE bench_consider_checks ADD COLUMN ${name} ${type}`).run(); }
      catch (error) { if (!String(error.message).includes("duplicate column")) throw error; }
    }
  }
  ready.add(env.DB);
}
export async function recordSpeedCheck(env, run) {
  if (run.fit !== true || run.error || !["prefill","decode"].includes(run.phase)) return;
  const metric = run.phase === "prefill" ? run.prompt_tok_s : run.write_tok_s;
  if (!(metric > 0)) return;
  try {
    await speedCheckTables(env);
    const found = (await env.DB.prepare("SELECT id,result FROM bench_considers WHERE machine_id=? ORDER BY id DESC LIMIT 100").bind(run.machine).all()).results || [];
    for (const item of found) {
      const result = JSON.parse(item.result);
      if (result.mode !== "speed") continue;
      const phase = Object.values(result.workloads || {}).map(w => w[run.phase]).find(p => p?.tok_s > 0 && p.measured === false
        && ["model","bank","tokenizer","cache_state","target","engine_version","precision"].every(k => (p.conditions?.[k] ?? null) === (run[k] ?? null))
        && p.conditions.target_prompt_tokens === run.target_prompt_tokens);
      if (!phase) continue;
      await env.DB.prepare(`INSERT INTO bench_consider_checks
        (consider_id,machine_id,suite,model,est_tok_s,measured_tok_s,error_pct,created,phase,bank,tokenizer,target_prompt_tokens,cache_state,target,engine_version,peak_rss_bytes,free_ram_bytes,run_uid)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(item.id,run.machine,"speed",run.model,phase.tok_s,metric,
        Math.round((phase.tok_s-metric)/metric*1000)/10,new Date().toISOString(),run.phase,run.bank,run.tokenizer,run.target_prompt_tokens,run.cache_state,run.target,run.engine_version || null,run.probes?.peak_rss_bytes ?? null,run.probes?.free_ram_bytes ?? null,run.uid).run();
      break;
    }
  } catch { /* estimate checks never reject an accepted measurement */ }
}
