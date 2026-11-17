// Bench tab: one place per job. "Measured" is what the bench ran on your Macs (leaderboard, best pick, blind battle);
// "Simulate" is the stack builder (the former Lab), which swaps its estimates for those measured numbers automatically.
(() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const RM = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const store = { get: (k, d) => window.__a1store?.get(k, d) ?? d, set: (k, v) => window.__a1store?.set(k, v) };

  // Order: your own loops first, then the general jobs, then simulation-only stacks.
  const ORDER = ["loop", "skills", "gtm-debug", "rag", "scan", "sql", "screen", "voice", "route", "inside"];
  function jobs() {
    const T = window.LabView?.templates || {}, SF = window.LabView?.suiteFor || {}, S = window.BenchView?.suites || {};
    const out = Object.entries(T).map(([id, t]) => ({ id, tpl: id, suite: SF[id] || null, title: t.title, tag: t.tag, icon: t.icon }));
    const covered = new Set(out.map(j => j.suite).filter(Boolean));
    for (const [sid, s] of Object.entries(S)) if (!covered.has(sid)) out.push({ id: sid, tpl: null, suite: sid, title: s.label, tag: "Bench suite", icon: "✓" });
    return out.sort((a, b) => (ORDER.indexOf(a.id) + 99) % 99 - (ORDER.indexOf(b.id) + 99) % 99);
  }
  let job = store.get("a1-job", "loop"), mode = store.get("a1-job-mode", "measured");
  // Old links and saved views: the Lab is now Simulate.
  function openLab() { mode = "simulate"; store.set("a1-job-mode", mode); }

  function html(catalog, picks) {
    const J = jobs();
    let j = J.find(x => x.id === job) || J[0];
    job = j.id;
    let m = mode;
    if (m === "measured" && !j.suite) m = "simulate";
    if (m === "simulate" && !j.tpl) m = "measured";
    const runs = s => (s && window.BenchView?.runCount?.(s)) || 0;
    return `<div class="jb">
      <header class="jb-hero"><span class="bn-kick">Bench · measured and simulated</span>
        <h2>Which model does the job, and what would the whole stack cost?</h2>
        <p>Pick a job. <b>Measured</b> shows real runs off the A1 on your Macs: the leaderboard, the bench's pick for each Mac, and blind battles. <b>Simulate</b> builds the whole stack around it and estimates memory, speed and load time on any Mac, using the measured numbers wherever a part has been benchmarked.</p></header>
      ${window.ConsiderView ? window.ConsiderView.html(catalog, picks) : ""}
      <div class="jb-jobs" role="tablist" aria-label="Jobs">${J.map(x => `
        <button type="button" class="jb-job" role="tab" data-job="${esc(x.id)}" aria-selected="${x.id === j.id}">
          <span class="lab-ic">${esc(x.icon)}</span><b>${esc(x.title)}</b>
          <small>${x.suite ? (runs(x.suite) ? `${runs(x.suite)} measured` : "not run yet") : "simulated only"}${x.tpl ? "" : " · no simulator"}</small></button>`).join("")}</div>
      <div class="jb-modes" role="group" aria-label="View">
        <button type="button" class="jb-mode" data-mode="measured" aria-pressed="${m === "measured"}" ${j.suite ? "" : "disabled"}>Measured</button>
        <button type="button" class="jb-mode" data-mode="simulate" aria-pressed="${m === "simulate"}" ${j.tpl ? "" : "disabled"}>Simulate</button>
        <span class="jb-hint">${m === "measured" ? (j.tpl ? "Real runs. Simulate uses them for this job's stack." : "Real runs. This job has no stack to simulate yet.")
          : (j.suite ? (runs(j.suite) ? "Measured numbers are used where a part has been benchmarked." : `Estimates only until this job is benchmarked: <code>agent.py bench ${esc(j.suite)}</code>.`) : "No bench suite covers this job yet, so everything here is an estimate.")}</span></div>
      <div class="jb-body" data-shown="${m}">${m === "measured" ? window.BenchView.html({ suite: j.suite, embedded: true }) : window.LabView.html(catalog, picks, { tpl: j.tpl, embedded: true })}</div>
    </div>`;
  }

  function wire(first, rerender, call) {
    const root = $(".jb"); if (!root) return;
    $$("[data-job]", root).forEach(b => b.onclick = () => { job = b.dataset.job; store.set("a1-job", job); rerender(); });
    $$("[data-mode]", root).forEach(b => b.onclick = () => { if (b.disabled) return; mode = b.dataset.mode; store.set("a1-job-mode", mode); rerender(); });
    // Considering a Mac (consider.js): a workflow row opens that job in Simulate with the weighed Mac selected.
    window.ConsiderView?.wire(root, rerender, id => { job = id; mode = "simulate"; store.set("a1-job", job); store.set("a1-job-mode", mode); rerender(); });
    if ($(".bn", root)) window.BenchView.wire(first, rerender, call); else window.LabView.wire(first, rerender);
    if (first && window.gsap && !RM()) gsap.from($$(".jb-hero > *, .jb-job", root), { y: 12, opacity: .2, duration: .4, stagger: .025, ease: "power2.out", clearProps: "transform,opacity" });
  }

  window.JobsView = { html, wire, jobs, openLab };
  const css = document.createElement("style");
  css.textContent = `.jb-jobs{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin:14px 0 10px}
  .jb-job{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;padding:10px 12px;border:1px solid var(--line,#3334);border-radius:12px;background:var(--card,transparent);color:inherit;cursor:pointer}
  .jb-job b{font:600 13px/1.25 inherit}.jb-job small{color:var(--mute);font-size:11px}
  .jb-job[aria-selected="true"]{border-color:var(--brand);box-shadow:0 0 0 1px var(--brand) inset}
  .jb-modes{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:4px 0 14px}
  .jb-mode{padding:6px 14px;border-radius:999px;border:1px solid var(--line,#3334);background:transparent;color:inherit;font-weight:600;cursor:pointer}
  .jb-mode[aria-pressed="true"]{background:var(--brand);color:var(--on-brand,#111);border-color:var(--brand)}
  .jb-mode:disabled{opacity:.4;cursor:not-allowed}.jb-hint{color:var(--mute);font-size:12px}
  .jb-hero h2{margin:.2em 0}.jb-hero p{color:var(--mute);max-width:70ch}`;
  document.head.appendChild(css);
})();
