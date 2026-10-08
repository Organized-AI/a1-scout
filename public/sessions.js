/* Sessions tab: "Connect coding sessions" turns on a 15-minute sync on every Mac running the agent.
   Opens with last week's alerts against the 4-week average (Monday cron, D1 session_alerts). Shows what Scout learned
   (languages, libraries, packages, models), how behavior, tool use and tokens change week to week, each Mac's last
   sync, and the sync log. Data: GET /api/sessions (D1); bundles archived in R2. */
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


  /* ---------- stat cards: each picks its own time frame; "i" explains it ---------- */
  const TF = { day: "Today", week: "This week", month: "This month", quarter: "This quarter", lastq: "Last quarter", ytd: "Year to date", all: "All time" };
  const PREV = { day: "yesterday", week: "last week", month: "last month", quarter: "last quarter", lastq: "the quarter before", ytd: "last year" };
  const CARDS = {
    sessions: { label: "Sessions", tf: "week", value: a => a.n, fmt: v => Math.round(v).toLocaleString(),
      info: "Coding sessions you started in Claude Code, Claude Desktop, Codex Desktop, the Codex CLI or an IDE, counted on the day each one began. Scripted runs (codex exec, claude -p, the Agent SDK, Paperclip and other orchestrators) aren't counted here; they're under Agents below." },
    tokens: { label: "Tokens", tf: "week", value: a => a.tin + a.tout + a.tcr + a.tcw, fmt: big,
      info: "Every token your sessions used, as the session logs report it: fresh input, output, cache writes and cache reads. Cache reads are usually most of it and cost far less than fresh input. A long session counts toward the period it started in." },
    active: { label: "Active hours", tf: "week", value: a => a.active / 60, fmt: v => v.toFixed(v < 10 ? 1 : 0),
      info: "Time you were actually working: each session is split into 5-minute slots, and only slots with at least one event count. A session left open overnight adds nothing while it sits idle." },
    cache: { label: "Cache hit", tf: "week", rate: true, value: a => { const d = a.tcr + a.tin + a.tcw; return d ? a.tcr / d : null; }, fmt: pct,
      info: "Share of input tokens served from the prompt cache: cache reads ÷ (cache reads + fresh input + cache writes). Higher means cheaper, faster turns. Long sessions in the same project usually score highest." },
    reach: { label: "Macs", value: a => a.hosts.size, fmt: v => String(v), sub: a => `${a.projects.size} project${a.projects.size === 1 ? "" : "s"}`,
      info: "How many of your Macs had sessions in this period, and how many distinct projects. A project is the repo or folder a session ran in, fingerprinted on the Mac; Scout never sees its name or path." },
  };
  // One time frame for every card: picking it on any card switches them all (remembered in this browser).
  let tfAll = "week"; try { const v = localStorage.getItem("a1-sessions-tf"); if (TF[v]) tfAll = v; } catch {}
  const tfOf = () => tfAll;
  function periodStart(tf, at) {
    const d = new Date(at); d.setHours(0, 0, 0, 0);
    if (tf === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    if (tf === "month") d.setDate(1);
    if (tf === "quarter") { d.setDate(1); d.setMonth(d.getMonth() - d.getMonth() % 3); }
    if (tf === "ytd") { d.setMonth(0, 1); }
    return tf === "all" ? -Infinity : d.getTime();
  }
  function shiftBack(tf, t) {
    const d = new Date(t);
    if (tf === "day") d.setDate(d.getDate() - 1);
    if (tf === "week") d.setDate(d.getDate() - 7);
    if (tf === "month") d.setMonth(d.getMonth() - 1);
    if (tf === "quarter") d.setMonth(d.getMonth() - 3);
    if (tf === "ytd") d.setFullYear(d.getFullYear() - 1);
    return d.getTime();
  }
  // The span a time frame covers, and the one it's compared with. "Last quarter" is a closed quarter against the one before;
  // the others run to now and compare with the same point in the previous period.
  function periodRange(tf, now = Date.now()) {
    if (tf === "lastq") { const q = periodStart("quarter", now), st = shiftBack("quarter", q); return { start: st, end: q, prevStart: shiftBack("quarter", st), prevEnd: st, closed: true }; }
    const start = periodStart(tf, now);
    return tf === "all" ? { start, end: now + 1 } : { start, end: now + 1, prevStart: shiftBack(tf, start), prevEnd: shiftBack(tf, now) + 1 };
  }
  function sumRange(from, to) {
    const a = { n: 0, turns: 0, active: 0, tin: 0, tout: 0, tcr: 0, tcw: 0, hosts: new Set(), projects: new Set() };
    for (const r of data.lite?.rows || []) {
      if (r[0] < from || r[0] >= to) continue;
      a.n++; a.hosts.add(r[1]); a.projects.add(r[2]); a.turns += r[3]; a.active += r[6]; a.tin += r[7]; a.tout += r[8]; a.tcr += r[9]; a.tcw += r[10];
    }
    return a;
  }
  // This period so far against the same stretch of the one before: Thursday 9am this week vs Thursday 9am last week.
  function cardModel(k) {
    const c = CARDS[k], tf = tfOf(k), rg = periodRange(tf);
    const cur = sumRange(rg.start, rg.end), v = c.value(cur);
    let delta = null;
    if (rg.prevStart != null) {
      const pv = c.value(sumRange(rg.prevStart, rg.prevEnd));
      if (v != null && pv != null && (c.rate || pv > 0)) delta = c.rate ? { pts: Math.round((v - pv) * 100) } : { pct: (v - pv) / pv };
    }
    return { c, tf, v, delta, closed: !!rg.closed, sub: c.sub ? c.sub(cur) : null };
  }
  function cardInner(k) {
    const m = cardModel(k);
    const d = m.delta == null ? (m.tf === "all" && data.totals.first ? `<small class="flat">since ${esc(new Date(data.totals.first).toLocaleDateString())}</small>` : `<small class="flat">nothing to compare yet</small>`)
      : m.delta.pts != null ? `<small class="${m.delta.pts >= 0 ? "up" : "down"}">${m.delta.pts >= 0 ? "+" : "−"}${Math.abs(m.delta.pts)} pts vs ${m.closed ? "" : "same point "}${PREV[m.tf]}</small>`
      : `<small class="${m.delta.pct >= 0 ? "up" : "down"}">${m.delta.pct >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(m.delta.pct * 100))}% vs ${m.closed ? "" : "same point "}${PREV[m.tf]}</small>`;
    return `<button type="button" class="st-i" data-info="${k}" aria-label="About ${esc(m.c.label)}" aria-expanded="false">i</button>
      <b data-cv="${m.v ?? ""}">${m.v == null ? "—" : esc(m.c.fmt(m.v))}</b>
      <span>${esc(m.c.label)}${m.sub ? ` · ${esc(m.sub)}` : ""}</span>
      <span class="st-tf">${esc(TF[m.tf])} <i aria-hidden="true">▾</i></span>${d}`;
  }
  function cardsHtml() {
    return `<div class="stats st-cards">${Object.keys(CARDS).map(k => `<div class="stat st-card" data-card="${k}" tabindex="0" role="button" aria-haspopup="menu"
      aria-label="${esc(CARDS[k].label)}, ${esc(TF[tfOf(k)])}. Change the time frame for all cards">${cardInner(k)}</div>`).join("")}</div>`;
  }
  function closePops() { document.querySelectorAll(".st-pop").forEach(p => p.remove()); document.querySelectorAll(".st-i[aria-expanded=true]").forEach(b => b.setAttribute("aria-expanded", "false")); }
  function openPop(card, html, cls) {
    closePops();
    const pop = document.createElement("div"); pop.className = `st-pop ${cls}`; pop.innerHTML = html;
    card.appendChild(pop);
    if (!RM()) gsap.fromTo(pop, { opacity: 0, y: -6, scale: .97 }, { opacity: 1, y: 0, scale: 1, duration: .22, ease: "power2.out" });
    return pop;
  }
  function paintCard(card, animate) {
    const k = card.dataset.card, from = +(card.querySelector("[data-cv]")?.dataset.cv || 0);
    card.innerHTML = cardInner(k);
    card.setAttribute("aria-label", `${CARDS[k].label}, ${TF[tfOf(k)]}. Change the time frame for all cards`);
    const b = card.querySelector("[data-cv]"), to = b.dataset.cv === "" ? null : +b.dataset.cv;
    if (to != null && animate && !RM()) { const o = { v: from || 0 }; gsap.to(o, { v: to, duration: .7, ease: "power2.out", onUpdate: () => b.textContent = CARDS[k].fmt(o.v), onComplete: () => b.textContent = CARDS[k].fmt(to) }); }
    if (animate && !RM()) gsap.fromTo(card.querySelectorAll("small, .st-tf"), { opacity: 0, y: 4 }, { opacity: 1, y: 0, duration: .3, stagger: .05 });
    wireCard(card);
  }
  function wireCard(card) {
    const k = card.dataset.card;
    card.querySelector(".st-i").onclick = e => {
      e.stopPropagation();
      if (card.querySelector(".st-pop.info")) return closePops();
      const pop = openPop(card, `<b>${esc(CARDS[k].label)}</b><p>${esc(CARDS[k].info)}</p>`, "info");
      pop.setAttribute("role", "note"); e.currentTarget.setAttribute("aria-expanded", "true");
    };
  }
  function wireCards(first) {
    document.querySelectorAll(".st-card").forEach(card => {
      wireCard(card);
      const open = () => {
        if (card.querySelector(".st-pop.menu")) return closePops();
        const k = card.dataset.card, cur = tfOf(k);
        const pop = openPop(card, Object.entries(TF).map(([t, l]) => `<button type="button" role="menuitemradio" aria-checked="${t === cur}" data-tf="${t}">${esc(l)}</button>`).join(""), "menu");
        pop.setAttribute("role", "menu");
        pop.querySelectorAll("[data-tf]").forEach(b => b.onclick = e => {
          e.stopPropagation(); tfAll = b.dataset.tf; try { localStorage.setItem("a1-sessions-tf", tfAll); } catch {}
          closePops();
          document.querySelectorAll(".st-card").forEach((c, i) => setTimeout(() => paintCard(c, true), RM() ? 0 : i * 60));
          repaintCharts();
          card.focus();
        });
        (pop.querySelector("[aria-checked=true]") || pop.querySelector("button")).focus();
      };
      card.onclick = e => { if (!e.target.closest(".st-pop, .st-i")) open(); };
      card.onkeydown = e => {
        if ((e.key === "Enter" || e.key === " ") && e.target === card) { e.preventDefault(); open(); }
        if (e.key === "Escape") { closePops(); card.focus(); }
        if (["ArrowDown", "ArrowUp"].includes(e.key) && e.target.closest(".st-pop.menu")) {
          e.preventDefault(); const bs = [...card.querySelectorAll(".st-pop.menu button")], i = bs.indexOf(document.activeElement);
          bs[(i + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length].focus();
        }
      };
    });
    if (!wireCards.doc) { wireCards.doc = true; document.addEventListener("click", e => { if (!e.target.closest(".st-card")) closePops(); }); }
    document.querySelectorAll(".st-card").forEach(card => {
      const b = card.querySelector("[data-cv]"), k = card.dataset.card, to = b.dataset.cv === "" ? null : +b.dataset.cv;
      if (to == null || !first || RM()) return;
      const o = { v: 0 }; gsap.to(o, { v: to, duration: .9, ease: "power2.out", onUpdate: () => b.textContent = CARDS[k].fmt(o.v), onComplete: () => b.textContent = CARDS[k].fmt(to) });
    });
  }

  /* ---------- agents: scripted runs, kept apart from your own work ---------- */
  const FAIL = { model_not_supported: "the model it asks for isn't available on this sign-in", rate_limited: "rate limited or out of quota",
    auth: "not signed in, or the sign-in was refused", server_error: "the provider's servers errored", not_found: "the API answered 404", other: "another error" };
  const dateOf = iso => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  function agentSpark(daily) {
    if (!daily?.length) return "";
    const W = 360, H = 46, n = daily.length, max = Math.max(...daily.map(d => d.runs), 1), bw = W / n;
    return `<svg class="st-aspark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Agent runs per day, failed runs in red">${daily.map((d, i) => {
      const h = d.runs / max * (H - 4), f = d.failed / max * (H - 4), x = (i * bw).toFixed(1), w = Math.max(1, bw - 1).toFixed(1);
      return `<rect x="${x}" y="${(H - h).toFixed(1)}" width="${w}" height="${(h - f).toFixed(1)}" fill="var(--mute)" opacity=".55"><title>${esc(d.day)}: ${d.runs} runs, ${d.failed} failed</title></rect><rect x="${x}" y="${(H - f).toFixed(1)}" width="${w}" height="${f.toFixed(1)}" fill="var(--bad)"><title>${esc(d.day)}: ${d.failed} failed</title></rect>`;
    }).join("")}</svg>`;
  }
  function agentsHtml(a) {
    if (!a?.groups?.length) return "";
    const total = a.groups.reduce((t, g) => t + g.runs, 0);
    return `<div class="section">Agents <small class="st-hint">scripted runs, kept out of your numbers above</small></div>
    <div class="st-agents">${agentSpark(a.daily)}${a.groups.map(g => {
      const top = g.failures[0], failing = g.failing_since && g.last_ok !== g.last;
      return `<div class="st-ag${failing ? " bad" : ""}"><div><b>${esc(g.harness === "unlabeled" ? g.app : g.harness)}</b> <span class="st-hint">on ${esc(g.host)} · ${esc(g.app)}</span></div>
        <div class="st-agn">${g.runs.toLocaleString()} runs · ${g.failed.toLocaleString()} failed${g.tokens ? ` · ${big(g.tokens)} tokens` : ""} · ${esc(dateOf(g.first))} to ${esc(dateOf(g.last))}</div>
        ${failing ? `<div class="st-agf">Every run has failed since ${esc(dateOf(g.failing_since))}${top ? `: ${esc(FAIL[top.kind] || top.kind)}` : ""}.${g.last_ok ? ` Last run that worked: ${esc(dateOf(g.last_ok))}.` : ""}</div>` : ""}</div>`;
    }).join("")}<div class="st-hint">${total.toLocaleString()} agent runs in all. Last 120 days above: grey worked, red failed.</div></div>`;
  }

  async function load(call) { data = await call("/api/sessions"); return data; }


  /* ---------- chart + tool grid follow the cards' time frame ---------- */
  const GRAIN = { day: "hour", week: "day", month: "day", quarter: "week", lastq: "week", ytd: "week", all: "month" };
  function floorTo(g, t) {
    const d = new Date(t); d.setMinutes(0, 0, 0);
    if (g !== "hour") d.setHours(0);
    if (g === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    if (g === "month") d.setDate(1);
    return d.getTime();
  }
  function stepOn(g, t) { const d = new Date(t); if (g === "hour") d.setHours(d.getHours() + 1); else if (g === "day") d.setDate(d.getDate() + 1); else if (g === "week") d.setDate(d.getDate() + 7); else d.setMonth(d.getMonth() + 1); return d.getTime(); }
  function periodEnd(tf, start) { const d = new Date(start); if (tf === "day") d.setDate(d.getDate() + 1); if (tf === "week") d.setDate(d.getDate() + 7); if (tf === "month") d.setMonth(d.getMonth() + 1); if (tf === "quarter") d.setMonth(d.getMonth() + 3); return d.getTime(); }
  function bucketLabel(g, t, tf) {
    const d = new Date(t);
    if (g === "hour") { const h = d.getHours(); return { label: `${h % 12 || 12}${h < 12 ? "a" : "p"}`, title: d.toLocaleString([], { weekday: "short", hour: "numeric" }) }; }
    if (g === "day") return { label: tf === "week" ? d.toLocaleDateString([], { weekday: "short" }) : String(d.getDate()), title: d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) };
    if (g === "week") return { label: d.toLocaleDateString([], { month: "short", day: "numeric" }), title: "Week of " + d.toLocaleDateString([], { month: "short", day: "numeric" }) };
    return { label: d.toLocaleDateString([], { month: "short" }) + (d.getMonth() === 0 ? ` '${String(d.getFullYear()).slice(2)}` : ""), title: d.toLocaleDateString([], { month: "long", year: "numeric" }) };
  }
  function buckets() {
    const tf = tfAll, g = GRAIN[tf], now = Date.now(), rows = data.lite?.rows || [], names = data.lite?.tools || [];
    const rg = periodRange(tf, now);
    const from = floorTo(g, tf === "all" ? (rows[0]?.[0] ?? now) : rg.start);
    // Today, this week, month and quarter show the whole period (later slots stay empty); YTD and all time stop at now;
    // last quarter is the closed quarter.
    const end = tf === "lastq" ? rg.end : tf === "all" || tf === "ytd" ? now + 1 : periodEnd(tf, rg.start);
    const out = [];
    for (let t = from; t < end && out.length < 400; t = stepOn(g, t)) out.push({ start: t, ...bucketLabel(g, t, tf), sessions: 0, turns: 0, edits: 0, errors: 0,
      active_minutes: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0, tool_calls: 0, toolMap: {} });
    let i = 0;
    for (const r of rows) {
      if (r[0] < from || r[0] >= end || (tf === "lastq" && r[0] < rg.start)) continue;
      while (i + 1 < out.length && out[i + 1].start <= r[0]) i++;
      const b = out[i];
      b.sessions++; b.turns += r[3]; b.edits += r[4]; b.errors += r[5]; b.active_minutes += r[6];
      b.tokens_in += r[7]; b.tokens_out += r[8]; b.tokens_cache_read += r[9]; b.tokens_cache_write += r[10]; b.tool_calls += r[11];
      for (const [ti, c] of r[12] || []) { const n = names[ti]; if (n) b.toolMap[n] = (b.toolMap[n] || 0) + c; }
    }
    for (const b of out) {
      b.tools = Object.entries(b.toolMap).map(([name, count]) => ({ name, count }));
      b.tokens_total = b.tokens_in + b.tokens_out + b.tokens_cache_read + b.tokens_cache_write;
      const den = b.tokens_cache_read + b.tokens_in + b.tokens_cache_write;
      b.cache_hit = den ? b.tokens_cache_read / den : null; b.error_rate = b.tool_calls ? b.errors / b.tool_calls : null;
    }
    return { tf, grain: g, list: out };
  }
  const chartTitle = () => `Over time <small class="st-hint">${esc(TF[tfAll])} by ${GRAIN[tfAll]}</small>`;
  const gridTitle = () => `Tool use <small class="st-hint">${esc(TF[tfAll])} by ${GRAIN[tfAll]} · darker = bigger share of that ${GRAIN[tfAll]}'s calls</small>`;
  function repaintCharts() {
    const bk = buckets(), c = document.querySelector("[data-chart]"), g = document.querySelector("[data-grid]");
    if (c) { c.innerHTML = trendSvg(bk.list); grow(c, .5); }
    if (g) { g.innerHTML = toolGrid(bk.list); if (!RM()) gsap.fromTo(g.querySelectorAll(".st-cell"), { opacity: 0 }, { opacity: 1, duration: .25, stagger: { amount: .35 } }); }
    document.querySelectorAll("[data-ctitle]").forEach(e => e.innerHTML = chartTitle());
    document.querySelectorAll("[data-gtitle]").forEach(e => e.innerHTML = gridTitle());
    document.querySelectorAll("[data-ptitle]").forEach(e => e.innerHTML = profileTitle());
    const pl = document.querySelector("[data-profile]");
    if (pl) { pl.innerHTML = profileLists(); animateLists(pl); if (!RM()) gsap.fromTo(pl.querySelectorAll(".st-list"), { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .3, stagger: .04 }); }
  }


  /* ---------- full transcripts: switch, list, reader ---------- */
  let txList = null, txActor = "you";
  function txSwitch(d) {
    if (!d.connect?.on) return "";
    const on = !!d.connect.transcripts, t = d.transcripts || {};
    return `<div class="st-tx-switch"><button type="button" class="st-switch" role="switch" aria-checked="${on}" data-tx="${on ? "off" : "on"}"><i></i></button>
      <div><b>Full transcripts</b> <span class="st-hint">${on ? `on · ${(t.n || 0).toLocaleString()} stored · ${big(t.bytes || 0)}B${t.redacted ? ` · ${t.redacted.toLocaleString()} credentials redacted` : ""}` : "off"}</span>
      <div class="st-hint">${on ? "Every session's full log goes to your private R2 bucket: prompts, replies, code, paths. Anything shaped like an API key, token or private key is replaced with [redacted:credential] on the Mac first."
        : "Keep the whole conversation, not just counts, so you can reread any session here. Stored in your private R2 bucket; credentials are scrubbed on the Mac before upload."}</div></div></div>`;
  }
  function txRows() {
    const rows = txList?.sessions;
    return !rows ? `<div class="empty">Loading…</div>` : !rows.length ? `<div class="empty">No sessions yet.</div>` : rows.map(r => `
      <button type="button" class="st-txrow" data-txopen="${esc(r.source)}:${esc(r.digest)}"${r.transcript_bytes ? "" : " disabled"}>
        <span>${esc(new Date(r.first_event).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</span>
        <span>${esc(r.app || r.source)}${r.harness ? ` · ${esc(r.harness)}` : ""} <small>${esc(r.host)}</small></span>
        <span>${r.turns} prompts · ${big(r.tokens || 0)} tokens${r.failure ? ` · <em class="bad">${esc(r.failure.replace(/_/g, " "))}</em>` : ""}</span>
        <span class="st-hint">${r.transcript_bytes ? `${big(r.transcript_bytes)}B · read ›` : data.connect?.transcripts ? "not uploaded yet" : "summary only"}</span>
      </button>`).join("");
  }
  function txHtml() {
    if (!data.connect?.on) return "";
    return `<div class="section">Transcripts <small class="st-hint">newest first</small></div>
    <div class="tabs st-txtabs">${["you", "agent"].map(a => `<button class="tab" data-txactor="${a}" aria-pressed="${a === txActor}">${a === "you" ? "Your sessions" : "Agent runs"}</button>`).join("")}</div>
    <div class="st-txlist" data-txlist>${txRows()}</div>`;
  }
  async function loadTx(call) {
    txList = await call(`/api/sessions/list?actor=${txActor}&limit=60`);
    const el = document.querySelector("[data-txlist]");
    if (el) { el.innerHTML = txRows(); wireTx(call); if (!RM()) gsap.fromTo(el.querySelectorAll(".st-txrow"), { opacity: 0, y: 4 }, { opacity: 1, y: 0, duration: .2, stagger: { amount: .3 } }); }
  }

  // Claude Code: {type: user|assistant, message: {content}}. Codex: {type: response_item|event_msg, payload}.
  function parseTranscript(text) {
    const out = [];
    const clip = (v, n = 4000) => { const t = typeof v === "string" ? v : JSON.stringify(v, null, 1); return t.length > n ? t.slice(0, n) + `\n… ${(t.length - n).toLocaleString()} more characters` : t; };
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const ts = o.timestamp;
      if (o.type === "user" || o.type === "assistant") {
        const c = o.message?.content, side = o.message?.role || o.type;
        if (o.isMeta) continue;
        if (typeof c === "string") { out.push({ kind: side, text: c, ts }); continue; }
        for (const part of Array.isArray(c) ? c : []) {
          if (part.type === "text" && part.text?.trim()) out.push({ kind: side, text: part.text, ts });
          else if (part.type === "tool_use") out.push({ kind: "tool", name: part.name, text: clip(part.input), ts });
          else if (part.type === "tool_result") out.push({ kind: "result", error: !!part.is_error, text: clip(Array.isArray(part.content) ? part.content.map(x => x.text || "").join("\n") : part.content), ts });
        }
      } else if (o.type === "response_item") {
        const p = o.payload || {};
        if (p.type === "message") {
          const t = (p.content || []).map(x => x.text || "").join("\n").trim();
          if (t && !(p.role === "user" && /^<(environment_context|user_instructions|permissions)/.test(t)) && p.role !== "developer" && p.role !== "system") out.push({ kind: p.role === "user" ? "user" : "assistant", text: t, ts });
        } else if (p.type === "function_call" || p.type === "custom_tool_call") out.push({ kind: "tool", name: p.name, text: clip(p.arguments ?? p.input), ts });
        else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") out.push({ kind: "result", text: clip(p.output), ts });
        else if (p.type === "local_shell_call") out.push({ kind: "tool", name: "shell", text: clip((p.action?.command || []).join(" ")), ts });
      } else if (o.type === "event_msg" && o.payload?.type === "task_complete" && o.payload.error) {
        out.push({ kind: "error", text: clip(o.payload.error), ts });
      }
    }
    return out;
  }
  async function openTranscript(id, call) {
    const [source, digest] = id.split(":"), row = (txList?.sessions || []).find(r => r.digest === digest);
    const shade = document.createElement("div"); shade.className = "st-reader-shade";
    shade.innerHTML = `<div class="st-reader" role="dialog" aria-modal="true" aria-label="Transcript"><header><div><b>${esc(row?.app || source)}</b> <span class="st-hint">${esc(row?.host || "")} · ${row ? esc(new Date(row.first_event).toLocaleString()) : ""}</span></div>
      <input type="search" placeholder="Find in transcript" aria-label="Find in transcript" data-find><button type="button" class="btn" data-close>Close</button></header><div class="st-msgs" data-msgs><div class="empty">Loading…</div></div></div>`;
    document.body.appendChild(shade);
    const close = () => { if (!RM()) gsap.to(shade, { opacity: 0, duration: .15, onComplete: () => shade.remove() }); else shade.remove(); document.removeEventListener("keydown", esc_); };
    const esc_ = e => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", esc_);
    shade.onclick = e => { if (e.target === shade || e.target.closest("[data-close]")) close(); };
    if (!RM()) gsap.fromTo(shade.querySelector(".st-reader"), { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: .3, ease: "power3.out" });
    shade.querySelector("[data-close]").focus();
    try {
      const r = await fetch(`/api/sessions/transcript?source=${encodeURIComponent(source)}&digest=${digest}`, { credentials: "same-origin", headers: token ? { authorization: "Bearer " + token } : {} });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Couldn't load it (${r.status}).`);
      const msgs = parseTranscript(await r.text());
      const box = shade.querySelector("[data-msgs]");
      const LABEL = { user: "You", assistant: "Assistant", tool: "Tool call", result: "Result", error: "Error" };
      box.innerHTML = msgs.length ? msgs.map(m => m.kind === "tool" || m.kind === "result"
        ? `<details class="st-m ${m.kind}${m.error ? " bad" : ""}"><summary>${LABEL[m.kind]}${m.name ? ` · <code>${esc(m.name)}</code>` : ""}${m.error ? " · failed" : ""}</summary><pre>${esc(m.text)}</pre></details>`
        : `<div class="st-m ${m.kind}"><div class="st-mh">${LABEL[m.kind]}${m.ts ? ` <span class="st-hint">${esc(new Date(m.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</span>` : ""}</div><div class="st-mt">${esc(m.text)}</div></div>`).join("")
        : `<div class="empty">Nothing readable in this transcript.</div>`;
      if (!RM()) gsap.fromTo(box.querySelectorAll(".st-m"), { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .25, stagger: { amount: .5 } });
      shade.querySelector("[data-find]").oninput = e => {
        const q = e.target.value.trim().toLowerCase();
        box.querySelectorAll(".st-m").forEach(m => { const hit = !q || m.textContent.toLowerCase().includes(q); m.style.display = hit ? "" : "none"; if (q && hit && m.tagName === "DETAILS") m.open = true; });
      };
    } catch (e) { shade.querySelector("[data-msgs]").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  function wireTx(call) {
    document.querySelectorAll("[data-txopen]").forEach(b => b.onclick = () => openTranscript(b.dataset.txopen, call));
    document.querySelectorAll("[data-txactor]").forEach(b => b.onclick = () => { txActor = b.dataset.txactor; txList = null;
      document.querySelectorAll("[data-txactor]").forEach(x => x.setAttribute("aria-pressed", x === b)); loadTx(call); });
  }

  function trendSvg(hist) {
    const m = METRICS[metric], W = 720, H = 180, pad = 26, n = hist.length;
    if (!n) return "";
    const bw = (W - pad) / n;
    const val = w => m.stack ? m.stack.reduce((t, [k]) => t + (w[k] || 0), 0) : m.get ? m.get(w) : w[m.key] || 0;
    const max = Math.max(...hist.map(w => val(w) || 0), 1e-9);
    const bars = hist.map((w, i) => {
      const x = pad + i * bw + 2, width = Math.max(2, bw - 4);
      let y = H - 18;
      const segs = (m.stack || [[m.key || "v", m.label, "var(--brand)"]]).map(([k, , col]) => {
        const v = m.stack ? w[k] || 0 : val(w), h = v / max * (H - 34);
        y -= h;
        return `<rect class="tb" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="${h.toFixed(1)}" fill="${col}" rx="1.5"><title>${esc(w.title || w.week)} · ${esc(m.stack ? k.replace("tokens_", "").replace("_", " ") : m.label)}: ${esc(m.fmt(v))}</title></rect>`;
      }).join("");
      const lbl = i % Math.ceil(n / 8) === 0 ? `<text x="${(x + width / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle">${esc(w.label || new Date(w.week + "T00:00:00Z").toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" }))}</text>` : "";
      return segs + lbl;
    }).join("");
    return `<svg class="st-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.label)} over ${esc(TF[tfAll])}">
      <text x="0" y="12">${esc(m.fmt(max))}</text><line x1="${pad}" x2="${W}" y1="${H - 18}" y2="${H - 18}" stroke="var(--line)"/>${bars}</svg>
      ${m.stack ? `<div class="st-legend">${m.stack.map(([, l, c]) => `<span><i style="background:${c}"></i>${esc(l)}</span>`).join("")}</div>` : ""}`;
  }

  // Tool share per week: which tools you lean on, and how that shifts.
  function toolGrid(hist) {
    const recent = hist;
    const tot = {};
    for (const w of recent) for (const t of w.tools) tot[t.name] = (tot[t.name] || 0) + t.count;
    const names = Object.entries(tot).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n]) => n);
    if (!names.length) return "";
    return `<div class="st-grid" style="--cols:${recent.length}"><span></span>${recent.map((w, i) => `<span class="st-wk">${recent.length > 16 && i % Math.ceil(recent.length / 12) ? "" : esc(w.label)}</span>`).join("")}
      ${names.map(n => `<span class="st-tool" title="${esc(n)}">${esc(n)}</span>${recent.map(w => {
        const c = (w.tools.find(t => t.name === n) || {}).count || 0, share = w.tool_calls ? c / w.tool_calls : 0;
        return `<span class="st-cell" style="--a:${Math.min(1, share * 2.5).toFixed(2)}" title="${esc(n)} · ${esc(w.title)}: ${c} calls (${pct(share)})"></span>`;
      }).join("")}`).join("")}</div>`;
  }

  // Your work for the cards' time frame: languages and LLMs by count, libraries, packages, models and apps by sessions, tools by calls.
  function profileFor() {
    const rows = data.lite?.rows || [], names = data.lite?.names || [], tools = data.lite?.tools || [];
    const rg = periodRange(tfAll), m = { languages: {}, libraries: {}, packages: {}, models: {}, tools: {}, llms: {}, apps: {} };
    const add = (k, i, n = 1) => { const name = names[i]; if (name) m[k][name] = (m[k][name] || 0) + n; };
    for (const r of rows) {
      if (r[0] < rg.start || r[0] >= rg.end) continue;
      const q = r[13] || {};
      add("apps", q.a);
      for (const [i, c] of q.l || []) add("languages", i, c);
      for (const i of q.i || []) add("libraries", i);
      for (const i of q.p || []) add("packages", i);
      for (const i of q.m || []) add("models", i);
      for (const [i, c] of q.g || []) add("llms", i, c);
      for (const [i, c] of r[12] || []) { const n = tools[i]; if (n) m.tools[n] = (m.tools[n] || 0) + c; }
    }
    const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
    return { languages: top(m.languages, 10), libraries: top(m.libraries, 15), packages: top(m.packages, 15), models: top(m.models, 10),
      tools: top(m.tools, 12), llms: top(m.llms, 8), apps: top(m.apps, 6) };
  }
  const profileTitle = () => `Your work <small class="st-hint">${esc(TF[tfAll])}</small>`;
  function profileLists() {
    const pr = profileFor();
    const html = list("Languages", pr.languages) + list("Libraries", pr.libraries) + list("Packages", pr.packages) + list("Hugging Face models", pr.models)
      + list("Tools", pr.tools) + list("LLMs", pr.llms) + list("Apps", pr.apps);
    return html || `<div class="empty">No sessions ${tfAll === "day" ? "today" : "in this period"} yet.</div>`;
  }
  function animateLists(el) { el.querySelectorAll(".st-row u").forEach(u => gsap.fromTo(u, { width: 0 }, { width: (u.dataset.w * 100) + "%", duration: RM() ? 0 : .7, ease: "power3.out" })); }

  function list(title, rows) {
    if (!rows?.length) return "";
    const max = rows[0].count || 1;
    return `<div class="st-list"><div class="st-lt">${esc(title)}</div>${rows.map(r => `<div class="st-row"><span title="${esc(r.name)}">${esc(r.name)}</span><b>${big(r.count)}</b><i><u data-w="${(r.count / max).toFixed(3)}"></u></i></div>`).join("")}</div>`;
  }

  // Weekly alerts (Monday cron): last week against the 4 before it. Flagged cards first.
  const ALERTS = {
    tokens: { label: "Tokens", fmt: big },
    cache_hit: { label: "Cache hit", fmt: pct, pts: true },
    error_rate: { label: "Error rate", fmt: pct, pts: true },
    tokens_per_prompt: { label: "Tokens / prompt", fmt: big },
    new_tools: { label: "New tools", fmt: v => String(v), names: true },
    new_llms: { label: "New LLMs", fmt: v => String(v), names: true },
  };
  function alertsHtml(a) {
    if (!a?.rows?.length) return "";
    const rows = a.rows.filter(r => ALERTS[r.metric] && r.value != null).sort((x, y) => y.flag - x.flag);
    if (!rows.length) return "";
    const wk = new Date(a.week + "T00:00:00Z").toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
    const card = r => {
      const m = ALERTS[r.metric];
      let vs = "";
      if (m.names) vs = r.detail?.length ? esc(r.detail.join(", ")) : "nothing new";
      else if (r.baseline != null) {
        const d = m.pts ? `${r.value >= r.baseline ? "+" : "−"}${Math.abs(Math.round((r.value - r.baseline) * 100))} pts` : r.change != null ? `${r.change >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(r.change * 100))}%` : "";
        vs = `<em>${d}</em> vs ${esc(m.fmt(r.baseline))} avg`;
      } else vs = "no earlier weeks yet";
      return `<div class="st-ac${r.flag ? ` flag ${esc(r.tone)}` : ""}" title="${m.names ? esc((r.detail || []).join(", ")) : ""}"><span>${esc(m.label)}</span><b data-av="${esc(r.value)}" data-af="${esc(r.metric)}">${esc(m.fmt(r.value))}</b><small>${vs}</small></div>`;
    };
    const n = rows.filter(r => r.flag).length;
    return `<div class="st-alerts"><div class="st-at"><span>Week of ${esc(wk)} ${a.baseline_weeks ? `vs the ${a.baseline_weeks}-week average` : "· first week of data"}</span><span>${n ? `${n} to look at` : "steady week"}</span></div><div class="st-acards">${rows.map(card).join("")}</div></div>`;
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
    return `${alertsHtml(d.alerts)}<div class="sub">Claude and Codex sessions from every Mac running the A1 agent, synced every ${d.every_min} minutes once connected. Only counts and names leave each Mac (tools, commands, languages, packages, models, tokens), checked by the same privacy filter as the Scout connector. No prompts, code, paths or file names. Scout ranks Hugging Face picks against this.</div>
    <div class="a1-cta st-cta">${connectBtn}<span class="a1-cta-note" data-sxnote>${on ? `Connected ${esc(ago(d.connect.at))}. Each Mac checks in every minute and syncs what changed.` : "One click. Each Mac picks it up within a minute; no install, no pairing."}</span></div>
    ${txSwitch(d)}
    ${hosts.length ? `<div class="a1-macs">${hosts.map(h => { const s = h.last_sync; const cls = !s ? "" : s.state === "failed" ? "stale" : "on";
      return `<span class="a1-mac ${cls}" title="${esc(s?.note || h.label)}"><i></i>${esc(String(h.label).split(" · ")[0])} · ${s ? `${s.state === "failed" ? "failed" : "synced"} ${esc(ago(s.finished))}${s.sessions ? ` · ${s.sessions} sessions` : ""}` : "waiting for first sync"}</span>`; }).join("")}</div>` : ""}
    ${t.sessions ? `
    ${cardsHtml()}
    <div class="section" data-ctitle>${chartTitle()}</div>
    <div class="tabs st-metrics">${Object.entries(METRICS).map(([k, m]) => `<button class="tab" data-metric="${k}" aria-pressed="${k === metric}">${esc(m.label)}</button>`).join("")}</div>
    <div class="st-chart" data-chart>${trendSvg(buckets().list)}</div>
    <div class="section" data-gtitle>${gridTitle()}</div>
    <div data-grid>${toolGrid(buckets().list)}</div>
    <div class="section" data-ptitle>${profileTitle()}</div>
    <div class="st-lists" data-profile>${profileLists()}</div>
    ` : `<div class="empty">${on ? "Waiting for the first sync. It starts within a minute on each Mac." : "Nothing synced yet."}</div>`}
    ${txHtml()}
    <div class="section">Sync log</div>
    ${(d.runs || []).length ? `<div class="st-log"><div class="st-lr st-lh"><span>When</span><span>Mac</span><span>Result</span><span>Sessions</span><span>Took</span></div>${d.runs.map(r => `<div class="st-lr ${r.state === "failed" ? "bad" : ""}">
      <span title="${esc(r.finished)}">${esc(ago(r.finished))}</span><span>${esc(r.host)}</span><span>${esc(r.state.replace("_", " "))}${r.trigger !== "loop" ? ` · ${esc(r.trigger)}` : ""}${r.note ? ` · ${esc(r.note)}` : ""}</span>
      <span>${r.sessions || 0}${r.files_scanned ? ` / ${r.files_scanned} files` : ""}</span><span>${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + " s" : "—"}</span></div>`).join("")}</div>` : `<div class="empty">No syncs yet.</div>`}
    ${agentsHtml(d.agents)}`;
  }

  function wire(first, rerender, call) {
    wireTx(call);
    if (data?.connect?.on && !txList) loadTx(call).catch(() => {});
    const sw = document.querySelector("[data-tx]");
    if (sw) sw.onclick = async () => {
      const on = sw.dataset.tx === "on";
      if (on && !confirm("Turn on full transcripts?\n\nEvery Claude and Codex session on your Macs, including prompts, code and file paths, will be stored in your private R2 bucket. Credentials are scrubbed on the Mac first. The first sync uploads your whole history.")) return;
      sw.disabled = true; if (!RM()) gsap.to(sw.querySelector("i"), { x: on ? 18 : 0, duration: .25, ease: "power2.out" });
      try { const r = await call("/api/sessions/transcripts", { method: "POST", body: JSON.stringify({ on }) }); if (!r.ok) throw new Error(r.error); await load(call); rerender(); }
      catch (e) { sw.disabled = false; alert(e.message || "Couldn't change that."); }
    };
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
      const c = document.querySelector("[data-chart]"); c.innerHTML = trendSvg(buckets().list); grow(c, .5);
    });
    grow(document, first ? .9 : .4);
    document.querySelectorAll(".st-row u").forEach(u => gsap.fromTo(u, { width: 0 }, { width: (u.dataset.w * 100) + "%", duration: RM() ? 0 : .8, ease: "power3.out", delay: RM() ? 0 : .1 }));
    wireCards(first);
    if (first && !RM()) gsap.fromTo(".st-ag", { opacity: 0, x: -8 }, { opacity: 1, x: 0, duration: .35, stagger: .06, ease: "power2.out", clearProps: "all" });
    animateAlerts(first);
    if (first && !RM()) gsap.fromTo(".st-list, .st-cell, .st-lr", { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .3, stagger: { amount: .6 }, ease: "power2.out", clearProps: "all" });
    if (data?.connect?.on && !timer) poll(call, rerender, 60000);
  }
  function animateAlerts(first) {
    const cards = document.querySelectorAll(".st-ac");
    if (!cards.length || !first || RM()) return;
    gsap.fromTo(cards, { opacity: 0, y: 10, scale: .97 }, { opacity: 1, y: 0, scale: 1, duration: .45, stagger: .07, ease: "back.out(1.6)", clearProps: "all" });
    document.querySelectorAll(".st-ac [data-av]").forEach(el => {
      const m = ALERTS[el.dataset.af], o = { v: 0 }, to = +el.dataset.av;
      gsap.to(o, { v: to, duration: .9, ease: "power2.out", onUpdate: () => el.textContent = m.fmt(m.pts ? o.v : Math.round(o.v)), onComplete: () => el.textContent = m.fmt(to) });
    });
    // GSAP can't tween var() or color-mix(), so pulse from the card's resolved border colour.
    document.querySelectorAll(".st-ac.flag").forEach((c, i) => {
      const rgb = (getComputedStyle(c).borderLeftColor.match(/\d+(\.\d+)?/g) || [251, 224, 77]).slice(0, 3).join(",");
      gsap.fromTo(c, { boxShadow: `0 0 0 0 rgba(${rgb},.55)` }, { boxShadow: `0 0 0 7px rgba(${rgb},0)`, duration: 1.1, delay: .5 + i * .07, repeat: 1, ease: "power1.out", clearProps: "boxShadow" });
    });
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
