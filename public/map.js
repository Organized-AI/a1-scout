// A1 Drive Map: a learning-first view of everything in stash/.
// Three ways in: "What it does" (grouped by job), "Learning path" (a guided order),
// and "Disk space" (the treemap). Every item opens a detail panel that explains it.
(() => {
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const gb = b => b == null ? "?" : b >= 1e12 ? (b / 1e12).toFixed(2) + " TB" : b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(0) + " MB" : (b / 1e3).toFixed(0) + " KB";
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // Jobs, in the order a newcomer meets them.
  const ROLES = [
    { id: "talk", label: "Talk and write", blurb: "Language models. Chat, draft, summarize, write code, call tools.", types: ["llm", "llm-code", "tool-llm"] },
    { id: "decide", label: "Decide and guard", blurb: "Small models that answer typed questions with calibrated confidence, pick a route, or flag risk. Your Jev primitives, offline.", types: ["decision", "router", "guard"] },
    { id: "predict", label: "Predict numbers", blurb: "Forecast a time series (prices, load, traffic) or predict a column in a table.", types: ["forecaster", "tabular"] },
    { id: "find", label: "Find and match", blurb: "Embeddings and rerankers: search by meaning, pick the right skill or document.", types: ["embedding", "reranker"] },
    { id: "see", label: "See", blurb: "Models that look at images, screenshots and UIs.", types: ["vlm", "ui-agent", "detector"] },
    { id: "pages", label: "Turn pages into data", blurb: "HTML to Markdown, fields to JSON, questions to SQL. The measurement-side helpers.", types: ["html-reader", "extractor", "text-to-sql"] },
    { id: "hear", label: "Hear and speak", blurb: "Speech to text and text to speech.", types: ["asr", "tts"] },
    { id: "create", label: "Make images", blurb: "Image generation weights.", types: ["image-gen"] },
    { id: "data", label: "Data to practice on", blurb: "Datasets for testing, fine-tuning and SQL practice.", types: ["dataset", "dataset-analytics"] },
    { id: "apps", label: "Apps to study", blurb: "Hugging Face Spaces: small apps showing how others wired a model into a UI.", types: ["space"] },
    { id: "research", label: "Research", blurb: "Papers behind the models and methods.", types: ["paper"] },
    { id: "yours", label: "Your own work", blurb: "Your fine-tuning runs and private material.", types: ["lora-run", "private-corpus"] },
    { id: "build", label: "Build it offline", blurb: "Source code, offline Python packages and the drive's bookkeeping.", types: ["code-repo", "doc", "wheels", "gguf", "manifests", "script", "folder"] },
  ];
  const roleOf = t => ROLES.find(r => r.types.includes(t)) || ROLES[ROLES.length - 1];
  const ROLE_COLOR = { talk: "#7cf2a0", decide: "#f2c46c", predict: "#e0a46c", find: "#6cc4f2", see: "#b99cf2", pages: "#f29c6c", hear: "#f27cc8", create: "#e6e36c", data: "#5fd3c4", apps: "#9fb7f2", research: "#c9b48a", yours: "#a3aea8", build: "#76847d" };

  // The agent tags models from their config; names tell us more about the job.
  function classify(i) {
    const n = i.name.toLowerCase();
    if (!i.path.startsWith("models")) return i.type;
    if (/laya|jev|decision/.test(n)) return "decision";
    if (/mitra|tabpfn/.test(n)) return "tabular";
    if (/chronos|timesfm|moirai|time-?series/.test(n)) return "forecaster";
    if (/router/.test(n)) return "router";
    if (/guard/.test(n)) return "guard";
    if (/yolo/.test(n)) return "detector";
    if (/ui-tars/.test(n)) return "ui-agent";
    if (/reader/.test(n)) return "html-reader";
    if (/nuextract/.test(n)) return "extractor";
    if (/sql/.test(n)) return "text-to-sql";
    if (/functiongemma|tool-calling|tool-use/.test(n)) return "tool-llm";
    if (/image/.test(n) && i.type === "gguf") return "image-gen";
    if (/rerank/.test(n)) return "reranker";
    if (/embed/.test(n)) return "embedding";
    if (/whisper|asr/.test(n)) return "asr";
    if (/tts|kokoro/.test(n)) return "tts";
    return i.type;
  }

  let catalog = null, mode = store.get("a1-map-mode", "jobs"), query = "", openPath = null;
  let tried = new Set(store.get("a1-tried", [])), stepsDone = new Set(store.get("a1-steps", []));
  const saveTried = () => store.set("a1-tried", [...tried]);
  const items = () => catalog.categories.flatMap(c => c.items.map(i => ({ ...i, cat: c.id, kind: classify(i) })));
  const abs = i => `${catalog.stash_root}/${i.path}`;
  const ram = () => catalog.ram_bytes || 16 * 2 ** 30;
  const ramLabel = () => `${Math.round(ram() / 2 ** 30)} GB`;

  // The Macs Jordan owns or is weighing. macOS lets the GPU use about 75% of memory by default.
  const MACHINES = [
    { id: "m1", label: "M1 16GB", gb: 16 }, { id: "m4", label: "M4 16GB", gb: 16 },
    { id: "m6", label: "M6 32GB", gb: 32 }, { id: "m5p", label: "M5 Pro 64GB", gb: 64 },
  ];
  const memNeed = (bytes, name) => (/jev-style-2b-decision-v3/i.test(name || "") ? 2.0e9 : bytes) * 1.2;
  function fitsOn(bytes, name) {
    const need = memNeed(bytes, name);
    return MACHINES.map(m => ({ ...m, need, fits: need <= m.gb * 2 ** 30 * 0.75 }));
  }
  window.MachineFit = fitsOn;
  function machineTags(i) {
    if (!i.path.startsWith("models") || !i.bytes) return "";
    const ok = fitsOn(i.bytes, i.name).filter(x => x.fits);
    return ok.length ? ok.map(x => `<em class="b-ok">fits ${x.label}</em>`).join("") : `<em class="b-bad">fits none of your Macs</em>`;
  }
  function machineTable(i) {
    if (!i.path.startsWith("models") || !i.bytes) return "";
    const rows = fitsOn(i.bytes, i.name);
    return `<p>Needs roughly ${gb(rows[0].need)} of memory to run. macOS lets models use about three quarters of a Mac's memory.</p>
      <dl class="facts" style="margin-top:6px">${rows.map(r => `<dt>${r.label}</dt><dd class="${r.fits ? "b-ok" : "b-bad"}">${r.fits ? "fits" : "too big"}</dd>`).join("")}</dl>`;
  }
  function fit(i) {
    const t = TYPES[i.kind] || {};
    if (!i.path.startsWith("models") || !i.bytes) return null;
    // Some repos ship two precisions; only one loads at a time.
    const multi = /jev-style-2b-decision-v3/i.test(i.name);
    const need = (multi ? 2.0e9 : i.bytes) * 1.2;
    const r = need / ram();
    const label = `${gb(need)} of memory`;
    if (r < 0.5) return { cls: "ok", text: "Runs easily", detail: `Needs roughly ${label}. Plenty of room on your ${ramLabel()} Mac.` };
    if (r < 0.8) return { cls: "warn", text: "Fits, close other apps", detail: `Needs roughly ${label} of your ${ramLabel()}. Close big apps first.` };
    return { cls: "bad", text: "Too big for this Mac", detail: `Needs roughly ${label}; your Mac has ${ramLabel()}. Save it for a bigger machine.` };
  }
  function license(i) {
    const l = String(i.meta?.license || "").toLowerCase();
    if (!l) return null;
    if (/^(apache|mit|bsd|cc-by-4|cc-by-3|openrail|odc-by)/.test(l)) return { cls: "ok", text: l, detail: "Permissive: fine for client work with attribution." };
    if (/nc/.test(l)) return { cls: "bad", text: l, detail: "Non-commercial: personal learning and internal experiments only." };
    if (/gpl/.test(l)) return { cls: "warn", text: l, detail: "Copyleft: fine internally; shipping it in client work can oblige you to share source." };
    return { cls: "warn", text: l, detail: "Custom or unusual license. Read it before using this in client work." };
  }
  function hubUrl(i) {
    const repo = i.source?.repo; if (!repo) return null;
    const pre = i.cat === "datasets" ? "datasets/" : i.cat === "spaces" ? "spaces/" : i.cat === "papers" ? "papers/" : "";
    return `https://huggingface.co/${pre}${repo}`;
  }

  /* ---------- learning path ---------- */
  const STEPS = [
    { id: "s1", title: "Get the big picture", goal: "Understand the four layers every local AI setup has.", find: () => [], concepts: ["local-stack", "mlx", "parameters"] },
    { id: "s2", title: "Run your first model", goal: "Chat with a small language model, entirely on your Mac.", find: all => all.filter(i => i.kind === "llm").sort((a, b) => a.bytes - b.bytes).slice(0, 2), concepts: ["quantization", "context", "safetensors"] },
    { id: "s3", title: "Search by meaning", goal: "Turn text into vectors, find the nearest match, then rerank. This is how skill selection works.", find: all => all.filter(i => ["embedding", "reranker"].includes(i.kind)).slice(0, 3), concepts: ["embeddings", "rerank"] },
    { id: "s4", title: "Make a calibrated decision", goal: "Ask a decision model a typed question and read its confidence. The offline version of what jev-gateway does.", find: all => all.filter(i => i.kind === "decision").slice(0, 3), concepts: ["calibration", "decision-models"] },
    { id: "s5", title: "Query real analytics data", goal: "Run SQL over GA4-shaped event data with DuckDB, no import step.", find: all => all.filter(i => i.kind === "dataset-analytics").slice(0, 2), concepts: ["dataset-formats"] },
    { id: "s6", title: "Give it eyes", goal: "Describe a screenshot or find a button on a page.", find: all => all.filter(i => ["vlm", "ui-agent"].includes(i.kind)).sort((a, b) => a.bytes - b.bytes).slice(0, 2), concepts: ["parameters"] },
    { id: "s7", title: "Turn a web page into data", goal: "Convert HTML to clean Markdown, the first step of any site scan.", find: all => all.filter(i => ["html-reader", "extractor", "text-to-sql"].includes(i.kind)).slice(0, 2), concepts: ["licenses"] },
    { id: "s8", title: "Teach a model something", goal: "See what a LoRA fine-tune produced and load it on top of its base model.", find: all => all.filter(i => i.kind === "lora-run"), concepts: ["lora"] },
    { id: "s9", title: "Hear and speak", goal: "Transcribe a clip, then speak a line back.", find: all => all.filter(i => ["asr", "tts"].includes(i.kind)).slice(0, 2), concepts: [] },
    { id: "s10", title: "Work with the network off", goal: "Install packages from the drive and know which venv to use.", find: all => all.filter(i => i.kind === "wheels").slice(0, 1), concepts: ["wheels", "venv", "pinning"] },
  ];

  /* ---------- views ---------- */
  function html(cat) {
    catalog = cat;
    if (!catalog?.categories?.length) return `<div class="sub">No catalog yet. Plug in the A1 and the map fills in.</div>`;
    const all = items();
    const learnable = all.filter(i => !["manifests", "script", "folder", "private-corpus", "doc"].includes(i.kind));
    const triedCount = learnable.filter(i => tried.has(i.path)).length;
    const d = catalog.drive;
    return `<div class="m-intro">
      <p class="sub" style="margin:0">Everything in <code>stash/</code> on the A1, ${all.length} items, explained. Open anything for what it is, why it's there, whether it runs on your Mac, and a command to try it.</p>
      <div class="m-progress" title="Tracked in this browser only"><div class="m-bar"><i style="width:${learnable.length ? (triedCount / learnable.length * 100).toFixed(1) : 0}%"></i></div>
        <span><b>${triedCount}</b> of ${learnable.length} tried · ${stepsDone.size} of ${STEPS.length} path steps</span></div>
    </div>
    <div class="m-tools">
      <div class="m-modes" role="tablist">${[["path", "Learning path"], ["jobs", "What it does"], ["space", "Disk space"]].map(([k, l]) => `<button class="tab" role="tab" data-mode="${k}" aria-pressed="${mode === k}">${l}</button>`).join("")}</div>
      <input id="m-q" class="m-q" type="search" placeholder="Search: whisper, sql, decision…" value="${esc(query)}" aria-label="Search the drive">
    </div>
    <div id="m-body">${mode === "path" ? pathView(all) : mode === "space" ? spaceView() : jobsView(all)}</div>
    <div class="m-drive"><div class="m-dbar">${["stash", "outside_stash"].map(k => `<i style="width:${(d[k] / d.total * 100).toFixed(2)}%" class="${k}"></i>`).join("")}</div>
      <span>${gb(d.stash)} in stash · ${gb(d.outside_stash)} other files (your recordings) · ${gb(d.free)} free of ${gb(d.total)} · catalog ${new Date(catalog.generated).toLocaleString()}</span></div>
    <details class="m-glossary"><summary>Glossary · ${Object.keys(CONCEPTS).length} concepts</summary>
      <div class="concepts">${Object.entries(CONCEPTS).map(([k, c]) => `<div class="concept" id="concept-${k}"><b>${esc(c.title)}</b>${esc(c.body)}</div>`).join("")}</div></details>
    <aside id="m-panel" class="m-panel" hidden aria-label="Item details"></aside><div id="m-scrim" class="m-scrim" hidden></div>`;
  }

  function cardHtml(i) {
    const t = TYPES[i.kind] || TYPES.folder, f = fit(i), lic = license(i), role = roleOf(i.kind);
    return `<button class="m-card${tried.has(i.path) ? " tried" : ""}" data-open="${esc(i.path)}" style="--role:${ROLE_COLOR[role.id]}">
      <span class="m-glyph">${esc(t.glyph)}</span>
      <span class="m-cname">${esc(i.name)}</span>
      <span class="m-kind">${esc(t.label)} · ${gb(i.bytes)}</span>
      <span class="m-badges">${machineTags(i)}${lic && lic.cls !== "ok" ? `<em class="b-${lic.cls}">${lic.cls === "bad" ? "Non-commercial" : "License: check"}</em>` : ""}${tried.has(i.path) ? `<em class="b-tried">Tried${notes[i.path]?.answers?.overall ? ` · ${notes[i.path].answers.overall}/5` : ""}</em>` : ""}</span>
    </button>`;
  }

  function matches(i) {
    if (!query) return true;
    const t = TYPES[i.kind] || {};
    return `${i.name} ${t.label} ${roleOf(i.kind).label} ${i.source?.repo || ""} ${i.summary || ""}`.toLowerCase().includes(query.toLowerCase());
  }

  function jobsView(all) {
    const shown = all.filter(matches);
    if (!shown.length) return `<div class="empty">Nothing matches “${esc(query)}”.</div>`;
    return ROLES.map(r => {
      const list = shown.filter(i => r.types.includes(i.kind)).sort((a, b) => b.bytes - a.bytes);
      if (!list.length) return "";
      return `<section class="m-role" style="--role:${ROLE_COLOR[r.id]}"><header><h2>${esc(r.label)} <span>${list.length}</span></h2><p>${esc(r.blurb)}</p></header>
        <div class="m-grid">${list.map(cardHtml).join("")}</div></section>`;
    }).join("");
  }

  function pathView(all) {
    return `<ol class="m-steps">${STEPS.map((s, n) => {
      const its = s.find(all), done = stepsDone.has(s.id);
      return `<li class="m-step${done ? " done" : ""}"><div class="m-snum">${n + 1}</div><div class="m-sbody">
        <h3>${esc(s.title)}</h3><p>${esc(s.goal)}</p>
        ${s.concepts.length ? `<div class="learn">${s.concepts.map(k => `<button class="chip" data-concept="${k}">${esc(CONCEPTS[k]?.title || k)}</button>`).join("")}</div>` : ""}
        ${its.length ? `<div class="m-grid">${its.map(cardHtml).join("")}</div>` : s.id === "s1" ? "" : `<p class="meta">Nothing on the drive for this step yet; the scout will suggest something.</p>`}
        <button class="btn${done ? "" : " go"} m-done" data-step="${s.id}">${done ? "Mark not done" : "Mark step done"}</button></div></li>`;
    }).join("")}</ol>`;
  }

  /* treemap, sized by sqrt of bytes so small things stay clickable */
  function squarify(list, x, y, w, h) {
    const total = list.reduce((a, i) => a + i.v, 0), out = [];
    if (!total) return out;
    const sc = (w * h) / total; let rest = list.map(i => ({ ...i, a: i.v * sc })).filter(i => i.a > 0);
    const worst = (row, len) => { const s = row.reduce((a, r) => a + r.a, 0), mx = Math.max(...row.map(r => r.a)), mn = Math.min(...row.map(r => r.a)); return Math.max(len * len * mx / (s * s), (s * s) / (len * len * mn)); };
    while (rest.length) {
      const len = Math.min(w, h); let row = [rest[0]], k = 1;
      while (k < rest.length && worst([...row, rest[k]], len) <= worst(row, len)) row.push(rest[k++]);
      rest = rest.slice(k); const s = row.reduce((a, r) => a + r.a, 0);
      if (w >= h) { const cw = s / h; let cy = y; row.forEach(r => { const ch = r.a / cw; out.push({ ...r, x, y: cy, w: cw, h: ch }); cy += ch; }); x += cw; w -= cw; }
      else { const ch = s / w; let cx = x; row.forEach(r => { const cw2 = r.a / ch; out.push({ ...r, x: cx, y, w: cw2, h: ch }); cx += cw2; }); y += ch; h -= ch; }
    }
    return out;
  }
  function spaceView() { return `<p class="meta" style="margin:0 0 8px">Blocks are grouped by job and sized by disk space (square-root scaled so small items stay clickable).</p><div class="tm" id="m-tm"></div>`; }
  function drawTreemap() {
    const tm = $("#m-tm"); if (!tm) return;
    const W = tm.clientWidth, H = tm.clientHeight;
    const all = items().filter(matches);
    const groups = ROLES.map(r => ({ r, list: all.filter(i => r.types.includes(i.kind)) })).filter(g => g.list.length);
    const outer = squarify(groups.map(g => ({ v: Math.sqrt(g.list.reduce((a, i) => a + i.bytes, 0) + 1), g })).sort((a, b) => b.v - a.v), 0, 0, W, H);
    tm.innerHTML = outer.map(o => {
      const inner = squarify(o.g.list.map(i => ({ v: Math.sqrt(Math.max(i.bytes, 1e5)), i })).sort((a, b) => b.v - a.v), 0, 18, o.w, Math.max(o.h - 18, 1));
      return `<div class="m-tgroup" style="left:${o.x}px;top:${o.y}px;width:${o.w}px;height:${o.h}px;--role:${ROLE_COLOR[o.g.r.id]}"><span class="m-tlabel">${esc(o.g.r.label)}</span>
        ${inner.map(c => `<button class="m-tcell" data-open="${esc(c.i.path)}" title="${esc(c.i.name)} · ${gb(c.i.bytes)}" style="left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px">${c.w > 70 && c.h > 30 ? `<span>${esc(c.i.name)}</span><small>${gb(c.i.bytes)}</small>` : ""}</button>`).join("")}</div>`;
    }).join("");
    tm.querySelectorAll(".m-tcell").forEach(c => c.onclick = () => flipOpen(c.dataset.open, c));
  }

  /* ---------- disk space: a block grows into a card and flips over ---------- */
  let flipTl = null;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function flipBack(i) {
    const t = TYPES[i.kind] || TYPES.folder, role = roleOf(i.kind), lic = license(i), n = notes[i.path];
    const share = catalog.drive?.stash ? (i.bytes / catalog.drive.stash * 100) : null;
    const fits = i.path.startsWith("models") && i.bytes ? fitsOn(i.bytes, i.name) : [];
    return `<div class="m-fkind">${esc(role.label)} · ${esc(t.label)}</div>
      <h2>${esc(i.name)}</h2>
      <div class="m-fsize"><b>${gb(i.bytes)}</b><span>${share != null ? `${share < 0.1 ? "<0.1" : share.toFixed(1)}% of the stash` : ""}${i.files ? ` · ${Number(i.files).toLocaleString()} files` : ""}</span></div>
      ${share != null ? `<div class="m-fbar"><i style="width:${Math.min(100, Math.max(share, 0.5))}%"></i></div>` : ""}
      <p>${esc(t.what)}</p>
      ${t.why ? `<p class="meta">${esc(t.why)}</p>` : ""}
      ${fits.length ? `<div class="m-ffits">${fits.map(f => `<span class="${f.fits ? "b-ok" : "b-bad"}">${esc(f.label)} ${f.fits ? "fits" : "too big"}</span>`).join("")}</div>` : ""}
      ${lic ? `<p class="meta"><span class="b-${lic.cls}">${esc(lic.text)}</span> · ${esc(lic.detail)}</p>` : ""}
      ${i.source?.repo ? `<p class="meta">From ${esc(i.source.repo)}</p>` : ""}
      ${n ? `<p class="meta">You tried it${n.answers?.overall ? `, rated ${n.answers.overall}/5` : ""}.</p>` : tried.has(i.path) ? `<p class="meta">You tried it.</p>` : ""}
      <div class="m-facts"><button class="btn go" data-full>Full details</button><button class="btn" data-fclose>Close</button></div>`;
  }
  function flipOpen(path, cell) {
    const i = items().find(x => x.path === path); if (!i) return;
    if (flipTl) return flipClose(() => flipOpen(path, cell));
    const r = cell.getBoundingClientRect(), role = roleOf(i.kind);
    const W = Math.min(420, innerWidth - 32);
    // Size the card to its content: measure an invisible copy of the back face at the final width.
    const probe = document.createElement("div"); probe.className = "m-fface m-fback"; probe.style.cssText = `position:fixed;visibility:hidden;transform:none;width:${W}px;height:auto;inset:auto;left:-9999px;top:0`;
    probe.innerHTML = flipBack(i); document.body.append(probe);
    const H = Math.min(Math.max(probe.scrollHeight + 4, 260), innerHeight - 64); probe.remove();
    const scrim = document.createElement("div"); scrim.className = "m-fscrim";
    const card = document.createElement("div"); card.className = "m-flip"; card.setAttribute("role", "dialog"); card.setAttribute("aria-label", i.name);
    card.style.setProperty("--role", ROLE_COLOR[role.id]);
    card.innerHTML = `<div class="m-finner"><div class="m-fface m-ffront"><span>${esc(i.name)}</span><small>${gb(i.bytes)}</small></div>
      <div class="m-fface m-fback">${flipBack(i)}</div></div>`;
    document.body.append(scrim, card);
    const inner = card.querySelector(".m-finner");
    gsap.set(card, { left: r.left, top: r.top, width: r.width, height: r.height });
    flipTl = gsap.timeline({ defaults: { ease: "power3.inOut" } });
    if (reduced()) {
      gsap.set(card, { left: (innerWidth - W) / 2, top: (innerHeight - H) / 2, width: W, height: H });
      gsap.set(inner, { rotationY: 180 });
      flipTl.fromTo(card, { opacity: 0 }, { opacity: 1, duration: .15 }).fromTo(scrim, { opacity: 0 }, { opacity: 1, duration: .15 }, 0);
    } else {
      flipTl.to(cell, { scale: .92, duration: .09, ease: "power2.in" })
        .to(cell, { scale: 1, duration: .14, ease: "back.out(3)" })
        .fromTo(scrim, { opacity: 0 }, { opacity: 1, duration: .35 }, .1)
        .to(card, { left: (innerWidth - W) / 2, top: (innerHeight - H) / 2, width: W, height: H, duration: .5 }, .12)
        .to(inner, { rotationY: 180, duration: .6, ease: "power2.inOut" }, .42)
        .fromTo(card.querySelectorAll(".m-fback > *"), { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: .25, stagger: .03, ease: "power2.out" }, .8);
    }
    card._cell = cell; card._scrim = scrim;
    const close = () => flipClose();
    scrim.onclick = close;
    card.querySelector("[data-fclose]").onclick = close;
    card.querySelector("[data-full]").onclick = () => flipClose(() => openPanel(path), true);
    setTimeout(() => card.querySelector("[data-fclose]").focus({ preventScroll: true }), reduced() ? 0 : 900);
  }
  function flipClose(after, fast) {
    const card = $(".m-flip"); if (!card) { flipTl = null; after && after(); return; }
    const done = () => { card._scrim.remove(); card.remove(); flipTl = null; after && after(); };
    if (reduced() || fast) { gsap.to([card, card._scrim], { opacity: 0, duration: .15, onComplete: done }); return; }
    const r = card._cell.isConnected ? card._cell.getBoundingClientRect() : null;
    const tl = gsap.timeline({ defaults: { ease: "power3.inOut" }, onComplete: done });
    tl.to(card.querySelector(".m-finner"), { rotationY: 0, duration: .45, ease: "power2.inOut" })
      .to(card, r ? { left: r.left, top: r.top, width: r.width, height: r.height, duration: .4 } : { opacity: 0, duration: .25 }, .25)
      .to(card._scrim, { opacity: 0, duration: .3 }, .3);
  }

  /* ---------- "I tried this" surveys ---------- */
  // One question set per job. Shared openers and closers wrap the job-specific middle.
  const MACS = [...MACHINES.map(m => m.label), "Other"];
  const S = {
    mac: { id: "mac", q: "Which Mac did you run it on?", type: "choice", options: MACS },
    speed: { id: "speed", q: "How fast did it feel?", type: "scale", lo: "Unusably slow", hi: "Instant" },
  };
  const SURVEYS = {
    talk: [S.mac,
      { id: "tasks", q: "What did you ask it to do?", type: "multi", options: ["Chat / Q&A", "Summarize", "Write code", "Call tools / return JSON", "Draft copy", "Something else"] },
      S.speed,
      { id: "tps", q: "Tokens per second, if you saw it", type: "text", hint: "mlx_lm prints this after each answer" },
      { id: "quality", q: "How good were the answers?", type: "scale", lo: "Wrong or rambling", hi: "As good as a cloud model" },
      { id: "format", q: "Did it follow format instructions (JSON, length, style)?", type: "choice", options: ["Yes", "Mostly", "No", "Didn't test"] },
      { id: "prompt", q: "Best prompt, or where it went wrong", type: "long" },
      { id: "fit", q: "Where would it fit?", type: "multi", options: ["Client deliverables", "Internal agents", "Workshops / demos", "Offline backup", "Nowhere yet"] }],
    decide: [S.mac,
      { id: "question", q: "What question did you ask it?", type: "long", hint: "Paste the typed question and the options" },
      { id: "match", q: "Did the answer match what you expected?", type: "choice", options: ["Yes", "Partly", "No"] },
      { id: "calibration", q: "Did its confidence look believable?", type: "scale", lo: "Confident nonsense", hi: "Well calibrated" },
      { id: "latency", q: "How long per decision?", type: "choice", options: ["Under 100 ms", "Under 1 s", "1 to 5 s", "Slower"] },
      { id: "replace", q: "Could it replace a jev-gateway or Claude call?", type: "choice", options: ["Yes", "For some cases", "No"] },
      { id: "edge", q: "An edge case that tripped it", type: "long" }],
    predict: [
      { id: "input", q: "What data did you feed it?", type: "text", hint: "e.g. ERCOT load, GA4 sessions, ad spend" },
      { id: "target", q: "What were you predicting, and how far ahead?", type: "text" },
      { id: "baseline", q: "Compared with a naive baseline (last value, seasonal average)", type: "choice", options: ["Better", "About the same", "Worse", "Didn't compare"] },
      { id: "shape", q: "How hard was getting the data into the right shape?", type: "scale", lo: "Painful", hi: "Easy" },
      { id: "use", q: "Useful for", type: "multi", options: ["ERCOT / grid", "Ad spend pacing", "Traffic forecasting", "Client reporting", "Other"] }],
    find: [
      { id: "corpus", q: "What did you search over?", type: "text", hint: "e.g. skill descriptions, docs, GTM tags" },
      { id: "relevance", q: "Did the top results make sense?", type: "scale", lo: "Random", hi: "Spot on" },
      { id: "vs", q: "Compared with keyword search", type: "choice", options: ["Better", "About the same", "Worse", "Didn't compare"] },
      S.speed,
      { id: "use", q: "Use it for", type: "multi", options: ["Skill / tool selection", "Doc search (RAG)", "Deduping", "Clustering", "Reranking results"] }],
    see: [S.mac,
      { id: "inputs", q: "What did you show it?", type: "multi", options: ["Screenshot", "Web page", "Photo", "Chart", "Document / PDF page"] },
      { id: "accuracy", q: "Did it describe or locate things correctly?", type: "scale", lo: "Mostly wrong", hi: "Right every time" },
      { id: "ui", q: "Did it find the right UI element or coordinates?", type: "choice", options: ["Yes", "Partly", "No", "Didn't test"] },
      S.speed,
      { id: "license", q: "Is the license OK for how you'd use it?", type: "choice", options: ["Yes", "Internal only", "Unsure"] }],
    pages: [
      { id: "input", q: "What page or input did you use?", type: "text", hint: "URL or a description" },
      { id: "clean", q: "How clean was the output?", type: "scale", lo: "Messy", hi: "Ready to use" },
      { id: "kept", q: "Did it keep what tracking needs (forms, CTAs, prices, product IDs)?", type: "choice", options: ["Yes", "Partly", "No"] },
      { id: "invented", q: "Did it invent fields or values?", type: "choice", options: ["None", "A few", "Many"] },
      { id: "scanner", q: "Could it slot into the GTM page scanner?", type: "choice", options: ["Yes", "Internal only (license)", "No"] }],
    hear: [S.mac,
      { id: "input", q: "What audio or text did you use?", type: "text" },
      { id: "accuracy", q: "Transcript accuracy or voice naturalness", type: "scale", lo: "Poor", hi: "Indistinguishable" },
      { id: "rt", q: "Speed versus real time", type: "choice", options: ["Faster than real time", "About real time", "Slower"] },
      { id: "quirks", q: "Names, accents or words it got wrong", type: "long" },
      { id: "use", q: "Use it for", type: "multi", options: ["Meeting notes", "Voice agent", "Reels / content", "Workshops", "Other"] }],
    create: [S.mac,
      { id: "prompt", q: "Prompt you used", type: "long" },
      { id: "quality", q: "Image quality", type: "scale", lo: "Unusable", hi: "Publishable" },
      { id: "time", q: "Seconds per image", type: "text" },
      { id: "use", q: "Good enough for", type: "multi", options: ["Social posts", "Slides", "Mockups", "Nothing yet"] }],
    data: [
      { id: "did", q: "What did you do with it?", type: "multi", options: ["Browsed it", "Queried it (DuckDB / SQL)", "Fine-tuned on it", "Used it as an eval set", "Used it in a demo"] },
      { id: "quality", q: "Data quality", type: "scale", lo: "Noisy", hi: "Clean" },
      { id: "fit", q: "Best fit", type: "multi", options: ["Client demo", "Workshop exercise", "Training data", "Testing / evals", "None"] },
      { id: "snippet", q: "A query or snippet worth keeping", type: "long" }],
    apps: [
      { id: "ran", q: "Did it run locally?", type: "choice", options: ["Yes, as is", "After fixes", "No"] },
      { id: "fixes", q: "What did you have to fix?", type: "long" },
      { id: "steal", q: "What pattern is worth stealing?", type: "long" },
      { id: "cf", q: "Rebuild it on Cloudflare Workers?", type: "choice", options: ["Yes", "Maybe", "No"] }],
    research: [
      { id: "takeaway", q: "One-sentence takeaway", type: "text" },
      { id: "understood", q: "How much did you understand?", type: "scale", lo: "Lost", hi: "Could teach it" },
      { id: "applies", q: "Applies to", type: "multi", options: ["Decision models", "Retrieval", "Agents", "Measurement / GTM", "Not yet"] },
      { id: "try", q: "Something to try from it", type: "long" }],
    yours: [
      { id: "vs", q: "Compared with the base model, the result is", type: "choice", options: ["Better", "About the same", "Worse", "Not compared"] },
      { id: "changed", q: "What changed in the output?", type: "long" },
      { id: "next", q: "The next run should change", type: "multi", options: ["More or better data", "More steps", "Different rank", "Different base model"] }],
    build: [
      { id: "installed", q: "Did it install or build offline?", type: "choice", options: ["Yes", "With fixes", "No"] },
      { id: "broke", q: "What broke?", type: "long" },
      { id: "commands", q: "Commands that worked", type: "long", hint: "Saved so next time is copy and paste" },
      { id: "for", q: "What you'd use it for", type: "text" }],
  };
  const CLOSERS = [
    { id: "overall", q: "Overall, how useful is this to you?", type: "scale", lo: "Not useful", hi: "Essential" },
    { id: "again", q: "Would you use it again?", type: "choice", options: ["Yes", "Maybe", "No"] },
    { id: "next", q: "Next step or anything else", type: "long" },
  ];
  const surveyFor = i => [...(SURVEYS[roleOf(i.kind).id] || SURVEYS.build), ...CLOSERS];

  let notes = {}, notesLoaded = false, editing = null, quietOpen = false;
  async function loadNotes() {
    try { notes = await window.call("/api/notes"); notesLoaded = true; Object.keys(notes).forEach(k => tried.add(k)); saveTried(); }
    catch { notes = {}; }
  }
  function qHtml(q, v) {
    const n = `sv-${q.id}`;
    const input = q.type === "scale"
      ? `<div class="sv-scale">${[1, 2, 3, 4, 5].map(k => `<label><input type="radio" name="${n}" value="${k}"${+v === k ? " checked" : ""}><span>${k}</span></label>`).join("")}</div>
         <div class="sv-ends"><small>${esc(q.lo)}</small><small>${esc(q.hi)}</small></div>`
      : q.type === "choice" || q.type === "multi"
      ? `<div class="sv-opts">${q.options.map(o => `<label><input type="${q.type === "multi" ? "checkbox" : "radio"}" name="${n}" value="${esc(o)}"${(q.type === "multi" ? (v || []).includes(o) : v === o) ? " checked" : ""}><span>${esc(o)}</span></label>`).join("")}</div>`
      : q.type === "long"
      ? `<textarea name="${n}" rows="3" placeholder="${esc(q.hint || "")}">${esc(v || "")}</textarea>`
      : `<input type="text" name="${n}" value="${esc(v || "")}" placeholder="${esc(q.hint || "")}">`;
    return `<fieldset class="sv-q"><legend>${esc(q.q)}</legend>${input}</fieldset>`;
  }
  function readSurvey(form, qs) {
    const out = {};
    for (const q of qs) {
      const n = `sv-${q.id}`;
      if (q.type === "multi") { const v = [...form.querySelectorAll(`[name="${n}"]:checked`)].map(x => x.value); if (v.length) out[q.id] = v; }
      else if (q.type === "scale" || q.type === "choice") { const x = form.querySelector(`[name="${n}"]:checked`); if (x) out[q.id] = q.type === "scale" ? +x.value : x.value; }
      else { const x = form.querySelector(`[name="${n}"]`); if (x && x.value.trim()) out[q.id] = x.value.trim(); }
    }
    return out;
  }
  function fmtAnswer(q, v) {
    if (q.type === "scale") return `${v} / 5 ${v >= 4 ? "· " + q.hi : v <= 2 ? "· " + q.lo : ""}`;
    return Array.isArray(v) ? v.join(", ") : String(v);
  }
  function notesHtml(i) {
    const qs = surveyFor(i), n = notes[i.path];
    if (editing === i.path) {
      return `<h3>Notes · ${esc(roleOf(i.kind).label)}</h3>
        <form class="sv" id="m-survey"><p class="meta">A few questions for this kind of item. Skip any; everything is optional.</p>
        ${qs.map(q => qHtml(q, n?.answers?.[q.id])).join("")}
        <div class="sv-acts"><button type="submit" class="btn go">Save notes</button><button type="button" class="btn" data-cancel>Cancel</button></div>
        <p class="meta sv-status" aria-live="polite"></p></form>`;
    }
    if (n) {
      const rows = qs.filter(q => n.answers[q.id] != null).map(q => `<dt>${esc(q.q)}</dt><dd>${esc(fmtAnswer(q, n.answers[q.id]))}</dd>`).join("");
      return `<h3>Your notes <span class="meta" style="letter-spacing:0;text-transform:none">${new Date(n.updated).toLocaleDateString()}</span></h3>
        <dl class="facts sv-saved">${rows || "<dt>No answers yet</dt><dd></dd>"}</dl>
        <div class="m-pfoot sv-acts"><button class="btn" data-edit>Edit notes</button><button class="btn" data-remove>Remove notes</button></div>`;
    }
    return `<div class="m-pfoot sv-acts"><button class="btn go" data-start>I tried this</button>
      ${tried.has(i.path) ? `<button class="btn" data-untry>Mark not tried</button>` : ""}</div>`;
  }
  function wireNotes(i) {
    const p = $("#m-panel");
    // Redraw the map (badges, progress) and reopen this panel in place, without the slide-in, scrolled to the notes.
    const reopen = () => { quietOpen = true; rerender(); if (openPath !== i.path) openPanel(i.path); const el = $("#m-panel #m-notes"); el && el.scrollIntoView({ block: "start" }); };
    const start = p.querySelector("[data-start]"), edit = p.querySelector("[data-edit]");
    [start, edit].forEach(b => b && (b.onclick = () => { editing = i.path; reopen(); }));
    const untry = p.querySelector("[data-untry]");
    if (untry) untry.onclick = () => { tried.delete(i.path); saveTried(); reopen(); };
    const rm = p.querySelector("[data-remove]");
    if (rm) rm.onclick = async () => {
      if (rm.dataset.armed !== "1") { rm.dataset.armed = "1"; rm.textContent = "Click again to remove"; return; }
      await window.call(`/api/notes?path=${encodeURIComponent(i.path)}`, { method: "DELETE" });
      delete notes[i.path]; tried.delete(i.path); saveTried(); reopen();
    };
    const form = p.querySelector("#m-survey");
    if (!form) return;
    gsap.fromTo(form.querySelectorAll(".sv-q"), { y: 6, opacity: 0 }, { y: 0, opacity: 1, duration: .2, stagger: .03, ease: "power2.out", clearProps: "all" });
    form.querySelector("[data-cancel]").onclick = () => { editing = null; reopen(); };
    form.onsubmit = async e => {
      e.preventDefault();
      const answers = readSurvey(form, surveyFor(i)), status = form.querySelector(".sv-status");
      status.textContent = "Saving…";
      try {
        const r = await window.call("/api/notes", { method: "POST", body: JSON.stringify({ path: i.path, name: i.name, role: roleOf(i.kind).id, kind: i.kind, answers }) });
        if (!r.ok) throw new Error(r.error || "not saved");
        notes[i.path] = { path: i.path, answers, updated: r.updated };
        tried.add(i.path); saveTried(); editing = null; reopen();
      } catch (err) { status.textContent = `Couldn't save: ${err.message}. Your answers are still in the form.`; }
    };
  }

  /* ---------- detail panel ---------- */
  function panelHtml(i) {
    const t = TYPES[i.kind] || TYPES.folder, m = i.meta || {}, f = fit(i), lic = license(i), role = roleOf(i.kind), hub = hubUrl(i);
    const facts = [["Size on disk", gb(i.bytes)], ["Files", i.files]];
    if (i.source?.repo) facts.push(["From", i.source.repo]);
    if (i.source?.revision) facts.push(["Pinned revision", String(i.source.revision).slice(0, 12)]);
    if (m.architecture) facts.push(["Architecture", m.architecture]);
    if (m.bits) facts.push(["Quantization", `${m.bits}-bit, group ${m.group_size || "?"}`]);
    if (m.context_tokens) facts.push(["Context", `${Number(m.context_tokens).toLocaleString()} tokens`]);
    if (m.layers) facts.push(["Layers", m.layers]);
    if (m.formats) facts.push(["Formats", Object.entries(m.formats).map(([k, v]) => `${k} ×${v}`).join(", ")]);
    if (m.tasks) facts.push(["Tasks", [].concat(m.tasks).join(", ")]);
    if (m.language) facts.push(["Language", m.language]);
    if (m.commit) facts.push(["Commit", m.commit.slice(0, 12)]);
    if (m.wheels) facts.push(["Wheels", `${m.wheels} (${(m.python || []).join(", ")})`]);
    if (m.highlights?.length) facts.push(["Includes", m.highlights.join(", ")]);
    (m.adapters || []).forEach(a => facts.push([a.name, `LoRA rank ${a.rank ?? "?"} on ${String(a.base || "?").split("/").pop()}, ${a.iters ?? "?"} steps`]));
    if (m.sdk) facts.push(["App type", m.sdk]);
    const cmd = t.try(i, { abs });
    const related = items().filter(x => x.path !== i.path && roleOf(x.kind) === role).slice(0, 5);
    return `<div class="m-phead"><span class="m-glyph" style="--role:${ROLE_COLOR[role.id]}">${esc(t.glyph)}</span>
        <div><div class="kind">${esc(role.label)} · ${esc(t.label)}</div><h2>${esc(i.name)}</h2></div>
        <button class="btn m-close" aria-label="Close">Close</button></div>
      <div class="m-pbadges">${machineTags(i).replace(/<em /g, "<span ").replace(/<\/em>/g, "</span>")}${lic ? `<span class="b-${lic.cls}">${esc(lic.text)}</span>` : ""}</div>
      <h3>What it is</h3><p>${esc(t.what)}</p>
      ${i.summary ? `<p class="meta" style="margin-top:6px">${esc(i.summary.replace(/\*\*|__|`/g, ""))}</p>` : ""}
      ${t.why ? `<h3>Why it's on your drive</h3><p>${esc(t.why)}</p>` : ""}
      ${f || lic ? `<h3>Which Macs can run it?</h3>${machineTable(i)}${lic ? `<h3>Can I use it for clients?</h3><p>${esc(lic.detail)}</p>` : ""}` : ""}
      ${cmd ? `<h3>Try it <button class="btn copy" data-copy>Copy</button></h3><pre id="m-cmd">${esc(cmd)}</pre>` : ""}
      ${t.learn?.length ? `<h3>Concepts behind it</h3><div class="learn">${t.learn.map(k => `<button class="chip" data-concept="${k}">${esc(CONCEPTS[k]?.title || k)}</button>`).join("")}</div>` : ""}
      <h3>Facts</h3><dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <h3>Where it lives</h3><pre>${esc(abs(i))}</pre>
      ${hub ? `<p style="margin-top:8px"><a href="${hub}" target="_blank" rel="noopener">Open on Hugging Face</a></p>` : ""}
      ${related.length ? `<h3>Also in ${esc(role.label)}</h3><div class="learn">${related.map(x => `<button class="chip" data-open="${esc(x.path)}">${esc(x.name)}</button>`).join("")}</div>` : ""}
      <section id="m-notes">${notesHtml(i)}</section>`;
  }
  function openPanel(path) {
    const i = items().find(x => x.path === path); if (!i) return;
    if (editing && editing !== path) editing = null;
    openPath = path;
    const p = $("#m-panel"), s = $("#m-scrim");
    p.innerHTML = panelHtml(i); p.hidden = false; s.hidden = false; p.scrollTop = 0;
    if (quietOpen) quietOpen = false;
    else gsap.fromTo(p, { x: 24, opacity: 0 }, { x: 0, opacity: 1, duration: .25, ease: "power2.out", clearProps: "transform,opacity" });
    wirePanel(); p.querySelector(".m-close").focus();
  }
  function closePanel() { openPath = null; editing = null; const p = $("#m-panel"); if (p) { p.hidden = true; $("#m-scrim").hidden = true; } }
  function wirePanel() {
    const p = $("#m-panel");
    p.querySelector(".m-close").onclick = closePanel;
    p.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openPanel(b.dataset.open));
    p.querySelectorAll("[data-concept]").forEach(b => b.onclick = () => showConcept(b.dataset.concept));
    const cp = p.querySelector("[data-copy]");
    if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText($("#m-cmd").textContent); cp.textContent = "Copied"; } catch { const r = document.createRange(); r.selectNodeContents($("#m-cmd")); getSelection().removeAllRanges(); getSelection().addRange(r); cp.textContent = "Selected"; } };
    wireNotes(items().find(x => x.path === openPath));
  }
  function showConcept(k) {
    closePanel();
    const det = $(".m-glossary"); det.open = true;
    const el = $("#concept-" + k); if (!el) return;
    $$(".concept").forEach(c => c.classList.remove("hl")); el.classList.add("hl");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  let rerender = () => {};
  function wire(first, redraw) {
    rerender = redraw;
    if (!notesLoaded) { notesLoaded = true; loadNotes().then(() => redraw()); }
    $$("[data-mode]").forEach(b => b.onclick = () => { mode = b.dataset.mode; store.set("a1-map-mode", mode); redraw(); });
    const q = $("#m-q");
    if (q) q.oninput = () => { query = q.value; $("#m-body").innerHTML = mode === "path" ? pathView(items()) : mode === "space" ? spaceView() : jobsView(items()); wireBody(); };
    wireBody(first);
    $("#m-scrim").onclick = closePanel;
    document.onkeydown = e => { if (e.key === "Escape") { if ($(".m-flip")) flipClose(); else closePanel(); } };
    $$(".m-glossary [data-concept]").forEach(b => b.onclick = () => showConcept(b.dataset.concept));
    if (openPath) openPanel(openPath);
  }
  function wireBody(first) {
    $$("#m-body [data-open]").forEach(b => b.onclick = () => openPanel(b.dataset.open));
    $$("#m-body [data-concept]").forEach(b => b.onclick = () => showConcept(b.dataset.concept));
    $$("#m-body [data-step]").forEach(b => b.onclick = () => { const s = b.dataset.step; stepsDone.has(s) ? stepsDone.delete(s) : stepsDone.add(s); store.set("a1-steps", [...stepsDone]); rerender(); });
    if (mode === "space") drawTreemap();
    // Animate only what is near the top; everything else is visible at rest.
    if (first) gsap.fromTo($$("#m-body .m-card, #m-body .m-step, #m-body .m-tgroup").slice(0, 24), { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: .25, stagger: .015, ease: "power2.out", clearProps: "all" });
  }
  window.addEventListener("resize", () => { if (mode === "space") { flipClose(); drawTreemap(); } });

  // Styles for the map live here so the page shell stays small.
  const css = document.createElement("style");
  css.textContent = `
  .m-intro{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:end;margin:4px 0 16px}
  @media(max-width:720px){.m-intro{grid-template-columns:1fr}}
  .m-progress{min-width:220px;font:12px "IBM Plex Mono",monospace;color:var(--mute)}
  .m-progress b{color:var(--ink)}
  .m-bar,.m-dbar{height:8px;background:var(--chip);border-radius:4px;overflow:hidden;margin-bottom:6px;display:flex}
  .m-bar i{background:var(--accent);display:block}
  .m-dbar i.stash{background:var(--accent)} .m-dbar i.outside_stash{background:var(--mute);opacity:.5}
  .m-tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between;margin-bottom:18px;position:sticky;top:env(safe-area-inset-top,0px);background:var(--bg);padding:8px 0;z-index:5}
  .m-modes{display:flex;gap:6px;flex-wrap:wrap}
  .m-q{flex:1 1 220px;max-width:340px;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:14px "IBM Plex Sans",sans-serif}
  .m-q:focus,.m-card:focus-visible,.tab:focus-visible,.btn:focus-visible,.chip:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .m-role{margin:0 0 26px}
  .m-role header{border-left:3px solid var(--role);padding-left:10px;margin-bottom:10px}
  .m-role h2{font:600 16px "IBM Plex Mono",monospace;margin:0}
  .m-role h2 span{color:var(--mute);font-weight:400;font-size:13px}
  .m-role p{margin:2px 0 0;color:var(--mute);font-size:14px;max-width:70ch}
  .m-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
  .m-card{all:unset;box-sizing:border-box;cursor:pointer;display:grid;grid-template-columns:34px minmax(0,1fr);grid-template-rows:auto auto auto;column-gap:10px;row-gap:2px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;min-width:0;transition:border-color .15s}
  .m-card:hover{border-color:var(--role)}
  .m-card.tried{border-style:dashed}
  .m-glyph{grid-row:1/4;width:34px;height:34px;border-radius:8px;display:grid;place-items:center;background:color-mix(in srgb,var(--role,var(--accent)) 22%,transparent);color:var(--ink);font:600 10px "IBM Plex Mono",monospace;text-align:center;line-height:1.1}
  .m-cname{font:600 13px "IBM Plex Mono",monospace;overflow-wrap:anywhere}
  .m-kind{font-size:12px;color:var(--mute)}
  .m-badges{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
  .m-badges em,.m-pbadges span{font-style:normal;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line)}
  .b-ok{color:var(--accent)} .b-warn{color:var(--warn)} .b-bad{color:var(--bad)} .b-tried{color:var(--mute)}
  .m-steps{list-style:none;margin:0;padding:0;display:grid;gap:10px}
  .m-step{display:grid;grid-template-columns:40px minmax(0,1fr);gap:14px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
  .m-step.done{border-color:var(--accent)}
  .m-snum{font:600 18px "IBM Plex Mono",monospace;color:var(--mute)} .m-step.done .m-snum{color:var(--accent)}
  .m-sbody{display:grid;gap:8px;min-width:0} .m-sbody h3{font:600 15px "IBM Plex Mono",monospace;margin:0} .m-sbody p{margin:0}
  .m-done{justify-self:start}
  .m-tgroup{position:absolute;border:2px solid var(--bg);border-radius:8px;background:color-mix(in srgb,var(--role) 14%,var(--panel));overflow:hidden}
  .m-tlabel{position:absolute;left:6px;top:2px;font:600 11px "IBM Plex Mono",monospace;color:var(--ink);white-space:nowrap}
  .m-tcell{all:unset;box-sizing:border-box;position:absolute;cursor:pointer;border:1px solid var(--bg);border-radius:4px;background:color-mix(in srgb,var(--role) 55%,var(--panel));padding:4px;overflow:hidden;color:#0b0d0c}
  .m-tcell:hover{filter:brightness(1.12)} .m-tcell span{display:block;font:600 11px "IBM Plex Mono",monospace;overflow-wrap:anywhere;line-height:1.2} .m-tcell small{font-size:10px;opacity:.75}
  .m-drive{margin:28px 0 8px;font:12px "IBM Plex Mono",monospace;color:var(--mute)}
  .m-glossary{margin-top:14px} .m-glossary summary{cursor:pointer;font:500 13px "IBM Plex Mono",monospace;color:var(--mute);padding:6px 0}
  .m-glossary .concepts{margin-top:10px}
  .m-scrim{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:20}
  .m-panel{position:fixed;top:0;right:0;bottom:0;width:min(480px,100%);background:var(--panel);border-left:1px solid var(--line);z-index:21;overflow-y:auto;padding:calc(18px + env(safe-area-inset-top,0px)) 20px calc(28px + env(safe-area-inset-bottom,0px))}
  .m-phead{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:12px;align-items:start}
  .m-phead .m-glyph{grid-row:auto;width:40px;height:40px}
  .m-phead h2{font:600 17px "IBM Plex Mono",monospace;margin:0;overflow-wrap:anywhere}
  .m-panel h3{font:500 11px "IBM Plex Mono",monospace;color:var(--mute);letter-spacing:.12em;text-transform:uppercase;margin:18px 0 6px;display:flex;justify-content:space-between;align-items:center}
  .m-panel p{margin:0} .m-panel a{color:var(--accent)}
  .m-pbadges{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
  .m-pfoot{margin-top:22px}
  .m-panel .copy{padding:2px 10px;font-size:12px}
  .sv{display:grid;gap:14px;margin-top:4px}
  .sv-q{border:1px solid var(--line);border-radius:10px;padding:10px 12px 12px;margin:0;min-width:0}
  .sv-q legend{font:500 13px "IBM Plex Sans",sans-serif;color:var(--ink);padding:0 4px}
  .sv-scale{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:6px}
  .sv-scale label,.sv-opts label{cursor:pointer}
  .sv-scale input,.sv-opts input{position:absolute;opacity:0;pointer-events:none}
  .sv-scale span{display:block;text-align:center;padding:8px 0;border:1px solid var(--line);border-radius:8px;font:600 13px "IBM Plex Mono",monospace}
  .sv-opts{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
  .sv-opts span{display:inline-block;padding:6px 10px;border:1px solid var(--line);border-radius:999px;font-size:13px}
  .sv-scale input:checked+span,.sv-opts input:checked+span{background:color-mix(in srgb,var(--accent) 22%,transparent);border-color:var(--accent);color:var(--ink)}
  .sv-scale input:focus-visible+span,.sv-opts input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
  .sv-ends{display:flex;justify-content:space-between;color:var(--mute);margin-top:4px}
  .sv textarea,.sv input[type=text]{width:100%;box-sizing:border-box;margin-top:6px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:14px "IBM Plex Sans",sans-serif;resize:vertical}
  .sv-acts{display:flex;gap:8px;flex-wrap:wrap}
  .sv-saved dt{white-space:normal}
  .m-fscrim{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:30}
  .m-flip{position:fixed;z-index:31;perspective:1400px}
  .m-finner{position:relative;width:100%;height:100%;transform-style:preserve-3d}
  .m-fface{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border-radius:12px;box-sizing:border-box;overflow:hidden}
  .m-ffront{background:color-mix(in srgb,var(--role) 55%,var(--panel));color:#0b0d0c;padding:8px;display:flex;flex-direction:column;justify-content:flex-end;gap:2px}
  .m-ffront span{font:600 14px "IBM Plex Mono",monospace;overflow-wrap:anywhere} .m-ffront small{font-size:11px;opacity:.75}
  .m-fback{transform:rotateY(180deg);background:var(--panel);border:1px solid var(--line);border-top:4px solid var(--role);padding:18px 20px;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
  .m-fback h2{font:600 18px "IBM Plex Mono",monospace;margin:0;overflow-wrap:anywhere}
  .m-fback p{margin:0;font-size:14px}
  .m-fkind{font:500 11px "IBM Plex Mono",monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--mute)}
  .m-fsize{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap} .m-fsize b{font:600 26px "IBM Plex Mono",monospace} .m-fsize span{color:var(--mute);font-size:13px}
  .m-fbar{height:6px;border-radius:3px;background:var(--chip);overflow:hidden} .m-fbar i{display:block;height:100%;background:var(--role)}
  .m-ffits{display:flex;flex-wrap:wrap;gap:6px} .m-ffits span{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--line)}
  .m-facts{display:flex;gap:8px;margin-top:auto;padding-top:6px}
  @media (prefers-reduced-motion: reduce){.m-card{transition:none}}
  `;
  document.head.appendChild(css);

  window.MapView = { html, wire };
})();
