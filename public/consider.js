// Considering a Mac: is a Mac from RAM Scout worth buying for the work this A1 does?
// RAM Scout's "Test in A1 Scout" link (?view=bench#ram-scout-macs=…, read by ram-scout-macs.js) brings the Macs.
// Bench then runs every simulated workflow on the chosen Mac as a hypothetical, next to the Macs you own, with the
// stack Simulate starts from (LabView.consider). Speeds scale your measured runs by Apple's published memory
// bandwidth; nothing has run on that Mac. Pure verdict logic is exported for tests (ConsiderView.verdict/summary).
(() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const gb = b => b == null ? "?" : (b / 1e9).toFixed(1) + " GB";
  const secs = s => s < 1 ? `${Math.round(s * 1000)} ms` : s < 90 ? `${s.toFixed(1)} s` : `${(s / 60).toFixed(1)} min`;
  const money = n => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const RM = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const store = { get: (k, d) => window.__a1store?.get(k, d) ?? d, set: (k, v) => window.__a1store?.set(k, v) };

  const test = (e, id) => e?.tests?.find(t => t.id === id)?.st;
  const fits = e => test(e, "fit") === "pass";
  const inTime = e => !!e && !e.noSpeed && test(e, "budget") === "pass";

  // One workflow: what the weighed Mac changes compared with the best Mac you own.
  function verdict(r) {
    const c = r.cand, o = r.bestOwned;
    if (!c || !c.stages?.length) return { kind: "na", text: "Nothing on the A1 for this workflow yet" };
    if (!fits(c)) return { kind: "worse", text: o && fits(o) ? "Today's stack doesn't fit in its memory" : "Today's stack doesn't fit here either" };
    if (r.bigger && !r.bigger.fitsOwned.length) return { kind: "unlock", text: `Runs ${r.bigger.item.name} (${gb(r.bigger.need)}), too big for your Macs` };
    if (!o || !fits(o)) return { kind: "unlock", text: "Runs today's stack; none of your Macs can" };
    if (inTime(c) && !o.noSpeed && !inTime(o)) return { kind: "budget", text: `Meets the ${secs(r.budget)} target your Macs miss` };
    if (c.noSpeed) return { kind: "unknown", text: "Fits; no speed estimate (Apple's bandwidth figure wasn't captured)" };
    const x = o.total / Math.max(c.total, 1e-6);
    if (x >= 1.25) return { kind: "faster", text: `${x.toFixed(1)}× faster than your ${o.mach.label}`, x };
    if (x <= 0.8) return { kind: "slower", text: `${(1 / x).toFixed(1)}× slower than your ${o.mach.label}`, x };
    return { kind: "same", text: `About the same as your ${o.mach.label}`, x };
  }

  // The whole set: does it open up work your Macs can't do, only speed it up, or change little? The math and wording
  // are the shared core's (public/consider-core.js), so the Worker's headline is the same sentence.
  const summary = rows => window.ConsiderCore.summaryOf(rows.map(verdict));

  let rowsCache = null, cacheKey = "";
  function candidates() { return window.RamScoutMacs ? window.RamScoutMacs.list() : []; }
  function chosen() {
    const cs = candidates();
    // ?consider=<machine_id> wins for this visit, then the Mac you last picked, then the first one.
    const want = window.__a1ConsiderOpen || store.get("a1-consider", "");
    return cs.find(m => m.id === want) || cs[0] || null;
  }
  function rowsFor(cand, catalog, picks) {
    const owned = window.LabView.ownedIds();
    const key = [cand.id, owned.join(","), catalog?.generated_at || catalog?.categories?.length || 0, window.BenchView?.loaded?.() ? 1 : 0].join("|");
    if (key !== cacheKey) { rowsCache = window.LabView.consider(catalog, picks, cand.id, owned); cacheKey = key; }
    return rowsCache;
  }

  const cellOwn = o => !o ? `<span class="cz-mute">no stack</span>`
    : !fits(o) ? `<span class="cz-bad">doesn't fit</span>`
    : `${o.noSpeed ? "fits" : secs(o.total)}<small>${esc(o.mach.label)} · ${gb(o.peak)} of ${gb(o.budget)}</small>`;
  const cellCand = c => !c?.stages?.length ? `<span class="cz-mute">—</span>`
    : !fits(c) ? `<span class="cz-bad">doesn't fit</span><small>${gb(c.peak)} of ${gb(c.budget)}</small>`
    : `${c.noSpeed ? "fits" : secs(c.total)}<small>${gb(c.peak)} of ${gb(c.budget)}${c.stages.some(s => s.scaled) ? " · scaled" : c.noSpeed ? "" : " · estimated"}</small>`;

  function html(catalog, picks) {
    if (!window.LabView?.consider) return "";
    const cs = candidates(), cand = chosen();
    if (!cand) return "";
    let rows;
    try { rows = rowsFor(cand, catalog, picks); } catch (e) { return `<section class="cz"><p class="cz-mute">Couldn't simulate ${esc(cand.label)}: ${esc(e.message)}</p></section>`; }
    const s = summary(rows), lo = cand.lowest_observed;
    const bw = window.RamScoutMacs.bandwidth(cand.id);
    const labelOf = id => (window.MachineFit ? window.MachineFit(1, "").find(m => m.id === id)?.label : null) || window.BenchView?.machLabel?.(id) || id;
    const owned = window.LabView.ownedIds().map(labelOf);
    return `<section class="cz cz-${s.tone}" aria-label="Considering a Mac">
      <div class="cz-top">
        <div><span class="bn-kick">Considering a Mac · from RAM Scout</span>
          <h3>${esc(cand.label)}: ${esc(s.head)}</h3>
          <p>${esc(s.sub)}</p>
          <p class="cz-facts">${lo && lo.price != null ? `<span>Seen at <b>${money(lo.price)}</b> ${esc(String(lo.price_basis || "").replace(/_/g, " "))}${lo.observed_at ? ` · ${esc(new Date(lo.observed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }))}` : ""}${lo.item_url ? ` · <a href="${esc(lo.item_url)}" target="_blank" rel="noopener noreferrer">listing ↗</a>` : ""}</span>` : ""}
            <span>${bw ? `${bw.gbs} GB/s memory bandwidth (Apple)` : "No published bandwidth captured: fit only"}</span>
            <span>Compared with ${esc(owned.join(" and "))}</span></p>
        </div>
        ${cs.length > 1 ? `<div class="cz-pick" role="group" aria-label="Mac to consider">${cs.map(m => `<button type="button" class="jb-mode" data-cz-mac="${esc(m.id)}" aria-pressed="${m.id === cand.id}">${esc(m.label)}</button>`).join("")}</div>` : ""}
      </div>
      <div class="cz-table" role="table" aria-label="Workflows on ${esc(cand.label)}">
        <div class="cz-row cz-h" role="row"><span role="columnheader">Workflow</span><span role="columnheader">Your best Mac today</span><span role="columnheader">${esc(cand.label)}</span><span role="columnheader">What changes</span></div>
        ${rows.map(r => { const v = verdict(r); return `<button type="button" class="cz-row cz-${v.kind}" role="row" data-cz-job="${esc(r.tplId)}" title="Open ${esc(r.title)} in Simulate on ${esc(cand.label)}">
          <span role="cell"><b>${esc(r.icon)} ${esc(r.title)}</b>${r.now ? `<small>${esc(r.now.name)}</small>` : ""}</span>
          <span role="cell">${cellOwn(r.bestOwned)}</span>
          <span role="cell">${cellCand(r.cand)}</span>
          <span role="cell" class="cz-v">${esc(v.text)}</span></button>`; }).join("")}
      </div>
      <p class="cz-note">Hypothetical: nothing has run on this Mac. Each workflow uses the stack Simulate starts from; memory must fit in the 75% macOS gives models, and speeds scale your measured runs by Apple's memory bandwidth (estimates from file size where a part has no run). Quality isn't predicted. Pick a row to see the full simulation; run <code>agent.py bench</code> on the Mac once you have it to measure it.</p>
      <div class="cz-actions"><button type="button" class="lab-btn" data-cz-clear>Remove RAM Scout Macs</button></div>
    </section>`;
  }

  function wire(root, rerender, openJob) {
    const box = $(".cz", root); if (!box) return;
    $$("[data-cz-mac]", box).forEach(b => b.onclick = () => { store.set("a1-consider", b.dataset.czMac); rerender(); });
    $$("[data-cz-job]", box).forEach(b => b.onclick = () => {
      const c = chosen(); if (c) window.LabView.focus(b.dataset.czJob, c.id);
      openJob(b.dataset.czJob);
      document.querySelector(".jb-body")?.scrollIntoView({ behavior: RM() ? "auto" : "smooth", block: "start" });
    });
    $("[data-cz-clear]", box)?.addEventListener("click", () => { window.RamScoutMacs.clear(); cacheKey = ""; rerender(); });
    if (window.gsap && !RM()) gsap.from($$(".cz-top > div, .cz-row", box), { y: 10, opacity: .2, duration: .35, stagger: .03, ease: "power2.out", clearProps: "transform,opacity" });
  }

  window.ConsiderView = { html, wire, verdict, summary, active: () => !!chosen() };
  if (typeof document === "undefined" || !document.createElement) return;
  const css = document.createElement("style");
  css.textContent = `.cz{margin:14px 0 18px;padding:16px;border:1px solid var(--line);border-top:3px solid var(--brand);border-radius:12px;background:var(--panel)}
  .cz.cz-bad{border-top-color:var(--mute)}.cz-top{display:flex;gap:12px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}
  .cz h3{margin:4px 0 6px;font:600 clamp(17px,2.3vw,21px)/1.25 "IBM Plex Mono",monospace}.cz p{margin:0 0 6px;max-width:78ch}
  .cz-facts{display:flex;flex-wrap:wrap;gap:4px 14px;color:var(--mute);font-size:12.5px}.cz-facts b{color:var(--ink)}.cz-facts a{color:var(--ink);text-underline-offset:2px}
  .cz-pick{display:flex;gap:6px;flex-wrap:wrap}
  .cz-table{display:grid;margin-top:10px;border-top:1px solid var(--line)}
  .cz-row{all:unset;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.4fr);gap:10px;padding:10px 6px;border-bottom:1px solid var(--line);font-size:13.5px;cursor:pointer}
  .cz-row:hover,.cz-row:focus-visible{background:color-mix(in srgb,var(--brand) 8%,transparent)}.cz-row:focus-visible{outline:2px solid var(--brand);outline-offset:-2px}
  .cz-row small{display:block;color:var(--mute);font-size:11.5px;margin-top:2px;overflow-wrap:anywhere}
  .cz-h{cursor:default;font:600 10.5px "IBM Plex Mono",monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--mute)}.cz-h:hover{background:none}
  .cz-v{font-weight:600}.cz-unlock .cz-v,.cz-budget .cz-v{color:var(--accent)}.cz-faster .cz-v{color:var(--ink)}
  .cz-same .cz-v,.cz-unknown .cz-v,.cz-na .cz-v{color:var(--mute);font-weight:500}.cz-worse .cz-v,.cz-slower .cz-v,.cz-bad{color:var(--bad)}
  .cz-unlock .cz-v::before,.cz-budget .cz-v::before{content:"▲ "}.cz-mute{color:var(--mute)}
  .cz-note{color:var(--mute);font-size:12px;margin-top:10px!important}.cz-actions{margin-top:8px}
  @media (max-width:720px){.cz-row{grid-template-columns:1fr 1fr}.cz-row>span:first-child,.cz-v{grid-column:1/-1}.cz-h{display:none}}`;
  document.head.appendChild(css);
})();
