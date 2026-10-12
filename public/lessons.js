// A1 Learning Path, lesson edition: chapters of short sections, each with an animated figure,
// one check-yourself question and XP. Content is ours; the reading-room pacing (numbered figures,
// stepwise diagrams, a question per section, XP for progress) is the pattern being borrowed.
(() => {
  const RM = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const XP = { section: 10, correct: 15, chapter: 100 };

  const CHAPTERS = [
    { id: "c1", title: "Run it locally", blurb: "What the files on the drive are, how they turn into answers, and how to keep it all working with the network off.", steps: ["s1", "s2", "s10", "s3", "s4"] },
    { id: "c2", title: "Put it to work", blurb: "Point the models at the jobs you actually do: analytics data, web pages, screens, voice, and your own examples.", steps: ["s5", "s7", "s6", "s9", "s8"] },
    { id: "c3", title: "Look inside", blurb: "Explain a prediction, then open a network up: read its activations, probe them, find a circuit, and decompose a layer into features.", steps: ["s11", "s12", "s13", "s14", "s15"] },
    { id: "c4", title: "Decide and route", blurb: "Use small decision models as the judges in your stack: ask typed questions, score models on your own work, turn confidence into rules, route through jev-gateway, and keep the evidence.", steps: ["s16", "s17", "s18", "s19", "s20"] },
  ];

  // Pill shorthand: "<color><flags>:<text>". Colors y b p g n. Flags: ! highlight, + stretch to fill the row.
  const L = {
    s1: {
      p: ["Every local AI setup is the same four layers stacked on each other. The model files are only data: something has to load them and do the math, something has to wrap that in a command, and something has to call it.",
          "On your setup the bottom layer lives on the A1 and everything above it runs on the Mac. That split is why you can eject the drive and lose nothing but the weights."],
      fig: { type: "flow", rows: [
        ["Weights on the A1", ["y:models/mlx/Qwen3-4B", "y:*.safetensors", "y:config.json"]],
        ["Runtime", ["b:MLX", "b:llama.cpp", "b:PyTorch"]],
        ["Wrapper", ["p:mlx_lm", "p:mlx_vlm", "p:mlx_audio"]],
        ["Your app", ["g+!:a script, a local server, or an agent"]]],
        cap: "The local stack. Each layer only talks to the one directly below it." },
      q: { q: "You copy a model folder to a Mac with no MLX installed. What happens?", o: ["It runs: the weights include the runtime", "Nothing runs until a runtime is installed", "It runs, just slower"], a: 1,
        why: "Weights are just numbers. Without a runtime to load them and do the math there's nothing to execute." } },
    s2: {
      p: ["A language model never sees your words. Your prompt is cut into tokens, each token becomes a number, and the model's whole job is to score every token in its vocabulary as the possible next one. Writing a reply is that single step, repeated.",
          "The 4-bit copies on the drive store each weight in a quarter of the bits. You give up a little accuracy and get a model that fits comfortably on a 16 GB Mac."],
      fig: { type: "flow", rows: [
        ["Your prompt", ["g+:The purchase tag fired twice on"]],
        ["Tokens", ["y:The", "y:·purchase", "y:·tag", "y:·fired", "y:·twice", "y:·on"]],
        ["Token IDs", ["p:785", "p:7172", "p:4877", "p:14955", "p:11450", "p:389"]],
        ["Model", ["b+:Qwen3-4B · 4-bit · 2.3 GB"]],
        ["Next token", ["y!:·checkout 0.41", "n:·the 0.22", "n:·page 0.12", "n:… 0.25"]]],
        cap: "One step of generation. IDs and scores are illustrative; the shape is exact." },
      q: { q: "Why does the 4-bit model fit where the 16-bit one doesn't?", o: ["It has fewer layers", "Each weight is stored in a quarter of the bits", "It loads only part of the vocabulary"], a: 1,
        why: "Same architecture, same layers; every number is just stored more compactly." } },
    s3: {
      p: ["An embedding model turns a piece of text into a long list of numbers, placed so that texts with similar meaning land near each other. Search becomes geometry: embed the question and find the closest stored vectors.",
          "Closest isn't always best, so a reranker reads the question together with each candidate and re-scores the shortlist. A fast, wide first pass, then a careful second one."],
      fig: { type: "flow", rows: [
        ["Question", ["g+:why did purchases double last week?"]],
        ["Embedding", ["b:0.12", "b:−0.40", "b:0.88", "b:0.03", "b:…", "b:0.05"]],
        ["Nearest 3", ["y:consent-mode-v2.md", "y:dedupe-purchase-tag.md", "y:ga4-sample-sql.md"]],
        ["Reranked", ["y!:dedupe-purchase-tag.md 0.92", "n:ga4-sample-sql.md 0.31", "n:consent-mode-v2.md 0.18"]]],
        cap: "Retrieve wide with embeddings, then let the reranker order the shortlist." },
      q: { q: "What does a reranker see that the embedding search doesn't?", o: ["The question and each candidate together", "More documents", "Your browsing history"], a: 0,
        why: "Embeddings compare two vectors made separately. A reranker reads the pair at once, so it catches meaning the vectors blur." } },
    s4: {
      p: ["A decision model doesn't write an answer, it fills in a form. You ask typed questions (yes or no, pick one, score 1 to 5) and get a probability for every option.",
          "Calibrated numbers are what make this useful: you can write rules on them, like act above 0.9 and ask a person below 0.6. jev-gateway asks exactly this shape of question, whether the answer comes from hosted Jev, Laya, or Clef-Flash on your Mac mini. Chapter 4 follows that path."],
      fig: { type: "bars", input: "The purchase event fired twice on the thank-you page after the consent banner update.",
        groups: [{ q: "is_bug · Is this a tracking bug?", rows: [["yes", 0.87], ["no", 0.09], ["unsure", 0.04]] },
                 { q: "area · Which area?", rows: [["tagging", 0.71], ["consent", 0.22], ["reporting", 0.07]] }],
        cap: "A decision model's answer to two typed questions about one sentence (illustrative values)." },
      q: { q: "A well-calibrated model says yes at 0.80. Across 100 answers like that, how many are right?", o: ["About 100", "About 80", "About 50"], a: 1,
        why: "That's what calibration means: the confidence matches the hit rate." } },
    s5: {
      p: ["The GA4 sample on the drive has the same shape as a BigQuery export: one row per event with the parameters nested inside. DuckDB reads those files where they sit, so there's no import step and no database server.",
          "Once the SQL works by hand, the text-to-SQL model can draft queries from a plain-English question for you to check."],
      fig: { type: "flow", rows: [
        ["On the A1", ["y:datasets/ga4-sample/events_*.parquet"]],
        ["DuckDB", ["b+:SELECT event_name, count(*) FROM 'events_*.parquet' GROUP BY 1"]],
        ["Result", ["g:page_view 12,418", "g:add_to_cart 1,206", "g!:purchase 312"]]],
        cap: "Counts are illustrative; run the card's command to get the real ones." },
      q: { q: "Why is there no import step?", o: ["DuckDB queries the Parquet files in place", "The data is already in BigQuery", "GA4 exports are plain CSV"], a: 0,
        why: "DuckDB treats files as tables, so the drive itself is the database." } },
    s6: {
      p: ["A vision-language model reads a picture the same way it reads text. The image is cut into patches, each patch becomes a token, and those tokens sit in front of your question.",
          "Screen-trained models like UI-TARS go one step further and answer with coordinates, which is what lets an agent find and click a button for you."],
      fig: { type: "flow", rows: [
        ["Screenshot", ["y:▦", "y:▦", "y:▦", "y:▦", "y:▦", "y:▦", "y:▦", "y:▦"]],
        ["Your question", ["g+:Where is the Accept all button?"]],
        ["Model", ["b+:UI-TARS-1.5-7B · 4-bit"]],
        ["Answer", ["p!:click(612, 488)"]]],
        cap: "Image patches become tokens; the answer comes back as a place to click." },
      q: { q: "How does the model see a screenshot?", o: ["It reads the page's HTML", "The image is split into patch tokens", "It runs OCR, then reads the text"], a: 1,
        why: "No HTML, no OCR: the pixels themselves are turned into tokens." } },
    s7: {
      p: ["Raw HTML is mostly menus, scripts and layout. A page reader strips it down to the content as Markdown, and an extractor fills a JSON template from that.",
          "Those are the first two steps of any site scan, including the GTM page scanner: clean text first, then fields."],
      fig: { type: "flow", rows: [
        ["HTML", ["n:<nav>…</nav>", "n:<script>…</script>", "y:<h1>Pro plan</h1>", "y:<p>$49/mo</p>"]],
        ["Reader", ["b+:ReaderLM-v2"]],
        ["Markdown", ["g+:# Pro plan · $49/mo"]],
        ["JSON", ["p!:{ \"plan\": \"Pro\", \"price\": 49 }"]]],
        cap: "Clutter out, content kept, then fields pulled from the content." },
      q: { q: "Why convert to Markdown before extracting fields?", o: ["Smaller, cleaner input means fewer mistakes", "Extractors can't read Unicode", "GTM requires Markdown"], a: 0,
        why: "The extractor's job gets easier the less noise it has to read past." } },
    s8: {
      p: ["Retraining every weight is expensive. A LoRA trains a small add-on instead: a pair of thin matrices beside each layer that nudge the frozen base model toward your examples.",
          "The add-on is megabytes, not gigabytes, so you can keep several and swap them on the same base model."],
      fig: { type: "flow", rows: [
        ["Base model, frozen", ["b+:Qwen3-4B · 2.3 GB"]],
        ["LoRA adapter", ["y!:adapters.safetensors · 20 MB"]],
        ["Tuned model", ["g+:same model, answers in your house style"]]],
        cap: "A small trained add-on on top of an unchanged base model." },
      q: { q: "What does a LoRA actually train?", o: ["Every weight, at lower precision", "Small extra matrices beside frozen weights", "Only the tokenizer"], a: 1,
        why: "The base stays frozen; only the thin add-on matrices learn." } },
    s9: {
      p: ["Speech in and speech out are two separate models. Whisper turns audio into text with timestamps; a text-to-speech model like Kokoro turns text back into a voice.",
          "Put a language model between them and you have a voice assistant that never leaves the Mac."],
      fig: { type: "flow", rows: [
        ["Your voice", ["y+:▁▃▆▃▁▅▇▅▂▁▃▅▂"]],
        ["Speech to text", ["b+:whisper-large-v3-turbo"]],
        ["Text", ["g+:did the purchase tag fire? [0.0–1.8 s]"]],
        ["Text to speech", ["b+:Kokoro-82M"]],
        ["Reply", ["p+!:▂▅▇▅▂▃▆▃▁▂▅▃"]]],
        cap: "Two models, one in each direction." },
      q: { q: "Which model produces the timestamps?", o: ["Kokoro", "Whisper", "Neither"], a: 1,
        why: "Whisper transcribes, and it marks when each piece of speech happened." } },
    s10: {
      p: ["A model on the drive is no use if pip can't install its runtime. The wheels folders hold every package file a venv needs, pinned to exact versions by a lock file.",
          "The venvs themselves live on the Mac's internal disk, because exFAT can't hold the links a venv relies on. The drive keeps the ingredients; the Mac keeps the kitchen."],
      fig: { type: "flow", rows: [
        ["On the A1", ["y:wheels/interp/", "y:requirements-lock.txt"]],
        ["Install, offline", ["b+:uv pip install --no-index --find-links /Volumes/A1/stash/wheels/interp -r …"]],
        ["On the Mac", ["g:~/.nvme-stash/venvs/interp"]],
        ["Check", ["p!:import torch, transformer_lens ✓"]]],
        cap: "Everything pip needs comes off the drive; nothing comes off the network." },
      q: { q: "Why don't the venvs live on the A1?", o: ["exFAT can't hold the links and permissions a venv needs", "The A1 is too slow", "The A1 is read-only"], a: 0,
        why: "exFAT has no symlinks or Unix permissions, and a venv is built on both." } },
    s11: {
      p: ["Explainable AI usually starts with one question about one prediction: why this answer? Attribution splits the output among the inputs, so you can say which columns pushed the score up and which pulled it down.",
          "SHAP does this for tabular models. For a decision model you can't open, change one input at a time and watch the probability move."],
      fig: { type: "bars", signed: true, input: "Lead quality: this lead scored 0.82; the average lead scores 0.40.",
        groups: [{ q: "SHAP value per input · they add up to +0.42", rows: [["pages_viewed = 14", 0.21], ["source = paid_search", 0.12], ["form_time = 9 s", 0.07], ["country = US", 0.04], ["device = mobile", -0.02]] }],
        cap: "Illustrative SHAP values: each bar is one input's push away from the average prediction." },
      q: { q: "One prediction's SHAP values add up to…", o: ["1", "The prediction minus the average prediction", "The number of inputs"], a: 1,
        why: "That additivity is what makes SHAP easy to chart and explain to a client." } },
    s12: {
      p: ["Inside a transformer, each token carries a vector called the residual stream up through every layer. Each layer reads it and adds something back.",
          "The logit lens asks every layer what it would predict if the model stopped right there. Watching the answer appear partway up is the first real look inside."],
      fig: { type: "flow", rows: [
        ["Prompt", ["g+:The Eiffel Tower is in the city of"]],
        ["Layer 0", ["n:·the"]],
        ["Layer 4", ["n:·France"]],
        ["Layer 8", ["y!:·Paris"]],
        ["Layer 11", ["y!:·Paris"]]],
        cap: "What GPT-2 small might guess at each layer (illustrative). The card's command prints the real trace." },
      q: { q: "What is the residual stream?", o: ["The training data", "The vector each token carries, which every layer reads and adds to", "The attention weights"], a: 1,
        why: "It's the shared workspace; most interpretability tools read, edit or decompose it." } },
    s13: {
      p: ["A linear probe is a tiny classifier trained on one layer's activations. If it can predict a property of the input, the model represents that property at that layer.",
          "Train the same probe on every layer of Pythia-70m and 160m and chart the accuracy. You'll see where a concept forms, and whether the bigger model forms it sooner."],
      fig: { type: "bars", fmt: "pct", input: "Property: is this token part of a city name?",
        groups: [{ q: "Probe accuracy by layer · Pythia-70m", rows: [["layer 0", 0.55], ["layer 1", 0.62], ["layer 2", 0.78], ["layer 3", 0.91], ["layer 4", 0.93], ["layer 5", 0.92]] }],
        cap: "Illustrative accuracies. Chance is 50%; the jump marks where the concept becomes readable." },
      q: { q: "A probe scores 93% at layer 4 but 55% at layer 0. The best reading?", o: ["The model forgot it", "The property becomes linearly readable by layer 4", "The probe overfit layer 0"], a: 1,
        why: "Early layers haven't built the feature yet; by layer 4 a straight line can find it." } },
    s14: {
      p: ["Correlation isn't proof. Activation patching runs two prompts that differ in one detail, copies one component's activation from the clean run into the corrupted run, and checks whether the right answer comes back.",
          "Repeat that for every attention head and a few stand out. Those heads, and the way they hand information to each other, are the circuit."],
      fig: { type: "flow", rows: [
        ["Clean run", ["g+:When Mary and John went to the store, John gave a drink to", "g!:·Mary"]],
        ["Corrupted run", ["p+:When Mary and John went to the store, Mary gave a drink to", "p:·John"]],
        ["Patch", ["y!:one head's output: clean → corrupted"]],
        ["Result", ["g!:·Mary comes back ✓"]]],
        cap: "Indirect-object identification in GPT-2 small. ARENA chapter 1 walks through the full search." },
      q: { q: "Patching one head restores the right answer. What does that show?", o: ["That head carries information the answer depends on", "That head is unused", "The model memorized the sentence"], a: 0,
        why: "Moving just that piece was enough to move the answer, so it's on the causal path." } },
    s15: {
      p: ["Models pack more concepts than they have dimensions, so single neurons are a blur of meanings. A sparse autoencoder rewrites one layer's activation as a handful of active features out of thousands, and each feature tends to mean one thing.",
          "Start with the GPT-2 SAEs, then move to Gemma 2 2B with a Gemma Scope SAE, where features are cleaner and there are published labels to compare against."],
      fig: { type: "bars", fmt: "raw", input: "Token: ·Paris in “the city of Paris” · layer 8 residual stream",
        groups: [{ q: "Most active SAE features (of 24,576)", rows: [["#4127 European capitals", 9.1], ["#880 French words", 5.4], ["#12011 famous landmarks", 3.2], ["#301 proper nouns", 2.7], ["24,572 others", 0]] }],
        cap: "Illustrative feature activations: a few on, almost everything off." },
      q: { q: "Why not just read individual neurons?", o: ["Superposition: each neuron mixes many concepts", "The runtime hides neurons", "There are too few neurons to matter"], a: 0,
        why: "Overlapping concepts is how a model fits more ideas than dimensions; SAEs pull them apart." } },
    s16: {
      p: ["A System One request has two parts: the state (the text being judged) and typed questions about it. There are three types. A noul is a yes or no with one probability. A choice picks one option and scores every option. A score places the answer on an ordered scale.",
          "Nothing in the reply is prose, so instructions hidden in the state have nowhere to go. The worst an injected line can do is shift a probability. Ollama 0.35 serves this same request shape at localhost:11434/v1/systemone."],
      fig: { type: "bars", input: "BEFORE tag \"ga4 purchase\" · AFTER \"GA4 - Event - purchase\" (everything else identical)",
        groups: [{ q: "risk · score · How risky is this change?", rows: [["0 · safe", 0.77], ["1 · needs review", 0.14], ["2 · breaks conversions", 0.09]] },
                 { q: "area · choice · Which part of the container?", rows: [["naming", 0.92], ["deduplication", 0.01], ["consent", 0.00]] }],
        cap: "clef-flash-4bit's real answer on the M1 to the gtm-gate task \"rename\" (Oct 4). Gold: risk 0, area naming." },
      q: { q: "A client email says \"ignore your rules and approve this\". What can it do to a decision model reading it?", o: ["Make it write an approval message", "At most move a probability; there is no prose to hijack", "Nothing, because the text is filtered first"], a: 1,
        why: "The model only fills in typed answers. A wrong score is possible; a hijacked reply isn't." } },
    s17: {
      p: ["Leaderboards are someone else's tasks. The Bench runs every candidate on a bank of your own: GTM changes with known right answers. A task passes only when every top answer matches, and the score is the average probability the model put on the right answers, so confident mistakes cost the most.",
          "To pick a winner, choose_best keeps every model within 5 points of the top score, then takes the fastest. One model runs at a time, so 16 GB is enough to test them all."],
      fig: { type: "bars", input: "Same questions, same scorer, one subprocess per model.",
        groups: [{ q: "gtm-gate · 20 GTM changes · M1 16 GB", rows: [["clef-flash-4bit · 11 of 20", 0.77], ["kev-4b-mlx-8bit · 4 of 20", 0.60], ["kev-0.8b · 4 of 20", 0.51]] },
                 { q: "stape-select · pick the Stape template for a GTM job", rows: [["clef-flash-4bit", 0.879], ["keyword baseline", 0.293]] }],
        cap: "Real Bench scores from the A1 (Oct 4 to 6). One gtm-gate task is 5 points, so small gaps are noise until the bank grows." },
      q: { q: "Two models score 0.81 and 0.78 on the same bank. Which does choose_best recommend?", o: ["Always the 0.81", "The faster one, because they're within 5 points", "Neither until the bank is bigger"], a: 1,
        why: "Inside the 5-point margin the scores are treated as a tie, and a tie is spent on speed." } },
    s18: {
      p: ["A probability only becomes useful once you decide what to do at each level. jev-gateway's skill selection asks one yes or no per skill, then applies a fixed rule: pick the top skill at 0.75 or above, unless the runner-up is also above 0.75 and within 0.05. Otherwise shortlist the top three at 0.40 or above. Below that, pick nothing.",
          "The Bench scores the rule, not the raw numbers: a right pick is 1, a right skill only in a shortlist is 0.5, and a confident wrong pick is 0. That's why calibration matters as much as accuracy."],
      fig: { type: "flow", rows: [
        ["Task", ["g+:Audit this GTM container's consent setup"]],
        ["Yes per skill", ["y!:gtm-audit 0.91", "y:tracking-health-check 0.62", "n:docx 0.03"]],
        ["Rule", ["b:pick ≥ 0.75", "b:shortlist ≥ 0.40", "b:tie < 0.05", "b:else none"]],
        ["Decision", ["p!:selected: gtm-audit"]]],
        cap: "The select-skill rule. Probabilities are illustrative; the thresholds are the gateway's real ones." },
      q: { q: "gtm-audit gets 0.80 and tracking-health-check gets 0.78. What does the gateway do?", o: ["Picks gtm-audit", "Shortlists both, because they're within 0.05", "Picks nothing"], a: 1,
        why: "Both clear 0.75 and they're 0.02 apart, which the rule treats as too close to call." } },
    s19: {
      p: ["Callers never talk to a model directly. They call jev-gateway, a Cloudflare Worker that owns the questions, the scoring and the fallback order. The Worker sends each model call through AI Gateway, which logs it and routes it to one of three backends.",
          "Clef-Flash answers first, running on your Mac mini and reached through a Cloudflare Tunnel with no inbound ports open. If it fails, hosted Jev answers instead, and a skill_selection_fallback event records why."],
      fig: { type: "flow", rows: [
        ["Caller", ["g:skill-router", "g:Bearing", "g:stape-agent-toolset"]],
        ["Worker", ["b+:jev-gateway · scoring · fallback · D1 audit"]],
        ["AI Gateway", ["p+:logs every call · custom-clef · custom-jev · custom-laya"]],
        ["Backend", ["y!:Clef-Flash · Mac mini via clef.organizedai.vip", "n:Jev · hosted fallback", "n:Laya · container"]]],
        cap: "One request through jev-gateway. The Worker decides; AI Gateway carries and logs each model call." },
      q: { q: "The Mac mini is asleep. What answers a skill-selection request?", o: ["Nothing; callers get an error", "Hosted Jev, with a fallback event saying why", "Clef-Flash from a cache"], a: 1,
        why: "Jev is the fallback, and every fallback is logged so a sleeping mini shows up before callers notice." } },
    s20: {
      p: ["A decision is only reviewable if its evidence survives. Online, jev-gateway writes every selection to D1, emits structured events to Workers Logs, and AI Gateway keeps the raw call. Workers Logs last seven days, so anything you report on monthly needs an export to R2 or an OpenTelemetry destination.",
          "Offline nothing reaches Cloudflare. wrangler dev keeps D1, KV and R2 on disk, and Local Explorer captures the logs. Write runs to a local outbox marked transport=direct, then replay it to the deployed gateway once you're back online."],
      fig: { type: "flow", rows: [
        ["Offline", ["n:wrangler dev", "n:Local Explorer", "y:outbox · transport=direct"]],
        ["Back online", ["b+:replay to the deployed jev-gateway"]],
        ["Stored", ["g:D1 · system of record", "g:Workers Logs · 7 days", "g!:R2 or OTel · past day 7"]]],
        cap: "Where a decision's evidence lives, online and off. Every event carries run_id and the model version." },
      q: { q: "A client asks about a decision from five weeks ago. Where is the evidence?", o: ["Workers Logs", "D1 and your R2 or OpenTelemetry export", "AI Gateway's cache"], a: 1,
        why: "Workers Logs keep seven days; D1 and the export are what last." } },
  };

  const parsePill = s => { const m = /^([ybpgn])([!+]*):(.*)$/s.exec(s) || [0, "n", "", s]; return { c: m[1], hl: m[2].includes("!"), wide: m[2].includes("+"), t: m[3] }; };
  const fmtV = (v, f) => f === "pct" ? Math.round(v * 100) + "%" : f === "raw" ? v.toFixed(1) : (v > 0 ? "" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2);

  function figHtml(f, n) {
    let body = "";
    if (f.type === "flow") {
      body = `<div class="lp-flow">${f.rows.map(([label, pills], k) => `
        ${k ? `<div class="lp-arrow" aria-hidden="true"><i></i></div>` : ""}
        <div class="lp-row"><span class="lp-rl">${esc(label)}</span><div class="lp-pills">${pills.map(parsePill).map(p => `<span class="lp-pill ${p.c}${p.hl ? " hl" : ""}${p.wide ? " wide" : ""}">${esc(p.t)}</span>`).join("")}</div></div>`).join("")}</div>`;
    } else {
      const max = Math.max(...f.groups.flatMap(g => g.rows.map(r => Math.abs(r[1])))) || 1;
      body = `${f.input ? `<div class="lp-input"><span>INPUT</span>${esc(f.input)}</div>` : ""}${f.groups.map(g => {
        const top = g.rows.reduce((b, r, k) => Math.abs(r[1]) > Math.abs(g.rows[b][1]) ? k : b, 0);
        return `<div class="lp-bars${f.signed ? " signed" : ""}"><div class="lp-bq">${esc(g.q)}</div>${g.rows.map(([lab, v], k) => `
          <div class="lp-brow${k === top ? " hl" : ""}${v < 0 ? " neg" : ""}"><span class="lp-bl">${esc(lab)}</span>
            <span class="lp-btrack"><i data-w="${(Math.abs(v) / max * (f.signed ? 50 : 100)).toFixed(2)}" style="width:${(Math.abs(v) / max * (f.signed ? 50 : 100)).toFixed(2)}%"></i></span>
            <b data-v="${v}" data-f="${f.fmt || "p"}">${fmtV(v, f.fmt || "p")}</b></div>`).join("")}</div>`;
      }).join("")}`;
    }
    return `<figure class="lp-fig" data-fig>${body}
      <figcaption><span><b>FIG. ${n}</b> — ${esc(f.cap)}</span><button type="button" class="lp-replay" aria-label="Replay figure ${n}">↻ Replay</button></figcaption></figure>`;
  }

  const quizStore = () => window.__a1store?.get("a1-quiz", {}) ?? {};
  function xpOf(ctx) {
    const qz = quizStore();
    const correct = Object.entries(qz).filter(([id, a]) => L[id] && L[id].q.a === a).length;
    const chapters = CHAPTERS.filter(c => c.steps.every(s => ctx.stepsDone.has(s))).length;
    return { xp: ctx.stepsDone.size * XP.section + correct * XP.correct + chapters * XP.chapter, correct, chapters };
  }

  function html(all, ctx) {
    const byId = Object.fromEntries(ctx.STEPS.map(s => [s.id, s]));
    const qz = quizStore();
    const { xp } = xpOf(ctx);
    let n = 0;
    const total = CHAPTERS.reduce((t, c) => t + c.steps.length, 0);
    const toc = CHAPTERS.map((c, ci) => `<li><span class="lp-tch">[ 0${ci + 1} ] ${esc(c.title)}</span><ol>${c.steps.map(id => { n++; return `<li><a href="#lp-${id}" data-toc="${id}" class="${ctx.stepsDone.has(id) ? "done" : ""}"><em>${String(n).padStart(2, "0")}</em>${esc(byId[id]?.title || id)}</a></li>`; }).join("")}</ol></li>`).join("");
    n = 0;
    const chapters = CHAPTERS.map((c, ci) => `
      <section class="lp-chapter" id="lp-${c.id}">
        <header class="lp-chead"><span class="lp-kick">Chapter ${ci + 1} of ${CHAPTERS.length}</span><h2>${esc(c.title)}</h2><p>${esc(c.blurb)}</p></header>
        ${c.steps.map(id => {
          n++;
          const s = byId[id], l = L[id]; if (!s || !l) return "";
          const its = s.find(all), done = ctx.stepsDone.has(id), ans = qz[id];
          return `<section class="lp-sec${done ? " done" : ""}" id="lp-${id}" data-sid="${id}">
            <div class="lp-kick">[ ${String(n).padStart(2, "0")} ] · Section ${n} of ${total}</div>
            <h3>${esc(s.title)}</h3>
            <p class="lp-goal">${esc(s.goal)}</p>
            ${l.p.map(t => `<p>${esc(t)}</p>`).join("")}
            ${figHtml(l.fig, n)}
            ${s.concepts.length ? `<div class="lp-concepts"><span>Key ideas</span>${s.concepts.map(k => `<button class="chip" data-concept="${k}">${esc(window.CONCEPTS?.[k]?.title || k)}</button>`).join("")}</div>` : ""}
            <div class="lp-drive"><span class="lp-kick">On your drive</span>${its.length ? `<div class="m-grid">${its.map(ctx.cardHtml).join("")}</div>` : `<p class="meta">Nothing on the drive for this yet. Approved picks arrive on the next plug-in.</p>`}</div>
            <div class="lp-quiz" data-quiz="${id}">
              <div class="lp-kick">Check yourself · +${XP.correct} XP</div>
              <p class="lp-qq">${esc(l.q.q)}</p>
              <div class="lp-opts">${l.q.o.map((o, k) => `<button type="button" class="lp-opt${ans != null ? (k === l.q.a ? " right" : k === ans ? " wrong" : "") : ""}" data-opt="${k}"${ans != null ? " disabled" : ""}><em>${"ABC"[k]}</em>${esc(o)}</button>`).join("")}</div>
              <p class="lp-why"${ans != null ? "" : " hidden"}>${ans === l.q.a ? "<b>Right.</b> " : ans != null ? "<b>Not quite.</b> " : ""}${esc(l.q.why)}</p>
            </div>
            <div class="lp-foot"><button type="button" class="btn${done ? "" : " go"} lp-done" data-lpdone="${id}">${done ? "✓ Done · mark not done" : `Mark section done · +${XP.section} XP`}</button></div>
          </section>`;
        }).join("")}
      </section>`).join("");
    return `<div class="lp">
      <header class="lp-hero">
        <span class="lp-kick">Learning path</span>
        <h2>Learn the stack on your own drive.</h2>
        <p>${total} short sections, from loading a model to reading its features. Every figure plays as you reach it, every section ends with one question, and everything it uses is already on the A1. Choosing hardware or setting up a drive of your own? Start with the <a href="https://guide.organizedai.vip/local-compute/" target="_blank" rel="noopener">Local Compute guide</a>.</p>
        <div class="lp-stats">
          <div><span>[ 01 ]</span><b>${CHAPTERS.length}</b><small>chapters</small></div>
          <div><span>[ 02 ]</span><b data-lp="done">${ctx.stepsDone.size ? [...ctx.stepsDone].filter(s => L[s]).length : 0}<i>/${total}</i></b><small>sections done</small></div>
          <div><span>[ 03 ]</span><b data-lp="right">${xpOf(ctx).correct}<i>/${total}</i></b><small>questions right</small></div>
          <div class="xp"><span>[ 04 ]</span><b data-lp="xp" data-n="${xp}">${xp}</b><small>XP · ${XP.section} a section, ${XP.correct} a right answer, ${XP.chapter} a chapter</small></div>
        </div>
      </header>
      <div class="lp-grid">
        <nav class="lp-toc" aria-label="Sections"><div class="lp-rail"><i></i></div><ol>${toc}</ol></nav>
        <article class="lp-main">${chapters}</article>
      </div></div>`;
  }

  /* ---------- motion ---------- */
  let triggers = [];
  function figTimeline(fig) {
    const tl = gsap.timeline({ paused: true });
    if (fig.querySelector(".lp-flow")) {
      fig.querySelectorAll(".lp-row, .lp-arrow").forEach(el => {
        if (el.classList.contains("lp-arrow")) { tl.fromTo(el.querySelector("i"), { scaleY: 0 }, { scaleY: 1, duration: .22, ease: "power1.in" }); return; }
        tl.fromTo(el.querySelector(".lp-rl"), { x: -14, opacity: 0 }, { x: 0, opacity: 1, duration: .3, ease: "power2.out" })
          .fromTo(el.querySelectorAll(".lp-pill"), { y: 8, scale: .7, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: .38, stagger: .055, ease: "back.out(2.2)" }, "<.05");
      });
      const hl = fig.querySelectorAll(".lp-pill.hl");
      if (hl.length) tl.fromTo(hl, { boxShadow: "0 0 0 0 color-mix(in srgb, var(--brand) 70%, transparent)" }, { boxShadow: "0 0 0 8px transparent", duration: .7, repeat: 1, ease: "power2.out" });
    } else {
      fig.querySelectorAll(".lp-input").forEach(el => tl.fromTo(el, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: .35 }));
      fig.querySelectorAll(".lp-bars").forEach(g => {
        tl.fromTo(g.querySelector(".lp-bq"), { opacity: 0 }, { opacity: 1, duration: .25 });
        g.querySelectorAll(".lp-brow").forEach((r, k) => {
          const bar = r.querySelector("i"), num = r.querySelector("b"), v = +num.dataset.v, f = num.dataset.f, o = { v: 0 };
          tl.fromTo(r.querySelector(".lp-bl"), { opacity: 0, x: -8 }, { opacity: 1, x: 0, duration: .2 }, k ? "<.08" : ">")
            .fromTo(bar, { width: "0%" }, { width: bar.dataset.w + "%", duration: .7, ease: "power3.out" }, "<")
            .fromTo(o, { v: 0 }, { v, duration: .7, ease: "power3.out", onUpdate: () => num.textContent = fmtV(o.v, f) }, "<");
        });
        const hl = g.querySelector(".lp-brow.hl"); if (hl) tl.fromTo(hl, { backgroundColor: "color-mix(in srgb, var(--brand) 28%, transparent)" }, { backgroundColor: "rgba(0,0,0,0)", duration: 1, clearProps: "backgroundColor" });
      });
    }
    return tl;
  }
  function floatXP(from, text) {
    if (RM()) return;
    const r = from.getBoundingClientRect(), t = document.createElement("span");
    t.className = "lp-xpfly"; t.textContent = text; t.style.left = r.left + r.width / 2 + "px"; t.style.top = r.top + "px";
    document.body.appendChild(t);
    gsap.fromTo(t, { y: 0, opacity: 0, scale: .8 }, { y: -46, opacity: 1, scale: 1, duration: .5, ease: "back.out(2)" });
    gsap.to(t, { opacity: 0, y: -70, duration: .4, delay: .9, onComplete: () => t.remove() });
  }
  function refreshStats(ctx, root) {
    const { xp, correct } = xpOf(ctx), total = CHAPTERS.reduce((t, c) => t + c.steps.length, 0);
    const xb = root.querySelector('[data-lp="xp"]'), old = +xb.dataset.n;
    xb.dataset.n = xp;
    if (RM()) xb.textContent = xp; else { const o = { v: old }; gsap.to(o, { v: xp, duration: .8, ease: "power2.out", onUpdate: () => xb.textContent = Math.round(o.v) }); gsap.fromTo(xb.parentElement, { scale: 1.04 }, { scale: 1, duration: .5, ease: "back.out(3)" }); }
    root.querySelector('[data-lp="done"]').innerHTML = `${[...ctx.stepsDone].filter(s => L[s]).length}<i>/${total}</i>`;
    root.querySelector('[data-lp="right"]').innerHTML = `${correct}<i>/${total}</i>`;
    const pr = document.querySelector(".m-progress span"); if (pr) pr.innerHTML = pr.innerHTML.replace(/\d+ of (\d+) path steps/, `${ctx.stepsDone.size} of $1 path steps`);
  }

  function wire(ctx) {
    triggers.forEach(t => t.kill()); triggers = [];
    const root = document.querySelector(".lp"); if (!root) return;
    const rm = RM(), ST = window.ScrollTrigger;
    // keep the contents list just under the sticky toolbar, whatever height it wraps to
    const tools = document.querySelector(".m-tools");
    const setTop = () => root.style.setProperty("--lp-top", (tools ? tools.offsetHeight : 56) + "px");
    setTop(); window.removeEventListener("resize", wire._top || (() => {})); wire._top = setTop; window.addEventListener("resize", setTop);
    if (ST) gsap.registerPlugin(ST);

    // figures: play when they scroll into view; replay on demand
    root.querySelectorAll("[data-fig]").forEach(fig => {
      const tl = figTimeline(fig);
      fig.querySelector(".lp-replay").onclick = () => rm ? null : tl.restart();
      if (rm || !ST) { tl.progress(1); return; }
      tl.progress(0).pause();
      triggers.push(ST.create({ trigger: fig, start: "top 78%", once: true, onEnter: () => tl.play() }));
    });
    if (!rm && ST) {
      // section copy rises in
      root.querySelectorAll(".lp-sec, .lp-chead").forEach(sec => {
        const parts = sec.querySelectorAll(":scope > .lp-kick, :scope > h2, :scope > h3, :scope > p, :scope > .lp-concepts");
        gsap.set(parts, { y: 16, opacity: 0 });
        triggers.push(ST.create({ trigger: sec, start: "top 82%", once: true, onEnter: () => gsap.to(parts, { y: 0, opacity: 1, duration: .55, stagger: .07, ease: "power3.out" }) }));
      });
      // reading progress on the rail
      const rail = root.querySelector(".lp-rail i");
      triggers.push(ST.create({ trigger: root.querySelector(".lp-main"), start: "top 30%", end: "bottom 70%", scrub: .4,
        onUpdate: s => gsap.set(rail, { scaleY: s.progress }) }));
      // hero stats count up once
      root.querySelectorAll(".lp-stats > div").forEach((d, k) => gsap.from(d, { y: 12, opacity: 0, duration: .45, delay: .1 + k * .07, ease: "power2.out", clearProps: "all" }));
    }
    // highlight the section being read in the contents list
    if (ST) root.querySelectorAll(".lp-sec").forEach(sec => triggers.push(ST.create({ trigger: sec, start: "top 45%", end: "bottom 45%",
      onToggle: s => { if (!s.isActive) return; root.querySelectorAll("[data-toc]").forEach(a => a.classList.toggle("on", a.dataset.toc === sec.dataset.sid));
        const on = root.querySelector(`[data-toc="${sec.dataset.sid}"]`); if (on && matchMedia("(max-width: 900px)").matches) on.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); } })));
    root.querySelectorAll("[data-toc]").forEach(a => a.onclick = e => { e.preventDefault(); document.getElementById("lp-" + a.dataset.toc)?.scrollIntoView({ behavior: rm ? "auto" : "smooth", block: "start" }); });

    // quiz
    root.querySelectorAll("[data-quiz]").forEach(box => {
      const id = box.dataset.quiz, l = L[id];
      box.querySelectorAll(".lp-opt").forEach(btn => btn.onclick = () => {
        const k = +btn.dataset.opt, qz = quizStore(); if (qz[id] != null) return;
        qz[id] = k; window.__a1store?.set("a1-quiz", qz);
        box.querySelectorAll(".lp-opt").forEach((b, j) => { b.disabled = true; if (j === l.q.a) b.classList.add("right"); else if (j === k) b.classList.add("wrong"); });
        const why = box.querySelector(".lp-why"); why.innerHTML = `${k === l.q.a ? "<b>Right.</b> " : "<b>Not quite.</b> "}${esc(l.q.why)}`; why.hidden = false;
        if (!rm) {
          if (k === l.q.a) { gsap.fromTo(btn, { scale: .96 }, { scale: 1, duration: .5, ease: "back.out(3)" }); floatXP(btn, `+${XP.correct} XP`); const r = btn.getBoundingClientRect(); window.burst?.(r.left + 24, r.top + r.height / 2, 10, 40); }
          else { gsap.fromTo(btn, { x: 0 }, { keyframes: [{ x: -6 }, { x: 6 }, { x: -4 }, { x: 0 }], duration: .35 }); }
          gsap.fromTo(why, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .35, delay: .15 });
        }
        refreshStats(ctx, root);
      });
    });

    // section done, chapter complete
    root.querySelectorAll("[data-lpdone]").forEach(btn => btn.onclick = () => {
      const id = btn.dataset.lpdone, was = ctx.stepsDone.has(id);
      const ch = CHAPTERS.find(c => c.steps.includes(id)), chWas = ch.steps.every(s => ctx.stepsDone.has(s));
      was ? ctx.stepsDone.delete(id) : ctx.stepsDone.add(id); ctx.saveSteps();
      const sec = btn.closest(".lp-sec"); sec.classList.toggle("done", !was);
      btn.classList.toggle("go", was); btn.textContent = was ? `Mark section done · +${XP.section} XP` : "✓ Done · mark not done";
      root.querySelector(`[data-toc="${id}"]`)?.classList.toggle("done", !was);
      if (!was && !rm) {
        floatXP(btn, `+${XP.section} XP`);
        gsap.fromTo(sec, { boxShadow: "inset 3px 0 0 0 var(--brand)" }, { boxShadow: "inset 3px 0 0 0 transparent", duration: 1.2, clearProps: "boxShadow" });
        if (!chWas && ch.steps.every(s => ctx.stepsDone.has(s))) {
          const r = btn.getBoundingClientRect(); window.burst?.(r.left + r.width / 2, r.top, 40, 170);
          setTimeout(() => floatXP(btn, `Chapter complete · +${XP.chapter} XP`), 450);
        }
      }
      refreshStats(ctx, root);
    });
  }

  window.Lessons = { html, wire, kill: () => { triggers.forEach(t => t.kill()); triggers = []; }, chapters: CHAPTERS };

  const css = document.createElement("style");
  css.textContent = `
  .lp{--serif:"Source Serif 4",Georgia,serif;--pill-y:#fbe04d;--pill-b:#a8d8ff;--pill-p:#ffb8c9;--pill-g:#b9f0c8;--pill-ink:#14130f}
  .lp-kick{display:block;font:500 11px "IBM Plex Mono",monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
  .lp-hero{border:1px solid var(--line);border-radius:12px;padding:26px 24px;margin:0 0 28px;background:linear-gradient(180deg,color-mix(in srgb,var(--brand) 6%,var(--panel)),var(--panel))}
  .lp-hero h2{font:600 clamp(26px,4vw,38px)/1.15 "IBM Plex Mono",monospace;margin:8px 0 10px;letter-spacing:-.01em}
  .lp-hero p{font:17px/1.6 var(--serif);color:var(--mute);max-width:62ch;margin:0 0 20px}
  .lp-hero p a,.lp-sec>p a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
  .lp-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .lp-stats>div{padding:14px 16px;border-right:1px solid var(--line);display:grid;gap:2px}
  .lp-stats>div:last-child{border-right:0}
  .lp-stats span{font:11px "IBM Plex Mono",monospace;color:var(--mute)}
  .lp-stats b{font:600 28px/1.1 "IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
  .lp-stats b i{font-style:normal;font-size:15px;color:var(--mute);font-weight:400}
  .lp-stats .xp b{color:var(--brand)}
  .lp-stats small{font:10.5px/1.35 "IBM Plex Mono",monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--mute)}
  @media(max-width:720px){.lp-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.lp-stats>div:nth-child(2){border-right:0}.lp-stats>div:nth-child(-n+2){border-bottom:1px solid var(--line)}}
  .lp-grid{display:grid;grid-template-columns:230px minmax(0,1fr);gap:36px;align-items:start}
  .lp-toc{position:sticky;top:calc(var(--lp-top,56px) + 14px);max-height:calc(100vh - var(--lp-top,56px) - 30px);overflow:auto;display:grid;grid-template-columns:3px 1fr;gap:14px;padding-right:4px}
  .lp-rail{background:var(--line);border-radius:2px;position:relative;overflow:hidden}
  .lp-rail i{position:absolute;inset:0;background:var(--brand);transform-origin:top;transform:scaleY(0)}
  .lp-toc ol{list-style:none;margin:0;padding:0;display:grid;gap:14px}
  .lp-toc ol ol{gap:2px;margin-top:6px}
  .lp-tch{font:600 11px "IBM Plex Mono",monospace;color:var(--mute);text-transform:uppercase;letter-spacing:.08em}
  .lp-toc a{display:flex;gap:8px;align-items:baseline;padding:4px 8px;border-radius:6px;color:var(--mute);text-decoration:none;font:13px/1.35 "IBM Plex Sans",sans-serif;transition:background .2s,color .2s}
  .lp-toc a em{font:11px "IBM Plex Mono",monospace;font-style:normal;opacity:.7}
  .lp-toc a:hover{color:var(--ink)}
  .lp-toc a.on{background:var(--chip);color:var(--ink)}
  .lp-toc a.on em{color:var(--brand);opacity:1}
  .lp-toc a.done::after{content:"✓";margin-left:auto;color:var(--accent);font-size:12px}
  @media(max-width:900px){.lp-grid{grid-template-columns:1fr;gap:16px}
    .lp-toc{top:var(--lp-top,56px);z-index:4;background:var(--bg);grid-template-columns:1fr;padding:6px 0;max-height:none;overflow-x:auto;overflow-y:hidden}
    .lp-rail,.lp-tch{display:none}.lp-toc>ol{display:flex;gap:0}.lp-toc ol ol{display:flex;margin:0;gap:4px}
    .lp-toc a{white-space:nowrap;border:1px solid var(--line);border-radius:999px;padding:4px 10px}}
  .lp-main{max-width:760px;min-width:0}
  .lp-chapter{margin-bottom:40px}
  .lp-chead{padding:8px 0 22px;border-bottom:1px solid var(--line);margin-bottom:8px}
  .lp-chead h2{font:600 30px/1.2 var(--serif);margin:6px 0 6px}
  .lp-chead p{font:17px/1.6 var(--serif);color:var(--mute);margin:0;max-width:62ch}
  .lp-sec{padding:30px 0 34px;border-bottom:1px solid var(--line);scroll-margin-top:calc(var(--lp-top,56px) + 60px)}
  .lp-sec h3{font:600 26px/1.25 var(--serif);margin:8px 0 6px}
  .lp-sec>p{font:17px/1.68 var(--serif);margin:0 0 14px;max-width:68ch}
  .lp-sec>p.lp-goal{font:500 15px/1.5 "IBM Plex Sans",sans-serif;color:var(--mute);margin-bottom:18px}
  .lp-sec.done h3::after{content:" ✓";color:var(--accent);font-size:.8em}
  .lp-fig{margin:22px 0 18px;border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:22px 20px 0;overflow:hidden}
  .lp-flow{display:grid;gap:0}
  .lp-row{display:grid;grid-template-columns:150px minmax(0,1fr);gap:14px;align-items:center}
  .lp-rl{font:500 12px "IBM Plex Mono",monospace;border:1px solid var(--line);border-radius:6px;padding:6px 10px;text-align:center;color:var(--ink);background:var(--bg)}
  .lp-pills{display:flex;gap:6px;flex-wrap:wrap;min-width:0}
  .lp-pill{font:500 12.5px "IBM Plex Mono",monospace;padding:7px 11px;border-radius:6px;color:var(--pill-ink);overflow-wrap:anywhere;border:1px solid rgba(0,0,0,.18)}
  .lp-pill.y{background:var(--pill-y)}.lp-pill.b{background:var(--pill-b)}.lp-pill.p{background:var(--pill-p)}.lp-pill.g{background:var(--pill-g)}
  .lp-pill.n{background:var(--chip);color:var(--mute);border-color:var(--line)}
  .lp-pill.wide{flex:1 1 auto}
  .lp-pill.hl{outline:2px solid var(--ink);outline-offset:1px}
  .lp-arrow{display:grid;grid-template-columns:150px minmax(0,1fr);gap:14px;height:26px}
  .lp-arrow i{grid-column:2;justify-self:center;width:2px;height:100%;background:var(--mute);position:relative;transform-origin:top}
  .lp-arrow i::after{content:"";position:absolute;left:50%;bottom:-1px;border:5px solid transparent;border-top:6px solid var(--mute);transform:translate(-50%,50%)}
  @media(max-width:620px){.lp-row,.lp-arrow{grid-template-columns:1fr;gap:6px}.lp-rl{justify-self:start}.lp-arrow i{grid-column:1}}
  .lp-input{font:14px/1.5 var(--serif);border-left:3px solid var(--brand);padding:4px 0 4px 12px;margin-bottom:16px}
  .lp-input span{display:block;font:500 10.5px "IBM Plex Mono",monospace;letter-spacing:.1em;color:var(--mute)}
  .lp-bars{display:grid;gap:4px;margin-bottom:16px}
  .lp-bq{font:500 12px "IBM Plex Mono",monospace;color:var(--mute);margin-bottom:4px}
  .lp-brow{display:grid;grid-template-columns:minmax(120px,190px) minmax(0,1fr) 58px;gap:10px;align-items:center;padding:3px 6px;border-radius:5px}
  .lp-bl{font:12.5px "IBM Plex Mono",monospace;overflow-wrap:anywhere}
  .lp-btrack{height:10px;background:var(--chip);border-radius:3px;position:relative;overflow:hidden}
  .lp-btrack i{position:absolute;top:0;bottom:0;left:0;background:color-mix(in srgb,var(--pill-b) 80%,var(--panel));border-radius:3px}
  .lp-brow.hl .lp-btrack i{background:var(--brand)}
  .lp-brow.hl .lp-bl,.lp-brow.hl b{color:var(--accent)}
  .lp-brow b{font:600 12.5px "IBM Plex Mono",monospace;text-align:right;font-variant-numeric:tabular-nums}
  .lp-bars.signed .lp-btrack::before{content:"";position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--mute);z-index:1}
  .lp-bars.signed .lp-btrack i{left:50%}
  .lp-bars.signed .lp-brow.neg .lp-btrack i{left:auto;right:50%;background:var(--pill-p)}
  .lp-fig figcaption{display:flex;justify-content:space-between;gap:10px;align-items:center;border-top:1px solid var(--line);margin:18px -20px 0;padding:10px 20px;font:11.5px/1.4 "IBM Plex Mono",monospace;color:var(--mute)}
  .lp-fig figcaption b{color:var(--ink);letter-spacing:.06em}
  .lp-replay{all:unset;cursor:pointer;color:var(--accent);white-space:nowrap;font:500 11.5px "IBM Plex Mono",monospace}
  .lp-replay:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .lp-concepts{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:4px 0 18px}
  .lp-concepts>span{font:500 11px "IBM Plex Mono",monospace;color:var(--mute);text-transform:uppercase;letter-spacing:.08em;margin-right:4px}
  .lp-drive{margin:0 0 20px}.lp-drive .lp-kick{color:var(--mute);margin-bottom:8px}
  .lp-quiz{border:1px solid var(--line);border-radius:10px;padding:16px;background:var(--panel);margin-bottom:16px}
  .lp-qq{font:600 17px/1.45 var(--serif);margin:6px 0 12px}
  .lp-opts{display:grid;gap:6px}
  .lp-opt{all:unset;box-sizing:border-box;cursor:pointer;display:flex;gap:10px;align-items:baseline;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:14.5px/1.4 "IBM Plex Sans",sans-serif;transition:border-color .15s,background .15s}
  .lp-opt em{font:600 12px "IBM Plex Mono",monospace;font-style:normal;color:var(--mute)}
  .lp-opt:hover:not([disabled]){border-color:var(--brand)}
  .lp-opt:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .lp-opt[disabled]{cursor:default}
  .lp-opt.right{border-color:var(--accent);background:color-mix(in srgb,var(--brand) 12%,transparent)}
  .lp-opt.right em{color:var(--accent)}
  .lp-opt.wrong{border-color:var(--bad);background:color-mix(in srgb,var(--bad) 10%,transparent)}
  .lp-why{font:15px/1.55 var(--serif);margin:12px 0 0;color:var(--ink)}
  .lp-foot{display:flex;justify-content:flex-end}
  .lp-xpfly{position:fixed;transform:translateX(-50%);z-index:60;pointer-events:none;font:600 13px "IBM Plex Mono",monospace;color:var(--on-brand);background:var(--brand);padding:4px 10px;border-radius:999px;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.3)}
  `;
  document.head.appendChild(css);
})();
