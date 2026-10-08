/* Sessions tab: "Connect coding sessions" turns on a 15-minute sync on every Mac running the agent.
   Shows what Scout learned (languages, libraries, packages, models), how behavior, tool use and tokens change week
   to week, each Mac's last sync, and the sync log. Data: GET /api/sessions (D1); bundles archived in R2. */
const SessionsView = (() => {
  let data = null, busy = false, timer = null, metric = "tokens";
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const big = n => n == null ? "—" : n >= 1e9 ? (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(Math.round(n));
  const ago = iso => { if (!iso) return "never"; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const pct = v => v == null ? "—" : Math.round(v * 100) + "%";
  const RM = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  const METRICS = {
    tokens: { label: "Tokens", stack: [["tokens_cache_read", "cache read", "var(--c-datasets)"], ["tokens_cache_write", "cache write", "var(--c-code)"], ["tokens_in", "input", "var(--c-models)"], ["tokens_out", "output", "var(--c-spaces)"]], fmt: big },
    sessions: { label: "Sessions", key: "sessions", fmt: big },
    active: { label: "Active hours", get: w => w.active_minutes / 60, fmt: v => v.toFixed(v < 10 ? 1 : 0) },
    turns: { label: "Prompts", key: "turns", fmt: big },
    edits: { label: "File edits", key: "edits", fmt: big },
    tools: { label: "Tool calls", key: "tool_calls", fmt: big },
    errors: { label: "Error rate", get: w => w.error_rate ?? 0, fmt: pct },
    cache: { label: "Cache hit", get: w => w.cache_hit ?? 0, fmt: pct },
    perturn: { label: "Tokens / prompt", get: w => w.turns ? w.tokens_total / w.turns : 0, fmt: big },
  };

  async function load(call) { data = await call("/api/sessions"); return data; }

  function trendSvg(hist) {
    const m = METRICS[metric], W = 720, H = 180, pad = 26, n = hist.length;
    if (!n) return "";
    const bw = (W - pad) / n;
    const val = w => m.stack ? m.stack.reduce((t, [k]) => t + (w[k] || 0), 0) : m.get ? m.get(w) : w[m.key] || 0;
    const max = Math.max(...hist.map(val), 1e-9);
    const bars = hist.map((w, i) => {
      const x = pad + i * bw + 2, width = Math.max(2, bw - 4);
      let y = H - 18;
      const segs = (m.stack || [[m.key || "v", m.label, "var(--brand)"]]).map(([k, , col]) => {
        const v = m.stack ? w[k] || 0 : val(w), h = v / max * (H - 34);
        y -= h;
        return `<rect class="tb" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="${h.toFixed(1)}" fill="${col}" rx="1.5"><title>${esc(w.week)} · ${esc(m.stack ? k.replace("tokens_", "").replace("_", " ") : m.label)}: ${esc(m.fmt(v))}</title></rect>`;
      }).join("");
      const lbl = i % Math.ceil(n / 8) === 0 ? `<text x="${(x + width / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle">${esc(new Date(w.week + "T00:00:00Z").toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" }))}</text>` : "";
      return segs + lbl;
    }).join("");
    return `<svg class="st-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.label)} per week">
      <text x="0" y="12">${esc(m.fmt(max))}</text><line x1="${pad}" x2="${W}" y1="${H - 18}" y2="${H - 18}" stroke="var(--line)"/>${bars}</svg>
      ${m.stack ? `<div class="st-legend">${m.stack.map(([, l, c]) => `<span><i style="background:${c}"></i>${esc(l)}</span>`).join("")}</div>` : ""}`;
  }

  // Tool share per week: which tools you lean on, and how that shifts.
  function toolGrid(hist) {
    const recent = hist.slice(-12);
    const tot = {};
    for (const w of recent) for (const t of w.tools) tot[t.name] = (tot[t.name] || 0) + t.count;
    const names = Object.entries(tot).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n]) => n);
    if (!names.length) return "";
    return `<div class="st-grid" style="--cols:${recent.length}"><span></span>${recent.map(w => `<span class="st-wk">${esc(w.week.slice(5))}</span>`).join("")}
      ${names.map(n => `<span class="st-tool" title="${esc(n)}">${esc(n)}</span>${recent.map(w => {
        const c = (w.tools.find(t => t.name === n) || {}).count || 0, share = w.tool_calls ? c / w.tool_calls : 0;
        return `<span class="st-cell" style="--a:${Math.min(1, share * 2.5).toFixed(2)}" title="${esc(n)} · week of ${esc(w.week)}: ${c} calls (${pct(share)})"></span>`;
      }).join("")}`).join("")}</div>`;
  }

  function list(title, rows) {
    if (!rows?.length) return "";
    const max = rows[0].count || 1;
    return `<div class="st-list"><div class="st-lt">${esc(title)}</div>${rows.map(r => `<div class="st-row"><span title="${esc(r.name)}">${esc(r.name)}</span><b>${big(r.count)}</b><i><u data-w="${(r.count / max).toFixed(3)}"></u></i></div>`).join("")}</div>`;
  }

  function html() {
    if (!data) return `<div class="empty">Loading sessions…</div>`;
    const d = data, on = d.connect?.on, t = d.totals, hist = d.history || [], pr = d.profile || {};
    const last = hist[hist.length - 1], prev = hist[hist.length - 2];
    const delta = (k, get) => { if (!last || !prev) return ""; const a = get ? get(last) : last[k], b = get ? get(prev) : prev[k]; if (!b) return ""; const ch = (a - b) / b; return `<small class="${ch >= 0 ? "up" : "down"}">${ch >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(ch * 100))}% vs last week</small>`; };
    const hosts = (d.hosts || []).filter(h => h.last_sync || on);
    const connectBtn = on
      ? `<button class="a1-run-btn" data-sx="now"${busy ? " disabled" : ""}><span class="a1-run-ic" aria-hidden="true"><i></i></span><span class="a1-run-t">Sync now</span><small>Connected · every ${d.every_min} min</small></button>
         <button class="btn" data-sx="off"${busy ? " disabled" : ""}>Disconnect</button>`
      : `<button class="a1-run-btn st-connect" data-sx="on"${busy ? " disabled" : ""}><span class="a1-run-ic" aria-hidden="true"><i></i></span><span class="a1-run-t">Connect coding sessions</span><small>Claude + Codex · every Mac with the agent</small></button>`;
    return `<div class="sub">Claude and Codex sessions from every Mac running the A1 agent, synced every ${d.every_min} minutes once connected. Only counts and names leave each Mac (tools, commands, languages, packages, models, tokens), checked by the same privacy filter as the Scout connector. No prompts, code, paths or file names. Scout ranks Hugging Face picks against this.</div>
    <div class="a1-cta st-cta">${connectBtn}<span class="a1-cta-note" data-sxnote>${on ? `Connected ${esc(ago(d.connect.at))}. Each Mac checks in every minute and syncs what changed.` : "One click. Each Mac picks it up within a minute; no install, no pairing."}</span></div>
    ${hosts.length ? `<div class="a1-macs">${hosts.map(h => { const s = h.last_sync; const cls = !s ? "" : s.state === "failed" ? "stale" : "on";
      return `<span class="a1-mac ${cls}" title="${esc(s?.note || h.label)}"><i></i>${esc(String(h.label).split(" · ")[0])} · ${s ? `${s.state === "failed" ? "failed" : "synced"} ${esc(ago(s.finished))}${s.sessions ? ` · ${s.sessions} sessions` : ""}` : "waiting for first sync"}</span>`; }).join("")}</div>` : ""}
    ${t.sessions ? `
    <div class="stats">
      <div class="stat"><b data-n="${t.sessions}">0</b><span>sessions since ${esc(new Date(t.first).toLocaleDateString())}</span></div>
      <div class="stat"><b>${last ? big(last.tokens_total) : "—"}</b><span>tokens this week</span>${delta("tokens_total")}</div>
      <div class="stat"><b>${last ? (last.active_minutes / 60).toFixed(1) : "—"}</b><span>active hours this week</span>${delta("active_minutes")}</div>
      <div class="stat"><b>${last ? pct(last.cache_hit) : "—"}</b><span>cache hit this week</span></div>
      <div class="stat"><b data-n="${t.macs}">0</b><span>Macs · ${t.projects} projects</span></div>
    </div>
    <div class="section">Over time</div>
    <div class="tabs st-metrics">${Object.entries(METRICS).map(([k, m]) => `<button class="tab" data-metric="${k}" aria-pressed="${k === metric}">${esc(m.label)}</button>`).join("")}</div>
    <div class="st-chart" data-chart>${trendSvg(hist)}</div>
    <div class="section">Tool use by week <small class="st-hint">darker = bigger share of that week's calls</small></div>
    ${toolGrid(hist)}
    <div class="section">Your work · last ${pr.window_days} days</div>
    <div class="st-lists">${list("Languages", pr.languages)}${list("Libraries", pr.libraries)}${list("Packages", pr.packages)}${list("Hugging Face models", pr.models)}${list("Tools", pr.tools)}${list("LLMs", pr.llms)}${list("Apps", pr.apps)}</div>
    ` : `<div class="empty">${on ? "Waiting for the first sync. It starts within a minute on each Mac." : "Nothing synced yet."}</div>`}
    <div class="section">Sync log</div>
    ${(d.runs || []).length ? `<div class="st-log"><div class="st-lr st-lh"><span>When</span><span>Mac</span><span>Result</span><span>Sessions</span><span>Took</span></div>${d.runs.map(r => `<div class="st-lr ${r.state === "failed" ? "bad" : ""}">
      <span title="${esc(r.finished)}">${esc(ago(r.finished))}</span><span>${esc(r.host)}</span><span>${esc(r.state.replace("_", " "))}${r.trigger !== "loop" ? ` · ${esc(r.trigger)}` : ""}${r.note ? ` · ${esc(r.note)}` : ""}</span>
      <span>${r.sessions || 0}${r.files_scanned ? ` / ${r.files_scanned} files` : ""}</span><span>${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + " s" : "—"}</span></div>`).join("")}</div>` : `<div class="empty">No syncs yet.</div>`}`;
  }

  function wire(first, rerender, call) {
    const note = document.querySelector("[data-sxnote]");
    document.querySelectorAll("[data-sx]").forEach(b => b.onclick = async () => {
      busy = true; b.disabled = true;
      if (!RM()) gsap.to(b, { scale: .96, duration: .1, yoyo: true, repeat: 1 });
      try {
        const a = b.dataset.sx;
        const r = a === "now" ? await call("/api/sessions/sync-now", { method: "POST", body: "{}" })
          : await call("/api/sessions/connect", { method: "POST", body: JSON.stringify({ on: a === "on" }) });
        if (!r.ok) throw new Error(r.error || "Couldn't send that.");
        await load(call);
        busy = false; rerender();
        const n = document.querySelector("[data-sxnote]");
        if (n && a !== "off") n.textContent = "Sent. Each Mac picks it up at its next check-in (within a minute); results land here.";
        poll(call, rerender, 20000);
      } catch (e) { busy = false; b.disabled = false; if (note) { note.textContent = e.message; note.classList.add("err"); } }
    });
    document.querySelectorAll("[data-metric]").forEach(b => b.onclick = () => {
      metric = b.dataset.metric;
      document.querySelectorAll("[data-metric]").forEach(x => x.setAttribute("aria-pressed", x === b));
      const c = document.querySelector("[data-chart]"); c.innerHTML = trendSvg(data.history || []); grow(c, .5);
    });
    grow(document, first ? .9 : .4);
    document.querySelectorAll(".st-row u").forEach(u => gsap.fromTo(u, { width: 0 }, { width: (u.dataset.w * 100) + "%", duration: RM() ? 0 : .8, ease: "power3.out", delay: RM() ? 0 : .1 }));
    document.querySelectorAll(".stat [data-n]").forEach(el => { const o = { v: 0 }; gsap.to(o, { v: +el.dataset.n, duration: first && !RM() ? .9 : 0, onUpdate: () => el.textContent = Math.round(o.v).toLocaleString() }); });
    if (first && !RM()) gsap.fromTo(".st-list, .st-cell, .st-lr", { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .3, stagger: { amount: .6 }, ease: "power2.out", clearProps: "all" });
    if (data?.connect?.on && !timer) poll(call, rerender, 60000);
  }
  function grow(root, d) {
    if (RM()) return;
    root.querySelectorAll(".st-svg .tb").forEach((r, i) => gsap.from(r, { attr: { height: 0, y: 162 }, duration: d, delay: i * .006, ease: "power3.out" }));
  }
  // While connected and the tab is open, refresh the log and charts so new syncs show up.
  function poll(call, rerender, ms) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      if (document.hidden || !document.querySelector("[data-sxnote]")) return;
      try { await load(call); rerender(); } catch {}
    }, ms);
  }
  return { html, wire, load };
})();
