// A1 Bench: measured numbers from `agent.py bench` runs on the Mac. Leaderboards per suite and machine, and a
// blind A/B battle that shows two models' answers to the same task and moves an Elo per suite.
// The Lab reads BenchView.measured() to swap its estimates for real numbers when a model has been benchmarked.
(() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const gb = b => b == null ? "—" : b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : (b / 1e6).toFixed(0) + " MB";
  const ms = v => v == null ? "—" : v >= 1000 ? (v / 1000).toFixed(1) + " s" : Math.round(v) + " ms";
  const RM = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const store = { get: (k, d) => window.__a1store?.get(k, d) ?? d, set: (k, v) => window.__a1store?.set(k, v) };

  const SUITES = {
    "gtm-debug": { label: "GTM debug", blurb: "Tags, triggers, variables and consent: does it fire, and why not." },
    "sql-ga4": { label: "SQL on GA4", blurb: "Plain questions to SQLite over a synthetic GA4-shaped week. Scored by result rows." },
    "html-json": { label: "HTML → JSON", blurb: "Pull fields out of page HTML. Scored against a JSON schema and expected values." },
    "rag-notes": { label: "Notes Q&A", blurb: "Answer from a handful of tracking notes, including when the notes don't say." },
    "asr": { label: "Speech to text", blurb: "Synthetic speech from macOS say. Passes under 15% word error rate." },
    "screen": { label: "Screen clicks", blurb: "Where to click on a described page. Passes when the click lands in the box." },
  };
  // Lab machine ids; anything else shows as reported.
  const MACH = { m1: "M1 Pro 16GB", m4: "M4 16GB", m6: "M6 32GB", m5p: "M5 Pro 64GB" };
  const machLabel = id => MACH[id] || id;

  let data = null, loading = null, err = null;
  let tab = store.get("a1-bench-tab", "board"), suite = store.get("a1-bench-suite", "rag-notes"), machine = store.get("a1-bench-mach", "");
  if (!SUITES[suite]) suite = "rag-notes";             // a suite saved by an older version
  if (tab !== "board" && tab !== "battle") tab = "board";
  let battle = null, reveal = null, bErr = null, bBusy = false;
  let callFn = null, rerenderFn = () => {};

  function load(call) {
    callFn = call || callFn;
    if (!callFn) return Promise.resolve(null);
    loading = callFn("/api/bench/leaderboard").then(d => { data = d; err = null; return d; })
      .catch(e => { err = e.message; return null; }).finally(() => { loading = null; });
    return loading;
  }
  function setData(d) { data = d; }

  // ---------- measured numbers for the Lab ----------
  const median = xs => { const v = xs.filter(x => typeof x === "number" && isFinite(x)).sort((a, b) => a - b); return v.length ? v[(v.length - 1) >> 1] : null; };
  function measured(path, mach) {
    const rows = (data?.rows || []).filter(r => r.model_path === path);
    if (!rows.length) return null;
    const here = rows.filter(r => r.machine === mach);
    return {
      tok_s: median(here.map(r => r.tok_s)), ttft_ms: median(here.map(r => r.ttft_ms)), load_s: median(here.map(r => r.load_s)),
      // memory use barely depends on the Mac, so any machine's peak will do
      peak_rss: Math.max(0, ...rows.map(r => r.peak_rss || 0)) || null,
      machine: here.length ? mach : null, runs: rows.length,
    };
  }
  function suiteResult(path, s) {
    return (data?.rows || []).filter(r => r.model_path === path && r.suite === s).sort((a, b) => b.id - a.id)[0] || null;
  }

  // ---------- rendering ----------
  const rowsFor = () => (data?.rows || []).filter(r => r.suite === suite && (!machine || r.machine === machine));

  function boardHtml() {
    const rows = rowsFor();
    const maxTps = Math.max(1, ...rows.map(r => r.tok_s || 0));
    if (!data) return `<div class="bn-empty">${err ? `Couldn't load the bench: ${esc(err)}` : "Loading measured runs…"}</div>`;
    if (!rows.length) return `<div class="bn-empty"><b>No ${esc(SUITES[suite].label)} runs${machine ? ` on ${esc(machLabel(machine))}` : ""} yet.</b>
      Plug in the A1, then on the Mac: <code>python3 agent/agent.py bench ${esc(suite)}</code> (add <code>--model models/mlx/&lt;name&gt;</code> for one model).</div>`;
    return `<div class="bn-table" role="table" aria-label="${esc(SUITES[suite].label)} leaderboard">
      <div class="bn-tr bn-th" role="row"><span role="columnheader">#</span><span role="columnheader">Model</span><span role="columnheader">Score</span><span role="columnheader">Speed</span>
        <span role="columnheader">First token</span><span role="columnheader">Peak memory</span><span role="columnheader">Load</span><span role="columnheader">Elo</span></div>
      ${rows.map((r, k) => `<div class="bn-tr" role="row" data-run="${r.id}">
        <span class="bn-rank" role="cell">${k + 1}</span>
        <span class="bn-model" role="cell"><b>${esc(r.model)}</b><small>${esc(machLabel(r.machine))} · ${esc(r.runtime || "?")} · ${new Date(r.created).toLocaleDateString()}${r.error ? ` · <em class="bn-bad" title="${esc(r.error)}">error</em>` : ""}</small></span>
        <span class="bn-cell" role="cell" data-label="Score"><i class="bn-bar sc"><b style="width:${(r.score * 100).toFixed(1)}%"></b></i><em data-num="${(r.score * 100).toFixed(0)}">${(r.score * 100).toFixed(0)}</em><small>${r.passed}/${r.total} pass</small></span>
        <span class="bn-cell" role="cell" data-label="Speed"><i class="bn-bar tp"><b style="width:${((r.tok_s || 0) / maxTps * 100).toFixed(1)}%"></b></i><em>${r.tok_s != null ? r.tok_s.toFixed(0) : "—"}</em><small>tok/s</small></span>
        <span class="bn-cell" role="cell" data-label="First token"><em>${ms(r.ttft_ms)}</em></span>
        <span class="bn-cell" role="cell" data-label="Peak memory"><em>${gb(r.peak_rss)}</em></span>
        <span class="bn-cell" role="cell" data-label="Load"><em>${r.load_s != null ? r.load_s.toFixed(1) + " s" : "—"}</em></span>
        <span class="bn-cell" role="cell" data-label="Elo"><em>${r.elo ?? "—"}</em><small>${r.battles ? `${r.battles} battle${r.battles > 1 ? "s" : ""}` : "no battles"}</small></span>
      </div>`).join("")}</div>
      <p class="bn-note">Latest run per model. Score is the mean task score; speed and first token are medians over the suite's tasks, greedy decoding, thinking off. Peak memory is the runner process's high-water mark.</p>`;
  }

  function battleHtml() {
    if (bErr) return `<div class="bn-empty">${esc(bErr)}</div>`;
    if (!battle) return `<div class="bn-empty">${bBusy ? "Picking two answers…" : "Pick a suite to start a battle."}</div>`;
    const side = s => {
      const r = reveal?.[s];
      return `<article class="bn-ans${reveal && reveal.vote === s ? " won" : ""}" data-side="${s}">
        <header><span class="bn-tag">${s.toUpperCase()}</span>${r ? `<b class="bn-name">${esc(r.model)}</b><span class="bn-elo" data-from="${r.elo_before}" data-to="${r.elo_after}">${r.elo_after}</span>
          <small>${r.elo_after >= r.elo_before ? "+" : ""}${r.elo_after - r.elo_before} · scorer: ${r.pass ? "pass" : "fail"}</small>` : `<b class="bn-name">Model ${s.toUpperCase()}</b>`}</header>
        <pre>${esc(battle[s].output)}</pre></article>`;
    };
    return `<div class="bn-task"><span class="bn-kick">Task · ${esc(battle.task.id)}</span><details${battle.task.prompt.length < 600 ? " open" : ""}><summary>Prompt</summary><pre>${esc(battle.task.prompt)}</pre></details></div>
      <div class="bn-duel">${side("a")}<span class="bn-vs" aria-hidden="true">vs</span>${side("b")}</div>
      <div class="bn-votes">${reveal
        ? `<span class="bn-mut">You voted ${reveal.vote === "tie" ? "a tie" : reveal.vote.toUpperCase()}.</span><button type="button" class="bn-btn go" data-next>Next battle →</button>`
        : `<button type="button" class="bn-btn" data-vote="a" ${bBusy ? "disabled" : ""}>← A is better</button><button type="button" class="bn-btn" data-vote="tie" ${bBusy ? "disabled" : ""}>Tie</button>
           <button type="button" class="bn-btn" data-vote="b" ${bBusy ? "disabled" : ""}>B is better →</button><button type="button" class="bn-btn ghost" data-next>Skip</button>`}</div>
      <p class="bn-note">Names stay hidden until you vote. Each battle takes one vote; Elo starts at 1000 and moves up to 32 points.</p>`;
  }

  function html() {
    const counts = Object.fromEntries((data?.suites || []).map(s => [s.id, s.models]));
    const machines = data?.machines || [];
    return `<div class="bn">
      <header class="bn-hero"><span class="bn-kick">Bench · measured on your Macs</span>
        <h2>Which model actually does the job?</h2>
        <p>Every number here came from a real run off the A1: one model loaded at a time, the same synthetic tasks, scored by code. The Lab uses these numbers in place of its estimates once a model has been benchmarked.</p></header>
      <div class="bn-tabs" role="tablist" aria-label="Bench views">
        <button type="button" role="tab" class="bn-tab" data-tab="board" aria-selected="${tab === "board"}">Leaderboard</button>
        <button type="button" role="tab" class="bn-tab" data-tab="battle" aria-selected="${tab === "battle"}">Blind battle</button></div>
      <div class="bn-suites" role="group" aria-label="Suite">${Object.entries(SUITES).map(([id, s]) => `
        <button type="button" class="bn-suite" data-suite="${id}" aria-pressed="${id === suite}"><b>${esc(s.label)}</b><small>${counts[id] ? `${counts[id]} model${counts[id] > 1 ? "s" : ""}` : "no runs"}</small></button>`).join("")}</div>
      <section class="bn-panel">
        <div class="bn-h"><p class="bn-mut">${esc(SUITES[suite].blurb)}</p>
          ${tab === "board" ? `<label class="bn-mach">Mac <select data-mach><option value="">All Macs</option>${machines.map(m => `<option value="${esc(m.machine)}"${m.machine === machine ? " selected" : ""}>${esc(machLabel(m.machine))}</option>`).join("")}</select></label>` : ""}</div>
        ${tab === "board" ? boardHtml() : battleHtml()}
      </section></div>`;
  }

  // ---------- behavior ----------
  async function nextBattle() {
    if (!callFn) return;
    bBusy = true; bErr = null; reveal = null; rerenderFn();
    try {
      const b = await callFn(`/api/bench/battle?suite=${encodeURIComponent(suite)}`);
      if (b.error) { battle = null; bErr = b.error; } else battle = b;
    } catch (e) { bErr = e.message; }
    bBusy = false; rerenderFn(); animateDuel();
  }
  async function vote(v) {
    if (!battle || bBusy || reveal) return;
    bBusy = true;
    const picked = $(`.bn-ans[data-side="${v}"]`);
    if (picked && window.gsap && !RM()) gsap.fromTo(picked, { scale: 1 }, { scale: 1.03, duration: .15, yoyo: true, repeat: 1 });
    try {
      const r = await callFn("/api/bench/battle", { method: "POST", body: JSON.stringify({ id: battle.id, vote: v }) });
      if (r.error) bErr = r.error; else reveal = r;
    } catch (e) { bErr = e.message; }
    bBusy = false; rerenderFn(); animateReveal();
    load().then(() => tab === "board" && rerenderFn());     // fresh Elo for the leaderboard
  }

  function animateBoard(root) {
    if (RM() || !window.gsap) return;
    const rows = $$(".bn-tr:not(.bn-th)", root);
    gsap.from(rows, { y: 10, opacity: 0, duration: .35, stagger: .05, ease: "power2.out", clearProps: "transform,opacity" });
    gsap.from($$(".bn-bar b", root), { scaleX: 0, transformOrigin: "left", duration: .7, stagger: .03, ease: "power3.out", delay: .1 });
    $$("[data-num]", root).forEach(el => { const o = { v: 0 }, to = +el.dataset.num;
      gsap.to(o, { v: to, duration: .8, ease: "power2.out", onUpdate: () => el.textContent = Math.round(o.v) }); });
  }
  function animateDuel() {
    if (RM() || !window.gsap) return;
    const a = $('.bn-ans[data-side="a"]'), b = $('.bn-ans[data-side="b"]');
    if (!a || !b) return;
    gsap.timeline().from(".bn-task", { y: -8, opacity: 0, duration: .3 })
      .from(a, { x: -40, opacity: 0, duration: .45, ease: "power3.out" }, "<.05")
      .from(b, { x: 40, opacity: 0, duration: .45, ease: "power3.out" }, "<")
      .from(".bn-vs", { scale: 0, rotation: -90, duration: .4, ease: "back.out(3)" }, "-=.2")
      .from(".bn-votes .bn-btn", { y: 6, opacity: 0, stagger: .05, duration: .25, clearProps: "all" }, "-=.15");
  }
  function animateReveal() {
    if (RM() || !window.gsap || !reveal) return;
    $$(".bn-ans header").forEach(h => gsap.from(h, { rotationX: -90, transformOrigin: "top", duration: .5, ease: "back.out(1.6)" }));
    $$(".bn-elo").forEach(el => { const o = { v: +el.dataset.from }, to = +el.dataset.to;
      gsap.to(o, { v: to, duration: 1, ease: "power2.out", delay: .25, onUpdate: () => el.textContent = Math.round(o.v) }); });
    const won = $(".bn-ans.won");
    if (won) gsap.fromTo(won, { boxShadow: "0 0 0 0 rgba(251,224,77,.7)" }, { boxShadow: "0 0 0 14px rgba(251,224,77,0)", duration: .9, ease: "power2.out" });
  }

  function wire(first, rerender, call) {
    rerenderFn = rerender; callFn = call || callFn;
    const root = $(".bn"); if (!root) return;
    if (!data && !loading) load().then(rerender);
    $$("[data-tab]", root).forEach(b => b.onclick = () => { tab = b.dataset.tab; store.set("a1-bench-tab", tab); rerender(); if (tab === "battle" && !battle && !bBusy) nextBattle(); else if (tab === "board") animateBoard(root); });
    $$("[data-suite]", root).forEach(b => b.onclick = () => { suite = b.dataset.suite; store.set("a1-bench-suite", suite); battle = null; reveal = null; bErr = null;
      rerender(); if (tab === "battle") nextBattle(); else animateBoard($(".bn")); });
    $("[data-mach]", root)?.addEventListener("change", e => { machine = e.target.value; store.set("a1-bench-mach", machine); rerender(); animateBoard($(".bn")); });
    $$("[data-vote]", root).forEach(b => b.onclick = () => vote(b.dataset.vote));
    $$("[data-next]", root).forEach(b => b.onclick = nextBattle);
    if (first) {
      if (window.gsap && !RM()) gsap.from($$(".bn-hero > *, .bn-tab, .bn-suite", root), { y: 12, opacity: .2, duration: .4, stagger: .03, ease: "power2.out", clearProps: "transform,opacity" });
      if (tab === "board") animateBoard(root);
      else if (!battle && !bBusy) nextBattle();
      else animateDuel();
    }
  }

  window.BenchView = { html, wire, load, setData, measured, suiteResult, suites: SUITES, machLabel };

  const css = document.createElement("style");
  css.textContent = `
  .bn{display:grid;gap:14px}
  .bn-kick{font:500 11px "IBM Plex Mono",monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
  .bn-mut{color:var(--mute);font-size:13px;margin:0}
  .bn-hero{border:1px solid var(--line);border-radius:12px;padding:22px 22px 18px;background:linear-gradient(180deg,color-mix(in srgb,var(--brand) 6%,var(--panel)),var(--panel))}
  .bn-hero h2{font:600 clamp(22px,3.4vw,32px)/1.15 "IBM Plex Mono",monospace;margin:8px 0}
  .bn-hero p{font:16px/1.6 "Source Serif 4",Georgia,serif;color:var(--mute);margin:0;max-width:66ch}
  .bn-tabs{display:flex;gap:6px}
  .bn-tab{all:unset;box-sizing:border-box;cursor:pointer;padding:7px 14px;border:1px solid var(--line);border-radius:999px;font:500 13px "IBM Plex Mono",monospace;min-height:36px;display:inline-flex;align-items:center}
  .bn-tab[aria-selected=true]{background:var(--brand);color:var(--on-brand);border-color:var(--brand)}
  .bn-suites{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
  .bn-suite{all:unset;box-sizing:border-box;cursor:pointer;display:grid;gap:3px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
  .bn-suite b{font:600 13px "IBM Plex Mono",monospace}.bn-suite small{color:var(--mute);font-size:12px}
  .bn-suite[aria-pressed=true]{border-color:var(--brand);box-shadow:0 0 0 1px var(--brand) inset}
  .bn-tab:focus-visible,.bn-suite:focus-visible,.bn-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .bn-panel{border:1px solid var(--line);border-radius:12px;padding:16px;background:var(--panel);min-width:0}
  .bn-h{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:12px}
  .bn-mach{font:500 12px "IBM Plex Mono",monospace;display:flex;gap:8px;align-items:center}
  .bn-mach select{padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);min-height:36px}
  .bn-empty{padding:18px;border:1px dashed var(--line);border-radius:10px;color:var(--mute);font-size:14px;line-height:1.6}
  .bn-empty b{color:var(--ink);display:block;margin-bottom:4px}
  .bn-empty code,.bn-note code{font:12.5px "IBM Plex Mono",monospace;background:var(--chip);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
  .bn-table{display:grid;gap:4px}
  .bn-tr{display:grid;grid-template-columns:28px minmax(150px,1.6fr) minmax(120px,1.2fr) minmax(110px,1fr) 80px 90px 60px 80px;gap:10px;align-items:center;padding:9px 10px;border:1px solid var(--line);border-radius:8px}
  .bn-th{border:0;padding-bottom:0;font:500 11px "IBM Plex Mono",monospace;color:var(--mute);text-transform:uppercase;letter-spacing:.06em}
  .bn-rank{font:600 15px "IBM Plex Mono",monospace;color:var(--accent)}
  .bn-model b{font:600 13px "IBM Plex Mono",monospace;overflow-wrap:anywhere;display:block}.bn-model small{color:var(--mute);font-size:11.5px}
  .bn-cell{display:grid;grid-template-columns:auto 1fr;column-gap:6px;align-items:baseline;min-width:0}
  .bn-cell em{font:600 14px "IBM Plex Mono",monospace;font-style:normal;font-variant-numeric:tabular-nums}
  .bn-cell small{color:var(--mute);font-size:11px}
  .bn-bar{grid-column:1/-1;display:block;height:6px;border-radius:3px;background:var(--chip);overflow:hidden;margin-bottom:4px}
  .bn-bar b{display:block;height:100%;border-radius:3px}.bn-bar.sc b{background:var(--accent)}.bn-bar.tp b{background:#6cc4f2}
  .bn-bad{color:var(--bad);font-style:normal}
  .bn-note{color:var(--mute);font-size:12.5px;margin:12px 0 0;line-height:1.5}
  @media(max-width:820px){
    .bn-th{display:none}
    .bn-tr{grid-template-columns:28px minmax(0,1fr) minmax(0,1fr);row-gap:8px;align-items:start}
    .bn-model{grid-column:2/-1}
    .bn-cell::before{content:attr(data-label);grid-column:1/-1;font:500 10.5px "IBM Plex Mono",monospace;color:var(--mute);text-transform:uppercase}
    .bn-tr>.bn-cell:nth-child(odd){grid-column:2}.bn-tr>.bn-cell:nth-child(even){grid-column:3}}
  .bn-task{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:12px;background:var(--bg)}
  .bn-task summary{cursor:pointer;font:500 12px "IBM Plex Mono",monospace;color:var(--mute);margin-top:4px}
  .bn pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.5 "IBM Plex Mono",monospace;margin:8px 0 0;max-height:340px;overflow:auto}
  .bn-duel{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:10px;align-items:stretch}
  @media(max-width:720px){.bn-duel{grid-template-columns:1fr}.bn-vs{justify-self:center}}
  .bn-ans{border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--bg);min-width:0;perspective:600px}
  .bn-ans header{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline}
  .bn-ans.won{border-color:var(--brand);box-shadow:0 0 0 1px var(--brand) inset}
  .bn-tag{font:700 12px "IBM Plex Mono",monospace;background:var(--chip);border:1px solid var(--line);border-radius:6px;padding:1px 7px}
  .bn-name{font:600 13px "IBM Plex Mono",monospace;overflow-wrap:anywhere}
  .bn-elo{font:700 16px "IBM Plex Mono",monospace;color:var(--accent);font-variant-numeric:tabular-nums}
  .bn-ans small{color:var(--mute);font-size:12px}
  .bn-vs{align-self:center;font:700 13px "IBM Plex Mono",monospace;color:var(--mute);text-transform:uppercase}
  .bn-votes{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}
  .bn-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:8px 14px;border:1px solid var(--line);border-radius:8px;font:600 13px "IBM Plex Mono",monospace;min-height:40px;display:inline-flex;align-items:center}
  .bn-btn:hover{border-color:var(--brand)}.bn-btn[disabled]{opacity:.5;cursor:default}
  .bn-btn.go{background:var(--brand);color:var(--on-brand);border-color:var(--brand)}
  .bn-btn.ghost{margin-left:auto;color:var(--mute)}
  `;
  document.head.appendChild(css);
})();
