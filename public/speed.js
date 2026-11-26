// Speed Lab: measured phase timings and explicitly estimated workload comparisons.
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const positive = n => typeof n === "number" && Number.isFinite(n) && n > 0;
  const number = (n, digits = 1) => typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "—";
  const seconds = n => positive(n) ? `${number(n)} s` : "unavailable";
  const rate = n => positive(n) ? `${number(n)} tok/s` : "unavailable";
  const ms = n => typeof n === "number" && Number.isFinite(n) ? `${number(n)} ms` : "unavailable";
  const gb = n => typeof n === "number" && Number.isFinite(n) ? `${number(n / 1e9, 2)} GB` : "unknown";
  const configKey = r => JSON.stringify([r.model, r.bank, r.tokenizer, r.target, r.engine_version ?? null, r.precision ?? null]);
  const cacheLabel = s => ({ "not_applicable": "No cache pair", "first-use-unconfirmed": "First use · cold not confirmed", "warm-repeat": "Warm repeat" }[s] || s || "Unknown cache condition");
  const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  let data = null, loading = null, error = "", seq = 0, callFn = null, paint = () => {};
  let selected = "", cache = "", workload = "agent", filterMachine = "", filterModel = "";
  let pendingAnimation = true;
  let split = { compatible: false, format: "", bytes: 0, wifi: 0 };

  function setData(value) {
    data = Array.isArray(value) ? { rows: value, has_more: false, next_before: null } : value;
    error = ""; pendingAnimation = true;
  }
  async function load(call, opts = {}) {
    callFn = call || callFn;
    if (!callFn) return null;
    if (opts.machine !== undefined) filterMachine = opts.machine;
    if (opts.model !== undefined) filterModel = opts.model;
    const ticket = ++seq, q = new URLSearchParams({ limit: "200" });
    if (filterMachine) q.set("machine", filterMachine);
    if (filterModel) q.set("model", filterModel);
    if (opts.more && data?.next_before) q.set("before", data.next_before);
    const previous = opts.more ? data?.rows || [] : [];
    error = "";
    loading = Promise.resolve().then(() => callFn(`/api/bench/speed?${q}`)).then(result => {
      if (ticket !== seq) return null;
      if (!result || !Array.isArray(result.rows) || result.error) throw new Error(result?.error || "Invalid speed response");
      const seen = new Set(previous.map(r => r.uid));
      data = { ...result, rows: previous.concat(result.rows.filter(r => !seen.has(r.uid))) };
      pendingAnimation = true;
      return data;
    }).catch(e => { if (ticket === seq) error = String(e.message || e); return null; })
      .finally(() => { if (ticket === seq) loading = null; });
    return loading;
  }
  function groups() {
    const map = new Map();
    for (const row of data?.rows || []) {
      const key = configKey(row);
      if (!map.has(key)) map.set(key, { key, seed: row, rows: [] });
      map.get(key).rows.push(row);
    }
    return [...map.values()];
  }
  function latest(rows, key) {
    const found = new Map();
    for (const row of [...rows].sort((a, b) => (b.id || 0) - (a.id || 0))) if (!found.has(key(row))) found.set(key(row), row);
    return [...found.values()];
  }
  function paired(rows) {
    const pairs = new Map();
    for (const row of rows) {
      if (!row.cache_pair_uid || !["first-use-unconfirmed", "warm-repeat"].includes(row.cache_state)) continue;
      const key = JSON.stringify([row.cache_pair_uid, row.machine, row.task_id, configKey(row), row.prompt_tokens, row.max_tokens, row.phase]);
      if (!pairs.has(key)) pairs.set(key, {});
      const pair = pairs.get(key), old = pair[row.cache_state];
      if (!old || (row.id || 0) > (old.id || 0)) pair[row.cache_state] = row;
    }
    return [...pairs.values()].filter(p => p["first-use-unconfirmed"] && p["warm-repeat"])
      .map(p => ({ cold: p["first-use-unconfirmed"], warm: p["warm-repeat"] }));
  }
  function machineSpec(id, rows) {
    const core = window.SpeedCore;
    const row = rows.find(r => r.machine === id);
    const chip = core?.MACHINE_CHIPS[id] || (row?.probes?.probe_scope !== "client" ? row?.probes?.chip : null);
    const memories = { m1: 16, m4: 16, m6: 32, m5p: 64, "dgx-spark": 128, "m5-max-128gb": 128 };
    return { id, chip, memory_gb: memories[id] || (row?.probes?.probe_scope !== "client" && row?.probes?.memory_bytes ? row.probes.memory_bytes / 2 ** 30 : null) };
  }
  function viewModel() {
    const options = groups();
    const group = options.find(g => g.key === selected) || options[0];
    if (group) selected = group.key;
    const states = [...new Set((group?.rows || []).map(r => r.cache_state))];
    if (!states.includes(cache)) cache = states.includes("first-use-unconfirmed") ? "first-use-unconfirmed" : states[0] || "";
    const rows = (group?.rows || []).filter(r => r.cache_state === cache);
    const good = rows.filter(r => r.fit === true && !r.error);
    const input = window.SpeedCore?.WORKLOADS[workload]?.input_tokens || (workload === "agent" ? 8000 : 500);
    const reading = latest(good.filter(r => r.phase === "prefill" && positive(r.prompt_tok_s) && positive(r.prompt_tokens)), r => `${r.machine}|${r.target_prompt_tokens}`);
    const writing = latest([...good.filter(r => r.phase === "decode" && positive(r.write_tok_s))]
      .sort((a, b) => Math.abs(a.target_prompt_tokens - input) - Math.abs(b.target_prompt_tokens - input)), r => `${r.machine}|${r.target_prompt_tokens}`)
      .sort((a, b) => Math.abs(a.target_prompt_tokens - input) - Math.abs(b.target_prompt_tokens - input))
      .filter((r, i, all) => all.findIndex(x => x.machine === r.machine) === i);
    const request = group ? Object.fromEntries(["model", "bank", "tokenizer", "target", "engine_version", "precision"].map(k => [k, group.seed[k] ?? null])) : null;
    if (request) request.cache_state = cache;
    const estimates = [];
    if (request && window.SpeedCore) {
      for (const id of [...new Set([...rows.map(r => r.machine), "m6", "m5p", "dgx-spark"])]) {
        const machine = machineSpec(id, rows);
        estimates.push(window.SpeedCore.estimateSpeed({ machine, request, runs: group.rows, calibration: data?.calibration || {} }));
      }
    }
    return { options, group, states, rows, reading, writing, pairs: paired(group?.rows || []), estimates, request };
  }
  const source = value => typeof value === "string" && /^https:\/\//.test(value) ? `<a href="${esc(value)}" target="_blank" rel="noopener">spec source ↗</a>` : "";
  function readingHtml(vm) {
    if (!vm.reading.length) return '<p class="sp-note">No successful reading probes with server token counts in this configuration.</p>';
    const maxX = Math.max(...vm.reading.map(r => r.prompt_tokens)), maxY = Math.max(...vm.reading.map(r => r.prompt_tok_s));
    const x = n => 58 + n / maxX * 500, y = n => 180 - n / maxY * 140;
    const machines = [...new Set(vm.reading.map(r => r.machine))];
    const colors = ["var(--brand,#fbe04d)", "var(--c-datasets,#6cc4f2)", "var(--c-papers,#7cf2a0)", "var(--c-code,#b99cf2)"];
    return `<svg class="sp-curve" viewBox="0 0 600 230" role="img" aria-label="Measured prompt-reading curve, input tokens versus reading tokens per second">
      <path d="M58 30V180H570" class="sp-axis"/>
      <text x="58" y="20">Measured reading · tok/s</text><text x="58" y="199">0</text><text x="558" y="199" text-anchor="end">${number(maxX, 0)}</text>
      <text x="305" y="223" text-anchor="middle">Server prompt tokens</text><text x="50" y="44" text-anchor="end">${number(maxY, 0)}</text>
      ${machines.map((machine, i) => { const points = vm.reading.filter(r => r.machine === machine).sort((a, b) => a.prompt_tokens - b.prompt_tokens);
        return `<g style="color:${colors[i % colors.length]}"><polyline class="sp-line" points="${points.map(r => `${x(r.prompt_tokens)},${y(r.prompt_tok_s)}`).join(" ")}"/>
          ${points.map(r => `<circle cx="${x(r.prompt_tokens)}" cy="${y(r.prompt_tok_s)}" r="4"><title>${esc(machine)}: measured ${rate(r.prompt_tok_s)} at ${esc(r.prompt_tokens)} prompt tokens; run ${esc(r.uid)}</title></circle>`).join("")}</g>`;
      }).join("")}</svg><div class="sp-legend">${machines.map((m, i) => `<span style="color:${colors[i % colors.length]}">● ${esc(m)}</span>`).join("")}</div>
      <details><summary>Measured reading values and provenance</summary>${vm.reading.map(r => `<p>${esc(r.machine)} · ${esc(r.prompt_tokens)} input tokens · measured ${rate(r.prompt_tok_s)} · TTFT ${ms(r.ttft_ms)} · run ${esc(r.uid)}</p>`).join("")}</details>`;
  }
  function writingHtml(vm) {
    const max = Math.max(1, ...vm.writing.map(r => r.write_tok_s));
    return vm.writing.length ? vm.writing.map(r => `<div class="sp-write"><b>${esc(r.machine)}</b><span>Measured ${rate(r.write_tok_s)}</span>
      <i><u style="width:${r.write_tok_s / max * 100}%"></u></i><small>${esc(r.prompt_tokens ?? "unknown")} server input tokens · ${esc(r.reply_tokens ?? "unknown")} reply tokens · run ${esc(r.uid)}</small></div>`).join("")
      : '<p class="sp-note">No successful writing probes in this configuration.</p>';
  }
  function cacheHtml(vm) {
    return `<h3>Measured cache · first use vs warm</h3><p class="sp-note">First use is unconfirmed cold; no cache eviction is performed. Only the same measurement pair is compared.</p>
      ${vm.pairs.length ? `<div class="sp-scroll"><table><thead><tr><th>Machine / probe</th><th>Measured first TTFT</th><th>Measured warm TTFT</th><th>Measured cache read</th></tr></thead><tbody>
        ${vm.pairs.slice(0, 30).map(p => `<tr><th>${esc(p.cold.machine)} · ${esc(p.cold.phase)} · ${esc(p.cold.target_prompt_tokens)} tokens</th><td>${ms(p.cold.ttft_ms)}</td><td>${ms(p.warm.ttft_ms)}</td><td>${number(p.warm.probes?.cache_read_gbs, 3)} GB/s</td></tr>`).join("")}
      </tbody></table></div><p class="sp-note">Cache-drive reads may include filesystem cache. ${vm.pairs.length > 30 ? "Showing the newest 30 pairs." : ""}</p>` : '<p class="sp-note">No complete cold/warm measurement pairs loaded.</p>'}`;
  }
  function estimateHtml(vm) {
    return `<h3>Estimated workload time · Consider</h3><p class="sp-note">Agent: 8,000 input / 150 output tokens × 10 turns. Chat: 500 input / 500 output tokens. Equal context each turn; selected cache condition. Model fit is checked per workload.</p>
      <div class="sp-scroll"><table><thead><tr><th>Machine</th><th>Reading</th><th>Writing</th><th>Estimated agent time</th><th>Estimated chat time</th></tr></thead><tbody>
        ${vm.estimates.map(e => { const w = e.workloads[workload];
          const phase = p => `${p.measured ? "Measured" : "Estimated"} ${rate(p.tok_s)}<small>${esc(p.basis)}${p.source_uid ? ` · run ${esc(p.source_uid)}` : ""} ${source(p.source_url)}</small>`;
          return `<tr><th>${esc(e.chip || e.machine_id)}<small>${esc(e.machine_id)}</small></th><td>${phase(w.prefill)}</td><td>${phase(w.decode)}</td>
            <td>Estimated ${seconds(e.workloads.agent.seconds)}<small>Fit: ${e.workloads.agent.fit === false ? "refused / insufficient memory" : e.workloads.agent.fit === true ? "fits measured footprint" : "unknown"}</small></td>
            <td>Estimated ${seconds(e.workloads.chat.seconds)}<small>Fit: ${e.workloads.chat.fit === false ? "refused / insufficient memory" : e.workloads.chat.fit === true ? "fits measured footprint" : "unknown"}</small></td></tr>`;
        }).join("")}</tbody></table></div>
      <p class="sp-note">Missing comparable GPU compute leaves reading and total time unavailable. Spark sparse FP4 peak is not comparable to Apple FP32. Writing scales by sourced bandwidth; these are estimates.</p>`;
  }
  function splitHtml(vm) {
    const core = window.SpeedCore, reader = vm.estimates.find(e => e.machine_id === "dgx-spark");
    const writer = vm.estimates.find(e => /^M\d/.test(e.chip || "") && vm.rows.some(r => r.machine === e.machine_id));
    const w = core?.WORKLOADS[workload];
    return `<h3>Estimated Spark + Mac split</h3><p class="sp-note">A hypothetical compatible KV cache transfer, not an implemented transfer. Declare a verified format and byte size before estimating links.</p>
      <form data-speed-split class="sp-controls"><label><input type="checkbox" name="compatible" ${split.compatible ? "checked" : ""}> Cache format verified compatible</label>
        <label>Cache format<input name="format" value="${esc(split.format)}" maxlength="80"></label><label>Cache size, bytes<input name="bytes" type="number" min="1" value="${split.bytes || ""}"></label>
        <label>Wi-Fi effective Gb/s<input name="wifi" type="number" min="0.01" step="0.01" value="${split.wifi || ""}"></label><button class="bn-btn" type="submit">Estimate links</button></form>
      <div class="sp-scroll"><table><thead><tr><th>Link</th><th>Estimated transfer per turn</th><th>Estimated ${esc(workload)} total</th></tr></thead><tbody>${["Wi-Fi", "2.5GbE", "10GbE"].map(kind => {
        const result = core && reader && writer && reader.workloads[workload].fit !== false && writer.workloads[workload].fit !== false
          ? core.splitEstimate({ reader: reader.workloads[workload].prefill, writer: writer.workloads[workload].decode, workload: w,
            link: { kind, effective_gbps: split.wifi, efficiency: .8 }, cache: split }) : { seconds: null, transfer_seconds: null, why: "Compatible reader/writer measurements and fit are required" };
        return `<tr><th>${kind}</th><td>Estimated ${seconds(result.transfer_seconds)}</td><td>Estimated ${seconds(result.seconds)}<small>${esc(result.why || "80% link efficiency assumed; transfer each turn")}</small></td></tr>`;
      }).join("")}</tbody></table></div>`;
  }
  function html() {
    const vm = viewModel();
    const label = r => `${r.model} · ${r.target} ${r.engine_version || "version unknown"} · ${r.precision || "precision unknown"} · bank ${r.bank} · tokenizer ${r.tokenizer}`;
    return `<section class="sp" aria-label="Speed Lab" aria-busy="${!!loading}">
      <header><span class="bn-kick">Speed Lab · measured reading and writing</span><h2>Read the prompt. Write the reply.</h2><p class="sp-note">Separate prompt reading from reply writing on each machine. Client TTFT includes transport and queue time. Every chart is measured; workload and hardware comparisons are estimated.</p></header>
      <form class="sp-controls" data-speed-filter><label>Machine ID<input name="machine" value="${esc(filterMachine)}" placeholder="All machines" maxlength="80"></label><label>Model ID<input name="model" value="${esc(filterModel)}" placeholder="All models" maxlength="200"></label>
        <button type="submit" class="bn-btn" ${loading ? "disabled" : ""}>Apply filters</button><button type="button" class="bn-btn" data-speed-refresh ${loading ? "disabled" : ""}>Refresh</button></form>
      ${error ? `<p class="sp-error" role="alert">Could not load speed runs: ${esc(error)}. Refresh to retry.</p>` : ""}
      ${vm.group ? `<div class="sp-controls"><label>Measurement configuration<select data-speed-config>${vm.options.map(g => `<option value="${esc(g.key)}" ${g.key === selected ? "selected" : ""}>${esc(label(g.seed))}</option>`).join("")}</select></label>
        <label>Cache condition<select data-speed-cache>${vm.states.map(s => `<option value="${esc(s)}" ${s === cache ? "selected" : ""}>${esc(cacheLabel(s))}</option>`).join("")}</select></label>
        <label>Workload<select data-speed-workload><option value="agent" ${workload === "agent" ? "selected" : ""}>Agent</option><option value="chat" ${workload === "chat" ? "selected" : ""}>Chat</option></select></label></div>
        <p class="sp-note">Comparisons keep model, bank, actual tokenizer, engine version, target, precision and cache condition separate. Showing ${vm.rows.length} measurements in this configuration.</p>
        <div class="sp-grid"><article class="sp-card"><h3>Measured prompt-reading curve</h3>${readingHtml(vm)}</article><article class="sp-card"><h3>Measured reply writing</h3><p class="sp-note">Latest probe nearest the selected workload's input length, per machine.</p>${writingHtml(vm)}</article></div>
        <article class="sp-card">${cacheHtml(vm)}</article><article class="sp-card">${estimateHtml(vm)}</article><article class="sp-card">${splitHtml(vm)}</article>
        <article class="sp-card"><h3>Measured fit and run diagnostics</h3><div class="sp-scroll"><table><thead><tr><th>Machine / phase</th><th>Fit / diagnostic</th><th>Measured free RAM</th><th>Measured peak RSS</th></tr></thead><tbody>${vm.rows.slice(0, 30).map(r => `<tr><th>${esc(r.machine)} · ${esc(r.phase)} · ${esc(r.target_prompt_tokens)} tokens<small>run ${esc(r.uid)}</small></th><td>${r.fit === false ? "Does not fit" : r.error ? "Run failed" : r.fit === true ? "Ran successfully" : "Fit unknown"}<small>${esc(r.reason || r.error || "")}</small></td><td>${gb(r.probes?.free_ram_bytes)}<small>${esc(r.probes?.free_ram_basis || "")}</small></td><td>${gb(r.probes?.peak_rss_bytes)}<small>${esc(r.probes?.rss_scope || "unknown scope")} · ${esc(r.probes?.probe_scope || "unknown probe scope")}</small></td></tr>`).join("")}</tbody></table></div><p class="sp-note">Client RSS is not server model memory. Showing at most 30 diagnostics.</p></article>`
        : `<div class="bn-empty">${loading ? "Loading measured speed runs…" : "No speed measurements loaded. On the Mac, run"} ${loading ? "" : '<code>python3 agent/agent.py bench speed --model models/mlx/Qwen3-0.6B-4bit --smoke</code>'}</div>`}
      <footer class="sp-controls"><span class="sp-note">${data?.rows?.length || 0} measured rows loaded${data?.has_more ? " · older measurements available" : ""}</span>${data?.has_more ? `<button type="button" class="bn-btn" data-speed-more ${loading ? "disabled" : ""}>Load older measurements</button>` : ""}</footer></section>`;
  }
  function wire(first, rerender, call) {
    paint = rerender || paint; callFn = call || callFn;
    const root = $(".sp"); if (!root) return;
    const reload = async opts => { const pending = load(null, opts); paint(); await pending; paint(); };
    if (!data && !loading && !error) reload({});
    const form = $("[data-speed-filter]", root);
    if (form) form.onsubmit = e => { e.preventDefault(); reload({ machine: form.elements.machine.value.trim(), model: form.elements.model.value.trim() }); };
    $("[data-speed-refresh]", root)?.addEventListener("click", () => reload({}));
    $("[data-speed-more]", root)?.addEventListener("click", () => reload({ more: true }));
    for (const [selector, update] of [["config", v => { selected = v; cache = ""; }], ["cache", v => { cache = v; }], ["workload", v => { workload = v; }]]) {
      $("[data-speed-" + selector + "]", root)?.addEventListener("change", e => { update(e.target.value); pendingAnimation = true; paint(); });
    }
    const splitForm = $("[data-speed-split]", root);
    if (splitForm) splitForm.onsubmit = e => { e.preventDefault(); const f = splitForm.elements;
      split = { compatible: f.compatible.checked, format: f.format.value.trim(), bytes: Number(f.bytes.value), wifi: Number(f.wifi.value) }; pendingAnimation = true; paint(); };
    if ((first || pendingAnimation) && window.gsap && !reduced()) {
      window.gsap.from($$(".sp-card", root), { y: 10, opacity: 0, duration: .35, stagger: .05, clearProps: "transform,opacity" });
      window.gsap.from($$(".sp-write u", root), { scaleX: 0, transformOrigin: "left", duration: .6, stagger: .04, clearProps: "transform" });
    }
    pendingAnimation = false;
  }
  window.SpeedView = { html, wire, load, setData, viewModel };
  const css = document.createElement("style");
  css.textContent = `.sp{display:grid;gap:14px;min-width:0}.sp h2{font:600 clamp(22px,3vw,30px) "IBM Plex Mono",monospace;margin:8px 0}.sp h3{font:600 15px "IBM Plex Mono",monospace;margin:0 0 10px}
    .sp-note{font-size:12.5px;color:var(--mute);line-height:1.6;margin:4px 0 10px}.sp-error{color:var(--bad)}.sp-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.sp-card{padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--panel);min-width:0}
    .sp-controls{display:flex;align-items:end;gap:10px;flex-wrap:wrap}.sp-controls label{display:grid;gap:4px;font:12px "IBM Plex Mono",monospace;min-width:0}.sp-controls select,.sp-controls input:not([type=checkbox]){font:12px "IBM Plex Mono",monospace;border:1px solid var(--line);border-radius:7px;padding:8px;background:var(--bg);color:var(--ink);max-width:100%;min-height:36px}.sp-controls select{max-width:min(600px,80vw)}.sp-controls input{max-width:220px}.sp :is(select,input,button):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .sp-curve{width:100%;display:block;overflow:visible;font:10px "IBM Plex Mono",monospace;fill:var(--mute)}.sp-axis{fill:none;stroke:var(--line)}.sp-line{fill:none;stroke:currentColor;stroke-width:2}.sp-curve circle{fill:currentColor}.sp-legend{display:flex;gap:14px;flex-wrap:wrap;font:12px "IBM Plex Mono",monospace}
    .sp-write{display:grid;grid-template-columns:1fr auto;gap:5px;margin:14px 0;font-size:13px}.sp-write i{grid-column:1/-1;height:7px;background:var(--chip);border-radius:4px;overflow:hidden}.sp-write u{display:block;height:100%;background:var(--c-datasets);border-radius:4px}.sp-write small{grid-column:1/-1;color:var(--mute);overflow-wrap:anywhere}
    .sp-scroll{max-width:100%;overflow:auto}.sp table{width:100%;border-collapse:collapse;font-size:12px;text-align:left}.sp th,.sp td{padding:9px;border-bottom:1px solid var(--line);vertical-align:top;min-width:110px}.sp th{font-weight:600}.sp td small,.sp th small{display:block;color:var(--mute);font-weight:400;max-width:36ch;overflow-wrap:anywhere}.sp a{color:var(--accent)}.sp details{color:var(--mute);font-size:12px;margin-top:10px}.sp summary{cursor:pointer}.sp details p{overflow-wrap:anywhere}@media(max-width:760px){.sp-grid{grid-template-columns:1fr}.sp-controls label{width:100%}.sp-controls select{max-width:100%}.sp-write{grid-template-columns:1fr}}`;
  document.head.appendChild(css);
})();
