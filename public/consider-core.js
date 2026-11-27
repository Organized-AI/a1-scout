// Considering a Mac: the one copy of the math that both the browser (Bench → Simulate, "Considering a Mac") and the
// Worker (POST /api/bench/consider) use. Classic script on purpose: the browser loads it with a <script> tag and the
// Worker imports this same file for its side effect, so there is no second model to keep in step.
//
// What it decides: memory fit (macOS lets models use 75% of memory), speed scaled from a measured run by Apple's
// memory bandwidth (local generation is memory-bound), the verdict per workflow, and the headline for the whole set.
// Speeds it returns are estimates; nothing has run on the Mac being considered.
(function (root) {
  "use strict";

  // Apple's published unified-memory bandwidth, GB/s. Copied from RAM Scout's runner/chip-speed.js (the dashboard's
  // Chip speed table); keep the two in step. Binned chips pick the bin by GPU/CPU cores when stated, else by memory.
  const SRC = {
    mbp2021: "https://support.apple.com/kb/SP854", studio2022: "https://support.apple.com/111900",
    mini2023: "https://support.apple.com/111837", studio2023: "https://support.apple.com/111835",
    mbpM3: "https://support.apple.com/117735", mbpM3ProMax: "https://support.apple.com/117736",
    mini2024: "https://support.apple.com/en-us/121555", studio2025: "https://support.apple.com/en-us/122211",
    mbpM5: "https://support.apple.com/125405", miniNow: "https://www.apple.com/mac-mini/specs/",
    studioNow: "https://www.apple.com/mac-studio/specs/",
  };
  const CHIPS = {
    "M1": { unknown: "Apple publishes no memory-bandwidth figure for the base M1" },
    "M1 Pro": { gbs: 200, src: "mbp2021" }, "M1 Max": { gbs: 400, src: "studio2022" }, "M1 Ultra": { gbs: 800, src: "studio2022" },
    "M2": { gbs: 100, src: "mini2023" }, "M2 Pro": { gbs: 200, src: "mini2023" }, "M2 Max": { gbs: 400, src: "studio2023" },
    "M2 Ultra": { gbs: 800, src: "studio2023" }, "M3": { gbs: 100, src: "mbpM3" }, "M3 Pro": { gbs: 150, src: "mbpM3ProMax" },
    "M3 Max": { bins: [300, 400], src: "mbpM3ProMax", gpu: [30, 40], cpu: [14, 16], mem: [[36, 96], [48, 64, 128]] },
    "M3 Ultra": { gbs: 819, src: "studio2025" }, "M4": { gbs: 120, src: "mini2024" }, "M4 Pro": { gbs: 273, src: "mini2024" },
    "M4 Max": { bins: [410, 546], src: "studio2025", gpu: [32, 40], cpu: [14, 16], mem: [[36], [48, 64, 128]] },
    "M5": { gbs: 153, src: "mbpM5" }, "M5 Pro": { gbs: 307, src: "miniNow" },
    "M5 Max": { bins: [460, 614], src: "studioNow", gpu: [32, 40], cpu: [], mem: [[36], [48, 64, 128]] },
    "M5 Ultra": { gbs: 1200, src: "studioNow" },
    "M6": { bins: [153, 170], src: "miniNow", gpu: [], cpu: [], mem: [[16], [24, 32]] },
  };

  // "M4" + "Pro" -> "M4 Pro"; "Apple M4 Pro chip" -> "M4 Pro"; base variant -> "M4". Anything else -> null.
  function chipName(chip, variant) {
    const text = [chip, variant && !/^base$/i.test(String(variant)) ? variant : ""].filter(Boolean).join(" ").trim();
    const m = text.match(/^(?:apple\s+)?m(\d{1,2})(?:\s+([a-z]+))?(?=[\s,(-]|$)/i);
    if (!m) return null;
    const word = (m[2] || "").toLowerCase();
    if (word && !["pro", "max", "ultra", "chip", "with"].includes(word)) return null;
    return "M" + m[1] + (["pro", "max", "ultra"].includes(word) ? " " + word[0].toUpperCase() + word.slice(1) : "");
  }

  // { chip, variant, memory_gb, gpu_cores?, cpu_cores? } -> { chip, gbs, source, bin } or { chip, gbs: null, why }.
  function bandwidthFor(spec) {
    const s = spec || {};
    const name = chipName(s.chip, s.variant);
    if (!name) return { chip: null, gbs: null, why: "chip not stated" };
    const row = CHIPS[name];
    if (!row) return { chip: name, gbs: null, why: `no Apple figure captured for ${name}` };
    if (row.unknown) return { chip: name, gbs: null, why: row.unknown };
    const out = (gbs, bin) => ({ chip: name, gbs, source: SRC[row.src], basis: "Apple spec", bin: bin || null });
    if (row.gbs) return out(row.gbs);
    const gpu = Number(s.gpu_cores), cpu = Number(s.cpu_cores), gb = Number(s.memory_gb);
    for (const k of [0, 1]) {
      if (row.gpu[k] && gpu === row.gpu[k]) return out(row.bins[k], `${gpu}-core GPU`);
      if (row.cpu[k] && cpu === row.cpu[k]) return out(row.bins[k], `${cpu}-core CPU`);
    }
    for (const k of [0, 1]) if (row.mem[k].includes(gb)) return out(row.bins[k], `${gb}GB memory`);
    return { chip: name, gbs: null, why: `${name} comes in ${row.bins.join(" or ")} GB/s versions; the listing does not say which` };
  }

  // A1 Bench's machine_id (agent/bench.py): the Lab's four known ids, else "<chip>-<memory>gb" slugged.
  const KNOWN = { "M1|16": "m1", "M4|16": "m4", "M6|32": "m6", "M5 Pro|64": "m5p" };
  function machineId(spec) {
    const s = spec || {};
    const name = chipName(s.chip, s.variant);
    const gb = Math.round(Number(s.memory_gb));
    if (!name || !Number.isFinite(gb)) return null;
    if (name === "M1" || name.startsWith("M1 ")) { if (gb === 16) return "m1"; }
    const known = KNOWN[name + "|" + gb];
    if (known) return known;
    return (name + "-" + gb + "gb").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  // The Lab's ids for the Macs you may own, as chip + memory, so bandwidth can be read from the same table.
  const LAB_SPECS = { m1: { chip: "M1 Pro", memory_gb: 16 }, m4: { chip: "M4", memory_gb: 16 }, m6: { chip: "M6", memory_gb: 32 }, m5p: { chip: "M5 Pro", memory_gb: 64 } };
  function bandwidthForMachine(id) {
    const spec = LAB_SPECS[id];
    return spec ? bandwidthFor(spec) : { gbs: null, why: "not a known Lab Mac" };
  }

  // macOS lets models use about 75% of memory. Bytes in, boolean out.
  const USABLE = 0.75;
  const budgetBytes = memGb => Number(memGb) * 2 ** 30 * USABLE;
  const fitsBytes = (peakBytes, memGb) => Number.isFinite(peakBytes) && peakBytes <= budgetBytes(memGb);

  // Speed: a measured tok/s on one Mac, scaled to another by memory bandwidth.
  const scaleTokS = (tokS, gbsTo, gbsFrom) => (tokS && gbsTo && gbsFrom ? tokS * gbsTo / gbsFrom : null);

  // Ratios: 25% faster or more is "faster", 20% slower or more is "slower", else about the same.
  const UP = 1.25, DOWN = 0.8;
  const kindOfRatio = x => (x >= UP ? "faster" : x <= DOWN ? "slower" : "same");

  // One workflow (or suite): what the weighed Mac changes compared with the best Mac you own. Same wording as the
  // browser's Simulate table (PR #15). `row` = { candFits, ownedFits (null if no owned stack), ownedLabel, unlocks,
  // ratio (owned speed / candidate speed) or null when there is no speed estimate, budgetFeasible }.
  function verdictOf(row) {
    if (!row || row.na) return { kind: "na", text: "Nothing on the A1 for this workflow yet" };
    if (!row.candFits) return { kind: "worse", text: row.ownedFits ? "Today's stack doesn't fit in its memory" : "Today's stack doesn't fit here either" };
    if (row.unlocks) return { kind: "unlock", text: row.unlocks };
    if (row.ownedFits === false || row.ownedFits == null) return { kind: "unlock", text: "Runs today's stack; none of your Macs can" };
    if (row.noSpeed) return { kind: "unknown", text: "Fits; no speed estimate (Apple's bandwidth figure wasn't captured)" };
    const x = row.ratio;
    if (x >= UP) return { kind: "faster", text: `${x.toFixed(1)}× faster than your ${row.ownedLabel}`, x };
    if (x <= DOWN) return { kind: "slower", text: `${(1 / x).toFixed(1)}× slower than your ${row.ownedLabel}`, x };
    return { kind: "same", text: `About the same as your ${row.ownedLabel}`, x };
  }

  // The set: does it open up work your Macs can't do, only speed it up, or change little? Same wording as PR #15.
  function summaryOf(verdicts) {
    const vs = verdicts.filter(v => v.kind !== "na");
    const n = vs.length, k = kind => vs.filter(v => v.kind === kind).length;
    const opens = k("unlock") + k("budget"), faster = k("faster"), worse = k("worse") + k("slower");
    const xs = vs.filter(v => v.kind === "faster").map(v => v.x).sort((a, b) => a - b);
    const mid = xs.length ? xs[(xs.length - 1) >> 1] : null;
    if (!n) return { tone: "none", n, opens, faster, worse, head: "No workflow could be simulated yet", sub: "Bench needs the drive catalog. Plug in the A1 and refresh." };
    if (opens) return { tone: "good", n, opens, faster, worse, head: `Worth a look: it opens up ${opens} of ${n} workflows`,
      sub: `${opens === 1 ? "One workflow gets" : `${opens} workflows get`} a model or a response time your Macs can't reach${faster ? `, and ${faster} more run faster` : ""}.` };
    if (faster * 2 >= n) return { tone: "mixed", n, opens, faster, worse, head: `Faster, nothing new: about ${mid.toFixed(1)}× on ${faster} of ${n} workflows`,
      sub: "Every workflow already runs on a Mac you own; this one would run them sooner." };
    return { tone: "bad", n, opens, faster, worse, head: worse ? "Not a step up for your workflows" : "Little gain for your workflows",
      sub: worse ? `${worse} of ${n} workflows would run slower or not fit; the rest about the same.` : "Your Macs already run these about as well." };
  }

  // Work weights: the share of your recent sessions that touch each suite, from the sessions' app and model names.
  // Every suite keeps a floor of one session so none drops to zero; weights sum to 1.
  const SIGNALS = {
    "sql-ga4": /sql|bigquery|ga4|query|warehouse|analytics/i,
    "gtm-debug": /gtm|tag ?manager|container|datalayer|tag/i,
    "gtm-gate": /gtm|tag ?manager|container|gate|review/i,
    "html-json": /html|scrap|page|json|crawl/i,
    "rag-notes": /notes|obsidian|rag|docs?|knowledge|chunk/i,
    "asr": /whisper|audio|voice|transcri|speech/i,
    "screen": /screen|browser|vision|chrome|screenshot/i,
    "skill-select": /skill/i,
    "stape-select": /stape/i,
  };
  function weightsFor(suites, sessions) {
    const rows = Array.isArray(sessions) ? sessions : [];
    const counts = {};
    for (const s of suites) {
      const re = SIGNALS[s];
      counts[s] = 1 + (re ? rows.filter(r => re.test(`${r.app || ""} ${r.model || ""}`)).length : 0);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    const out = {};
    for (const s of suites) out[s] = { weight: Math.round((counts[s] / total) * 1000) / 1000, signals: counts[s] - 1 };
    return out;
  }

  // The p95 context a Mac must hold beside the model, from per-session input tokens (a context proxy).
  // KV cache: 128 KB per token for an 8B-class model at fp16 (2 × 32 layers × 8 KV heads × 128 dims × 2 bytes).
  const KV_BYTES_PER_TOKEN = 131072;
  function p95(values) {
    const xs = (values || []).filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
    if (!xs.length) return null;
    return xs[Math.min(xs.length - 1, Math.ceil(0.95 * xs.length) - 1)];
  }
  function contextFits(modelPeakBytes, memGb, p95Tokens) {
    const left = budgetBytes(memGb) - (Number(modelPeakBytes) || 0);
    const need = (Number(p95Tokens) || 0) * KV_BYTES_PER_TOKEN;
    return { fits: left >= need, left_gb: Math.round(left / 2 ** 27) / 8, need_gb: Math.round(need / 2 ** 27) / 8 };
  }

  root.ConsiderCore = Object.freeze({
    chipName, bandwidthFor, machineId, bandwidthForMachine, LAB_SPECS,
    USABLE, budgetBytes, fitsBytes, scaleTokS, UP, DOWN, kindOfRatio,
    verdictOf, summaryOf, SIGNALS, weightsFor, KV_BYTES_PER_TOKEN, p95, contextFits,
  });
})(typeof window !== "undefined" ? window : globalThis);
