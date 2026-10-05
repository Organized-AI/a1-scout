// A1 Lab: compose stash components into stacks, simulate scenarios on a chosen Mac, and run a simulated test suite.
// Estimates come from file sizes and published hardware figures. When a model has A1 Bench runs (bench.js,
// agent.py bench), its measured tok/s, peak memory, load time and pass rate replace the estimates.
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
    loop: { title: "GTM autoresearch loop", tag: "Autoresearch", icon: "↻✓",
      blurb: "The gtm-autoresearch loop with local parts: a model proposes container edits, a decision model gates each one before it is kept, a privacy filter checks payloads, and a forecaster watches for drift. Claude can stay the proposer; every check here runs on the Mac.",
      slots: [{ id: "gate", label: "Change gate", kinds: ["decision"] }, { id: "mut", label: "Local proposer", kinds: ["llm-code", "llm"], optional: true },
              { id: "pii", label: "Privacy filter", kinds: ["pii"], optional: true }, { id: "drift", label: "Drift check", kinds: ["forecaster"], optional: true }],
      scenarios: [
        { id: "gate", name: "Gate one proposed change", input: "A container diff plus 4 typed questions (fires? loses or double counts? risk? area?)", questions: 4, budget: 3,
          expect: "Keep or revert with a probability; anything over 0.3 on \"breaks a conversion\" is reverted even if the score went up.", risk: "Thresholds come from your ledger: replay kept vs reverted rounds before trusting a cut-off." },
        { id: "round", name: "One round: 3 candidates, gated", input: "Prompt of 6k tokens, 3 candidate edits of ~1.2k tokens each, 4 questions per candidate", prompt: 6000, gen: 3600, questions: 12, budget: 240,
          expect: "Three candidates proposed locally, the bad ones dropped before scoring and Playwright.", risk: "Small local proposers write invalid container JSON more often; keep the JSON check and its retry budget." },
        { id: "night", name: "Overnight, zero egress", input: "30 rounds × 3 candidates on the laptop, no cloud calls", prompt: 180000, gen: 108000, questions: 360, piiKB: 60, budget: 6 * 3600,
          expect: "A winning workspace and a full ledger by morning for a client whose data can't leave the machine.", risk: "Overnight on a 16 GB Mac means one model loaded at a time; the gate and proposer swap in and out." },
        { id: "pii", name: "Is there personal data in this push?", input: "A 2 KB dataLayer push and its URL parameters", piiKB: 2, questions: 1, budget: 1,
          expect: "Email, phone and name spans flagged before the event leaves the page or the server container.", risk: "Hashed values look random to the filter; check hashing separately." },
        { id: "drift", name: "Did purchases drop after the change?", input: "180 days of daily purchases, forecast the last 14", series: 180, horizon: 14, questions: 1, budget: 10,
          expect: "Days that fall under the forecast's low band are flagged for a tag check.", risk: "Sales and holidays look like drops; give it a full year when you have it." }],
      words: /autoresearch|evolution|optimi|privacy|pii|forecast|decision|calibrat/i },
    skills: { title: "Pick a skill before loading it", tag: "Skill Loop router", icon: "?→1",
      blurb: "Skill Loop's select-skill route, run locally: the task and every installed skill's name and description go to a decision model, one yes/no per skill, and only the chosen skill's instructions enter the context. An embedder can shortlist first so fewer questions are asked.",
      slots: [{ id: "sel", label: "Selector", kinds: ["decision"] }, { id: "emb", label: "Shortlist embedder", kinds: ["embedding"], optional: true },
              { id: "work", label: "Agent model", kinds: ["llm", "llm-code"], optional: true }],
      scenarios: [
        { id: "pick", name: "Pick one of 67 skills", input: "One task, 67 skill names and descriptions, one yes/no each", questions: 67, chunks: 0, budget: 3,
          expect: "One skill picked at 0.75 or more, or a top-3 shortlist, or nothing when no skill fits; about 114k tokens of skill bodies never loaded.", risk: "A false pick loads the wrong instructions silently; the gateway's target is zero false picks when nothing fits." },
        { id: "short", name: "Shortlist with embeddings, then ask 10", input: "Embed the task against 67 cached skill descriptions, ask the top 10", chunks: 1, questions: 10, budget: 2,
          expect: "Same pick with a sixth of the questions.", risk: "If the embedder drops the right skill from the 10, the selector can't recover it; measure top-10 recall first." },
        { id: "nightly", name: "Nightly regression: 40 fixtures", input: "40 recorded tasks with known right skills, 67 questions each", questions: 2680, chunks: 0, budget: 1800,
          expect: "Decided precision and top-3 recall per rubric version, compared with last night's.", risk: "Fixtures go stale as skills change; refresh them from /v1/skill-outcome results." }],
      words: /skill|route|select|retriev|decision|calibrat/i },
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
  const memNeed = i => (isModel(i) ? measured(i, null)?.peak_rss || i.bytes * 1.2 : 0);
  const glyph = k => window.TYPES?.[k]?.glyph || "•";
  const label = k => window.TYPES?.[k]?.label || k;
  const machines = () => (window.MachineFit ? window.MachineFit(1, "").map(m => ({ id: m.id, label: m.label, gb: m.gb })) : [{ id: "m1", label: "M1 16GB", gb: 16 }]);
  const tps = (i, mid) => Math.min(150, 0.6 * BW[mid].gbs * 1e9 / Math.max(i.bytes, 1e8));
  // Measured beats estimated: A1 Bench numbers for this model (speed and load on this Mac, memory from any Mac).
  const measured = (i, mid) => (window.BenchView && i?.path ? window.BenchView.measured(i.path, mid) : null);
  const SUITE_FOR = { rag: "rag-notes", voice: "asr", scan: "html-json", screen: "screen", sql: "sql-ga4", loop: "gtm-gate", skills: "skill-select" };
  // the part whose quality the suite measures; checked first, then any other part with a run
  const SUITE_SLOT = { rag: "llm", voice: "asr", scan: "ext", screen: "vis", sql: "sqlm", loop: "gate", skills: "sel" };
  // The model the bench picked for this job on this Mac (it searched every model that fits), for that template's main slot.
  const benchPick = (tplId, slotId, mid) => (SUITE_SLOT[tplId] === slotId && window.BenchView?.best?.(SUITE_FOR[tplId], mid)?.model_path) || null;

  function stageTime(slotId, i, sc, mid) {
    const scale = Math.max(i.bytes, 1e8) / 0.35e9;
    switch (i.kind) {
      case "embedding": return sc.chunks === 0 ? { s: 0, what: "skipped (no shortlist in this scenario)" } : { s: (sc.chunks || 20) * 0.012 * scale, what: `embed ${sc.chunks || 20} chunks` };
      case "reranker": return { s: (sc.cands || 20) * 0.035 * scale, what: `rerank ${sc.cands || 20} candidates` };
      case "asr": return sc.audioIn ? { s: sc.audioIn * (0.04 + 0.025 * i.bytes / 1e9), what: `transcribe ${secs(sc.audioIn)} of audio` } : { s: 0, what: "skipped (no audio in)" };
      case "tts": return sc.audioOut ? { s: sc.audioOut * (0.25 + 0.1 * i.bytes / 1e9), what: `speak ${secs(sc.audioOut)}` } : { s: 0, what: "skipped (no audio out)" };
      case "decision": case "guard": {
        // decision-model bench runs report questions per second as tok_s; scale it to this scenario's question count
        const qps = i.kind === "decision" ? measured(i, mid)?.tok_s : null;
        return qps ? { s: (sc.questions || 1) / qps, what: `${sc.questions || 1} typed question(s) at ${qps.toFixed(1)}/s, measured`, measured: true }
                   : { s: (sc.questions || 1) * 0.18 * Math.max(1, i.bytes / 1e9), what: `${sc.questions || 1} typed question(s)` };
      }
      case "pii": return sc.piiKB ? { s: sc.piiKB * 0.02 * Math.max(1, i.bytes / 1e9), what: `scan ${sc.piiKB} KB for personal data` } : { s: 0, what: "skipped (nothing to scan)" };
      case "forecaster": return sc.series ? { s: 0.4 + i.bytes / 1e9, what: `forecast ${sc.horizon} days from ${sc.series}` } : { s: 0, what: "skipped (no series)" };
      case "dataset-analytics": return { s: 0.25, what: "DuckDB over Parquet" };
      case "sae": return { s: (sc.passes || 1) * 0.3, what: "encode activations" };
      case "interp-model": return { s: (sc.passes || 1) * (0.4 + i.bytes / 1e9), what: `${sc.passes || 1} forward pass(es) with cache, CPU` };
      default: {
        const real = measured(i, mid)?.tok_s;
        const t = real || tps(i, mid);
        const prompt = sc.prompt || (sc.htmlKB ? sc.htmlKB * 250 : 0) + (sc.patches || 0);
        if (slotId === "rtr") return { s: prompt / (t * 8) + 8 / t, what: "pick a route", measured: !!real };
        if (!sc.gen && !prompt) return { s: 0, what: "skipped" };
        return { s: prompt / (t * 8) + (sc.gen || 0) / t, what: `${prompt} prompt + ${sc.gen || 0} new tokens at ${real ? "" : "~"}${t.toFixed(0)} tok/s${real ? " (measured)" : ""}`, tps: t, measured: !!real };
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
    // ~0.4 GB per runtime, except where measured peak memory already includes it
    const overhead = runtimes.filter(r => r !== "DuckDB" && filled.some(c => runtime(c.item) === r && !measured(c.item, null)?.peak_rss));
    const peak = filled.reduce((t, c) => t + memNeed(c.item), 0) + overhead.length * 0.4e9;
    const budget = mach.gb * 2 ** 30 * 0.75;
    const stages = filled.map(c => { const m = measured(c.item, mach.id);
      return { ...c, ...stageTime(c.slot.id, c.item, sc, mach.id), load: isModel(c.item) ? m?.load_s ?? c.item.bytes / A1_READ : 0, loadMeasured: m?.load_s != null }; });
    const total = stages.reduce((t, s) => t + s.s, 0), firstLoad = stages.reduce((t, s) => t + s.load, 0);
    const wheels = all.filter(i => i.cat === "wheels").map(i => i.name);
    const code = all.filter(i => i.cat === "code").map(i => i.name.toLowerCase());
    const offline = { MLX: wheels.includes("macos-arm64"), PyTorch: wheels.includes("interp") || wheels.includes("kev"), "llama.cpp": code.some(n => n.includes("llama.cpp")), DuckDB: true };
    const lic = filled.map(c => ({ name: c.item.name, lic: c.item.meta?.license || null, ok: PERMISSIVE.test(c.item.meta?.license || "") }));
    const missing = comps.filter(c => !c.item && !c.slot.optional);
    const suite = SUITE_FOR[st.tpl];
    const ordered = [...filled].sort((a, b) => (b.slot.id === SUITE_SLOT[st.tpl]) - (a.slot.id === SUITE_SLOT[st.tpl]));
    const q = suite && window.BenchView ? ordered.map(c => window.BenchView.suiteResult(c.item.path, suite)).find(Boolean) : null;
    const rate = q ? q.passed / Math.max(1, q.total) : null;
    const nMeasured = stages.filter(s => s.measured || s.loadMeasured).length;
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
      q ? { id: "quality", name: "Output matches the expected answer", st: rate >= 0.75 ? "pass" : rate >= 0.5 ? "warn" : "fail",
            why: `Measured: ${q.model} passed ${q.passed} of ${q.total} ${window.BenchView.suites?.[suite]?.label || suite} tasks (score ${Math.round(q.score * 100)}) on ${machines().find(m => m.id === q.machine)?.label || window.BenchView.machLabel?.(q.machine) || q.machine}.` }
        : { id: "quality", name: "Output matches the expected answer", st: "pending",
            why: `${sc.expect} ${suite ? `Not benchmarked yet: run agent.py bench ${suite} with the A1 plugged in.` : "No bench suite covers this job yet."}` },
    ];
    return { tpl, sc, mach, comps, stages, total, firstLoad, peak, budget, runtimes, tests, measured: nMeasured, quality: q };
  }

  // ---------- state ----------
  let st = store.get("a1-lab", null);
  const defaults = tplId => {
    const tpl = T[tplId], pick = {};
    tpl.slots.forEach(sl => { const c = candidates(sl); const fit = c.find(i => memNeed(i) < 6e9) || c[0]; if (fit && !(sl.optional && sl.id === "ext")) pick[sl.id] = fit.path;
      const bp = benchPick(tplId, sl.id, "m1");               // the bench's pick beats the smallest-that-fits guess
      if (bp && c.some(i => i.path === bp)) pick[sl.id] = bp; });
    return { tpl: tplId, sc: tpl.scenarios[0].id, mach: "m1", pick };
  };
  const save = () => store.set("a1-lab", st);
  const saved = () => store.get("a1-lab-saved", []);


  // ---------- game layer: XP, levels, missions, stack grade ----------
  const fresh = () => ({ xp: 0, runs: 0, tried: [], green: [], macs: {}, done: [], seen: {} });
  const game = () => ({ ...fresh(), ...(store.get("a1-lab-game", null) || {}) });
  const saveGame = g => store.set("a1-lab-game", g);
  const LEVELS = ["Tinkerer", "Builder", "Stack smith", "Pipeline pilot", "Systems wizard", "A1 Architect"];
  const levelOf = xp => { const n = Math.floor(Math.sqrt(xp / 40)); return { n: n + 1, title: LEVELS[Math.min(n, LEVELS.length - 1)], next: LEVELS[Math.min(n + 1, LEVELS.length - 1)], from: 40 * n * n, to: 40 * (n + 1) * (n + 1) }; };
  function grade(e) {
    const T_ = id => e.tests.find(t => t.id === id)?.st;
    const speed = !e.stages.length ? 0 : 40 * Math.min(1, e.sc.budget / Math.max(e.total, 1e-3) / 4);
    const mem = e.peak > e.budget ? 0 : 25 * Math.min(1, .4 + (1 - e.peak / e.budget) * 1.2);
    const parts = [["Speed", speed, 40], ["Memory headroom", mem, 25], ["Works offline", T_("offline") === "pass" ? 15 : 7, 15],
                   ["Client-safe licenses", T_("license") === "pass" ? 10 : 4, 10], ["All parts present", T_("present") === "pass" ? 10 : 0, 10]];
    const pts = Math.round(parts.reduce((t, p) => t + p[1], 0));
    return { pts, letter: pts >= 90 ? "S" : pts >= 80 ? "A" : pts >= 65 ? "B" : pts >= 50 ? "C" : "D", parts };
  }
  const stackKey = s => `${s.tpl}:${Object.values(s.pick).sort().join("+")}`;
  const allGreen = e => e.stages.length && e.tests.every(t => t.st === "pass" || t.st === "pending");
  const MISSIONS = [
    { id: "first", icon: "▶", name: "First light", how: "Run any simulation.", xp: 20, test: (e, g) => g.runs >= 1 },
    { id: "green", icon: "✓", name: "All green", how: "Pass every test that can run, on any stack.", xp: 40, test: e => allGreen(e) },
    { id: "clean", icon: "§", name: "Client-safe", how: "A stack where every part has a permissive license.", xp: 30, test: e => e.tests.find(t => t.id === "license")?.st === "pass" && e.stages.length },
    { id: "sub1", icon: "⚡", name: "Speed demon", how: "Any stack under 1 second per request.", xp: 40, test: e => e.stages.length && e.total < 1 },
    { id: "voice4", icon: "♪", name: "Talk back fast", how: "Voice assistant answers the spoken question within 4 s on the M1.", xp: 50, test: (e, g, s) => s.tpl === "voice" && s.sc === "ask" && s.mach === "m1" && e.stages.length >= 3 && e.total <= 4 },
    { id: "tight", icon: "▦", name: "Tight fit", how: "Use over half of a Mac's usable memory and still fit.", xp: 50, test: e => e.peak > e.budget * .5 && e.peak <= e.budget },
    { id: "shop", icon: "⌘", name: "Hardware shopper", how: "Run the same stack on three different Macs.", xp: 40, test: (e, g, s) => (g.macs[stackKey(s)] || []).length >= 3 },
    { id: "trio", icon: "★", name: "Hat trick", how: "All green on three different stacks.", xp: 100, test: (e, g) => g.green.length >= 3 },
    { id: "all7", icon: "◎", name: "Collector", how: `Run all ${Object.keys(T).length} stacks.`, xp: 80, test: (e, g) => g.tried.length >= Object.keys(T).length },
    { id: "sgrade", icon: "S", name: "S rank", how: "Score 90 or more on any stack.", xp: 120, test: e => grade(e).pts >= 90 },
  ];
  function award(e) {
    const g = game(), s = st; let gained = 0; const unlocked = [], before = levelOf(g.xp);
    g.runs++;
    if (!g.tried.includes(s.tpl)) g.tried.push(s.tpl);
    const k = stackKey(s); g.macs[k] = [...new Set([...(g.macs[k] || []), s.mach])];
    const seen = `${k}|${s.sc}|${s.mach}`;
    if (!g.seen[seen]) { g.seen[seen] = 1; gained += 10; }
    if (allGreen(e) && !g.green.includes(s.tpl)) { g.green.push(s.tpl); gained += 25; }
    for (const m of MISSIONS) if (!g.done.includes(m.id) && m.test(e, g, s)) { g.done.push(m.id); gained += m.xp; unlocked.push(m); }
    g.xp += gained; saveGame(g);
    const after = levelOf(g.xp);
    return { gained, unlocked, before, after, levelUp: after.n > before.n, g };
  }

  // ---------- diagrams ----------
  const GAUGE_L = Math.PI * 70;
  function gaugeSvg(gr, live) {
    const off = live ? GAUGE_L * (1 - gr.pts / 100) : GAUGE_L;
    return `<svg class="lab-gauge" viewBox="0 0 160 100" role="img" aria-label="Stack grade ${gr.letter}, ${gr.pts} of 100">
      <path d="M10,90 A70,70 0 0 1 150,90" class="lab-g-track"/>
      <path d="M10,90 A70,70 0 0 1 150,90" class="lab-g-arc g-${gr.letter}" data-arc stroke-dasharray="${GAUGE_L.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
      ${[0, 25, 50, 75, 100].map(v => { const a = Math.PI * (1 - v / 100); return `<line x1="${80 + 58 * Math.cos(a)}" y1="${90 - 58 * Math.sin(a)}" x2="${80 + 64 * Math.cos(a)}" y2="${90 - 64 * Math.sin(a)}" class="lab-g-tick"/>`; }).join("")}
      <text x="80" y="74" class="lab-g-letter g-${gr.letter}" data-letter>${live ? gr.letter : "?"}</text>
      <text x="80" y="94" class="lab-g-pts" data-pts>${live ? gr.pts : "–"} / 100</text></svg>`;
  }
  function sysSvg(e) {
    const W = 800, cy = 118, n = e.stages.length;
    const xs = n ? e.stages.map((_, k) => n === 1 ? 545 : 435 + k * (230 / (n - 1))) : [];
    const outX = 745, ramH = 150, ramY = 46, cap = e.mach.gb * 2 ** 30;
    let y = ramY + ramH;
    const blocks = e.stages.filter(s => isModel(s.item)).map((s, k) => {
      const h = Math.max(3, Math.min(ramH, memNeed(s.item) / cap * ramH)); y -= h;
      return `<rect class="lab-ramblk c${k % 4}" x="196" y="${y.toFixed(1)}" width="58" height="${h.toFixed(1)}" rx="3"><title>${esc(s.item.name)} · ${gb(memNeed(s.item))}</title></rect>`;
    }).join("");
    const budY = ramY + ramH * .25, toLoad = e.stages.reduce((t, s) => t + (isModel(s.item) ? s.item.bytes : 0), 0);
    const pts = [370, ...xs, outX];
    const wires = pts.slice(0, -1).map((x, k) => `<line class="lab-wireline" x1="${x + (k ? 26 : 0)}" y1="${cy}" x2="${pts[k + 1] - 26}" y2="${cy}"/>`).join("");
    const nodes = e.stages.map((s, k) => `<g class="lab-dnode" data-dn="${k}" transform="translate(${xs[k]},${cy})">
        <circle r="26" class="lab-dn-c"/><text class="lab-dn-g" y="5">${esc(glyph(s.item.kind))}</text>
        <text class="lab-dn-name" y="46">${esc(s.slot.label)}</text><text class="lab-dn-t" y="-36" data-dt="${k}">${secs(s.s)}</text></g>`).join("");
    return `<svg class="lab-sys" viewBox="0 0 ${W} 230" role="img" aria-label="How the stack runs: weights load from the A1 into the Mac's memory, then a request flows through each stage">
      <defs><linearGradient id="labShine" x1="0" x2="1"><stop offset="0" stop-color="var(--brand)" stop-opacity="0"/><stop offset=".5" stop-color="var(--brand)" stop-opacity=".9"/><stop offset="1" stop-color="var(--brand)" stop-opacity="0"/></linearGradient></defs>
      <g class="lab-a1"><rect x="8" y="78" width="118" height="80" rx="10" class="lab-box"/>
        <rect x="20" y="92" width="94" height="10" rx="3" class="lab-slot-led"/><text x="67" y="126" class="lab-box-t">A1 · stash</text>
        <text x="67" y="144" class="lab-box-s">${gb(toLoad)} to load</text></g>
      <line x1="126" y1="${cy}" x2="170" y2="${cy}" class="lab-usb"/><line x1="126" y1="${cy}" x2="170" y2="${cy}" class="lab-flow" data-flow/>
      <text x="148" y="${cy - 10}" class="lab-box-s">USB</text>
      <g class="lab-mac"><rect x="170" y="14" width="200" height="202" rx="14" class="lab-box"/>
        <text x="270" y="34" class="lab-box-t">${esc(e.mach.label)}</text>
        <rect x="192" y="${ramY - 2}" width="66" height="${ramH + 4}" rx="5" class="lab-ram"/>${blocks}
        <line x1="186" x2="264" y1="${budY}" y2="${budY}" class="lab-budline"/><text x="268" y="${budY + 4}" class="lab-box-s" text-anchor="start">75%</text>
        <text x="315" y="96" class="lab-box-s">memory</text><text x="315" y="114" class="lab-box-v${e.peak > e.budget ? " bad" : ""}" data-peak>${gb(e.peak)}</text>
        <text x="315" y="146" class="lab-box-s">bandwidth</text><text x="315" y="164" class="lab-box-v">${BW[e.mach.id]?.gbs || "?"} GB/s</text></g>
      ${wires}${nodes}
      <g class="lab-out" transform="translate(${outX},${cy})"><rect x="-24" y="-24" width="48" height="48" rx="12" class="lab-out-r" transform="rotate(45)"/><text y="6" class="lab-dn-g">✓</text>
        <text y="50" class="lab-dn-name">Answer</text></g>
      <circle r="7" class="lab-packet" cx="370" cy="${cy}" data-packet data-xs="${pts.join(",")}" opacity="0"/>
    </svg>`;
  }
  function playerBar() {
    const g = game(), L = levelOf(g.xp), pct = Math.min(100, (g.xp - L.from) / (L.to - L.from) * 100);
    const next = MISSIONS.find(m => !g.done.includes(m.id));
    return `<div class="lab-player">
      <div class="lab-lvl"><svg viewBox="0 0 40 40" aria-hidden="true"><polygon points="20,2 37,11 37,29 20,38 3,29 3,11" class="lab-hex"/></svg><b data-lvl>${L.n}</b></div>
      <div class="lab-xpwrap"><div class="lab-xptop"><b data-title>${esc(L.title)}</b><span data-xp>${g.xp} XP</span></div>
        <div class="lab-xpbar"><i data-xpbar style="width:${pct}%"></i></div>
        <small data-xpnext>${L.to - g.xp} XP to ${esc(L.next)}${next ? ` · next mission: <b>${esc(next.name)}</b> — ${esc(next.how)}` : " · every mission done"}</small></div>
      <div class="lab-badges">${MISSIONS.map(m => `<span class="lab-badge${g.done.includes(m.id) ? " on" : ""}" data-badge="${m.id}" title="${esc(m.name)}: ${esc(m.how)} (+${m.xp} XP)">${esc(m.icon)}</span>`).join("")}</div>
    </div>`;
  }
  function missionsPanel() {
    const g = game();
    return `<section class="lab-panel lab-missions"><div class="lab-h"><span class="lab-kick">Missions · ${g.done.length} of ${MISSIONS.length}</span><span class="lab-mut">Run simulations to earn XP. Each new stack, scenario and Mac combination is worth 10 XP; all green on a new stack is 25.</span></div>
      <ul>${MISSIONS.map(m => `<li class="lab-m${g.done.includes(m.id) ? " on" : ""}" data-mission="${m.id}"><span class="lab-badge${g.done.includes(m.id) ? " on" : ""}">${esc(m.icon)}</span><div><b>${esc(m.name)}</b><small>${esc(m.how)}</small></div><em>+${m.xp}</em></li>`).join("")}</ul></section>`;
  }
  function toast(root, html, cls = "") {
    let box = $(".lab-toasts"); if (!box) { box = document.createElement("div"); box.className = "lab-toasts"; box.setAttribute("aria-live", "polite"); document.body.appendChild(box); }
    const t = document.createElement("div"); t.className = "lab-toast " + cls; t.innerHTML = html; box.appendChild(t);
    if (window.gsap && !RM()) gsap.timeline().from(t, { x: 60, opacity: 0, duration: .45, ease: "back.out(2)" }).to(t, { opacity: 0, x: 40, duration: .4, delay: 3.2, onComplete: () => t.remove() });
    else setTimeout(() => t.remove(), 3600);
  }
  function celebrate(root, e, res) {
    const gr = grade(e), arc = $("[data-arc]", root), L0 = res.before, L1 = res.after, rm = RM() || !window.gsap;
    const pBox = $(".lab-player", root);
    const setText = (sel, v) => { const n = $(sel, root); if (n) n.textContent = v; };
    if (rm) { if (arc) arc.setAttribute("stroke-dashoffset", GAUGE_L * (1 - gr.pts / 100)); setText("[data-letter]", gr.letter); setText("[data-pts]", `${gr.pts} / 100`); }
    else {
      const o = { v: 0 };
      gsap.timeline()
        .fromTo(arc, { attr: { "stroke-dashoffset": GAUGE_L } }, { attr: { "stroke-dashoffset": GAUGE_L * (1 - gr.pts / 100) }, duration: 1.1, ease: "power3.out" })
        .to(o, { v: gr.pts, duration: 1.1, ease: "power3.out", onUpdate: () => setText("[data-pts]", `${Math.round(o.v)} / 100`) }, "<")
        .add(() => setText("[data-letter]", gr.letter))
        .fromTo($("[data-letter]", root), { scale: 0, transformOrigin: "50% 60%" }, { scale: 1, duration: .5, ease: "back.out(3)" });
      $$(".lab-part i", root).forEach(b => gsap.fromTo(b, { scaleX: 0 }, { scaleX: 1, duration: .8, ease: "power2.out", transformOrigin: "left" }));
    }
    if (gr.letter === "S" || gr.letter === "A") { const a = $(".lab-gauge", root); if (a && window.burst && !rm) { const r = a.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, 18, 70); } }
    // XP
    if (pBox) {
      const toPct = Math.min(100, (res.g.xp - L1.from) / (L1.to - L1.from) * 100), bar = $("[data-xpbar]", root);
      setText("[data-lvl]", L1.n); setText("[data-title]", L1.title);
      if (res.gained && !rm) {
        const f = document.createElement("span"); f.className = "lab-xpfloat"; f.textContent = `+${res.gained} XP`; pBox.appendChild(f);
        gsap.fromTo(f, { y: 10, opacity: 0 }, { y: -26, opacity: 1, duration: .6, ease: "power2.out", onComplete: () => gsap.to(f, { opacity: 0, duration: .5, delay: .8, onComplete: () => f.remove() }) });
        const o = { v: res.g.xp - res.gained };
        gsap.to(o, { v: res.g.xp, duration: .9, onUpdate: () => setText("[data-xp]", `${Math.round(o.v)} XP`) });
        if (res.levelUp) gsap.timeline().to(bar, { width: "100%", duration: .5 }).set(bar, { width: "0%" }).to(bar, { width: toPct + "%", duration: .6 })
          .fromTo($(".lab-lvl", root), { scale: 1.5, rotate: -20 }, { scale: 1, rotate: 0, duration: .7, ease: "elastic.out(1,.4)" }, "<");
        else gsap.to(bar, { width: toPct + "%", duration: .9, ease: "power2.out" });
      } else { if (bar) bar.style.width = toPct + "%"; setText("[data-xp]", `${res.g.xp} XP`); }
      const next = MISSIONS.find(m => !res.g.done.includes(m.id)), nx = $("[data-xpnext]", root);
      if (nx) nx.innerHTML = `${L1.to - res.g.xp} XP to ${esc(L1.next)}${next ? ` · next mission: <b>${esc(next.name)}</b> — ${esc(next.how)}` : " · every mission done"}`;
    }
    if (!res.gained) toast(root, `<b>No new XP</b><span>Change a part, the scenario or the Mac to earn more.</span>`, "quiet");
    if (res.levelUp) toast(root, `<span class="lab-badge on">${L1.n}</span><div><b>Level up · ${esc(L1.title)}</b><span>You reached level ${L1.n}.</span></div>`, "big");
    res.unlocked.forEach((m, k) => setTimeout(() => {
      toast(root, `<span class="lab-badge on">${esc(m.icon)}</span><div><b>Mission complete · ${esc(m.name)}</b><span>+${m.xp} XP · ${esc(m.how)}</span></div>`);
      $$(`[data-badge="${m.id}"], [data-mission="${m.id}"], [data-mission="${m.id}"] .lab-badge`, root).forEach(b => b.classList.add("on"));
      const b = $(`[data-badge="${m.id}"]`, root);
      if (b && !rm) { gsap.fromTo(b, { scale: 0, rotate: -90 }, { scale: 1, rotate: 0, duration: .7, ease: "back.out(3)" }); if (window.burst) { const r = b.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, 14, 50); } }
    }, 900 + k * 700));
    const mk = $(".lab-missions .lab-kick", root); if (mk) mk.textContent = `Missions · ${res.g.done.length} of ${MISSIONS.length}`;
  }

  // ---------- rendering ----------
  function papersFor(tpl) {
    return (picks || []).filter(p => p.kind === "paper" && tpl.words.test(`${p.title || ""} ${p.summary || ""}`)).slice(0, 4);
  }
  function html(cat, pk, opts = {}) {
    catalog = cat; picks = pk || [];
    if (!st || !T[st.tpl]) st = defaults("rag");
    if (opts.tpl && T[opts.tpl] && st.tpl !== opts.tpl) { st = defaults(opts.tpl); save(); }
    const e = evaluate(st);
    const P = papersFor(e.tpl);
    const pass = e.tests.filter(t => t.st === "pass").length;
    return `<div class="lab${opts.embedded ? " lab-embed" : ""}">
      ${opts.embedded ? "" : `<header class="lab-hero"><span class="lab-kick">Lab · ${e.measured || e.quality ? "measured where benchmarked" : "simulated"}</span>
        <h2>Build a stack. See how it would run.</h2>
        <p>Pick a job, choose parts from what's on the A1, and pick a Mac. The Lab estimates memory, speed and load time from file sizes, then runs a simulated test suite. Parts you've run through the Bench use their measured numbers instead, marked <em class="lab-meas">measured</em>. Nothing here touches the drive.</p></header>`}
      ${playerBar()}
      ${opts.embedded ? "" : `<div class="lab-tpls" role="tablist" aria-label="Stack templates">${Object.entries(T).map(([id, t]) => `
        <button type="button" class="lab-tpl" role="tab" aria-selected="${id === st.tpl}" data-tpl="${id}"><span class="lab-ic">${esc(t.icon)}</span><b>${esc(t.title)}</b><small>${esc(t.tag)}</small></button>`).join("")}</div>`}
      <div class="lab-grid">
        <section class="lab-panel">
          <div class="lab-h"><span class="lab-kick">1 · Parts</span><span class="lab-mut">${esc(e.tpl.blurb)}</span></div>
          ${e.tpl.slots.map(sl => { const c = candidates(sl); const cur = st.pick[sl.id] || "";
            return `<label class="lab-slot"><span class="lab-sl">${esc(sl.label)}${sl.optional ? " <em>optional</em>" : ""}</span>
              <select data-slot="${sl.id}" id="lab-${sl.id}">${sl.optional || !c.length ? `<option value="">${c.length ? "None" : "Nothing on the A1 for this yet"}</option>` : ""}
                ${c.map(i => `<option value="${esc(i.path)}"${i.path === cur ? " selected" : ""}>${i.path === benchPick(st.tpl, sl.id, st.mach) ? "★ " : ""}${esc(i.name)} · ${gb(i.bytes)} · ${runtime(i)}${i.path === benchPick(st.tpl, sl.id, st.mach) ? " · best on the bench" : ""}</option>`).join("")}</select></label>`; }).join("")}
          <div class="lab-h" style="margin-top:14px"><span class="lab-kick">2 · Mac</span></div>
          <div class="lab-machs">${machines().map(m => `<button type="button" class="lab-mach" data-mach="${m.id}" aria-pressed="${m.id === st.mach}">${esc(m.label)}<small>${BW[m.id]?.gbs || "?"} GB/s${BW[m.id]?.note === "assumed" ? " · assumed" : ""}</small></button>`).join("")}</div>
          <div class="lab-h" style="margin-top:14px"><span class="lab-kick">3 · Scenario</span></div>
          <div class="lab-scs">${e.tpl.scenarios.map(s => `<button type="button" class="lab-sc" data-sc="${s.id}" aria-pressed="${s.id === e.sc.id}"><b>${esc(s.name)}</b><small>${esc(s.input)}</small></button>`).join("")}</div>
          <p class="lab-risk"><b>Likely to go wrong:</b> ${esc(e.sc.risk)}</p>
        </section>
        <section class="lab-panel lab-sim">
          <div class="lab-h"><span class="lab-kick">Simulation</span><button type="button" class="lab-btn go" data-run>▶ Run simulation</button></div>
          <div class="lab-sysw">${sysSvg(e)}</div>
          <div class="lab-grade">${gaugeSvg(grade(e), false)}<ul class="lab-parts">${grade(e).parts.map(([n, v, m]) => `<li class="lab-part"><span>${esc(n)}</span><b>${Math.round(v)}/${m}</b><em><i style="width:${v / m * 100}%"></i></em></li>`).join("")}</ul></div>
          <div class="lab-pipe">${e.stages.length ? e.stages.map((s, k) => `${k ? '<i class="lab-wire"><b></b></i>' : ""}<div class="lab-node" data-k="${k}"><span class="lab-g">${esc(glyph(s.item.kind))}</span><b>${esc(s.item.name)}</b><small>${esc(label(s.item.kind))} · ${gb(s.item.bytes)}${s.measured ? ' · <span class="lab-meas">measured</span>' : ""}</small><em data-t="${k}">${secs(s.s)}</em></div>`).join("") : '<p class="lab-mut">Choose parts to see the pipeline.</p>'}</div>
          <div class="lab-stats">
            <div><span>Per request (warm)</span><b data-n="total">${secs(e.total)}</b></div>
            <div><span>First load off the A1${e.stages.some(s => s.loadMeasured) ? " · measured" : ""}</span><b>${secs(e.firstLoad)}</b></div>
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
      ${missionsPanel()}
      <section class="lab-panel">
        <div class="lab-h"><span class="lab-kick">Papers behind this stack</span></div>
        ${P.length ? `<ul class="lab-papers">${P.map(p => `<li><a href="https://arxiv.org/abs/${esc(p.repo)}" target="_blank" rel="noopener">${esc(p.title || p.repo)}</a><small>${esc(p.repo)} · ${p.status === "stashed" ? "on the A1" : p.status}</small></li>`).join("")}</ul>`
          : `<p class="lab-mut">No scouted papers match this job yet. Adding arXiv papers by ID is Phase 1 of the Lab plan.</p>`}
      </section>
    </div>`;
  }

  function animateSim(root) {
    const nodes = $$(".lab-node", root), wires = $$(".lab-wire b", root), logs = $$(".lab-log li", root);
    const e = evaluate(st), res = award(e), runBtn = $("[data-run]", root);
    if (RM() || !window.gsap) { nodes.forEach(n => n.classList.add("done")); celebrate(root, e, res); return; }
    if (runBtn) runBtn.disabled = true;
    const times = e.stages.map(s => s.s), sum = times.reduce((a, b) => a + b, 0) || 1;
    const pk = $("[data-packet]", root), xs = (pk?.dataset.xs || "").split(",").map(Number), dn = $$(".lab-dnode", root);
    const tl = gsap.timeline({ onComplete: () => { if (runBtn) runBtn.disabled = false; celebrate(root, e, res); } });
    tl.set(nodes, { className: "lab-node" }).set(logs, { opacity: .25 }).set(wires, { scaleX: 0 }).set(dn, { attr: { class: "lab-dnode" } })
      .set($("[data-arc]", root), { attr: { "stroke-dashoffset": GAUGE_L } });
    // 1. weights stream off the A1 and stack up in memory
    tl.fromTo("[data-flow]", { strokeDashoffset: 0, opacity: 1 }, { strokeDashoffset: -80, duration: Math.min(1.6, .5 + e.firstLoad / 20), ease: "none" })
      .from($$(".lab-ramblk", root), { y: -160, opacity: 0, duration: .55, stagger: .2, ease: "bounce.out" }, "<")
      .to("[data-flow]", { opacity: 0, duration: .2 })
      .set(pk, { attr: { cx: xs[0] }, opacity: 1 });
    nodes.forEach((n, k) => {
      const d = Math.max(.3, Math.min(.9, times[k] / sum * 2.4));
      const t = $(`[data-t="${k}"]`, root), o = { v: 0 };
      if (pk) tl.to(pk, { attr: { cx: xs[k + 1] }, duration: .35, ease: "power1.inOut" }).add(() => dn[k]?.setAttribute("class", "lab-dnode live"));
      tl.add(() => n.classList.add("live"))
        .fromTo(n, { scale: .96 }, { scale: 1.04, duration: .18, yoyo: true, repeat: 1 })
        .to(logs[k] || {}, { opacity: 1, duration: .2 }, "<")
        .fromTo(o, { v: 0 }, { v: times[k], duration: d, ease: "none", onUpdate: () => t && (t.textContent = secs(o.v)) }, "<")
        .add(() => { n.classList.remove("live"); n.classList.add("done"); dn[k]?.setAttribute("class", "lab-dnode done"); });
      if (wires[k]) tl.to(wires[k], { scaleX: 1, duration: .35, ease: "power1.inOut" });
    });
    if (pk) tl.to(pk, { attr: { cx: xs[xs.length - 1] }, duration: .35, ease: "power1.in" }).to(pk, { attr: { r: 16 }, opacity: 0, duration: .3 })
      .fromTo(".lab-out", { scale: .6, transformOrigin: "50% 50%" }, { scale: 1, duration: .5, ease: "back.out(3)" }, "<").set(pk, { attr: { r: 7 } });
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

  window.LabView = { html, wire, evaluate: s => evaluate(s), templates: T, suiteFor: SUITE_FOR, _setCatalog: (c, p) => { catalog = c; picks = p || []; }, _defaults: id => defaults(id), grade: e => grade(e), missions: MISSIONS, levelOf };

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

  .lab-player{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px;align-items:center;border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:var(--panel)}
  @media(max-width:720px){.lab-player{grid-template-columns:auto minmax(0,1fr)}.lab-badges{grid-column:1/-1}}
  .lab-lvl{position:relative;width:48px;height:48px;display:grid;place-items:center}
  .lab-lvl svg{position:absolute;inset:0;width:100%;height:100%}.lab-hex{fill:var(--brand);stroke:none}
  .lab-lvl b{position:relative;font:700 18px "IBM Plex Mono",monospace;color:var(--on-brand)}
  .lab-xptop{display:flex;justify-content:space-between;gap:8px;font:600 13px "IBM Plex Mono",monospace}.lab-xptop span{color:var(--mute);font-variant-numeric:tabular-nums}
  .lab-xpbar{height:10px;border-radius:5px;background:var(--chip);border:1px solid var(--line);overflow:hidden;margin:6px 0 4px}
  .lab-xpbar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--brand));border-radius:5px}
  .lab-xpwrap small{color:var(--mute);font-size:12px}.lab-xpwrap small b{color:var(--ink)}
  .lab-badges{display:flex;gap:6px;flex-wrap:wrap}
  .lab-badge{width:28px;height:28px;border-radius:8px;display:inline-grid;place-items:center;font:700 12px "IBM Plex Mono",monospace;border:1px dashed var(--line);color:var(--mute);flex:none}
  .lab-badge.on{border:1px solid var(--brand);background:color-mix(in srgb,var(--brand) 18%,transparent);color:var(--ink)}
  .lab-xpfloat{position:absolute;right:16px;top:6px;font:700 15px "IBM Plex Mono",monospace;color:var(--brand);pointer-events:none}
  .lab-sysw{border:1px solid var(--line);border-radius:10px;background:var(--bg);padding:6px;margin-bottom:10px;overflow-x:auto}
  .lab-sys{display:block;width:100%;min-width:560px;height:auto}
  .lab-box{fill:var(--panel);stroke:var(--line);stroke-width:1.5}
  .lab-box-t{font:600 13px "IBM Plex Mono",monospace;fill:var(--ink);text-anchor:middle}
  .lab-box-s{font:11px "IBM Plex Sans",sans-serif;fill:var(--mute);text-anchor:middle}
  .lab-box-v{font:600 14px "IBM Plex Mono",monospace;fill:var(--ink);text-anchor:middle}.lab-box-v.bad{fill:var(--bad)}
  .lab-slot-led{fill:color-mix(in srgb,var(--brand) 35%,transparent)}
  .lab-usb{stroke:var(--line);stroke-width:4;stroke-linecap:round}
  .lab-flow{stroke:var(--brand);stroke-width:4;stroke-linecap:round;stroke-dasharray:6 10;opacity:0}
  .lab-ram{fill:var(--chip);stroke:var(--line)}
  .lab-ramblk.c0{fill:var(--accent)}.lab-ramblk.c1{fill:#6cc4f2}.lab-ramblk.c2{fill:#b99cf2}.lab-ramblk.c3{fill:#7cf2a0}
  .lab-budline{stroke:var(--bad);stroke-width:1.5;stroke-dasharray:4 3}
  .lab-wireline{stroke:var(--line);stroke-width:3;stroke-linecap:round}
  .lab-dn-c{fill:var(--panel);stroke:var(--line);stroke-width:2;transition:stroke .2s,fill .2s}
  .lab-dnode.live .lab-dn-c{stroke:var(--brand);stroke-width:3;fill:color-mix(in srgb,var(--brand) 20%,var(--panel))}
  .lab-dnode.done .lab-dn-c{stroke:var(--accent)}
  .lab-dn-g{font:700 14px "IBM Plex Mono",monospace;fill:var(--accent);text-anchor:middle}
  .lab-dn-name{font:12px "IBM Plex Sans",sans-serif;fill:var(--mute);text-anchor:middle}
  .lab-dn-t{font:600 11px "IBM Plex Mono",monospace;fill:var(--ink);text-anchor:middle}
  .lab-out-r{fill:color-mix(in srgb,var(--brand) 16%,var(--panel));stroke:var(--brand);stroke-width:2}
  .lab-packet{fill:var(--brand);filter:drop-shadow(0 0 6px var(--brand))}
  .lab-grade{display:grid;grid-template-columns:150px minmax(0,1fr);gap:14px;align-items:center;margin-bottom:10px}
  @media(max-width:520px){.lab-grade{grid-template-columns:1fr}}
  .lab-gauge{width:150px;height:auto}
  .lab-g-track{fill:none;stroke:var(--chip);stroke-width:12;stroke-linecap:round}
  .lab-g-arc{fill:none;stroke:var(--brand);stroke-width:12;stroke-linecap:round}
  .lab-g-arc.g-S{stroke:#7cf2a0}.lab-g-arc.g-A{stroke:var(--brand)}.lab-g-arc.g-B{stroke:#6cc4f2}.lab-g-arc.g-C{stroke:var(--warn)}.lab-g-arc.g-D{stroke:var(--bad)}
  .lab-g-tick{stroke:var(--line);stroke-width:2}
  .lab-g-letter{font:700 34px "IBM Plex Mono",monospace;fill:var(--ink);text-anchor:middle}
  .lab-g-pts{font:11px "IBM Plex Mono",monospace;fill:var(--mute);text-anchor:middle}
  .lab-parts{list-style:none;margin:0;padding:0;display:grid;gap:5px}
  .lab-part{display:grid;grid-template-columns:minmax(0,1fr) 48px;gap:2px 8px;font-size:12px}
  .lab-part span{color:var(--mute)}.lab-part b{font:600 12px "IBM Plex Mono",monospace;text-align:right}
  .lab-part em{grid-column:1/-1;height:5px;border-radius:3px;background:var(--chip);overflow:hidden}.lab-part em i{display:block;height:100%;background:var(--accent)}
  .lab-missions ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
  .lab-m{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:10px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:9px 10px;opacity:.72}
  .lab-m.on{opacity:1;border-color:color-mix(in srgb,var(--brand) 60%,var(--line))}
  .lab-m b{font:600 13px "IBM Plex Sans",sans-serif;display:block}.lab-m small{color:var(--mute);font-size:12px;line-height:1.4}
  .lab-m em{font:600 12px "IBM Plex Mono",monospace;font-style:normal;color:var(--accent)}
  .lab-toasts{position:fixed;right:16px;bottom:16px;display:grid;gap:8px;z-index:60;max-width:min(360px,calc(100vw - 32px))}
  .lab-toast{display:flex;gap:10px;align-items:center;background:var(--panel);border:1px solid var(--brand);border-radius:12px;padding:10px 12px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
  .lab-toast b{display:block;font:600 13px "IBM Plex Mono",monospace}.lab-toast span{color:var(--mute);font-size:12.5px}
  .lab-toast.quiet{border-color:var(--line)}.lab-toast.big{border-width:2px}
  .lab-btn:disabled{opacity:.55;cursor:default}
    .lab-meas{font:600 10.5px "IBM Plex Mono",monospace;font-style:normal;color:var(--accent);text-transform:uppercase;letter-spacing:.06em}
  .lab-papers{margin:0;padding-left:18px;display:grid;gap:6px}.lab-papers small{display:block;color:var(--mute);font-size:12px}.lab-papers a{color:var(--ink)}
  `;
  document.head.appendChild(css);
})();
