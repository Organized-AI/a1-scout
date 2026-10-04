// A1 Lab: compose stash components into stacks, simulate scenarios on a chosen Mac, and run a simulated test suite.
// Everything here is an estimate from file sizes and published hardware figures; nothing runs on the Mac yet.
// Real offline runs of these tests are Phase 5 of the Lab plan (agent.py lab <stack>).
(() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const gb = b => b == null ? "?" : b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(0) + " MB" : (b / 1e3).toFixed(0) + " KB";
  const secs = s => s < 1 ? `${Math.round(s * 1000)} ms` : s < 90 ? `${s.toFixed(1)} s` : `${(s / 60).toFixed(1)} min`;
  const RM = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const store = { get: (k, d) => window.__a1store?.get(k, d) ?? d, set: (k, v) => window.__a1store?.set(k, v) };

  // Memory bandwidth drives local generation speed. M1 Pro and M4 are published figures; M6 and M5 Pro are assumptions.
  const BW = { m1: { gbs: 200, note: "M1 Pro, published" }, m4: { gbs: 120, note: "M4, published" },
               m6: { gbs: 150, note: "assumed" }, m5p: { gbs: 300, note: "assumed" } };
  const A1_READ = 0.9e9;          // bytes/s off the A1 over USB on a first (uncached) load
  const PERMISSIVE = /^(apache-2\.0|mit|bsd.*|cc-by-4\.0|cc0.*|odc-by|openrail.*)$/i;

  // Templates: roles to fill, scenarios to simulate, words to find related papers.
  const T = {
    rag: { title: "Answer from your docs", tag: "Local RAG", icon: "≈→¶",
      blurb: "Embed your notes once, retrieve the closest passages, rerank them, and have a small model answer with citations.",
      slots: [{ id: "emb", label: "Embedder", kinds: ["embedding"] }, { id: "rr", label: "Reranker", kinds: ["reranker"], optional: true },
              { id: "llm", label: "Answer model", kinds: ["llm", "vlm"] }],
      scenarios: [
        { id: "purch", name: "Why did purchases double last week?", input: "Question over 200 chunks of tracking notes", chunks: 200, cands: 20, prompt: 2400, gen: 180, budget: 15,
          expect: "Cites dedupe-purchase-tag.md and names the duplicate purchase tag.", risk: "Without a reranker the nearest-sounding consent doc can outrank the right one." },
        { id: "consent", name: "Summarize a client's consent setup", input: "50 chunks from one client folder", chunks: 50, cands: 20, prompt: 3200, gen: 320, budget: 20,
          expect: "Lists CMP, consent mode version and which tags wait for consent.", risk: "Long summaries are slow on 16 GB Macs; watch time to first token." },
        { id: "needle", name: "Find the tag that fires on checkout", input: "800 chunks across all GTM exports", chunks: 800, cands: 30, prompt: 1800, gen: 120, budget: 12,
          expect: "Returns the tag name and trigger from the right container.", risk: "Embedding 800 chunks the first time dominates the run; cache the vectors." }],
      words: /retriev|rag|embed|rerank|search|memory/i },
    voice: { title: "Voice assistant", tag: "Hear and speak", icon: "♪→T→♪",
      blurb: "Transcribe speech, think with a small language model, and speak the answer back, all on the Mac.",
      slots: [{ id: "asr", label: "Speech to text", kinds: ["asr"] }, { id: "llm", label: "Brain", kinds: ["llm"] }, { id: "tts", label: "Text to speech", kinds: ["tts"] }],
      scenarios: [
        { id: "ask", name: "\"Did the purchase tag fire?\"", input: "4 s question, 60-token reply, 6 s of speech", audioIn: 4, prompt: 300, gen: 60, audioOut: 6, budget: 4,
          expect: "Reply starts speaking within about 4 seconds.", risk: "A big brain model makes the pause feel broken; voice wants under 4 s." },
        { id: "talk", name: "Transcribe a workshop recording", input: "60 min of audio, 400-token summary", audioIn: 3600, prompt: 6000, gen: 400, audioOut: 0, budget: 900,
          expect: "Timestamped transcript plus a summary.", risk: "Long audio favors the turbo Whisper; full large-v3 is slower for little gain." },
        { id: "vo", name: "Voiceover for a 30 s short", input: "Script in, 30 s of speech out", audioIn: 0, prompt: 200, gen: 0, audioOut: 30, budget: 30,
          expect: "Clean 30 s voice file.", risk: "Some TTS voices are English-only; check the card." }],
      words: /speech|voice|audio|tts|whisper|asr/i },
    scan: { title: "Turn a web page into data", tag: "Site scan", icon: "</>→{ }",
      blurb: "Strip a page to clean Markdown, pull the fields you need, then let a decision model judge the result.",
      slots: [{ id: "read", label: "Page reader", kinds: ["html-reader"] }, { id: "ext", label: "Field extractor", kinds: ["extractor", "llm"], optional: true },
              { id: "dec", label: "Checker", kinds: ["decision"], optional: true }],
      scenarios: [
        { id: "price", name: "Pricing page to JSON", input: "60 KB of HTML, plan and price fields", htmlKB: 60, gen: 500, questions: 2, budget: 25,
          expect: "{ plan, price, interval } for each plan.", risk: "Pages over the reader's context are cut; split by section." },
        { id: "tags", name: "Which tags are on checkout?", input: "120 KB of HTML with scripts", htmlKB: 120, gen: 700, questions: 3, budget: 40,
          expect: "GTM container ID, GA4 and Meta pixel IDs found.", risk: "Readers drop scripts by design; read tag IDs from the raw HTML first." },
        { id: "consent", name: "Is there a consent banner?", input: "40 KB of HTML", htmlKB: 40, gen: 300, questions: 2, budget: 15,
          expect: "Yes/no with the CMP name and a calibrated confidence.", risk: "Banners injected by JavaScript aren't in static HTML." }],
      words: /html|web|page|extract|document|parse/i },
    screen: { title: "Debug tags from a screenshot", tag: "Screen agent", icon: "⌖",
      blurb: "Show a vision model the page, have it say where to click, and check the answer with a decision model.",
      slots: [{ id: "vis", label: "Screen model", kinds: ["ui-agent", "vlm"] }, { id: "dec", label: "Checker", kinds: ["decision"], optional: true }],
      scenarios: [
        { id: "accept", name: "Where is \"Accept all\"?", input: "1440×900 screenshot", patches: 1300, gen: 40, questions: 1, budget: 10,
          expect: "click(x, y) inside the button.", risk: "Small models confuse \"Accept all\" with \"Settings\"." },
        { id: "step", name: "Which checkout step is this?", input: "Screenshot of a checkout page", patches: 1300, gen: 30, questions: 2, budget: 10,
          expect: "Names the step and whether the purchase button is visible.", risk: "Overlays and cookie walls hide the real page." },
        { id: "el", name: "Find the element a tag should fire on", input: "Screenshot plus the trigger's CSS selector", patches: 1300, gen: 80, questions: 2, budget: 15,
          expect: "Coordinates of the element the selector names.", risk: "Selectors can't be seen in pixels; pair with the DOM when you can." }],
      words: /screen|gui|ui|agent|vision|visual/i },
    sql: { title: "Ask your analytics data", tag: "Text to SQL", icon: "SQL",
      blurb: "Write SQL from a plain question, run it with DuckDB on the GA4-shaped sample on the drive, and read the result.",
      slots: [{ id: "sqlm", label: "SQL writer", kinds: ["text-to-sql", "llm-code", "llm"] }, { id: "data", label: "Data", kinds: ["dataset-analytics"] }],
      scenarios: [
        { id: "daily", name: "Purchases per day last week", input: "Schema plus question", prompt: 900, gen: 120, budget: 10,
          expect: "Seven rows of date and purchase count.", risk: "GA4 event params are nested; the model must UNNEST." },
        { id: "top", name: "Top 10 events", input: "Schema plus question", prompt: 700, gen: 80, budget: 8,
          expect: "event_name with counts, descending.", risk: "Low risk; good first test." },
        { id: "funnel", name: "Checkout funnel drop-off", input: "Schema plus a multi-step question", prompt: 1200, gen: 260, budget: 15,
          expect: "Counts at view_item, add_to_cart, begin_checkout, purchase.", risk: "Multi-step SQL is where 3B models slip; check every step." }],
      words: /sql|table|analytic|query|bigquery|tabular/i },
    route: { title: "Route requests to the right model", tag: "Router", icon: "→?",
      blurb: "A small router reads each request and picks a model; a guard screens what comes in before anything runs.",
      slots: [{ id: "rtr", label: "Router", kinds: ["router", "decision"] }, { id: "work", label: "Worker model", kinds: ["llm-code", "llm"] },
              { id: "grd", label: "Guard", kinds: ["guard"], optional: true }],
      scenarios: [
        { id: "code", name: "\"Write a Worker that returns the country\"", input: "Coding request", prompt: 400, gen: 350, questions: 1, budget: 20,
          expect: "Routed to the coding model; working code back.", risk: "Routers trained on other route lists need your route descriptions." },
        { id: "chat", name: "\"Summarize this thread\"", input: "Chat request with 2 KB of text", prompt: 900, gen: 200, questions: 1, budget: 12,
          expect: "Routed to the general model.", risk: "Misroutes cost a slow big-model call." },
        { id: "bad", name: "Prompt-injection attempt", input: "Request hiding \"ignore your instructions\"", prompt: 300, gen: 0, questions: 1, budget: 3,
          expect: "Guard flags it before routing.", risk: "With no guard in the stack this passes straight through." }],
      words: /rout|guard|safety|select|decision/i },
    inside: { title: "Look inside a model", tag: "Interpretability", icon: "◉→",
      blurb: "Run a full-precision model with its activations cached, then read them with the logit lens or a sparse autoencoder.",
      slots: [{ id: "mdl", label: "Model to inspect", kinds: ["interp-model"] }, { id: "sae", label: "Sparse autoencoder", kinds: ["sae"], optional: true }],
      scenarios: [
        { id: "lens", name: "Logit lens on \"The Eiffel Tower is in the city of\"", input: "One prompt, every layer", passes: 1, budget: 20,
          expect: "\"Paris\" appears by the middle layers.", risk: "4-bit copies add noise; use the models/hf full-precision weights." },
        { id: "probe", name: "Probe for city names across layers", input: "2,000 tokens from pile-10k", passes: 40, budget: 120,
          expect: "Accuracy jumps from ~55% to ~90% by layer 4.", risk: "Probing needs labeled tokens; build them first." },
        { id: "feat", name: "Top SAE features on \"Paris\"", input: "One token, one layer", passes: 1, budget: 20,
          expect: "A European-capitals feature is among the top five.", risk: "The SAE must match the model and the hook point exactly." }],
      words: /interpret|sparse|autoencoder|circuit|probe|mechanistic|feature/i },
  };

  // ---------- items and estimates ----------
  let catalog = null, picks = [];
  const classify = i => (window.A1Classify ? window.A1Classify(i) : i.type);
  const items = () => (catalog?.categories || []).flatMap(c => c.items.map(i => ({ ...i, cat: c.id, kind: classify(i) })));
  const usable = i => i.cat === "datasets" ? (i.bytes || 0) > 1e6 : i.cat === "models" && (i.bytes || 0) > 5e7;
  const candidates = slot => items().filter(i => slot.kinds.includes(i.kind) && usable(i))
    .sort((a, b) => slot.kinds.indexOf(a.kind) - slot.kinds.indexOf(b.kind) || a.bytes - b.bytes);
  const runtime = i => i.cat === "datasets" ? "DuckDB" : /\/gguf\//.test(i.path) ? "llama.cpp" : /\/hf\//.test(i.path) ? "PyTorch" : "MLX";
  const isModel = i => i.cat === "models";
  const memNeed = i => (isModel(i) ? i.bytes * 1.2 : 0);
  const glyph = k => window.TYPES?.[k]?.glyph || "•";
  const label = k => window.TYPES?.[k]?.label || k;
  const machines = () => (window.MachineFit ? window.MachineFit(1, "").map(m => ({ id: m.id, label: m.label, gb: m.gb })) : [{ id: "m1", label: "M1 16GB", gb: 16 }]);
  const tps = (i, mid) => Math.min(150, 0.6 * BW[mid].gbs * 1e9 / Math.max(i.bytes, 1e8));

  function stageTime(slotId, i, sc, mid) {
    const scale = Math.max(i.bytes, 1e8) / 0.35e9;
    switch (i.kind) {
      case "embedding": return { s: (sc.chunks || 20) * 0.012 * scale, what: `embed ${sc.chunks || 20} chunks` };
      case "reranker": return { s: (sc.cands || 20) * 0.035 * scale, what: `rerank ${sc.cands || 20} candidates` };
      case "asr": return sc.audioIn ? { s: sc.audioIn * (0.04 + 0.025 * i.bytes / 1e9), what: `transcribe ${secs(sc.audioIn)} of audio` } : { s: 0, what: "skipped (no audio in)" };
      case "tts": return sc.audioOut ? { s: sc.audioOut * (0.25 + 0.1 * i.bytes / 1e9), what: `speak ${secs(sc.audioOut)}` } : { s: 0, what: "skipped (no audio out)" };
      case "decision": case "guard": return { s: (sc.questions || 1) * 0.18 * Math.max(1, i.bytes / 1e9), what: `${sc.questions || 1} typed question(s)` };
      case "dataset-analytics": return { s: 0.25, what: "DuckDB over Parquet" };
      case "sae": return { s: (sc.passes || 1) * 0.3, what: "encode activations" };
      case "interp-model": return { s: (sc.passes || 1) * (0.4 + i.bytes / 1e9), what: `${sc.passes || 1} forward pass(es) with cache, CPU` };
      default: {
        const t = tps(i, mid);
        const prompt = sc.prompt || (sc.htmlKB ? sc.htmlKB * 250 : 0) + (sc.patches || 0);
        if (slotId === "rtr") return { s: prompt / (t * 8) + 8 / t, what: "pick a route" };
        if (!sc.gen && !prompt) return { s: 0, what: "skipped" };
        return { s: prompt / (t * 8) + (sc.gen || 0) / t, what: `${prompt} prompt + ${sc.gen || 0} new tokens at ~${t.toFixed(0)} tok/s`, tps: t };
      }
    }
  }

  function evaluate(st) {
    const tpl = T[st.tpl], sc = tpl.scenarios.find(x => x.id === st.sc) || tpl.scenarios[0];
    const mach = machines().find(m => m.id === st.mach) || machines()[0];
    const all = items();
    const comps = tpl.slots.map(sl => ({ slot: sl, item: all.find(i => i.path === st.pick[sl.id]) || null }));
    const filled = comps.filter(c => c.item);
    const runtimes = [...new Set(filled.map(c => runtime(c.item)))];
    const peak = filled.reduce((t, c) => t + memNeed(c.item), 0) + runtimes.filter(r => r !== "DuckDB").length * 0.4e9;
    const budget = mach.gb * 2 ** 30 * 0.75;
    const stages = filled.map(c => ({ ...c, ...stageTime(c.slot.id, c.item, sc, mach.id), load: isModel(c.item) ? c.item.bytes / A1_READ : 0 }));
    const total = stages.reduce((t, s) => t + s.s, 0), firstLoad = stages.reduce((t, s) => t + s.load, 0);
    const wheels = all.filter(i => i.cat === "wheels").map(i => i.name);
    const code = all.filter(i => i.cat === "code").map(i => i.name.toLowerCase());
    const offline = { MLX: wheels.includes("macos-arm64"), PyTorch: wheels.includes("interp"), "llama.cpp": code.some(n => n.includes("llama.cpp")), DuckDB: true };
    const lic = filled.map(c => ({ name: c.item.name, lic: c.item.meta?.license || null, ok: PERMISSIVE.test(c.item.meta?.license || "") }));
    const missing = comps.filter(c => !c.item && !c.slot.optional);
    const tests = [
      { id: "present", name: "Every required part is on the A1", st: missing.length ? "fail" : "pass",
        why: missing.length ? `Missing: ${missing.map(c => c.slot.label).join(", ")}. Approve one in Scout.` : `${filled.length} parts found on the drive.` },
      { id: "fit", name: `Fits ${mach.label} with everything loaded`, st: peak <= budget ? "pass" : "fail",
        why: `${gb(peak)} needed of ${gb(budget)} usable (macOS lets models use about 75% of memory).` },
      { id: "offline", name: "Every runtime installs with the network off", st: runtimes.every(r => offline[r]) ? "pass" : "warn",
        why: runtimes.map(r => `${r}: ${offline[r] ? "on the drive" : "not on the drive yet"}`).join(" · ") + (runtimes.length > 1 ? ` · ${runtimes.length} venvs` : "") },
      { id: "license", name: "Licenses allow client work", st: lic.every(l => l.ok) ? "pass" : "warn",
        why: lic.filter(l => !l.ok).map(l => `${l.name}: ${l.lic || "no license listed"}`).join(" · ") || "All permissive." },
      { id: "budget", name: `Answers within ${secs(sc.budget)} (warm)`, st: !filled.length ? "fail" : total <= sc.budget ? "pass" : "fail",
        why: `Estimated ${secs(total)} per request once loaded; first load adds ${secs(firstLoad)} reading weights off the A1.` },
      { id: "quality", name: "Output matches the expected answer", st: "pending", why: `${sc.expect} Runs for real on the Mac in Phase 5, scored by a jev-gateway rubric.` },
    ];
    return { tpl, sc, mach, comps, stages, total, firstLoad, peak, budget, runtimes, tests };
  }

  // ---------- state ----------
  let st = store.get("a1-lab", null);
  const defaults = tplId => {
    const tpl = T[tplId], pick = {};
    tpl.slots.forEach(sl => { const c = candidates(sl); const fit = c.find(i => memNeed(i) < 6e9) || c[0]; if (fit && !(sl.optional && sl.id === "ext")) pick[sl.id] = fit.path; });
    return { tpl: tplId, sc: tpl.scenarios[0].id, mach: "m1", pick };
  };
  const save = () => store.set("a1-lab", st);
  const saved = () => store.get("a1-lab-saved", []);

  // ---------- rendering ----------
  function papersFor(tpl) {
    return (picks || []).filter(p => p.kind === "paper" && tpl.words.test(`${p.title || ""} ${p.summary || ""}`)).slice(0, 4);
  }
  function html(cat, pk) {
    catalog = cat; picks = pk || [];
    if (!st || !T[st.tpl]) st = defaults("rag");
    const e = evaluate(st);
    const P = papersFor(e.tpl);
    const pass = e.tests.filter(t => t.st === "pass").length;
    return `<div class="lab">
      <header class="lab-hero"><span class="lab-kick">Lab · simulated</span>
        <h2>Build a stack. See how it would run.</h2>
        <p>Pick a job, choose parts from what's on the A1, and pick a Mac. The Lab estimates memory, speed and load time from file sizes, then runs a simulated test suite. Real offline runs come later; nothing here touches the drive.</p></header>
      <div class="lab-tpls" role="tablist" aria-label="Stack templates">${Object.entries(T).map(([id, t]) => `
        <button type="button" class="lab-tpl" role="tab" aria-selected="${id === st.tpl}" data-tpl="${id}"><span class="lab-ic">${esc(t.icon)}</span><b>${esc(t.title)}</b><small>${esc(t.tag)}</small></button>`).join("")}</div>
      <div class="lab-grid">
        <section class="lab-panel">
          <div class="lab-h"><span class="lab-kick">1 · Parts</span><span class="lab-mut">${esc(e.tpl.blurb)}</span></div>
          ${e.tpl.slots.map(sl => { const c = candidates(sl); const cur = st.pick[sl.id] || "";
            return `<label class="lab-slot"><span class="lab-sl">${esc(sl.label)}${sl.optional ? " <em>optional</em>" : ""}</span>
              <select data-slot="${sl.id}" id="lab-${sl.id}">${sl.optional || !c.length ? `<option value="">${c.length ? "None" : "Nothing on the A1 for this yet"}</option>` : ""}
                ${c.map(i => `<option value="${esc(i.path)}"${i.path === cur ? " selected" : ""}>${esc(i.name)} · ${gb(i.bytes)} · ${runtime(i)}</option>`).join("")}</select></label>`; }).join("")}
          <div class="lab-h" style="margin-top:14px"><span class="lab-kick">2 · Mac</span></div>
          <div class="lab-machs">${machines().map(m => `<button type="button" class="lab-mach" data-mach="${m.id}" aria-pressed="${m.id === st.mach}">${esc(m.label)}<small>${BW[m.id]?.gbs || "?"} GB/s${BW[m.id]?.note === "assumed" ? " · assumed" : ""}</small></button>`).join("")}</div>
          <div class="lab-h" style="margin-top:14px"><span class="lab-kick">3 · Scenario</span></div>
          <div class="lab-scs">${e.tpl.scenarios.map(s => `<button type="button" class="lab-sc" data-sc="${s.id}" aria-pressed="${s.id === e.sc.id}"><b>${esc(s.name)}</b><small>${esc(s.input)}</small></button>`).join("")}</div>
          <p class="lab-risk"><b>Likely to go wrong:</b> ${esc(e.sc.risk)}</p>
        </section>
        <section class="lab-panel lab-sim">
          <div class="lab-h"><span class="lab-kick">Simulation</span><button type="button" class="lab-btn go" data-run>▶ Run simulation</button></div>
          <div class="lab-pipe">${e.stages.length ? e.stages.map((s, k) => `${k ? '<i class="lab-wire"><b></b></i>' : ""}<div class="lab-node" data-k="${k}"><span class="lab-g">${esc(glyph(s.item.kind))}</span><b>${esc(s.item.name)}</b><small>${esc(label(s.item.kind))} · ${gb(s.item.bytes)}</small><em data-t="${k}">${secs(s.s)}</em></div>`).join("") : '<p class="lab-mut">Choose parts to see the pipeline.</p>'}</div>
          <div class="lab-stats">
            <div><span>Per request (warm)</span><b data-n="total">${secs(e.total)}</b></div>
            <div><span>First load off the A1</span><b>${secs(e.firstLoad)}</b></div>
            <div><span>Peak memory</span><b class="${e.peak > e.budget ? "bad" : ""}">${gb(e.peak)}</b></div>
            <div><span>Runtimes</span><b>${esc(e.runtimes.join(" + ") || "—")}</b></div></div>
          <div class="lab-mem" aria-label="Memory use against the usable budget">
            ${e.stages.filter(s => isModel(s.item)).map((s, k) => `<i style="width:${Math.min(100, memNeed(s.item) / (e.mach.gb * 2 ** 30) * 100)}%" class="c${k % 4}" title="${esc(s.item.name)} ${gb(memNeed(s.item))}"></i>`).join("")}
            <span class="lab-budget" style="left:75%"></span></div>
          <div class="lab-memleg"><span>${gb(e.peak)} of ${e.mach.gb} GB</span><span>75% usable line</span></div>
          <ol class="lab-log" aria-live="polite">${e.stages.map(s => `<li><b>${esc(s.slot.label)}</b> ${esc(s.what)} <em>${secs(s.s)}</em></li>`).join("")}</ol>
        </section>
      </div>
      <section class="lab-panel lab-tests">
        <div class="lab-h"><span class="lab-kick">Test suite · ${pass} of ${e.tests.length} passing</span><span class="lab-spacer"></span>
          <button type="button" class="lab-btn" data-tests>Run tests</button><button type="button" class="lab-btn" data-save>Save stack</button></div>
        <ul class="lab-tlist">${e.tests.map(t => `<li class="lab-t ${t.st}" data-test="${t.id}"><span class="lab-ts">${{ pass: "✓", fail: "✗", warn: "!", pending: "…" }[t.st]}</span><div><b>${esc(t.name)}</b><small>${esc(t.why)}</small></div></li>`).join("")}</ul>
        ${saved().length ? `<div class="lab-saved"><span class="lab-kick">Saved stacks</span>${saved().map((s, k) => `<button type="button" class="lab-chip" data-load="${k}">${esc(T[s.tpl]?.tag || s.tpl)} · ${esc(Object.values(s.pick).map(p => p.split("/").pop()).join(" + "))}</button>`).join("")}</div>` : ""}
      </section>
      <section class="lab-panel">
        <div class="lab-h"><span class="lab-kick">Papers behind this stack</span></div>
        ${P.length ? `<ul class="lab-papers">${P.map(p => `<li><a href="https://arxiv.org/abs/${esc(p.repo)}" target="_blank" rel="noopener">${esc(p.title || p.repo)}</a><small>${esc(p.repo)} · ${p.status === "stashed" ? "on the A1" : p.status}</small></li>`).join("")}</ul>`
          : `<p class="lab-mut">No scouted papers match this job yet. Adding arXiv papers by ID is Phase 1 of the Lab plan.</p>`}
      </section>
    </div>`;
  }

  function animateSim(root) {
    const nodes = $$(".lab-node", root), wires = $$(".lab-wire b", root), logs = $$(".lab-log li", root);
    if (RM() || !window.gsap) { nodes.forEach(n => n.classList.add("done")); return; }
    const e = evaluate(st), times = e.stages.map(s => s.s), sum = times.reduce((a, b) => a + b, 0) || 1;
    const tl = gsap.timeline();
    tl.set(nodes, { className: "lab-node" }).set(logs, { opacity: .25 }).set(wires, { scaleX: 0 });
    nodes.forEach((n, k) => {
      const d = Math.max(.35, Math.min(1.6, times[k] / sum * 4));
      const t = $(`[data-t="${k}"]`, root), o = { v: 0 };
      tl.add(() => n.classList.add("live"))
        .fromTo(n, { scale: .96 }, { scale: 1.04, duration: .18, yoyo: true, repeat: 1 })
        .to(logs[k] || {}, { opacity: 1, duration: .2 }, "<")
        .fromTo(o, { v: 0 }, { v: times[k], duration: d, ease: "none", onUpdate: () => t && (t.textContent = secs(o.v)) }, "<")
        .add(() => { n.classList.remove("live"); n.classList.add("done"); });
      if (wires[k]) tl.to(wires[k], { scaleX: 1, duration: .35, ease: "power1.inOut" });
    });
    const tot = $('[data-n="total"]', root), o2 = { v: 0 };
    tl.fromTo(o2, { v: 0 }, { v: e.total, duration: .6, onUpdate: () => tot && (tot.textContent = secs(o2.v)) });
  }
  function animateTests(root) {
    const rows = $$(".lab-t", root);
    if (RM() || !window.gsap) return;
    const tl = gsap.timeline();
    tl.set(rows, { opacity: .2, x: -8 });
    rows.forEach(r => tl.to(r, { opacity: 1, x: 0, duration: .25 }).fromTo($(".lab-ts", r), { scale: 0 }, { scale: 1, duration: .35, ease: "back.out(3)" }, "<.1")
      .add(() => { if (r.classList.contains("fail")) gsap.fromTo(r, { x: -4 }, { x: 0, duration: .4, ease: "elastic.out(1,.4)" }); }));
  }

  function wire(first, rerender) {
    const root = $(".lab"); if (!root) return;
    const redo = () => { save(); rerender(); };
    $$("[data-tpl]", root).forEach(b => b.onclick = () => { st = defaults(b.dataset.tpl); redo(); });
    $$("[data-slot]", root).forEach(s => s.onchange = () => { if (s.value) st.pick[s.dataset.slot] = s.value; else delete st.pick[s.dataset.slot]; redo(); });
    $$("[data-mach]", root).forEach(b => b.onclick = () => { st.mach = b.dataset.mach; redo(); });
    $$("[data-sc]", root).forEach(b => b.onclick = () => { st.sc = b.dataset.sc; redo(); });
    $("[data-run]", root)?.addEventListener("click", () => animateSim(root));
    $("[data-tests]", root)?.addEventListener("click", () => animateTests(root));
    $("[data-save]", root)?.addEventListener("click", e => { const s = saved(); s.unshift(JSON.parse(JSON.stringify(st))); store.set("a1-lab-saved", s.slice(0, 8)); e.target.textContent = "Saved"; setTimeout(rerender, 600); });
    $$("[data-load]", root).forEach(b => b.onclick = () => { st = JSON.parse(JSON.stringify(saved()[+b.dataset.load])); redo(); });
    if (first && window.gsap && !RM()) gsap.from($$(".lab-hero > *, .lab-tpl, .lab-panel", root), { y: 14, opacity: .2, duration: .45, stagger: .03, ease: "power2.out", clearProps: "transform,opacity" });
  }

  window.LabView = { html, wire, evaluate: s => evaluate(s), templates: T, _setCatalog: (c, p) => { catalog = c; picks = p || []; }, _defaults: id => defaults(id) };

  const css = document.createElement("style");
  css.textContent = `
  .lab{display:grid;gap:16px}
  .lab-kick{font:500 11px "IBM Plex Mono",monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
  .lab-mut{color:var(--mute);font-size:13px}
  .lab-hero{border:1px solid var(--line);border-radius:12px;padding:22px 22px 18px;background:linear-gradient(180deg,color-mix(in srgb,var(--brand) 6%,var(--panel)),var(--panel))}
  .lab-hero h2{font:600 clamp(22px,3.4vw,32px)/1.15 "IBM Plex Mono",monospace;margin:8px 0}
  .lab-hero p{font:16px/1.6 "Source Serif 4",Georgia,serif;color:var(--mute);margin:0;max-width:66ch}
  .lab-tpls{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
  .lab-tpl{all:unset;box-sizing:border-box;cursor:pointer;display:grid;gap:4px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
  .lab-tpl b{font:600 13px "IBM Plex Mono",monospace}.lab-tpl small{color:var(--mute);font-size:12px}
  .lab-tpl[aria-selected=true]{border-color:var(--brand);box-shadow:0 0 0 1px var(--brand) inset}
  .lab-tpl:focus-visible,.lab-btn:focus-visible,.lab-mach:focus-visible,.lab-sc:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .lab-ic{font:600 12px "IBM Plex Mono",monospace;color:var(--accent)}
  .lab-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:16px}
  @media(max-width:900px){.lab-grid{grid-template-columns:1fr}}
  .lab-panel{border:1px solid var(--line);border-radius:12px;padding:16px;background:var(--panel);min-width:0}
  .lab-h{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}.lab-spacer{flex:1}
  .lab-slot{display:grid;gap:4px;margin-bottom:10px}.lab-sl{font:500 12px "IBM Plex Mono",monospace}.lab-sl em{color:var(--mute);font-style:normal}
  .lab-slot select{width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:13px "IBM Plex Sans",sans-serif;min-height:40px}
  .lab-machs{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px}
  .lab-mach{all:unset;box-sizing:border-box;cursor:pointer;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font:600 12.5px "IBM Plex Mono",monospace;display:grid}
  .lab-mach small{font:400 11px "IBM Plex Sans",sans-serif;color:var(--mute)}
  .lab-mach[aria-pressed=true]{background:var(--brand);color:var(--on-brand);border-color:var(--brand)}.lab-mach[aria-pressed=true] small{color:var(--on-brand)}
  .lab-scs{display:grid;gap:6px}
  .lab-sc{all:unset;box-sizing:border-box;cursor:pointer;padding:9px 11px;border:1px solid var(--line);border-radius:8px;display:grid;gap:2px}
  .lab-sc b{font:600 13px "IBM Plex Sans",sans-serif}.lab-sc small{color:var(--mute);font-size:12px}
  .lab-sc[aria-pressed=true]{border-color:var(--brand)}
  .lab-risk{margin:10px 0 0;font-size:13px;color:var(--mute)}.lab-risk b{color:var(--warn)}
  .lab-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:7px 12px;border:1px solid var(--line);border-radius:8px;font:500 12.5px "IBM Plex Mono",monospace;min-height:36px;display:inline-flex;align-items:center}
  .lab-btn.go{background:var(--brand);color:var(--on-brand);border-color:var(--brand);margin-left:auto}
  .lab-pipe{display:flex;align-items:stretch;gap:0;overflow-x:auto;padding:6px 2px 10px}
  .lab-node{flex:1 1 0;min-width:120px;border:1px solid var(--line);border-radius:10px;padding:10px;display:grid;gap:3px;background:var(--bg);transition:border-color .2s,box-shadow .2s}
  .lab-node b{font:600 12px "IBM Plex Mono",monospace;overflow-wrap:anywhere}.lab-node small{color:var(--mute);font-size:11.5px}
  .lab-node em{font:600 12px "IBM Plex Mono",monospace;font-style:normal;color:var(--accent);font-variant-numeric:tabular-nums}
  .lab-g{font:600 13px "IBM Plex Mono",monospace;color:var(--accent)}
  .lab-node.live{border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 30%,transparent)}
  .lab-node.done{border-color:color-mix(in srgb,var(--brand) 55%,var(--line))}
  .lab-wire{flex:0 0 22px;align-self:center;height:2px;background:var(--line);position:relative}
  .lab-wire b{position:absolute;inset:0;background:var(--brand);transform-origin:left;transform:scaleX(0)}
  .lab-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:6px 0 12px}
  @media(max-width:620px){.lab-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
  .lab-stats div{border:1px solid var(--line);border-radius:8px;padding:8px 10px;display:grid;gap:2px}
  .lab-stats span{font:11px "IBM Plex Mono",monospace;color:var(--mute)}
  .lab-stats b{font:600 17px "IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}.lab-stats b.bad{color:var(--bad)}
  .lab-mem{position:relative;height:14px;border-radius:7px;background:var(--chip);border:1px solid var(--line);display:flex;overflow:hidden}
  .lab-mem i{display:block;height:100%}.lab-mem .c0{background:var(--accent)}.lab-mem .c1{background:#6cc4f2}.lab-mem .c2{background:#b99cf2}.lab-mem .c3{background:#7cf2a0}
  .lab-budget{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--bad)}
  .lab-memleg{display:flex;justify-content:space-between;font:11px "IBM Plex Mono",monospace;color:var(--mute);margin:4px 0 10px}
  .lab-log{margin:0;padding-left:18px;display:grid;gap:4px;font-size:13px}.lab-log em{font-style:normal;color:var(--mute);font-family:"IBM Plex Mono",monospace}
  .lab-tlist{list-style:none;margin:0;padding:0;display:grid;gap:6px}
  .lab-t{display:grid;grid-template-columns:26px minmax(0,1fr);gap:10px;align-items:start;border:1px solid var(--line);border-radius:8px;padding:9px 10px}
  .lab-t b{font:600 13px "IBM Plex Sans",sans-serif}.lab-t small{display:block;color:var(--mute);font-size:12.5px;line-height:1.45}
  .lab-ts{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font:700 12px "IBM Plex Mono",monospace;border:1px solid var(--line)}
  .lab-t.pass .lab-ts{background:var(--accent);color:var(--on-brand);border-color:var(--accent)}
  .lab-t.fail{border-color:color-mix(in srgb,var(--bad) 50%,var(--line))}.lab-t.fail .lab-ts{background:var(--bad);color:var(--bg);border-color:var(--bad)}
  .lab-t.warn .lab-ts{color:var(--warn);border-color:var(--warn)}.lab-t.pending .lab-ts{color:var(--mute)}
  .lab-saved{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:12px}
  .lab-chip{all:unset;cursor:pointer;border:1px solid var(--line);border-radius:999px;padding:3px 10px;font:12px "IBM Plex Mono",monospace}
  .lab-papers{margin:0;padding-left:18px;display:grid;gap:6px}.lab-papers small{display:block;color:var(--mute);font-size:12px}.lab-papers a{color:var(--ink)}
  `;
  document.head.appendChild(css);
})();
