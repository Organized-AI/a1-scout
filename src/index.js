// a1-scout: weekly Hugging Face scout for the Organized-AI repos.
// Scores models, datasets, Spaces, papers and collections against what the org is
// actually building, stores picks in D1, serves them to the Mac agent that fills the
// A1 drive, and holds the drive catalog behind the map view.

const HF = "https://huggingface.co/api";
const DAY = 86400000;

// Each theme: repo keywords that signal the org works on it, and Hub queries to run for it.
// Models default to author=mlx-community so everything suggested runs on Apple Silicon.
const THEMES = [
  {
    id: "tracking", label: "Tracking & analytics",
    repoKw: ["gtm", "tracking", "ga4", "stape", "capi", "pixel", "consent", "cmp", "attribution", "measure", "ads", "media-buyer", "site-scan"],
    models: [{ search: "sql" }, { search: "qwen3 coder" }],
    datasets: ["text-to-sql", "ecommerce events", "clickstream", "marketing analytics"],
    spaces: ["text-to-sql", "analytics agent"],
    paperKw: ["text-to-sql", "sql", "tabular", "analytics", "attribution", "advertising", "recommendation"],
  },
  {
    id: "agents", label: "Agents & tool calling",
    repoKw: ["agent", "claw", "hermes", "harness", "mcp", "skill", "plugin", "substrate", "orchestrator", "workshop", "fde", "bearing"],
    models: [{ search: "tool" }, { search: "function" }, { search: "instruct" }],
    datasets: ["function-calling", "tool-use", "agent trajectories", "mcp"],
    spaces: ["mcp", "smolagents", "agent"],
    paperKw: ["agent", "tool use", "tool-use", "function calling", "mcp", "planning", "multi-agent", "computer use"],
  },
  {
    id: "decisions", label: "Decision models & routing",
    repoKw: ["jev", "router", "proof", "bench", "eval", "guard", "calibration", "laya", "verdict", "intake"],
    models: [{ search: "reward" }, { search: "guard" }, { search: "classifier", author: null }],
    datasets: ["routing", "llm judge", "preference", "guardrail"],
    spaces: ["leaderboard", "llm router"],
    paperKw: ["routing", "router", "calibration", "reward model", "judge", "guardrail", "verification", "uncertainty", "evaluation"],
  },
  {
    id: "retrieval", label: "Embeddings, rerank & memory",
    repoKw: ["memory", "engram", "rag", "research", "canon", "index", "penumbra", "knowledge", "brain", "docgen", "guide"],
    models: [{ search: "embedding" }, { search: "reranker" }],
    datasets: ["retrieval", "embedding pairs", "rag"],
    spaces: ["mteb", "rag"],
    paperKw: ["retrieval", "rag", "embedding", "rerank", "memory", "long context", "knowledge graph"],
  },
  {
    id: "vision", label: "Video, vision & creative",
    repoKw: ["jockey", "yolo", "cuts", "motion", "clip", "video", "twelvelabs", "remotion", "3d", "visual", "ad-forge", "creative", "clipper"],
    models: [{ search: "VL" }, { search: "vision" }, { search: "yolo", author: null }],
    datasets: ["video captions", "ad creative", "ui screenshots"],
    spaces: ["video understanding", "object detection"],
    paperKw: ["video", "vision-language", "multimodal", "detection", "segmentation", "image generation", "3d"],
  },
  {
    id: "voice", label: "Voice & audio",
    repoKw: ["voice", "strudel", "music", "audio", "talk", "tts", "dnb", "transcript"],
    models: [{ search: "tts" }, { search: "whisper" }, { search: "audio" }],
    datasets: ["speech", "music captions"],
    spaces: ["tts", "music generation"],
    paperKw: ["speech", "tts", "text-to-speech", "audio", "music", "asr", "voice"],
  },
  {
    id: "code", label: "Coding agents",
    repoKw: ["codebase", "devops", "dev-ops", "gitops", "terraform", "codex", "claude-code", "session", "optimize", "keys", "setup"],
    models: [{ search: "coder" }, { search: "devstral" }],
    datasets: ["swe", "code instructions", "commit messages"],
    spaces: ["code", "swe-bench"],
    paperKw: ["code generation", "software engineering", "swe-bench", "coding agent", "program repair"],
  },
  {
    id: "markets", label: "Markets, energy & time series",
    repoKw: ["trader", "trading", "ercot", "gridmarket", "maritime", "token-fund", "prop-forge", "diligence", "capital", "organized-market"],
    models: [{ search: "time series", author: null }, { search: "chronos", author: null }],
    datasets: ["time series", "financial news", "energy"],
    spaces: ["time series forecasting"],
    paperKw: ["time series", "forecasting", "financial", "trading", "energy", "power grid"],
  },
  {
    id: "interp", label: "Interpretability & explainable AI",
    repoKw: ["interp", "explain", "xai", "seekr", "attribution", "sae", "probe", "circuit"],
    models: [{ search: "sparse autoencoder", author: null }, { search: "sae", author: null }],
    datasets: ["interpretability", "sae activations", "probing"],
    spaces: ["sparse autoencoder", "interpretability"],
    paperKw: ["interpretability", "sparse autoencoder", "circuit", "attribution", "probing", "mechanistic", "explainable"],
  },
];
// Collections are searched once across the board; they are curated bundles, good for learning a stack.
const COLLECTION_QUERIES = ["mlx", "apple silicon", "function calling", "embedding", "agents", "interpretability"];

const DTYPE_BYTES = { F64: 8, I64: 8, U64: 8, F32: 4, I32: 4, U32: 4, BF16: 2, F16: 2, I16: 2, U16: 2, I8: 1, U8: 1, F8_E4M3: 1, F8_E5M2: 1, BOOL: 1 };
const NC_LICENSE = /(nc|non-?commercial|research|llama.*community|gemma|agpl|gpl|^other$|unknown)/i;
const SKIP_NAME = /(uncensored|abliterat|nsfw|erotic|jailbreak)/i;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });
const now = () => new Date().toISOString();

function authed(req, env) {
  const h = req.headers.get("authorization") || "";
  return env.SCOUT_TOKEN && h === `Bearer ${env.SCOUT_TOKEN}`;
}
// Cloudflare Access: the browser signs in at the Access login page and Access attaches a signed JWT to every request.
// The Worker still verifies it (signature, audience, issuer, expiry, and that the email is ACCESS_EMAIL), so a request
// that skips Access (or a forged header) gets nothing. The Mac keeps using SCOUT_TOKEN.
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));
let accessKeys = null, accessKeysAt = 0;
export async function accessOk(req, env, fetcher = fetch) {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD || !env.ACCESS_EMAIL) return false;
  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (!jwt) return false;
  try {
    const [h, p, sig] = jwt.split(".");
    const head = JSON.parse(new TextDecoder().decode(b64u(h))), c = JSON.parse(new TextDecoder().decode(b64u(p)));
    const iss = `https://${env.ACCESS_TEAM}.cloudflareaccess.com`;
    if (c.iss !== iss || ![].concat(c.aud || []).includes(env.ACCESS_AUD) || !(c.exp * 1000 > Date.now())) return false;
    if (String(c.email || "").toLowerCase() !== env.ACCESS_EMAIL.toLowerCase()) return false;
    if (!accessKeys || Date.now() - accessKeysAt > 3600e3 || !accessKeys.some(k => k.kid === head.kid)) {
      accessKeys = (await (await fetcher(`${iss}/cdn-cgi/access/certs`)).json()).keys || []; accessKeysAt = Date.now();
    }
    const jwk = accessKeys.find(k => k.kid === head.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(sig), new TextEncoder().encode(`${h}.${p}`));
  } catch { return false; }
}
export const _resetAccessKeys = () => { accessKeys = null; };
async function kvGet(env, k) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k=?").bind(k).first();
  return row ? JSON.parse(row.v) : null;
}
async function kvSet(env, k, v) {
  await env.DB.prepare("INSERT INTO kv (k,v,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated=excluded.updated")
    .bind(k, JSON.stringify(v), now()).run();
}

// Normalize a repo name so quant/format variants of something already stashed are skipped.
function baseName(repo) {
  let n = String(repo).split("/").pop().toLowerCase();
  for (let i = 0; i < 4; i++) n = n.replace(/[-_.](\d+bit|bf16|fp16|f16|fp8|dwq|mlx|gguf|mxfp\d|nvfp\d|int\d|q\d(_k)?(_[ms])?|awq|gptq|pdf|hf)$/g, "");
  return n.replace(/[^a-z0-9.]+/g, "-");
}

function themeWeights(profile) {
  const w = {}, hits = {};
  const repos = profile?.repos || [];
  if (!repos.length) { THEMES.forEach(t => { w[t.id] = 0.5; hits[t.id] = []; }); return { w, hits }; }
  const t0 = Date.now();
  for (const t of THEMES) {
    let s = 0; const h = [];
    for (const r of repos) {
      const text = `${r.name} ${r.description || ""}`.toLowerCase();
      if (!t.repoKw.some(k => text.includes(k))) continue;
      const age = (t0 - Date.parse(r.pushedAt || 0)) / DAY;
      s += age <= 30 ? 1 : age <= 90 ? 0.6 : 0.3;
      h.push({ name: r.name, age });
    }
    hits[t.id] = h.sort((a, b) => a.age - b.age).map(x => x.name);
    w[t.id] = s;
  }
  const max = Math.max(...Object.values(w), 1);
  for (const k in w) w[k] = Math.sqrt(w[k] / max);
  return { w, hits };
}

async function hf(path, env) {
  const headers = { "user-agent": "a1-scout (organized-ai)" };
  if (env.HF_TOKEN) headers.authorization = `Bearer ${env.HF_TOKEN}`;
  const r = await fetch(`${HF}${path}`, { headers });
  if (!r.ok) throw new Error(`HF ${r.status} on ${path.slice(0, 80)}`);
  return r.json();
}
// Size of what a download will actually fetch: files at this revision, optionally filtered by fnmatch-style globs
// (as the hf CLI's --include does: * also crosses folders). usedStorage counts every revision, so it overstates.
const globRe = g => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
async function treeSize(env, kind, repo, sha, include = []) {
  const res = include.map(globRe);
  const dirs = include.length ? [...new Set(include.map(g => { const lit = g.split(/[*?[]/)[0]; return lit.includes("/") ? lit.slice(0, lit.lastIndexOf("/")) : ""; }))] : [""];
  const headers = { "user-agent": "a1-scout (organized-ai)" };
  if (env.HF_TOKEN) headers.authorization = `Bearer ${env.HF_TOKEN}`;
  let total = 0; const seen = new Set();
  for (const d of dirs) {
    let next = `${HF}/${kind}s/${repo}/tree/${sha || "main"}${d ? "/" + d.split("/").map(encodeURIComponent).join("/") : ""}?recursive=true&limit=1000`;
    for (let page = 0; next && page < 30; page++) {
      const r = await fetch(next, { headers }); if (!r.ok) throw new Error(`tree ${r.status}`);
      for (const f of await r.json()) if (f.type === "file" && !seen.has(f.path) && (!res.length || res.some(x => x.test(f.path)))) { seen.add(f.path); total += f.size || 0; }
      next = (r.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
    }
  }
  return total;
}
const qs = (base, expand) => { const p = new URLSearchParams(base); expand.forEach(e => p.append("expand[]", e)); return p; };

function modelBytes(m) {
  const p = m.safetensors?.parameters;
  if (!p) return null;
  let b = 0;
  for (const [dt, n] of Object.entries(p)) b += n * (DTYPE_BYTES[dt] ?? 2);
  return Math.round(b);
}
function freshness(d) {
  const age = (Date.now() - Date.parse(d || 0)) / DAY;
  return age <= 30 ? 15 : age <= 90 ? 10 : age <= 365 ? 4 : 0;
}

function scoreCandidate(c, weight) {
  const reasons = [];
  let s = weight * 40;
  const pop = Math.min(20, Math.log10((c.likes || 0) + 1) * (c.kind === "paper" ? 9 : 7));
  const trend = Math.min(15, Math.log10((c.trending || 0) + 1) * 8);
  const fresh = c.kind === "paper" ? 0 : freshness(c.lastModified);
  s += pop + trend + fresh;
  if (c.kind === "paper" && c.kwHits) { s += Math.min(15, c.kwHits * 6); reasons.push(`mentions ${c.kwWords.slice(0, 2).join(", ")}`); }
  if (c.kind === "model" && c.mlx) { s += 10; reasons.push("runs on MLX"); }
  if (c.kind === "space" && c.sdk === "static") { s += 5; reasons.push("static app, runs offline in a browser"); }
  if (c.kind === "collection") reasons.push(`${c.extra.items.length} items to learn from`);
  if (fresh >= 10) reasons.push("updated recently");
  if (trend >= 8) reasons.push("trending on the Hub");
  if (pop >= 14) reasons.push(`${c.likes} ${c.kind === "paper" || c.kind === "collection" ? "upvotes" : "likes"}`);
  const flags = [];
  const gb = c.size_bytes ? c.size_bytes / 1e9 : null;
  if (c.kind === "model" || c.kind === "dataset" || c.kind === "space") {
    if (gb === null) flags.push("size-unknown");
    else if (gb > 20) { s -= 10; flags.push("large"); }
  }
  if (c.gated && c.gated !== "false") flags.push("gated");
  if (c.kind !== "paper" && c.kind !== "collection") {
    if (!c.license) flags.push("no-license");
    else if (NC_LICENSE.test(c.license)) flags.push("license-check");
  }
  return { score: Math.round(Math.max(0, Math.min(100, s)) * 10) / 10, reasons, flags };
}

async function collect(env, weights) {
  const out = new Map();
  const add = (c, themeId) => {
    const prev = out.get(c.id);
    if (!prev || (weights[themeId] ?? 0) > (weights[prev.theme] ?? 0)) out.set(c.id, { ...c, theme: themeId });
  };
  const jobs = [];
  const run = (p, fn) => jobs.push(p.then(fn).catch(e => ({ error: e.message })));

  for (const t of THEMES) {
    for (const q of t.models) {
      const author = q.author === undefined ? "mlx-community" : q.author;
      const params = qs({ search: q.search, sort: "trendingScore", limit: "12", ...(author ? { author } : {}) },
        ["safetensors", "likes", "sha", "gated", "pipeline_tag", "cardData", "trendingScore", "lastModified", "library_name", "tags"]);
      run(hf(`/models?${params}`, env), list => list.forEach(m => add({
        id: `model:${m.id}`, kind: "model", repo: m.id, sha: m.sha, title: null,
        summary: m.pipeline_tag || null, extra: { pipeline: m.pipeline_tag, library: m.library_name },
        size_bytes: modelBytes(m), likes: m.likes, trending: m.trendingScore, lastModified: m.lastModified,
        gated: String(m.gated), license: m.cardData?.license || null,
        mlx: m.library_name === "mlx" || (m.tags || []).includes("mlx") || m.id.startsWith("mlx-community/"),
      }, t.id)));
    }
    for (const search of t.datasets) {
      const params = qs({ search, sort: "trendingScore", limit: "10" }, ["mainSize", "likes", "sha", "gated", "cardData", "trendingScore", "lastModified", "description", "tags"]);
      run(hf(`/datasets?${params}`, env), list => list.filter(d => {
        const langs = (d.tags || []).filter(t => t.startsWith("language:"));
        return !langs.length || langs.includes("language:en");
      }).forEach(d => add({
        id: `dataset:${d.id}`, kind: "dataset", repo: d.id, sha: d.sha, title: null,
        summary: (d.description || "").replace(/\s+/g, " ").trim().slice(0, 280) || null, extra: {},
        size_bytes: d.mainSize ?? null, likes: d.likes, trending: d.trendingScore, lastModified: d.lastModified,
        gated: String(d.gated), license: d.cardData?.license ? [].concat(d.cardData.license).join(",") : null,
      }, t.id)));
    }
    for (const search of t.spaces) {
      const params = qs({ search, sort: "trendingScore", limit: "8" }, ["sdk", "likes", "sha", "trendingScore", "lastModified", "cardData"]);
      run(hf(`/spaces?${params}`, env), list => list.forEach(s => add({
        id: `space:${s.id}`, kind: "space", repo: s.id, sha: s.sha, title: s.cardData?.title || null,
        summary: s.cardData?.short_description || null, extra: { sdk: s.sdk, emoji: s.cardData?.emoji },
        sdk: s.sdk, size_bytes: null, likes: s.likes, trending: s.trendingScore, lastModified: s.lastModified,
        gated: "false", license: s.cardData?.license || null,
      }, t.id)));
    }
  }

  // Daily papers: score each against every theme's keywords and keep the best theme.
  run(hf(`/daily_papers?limit=100`, env), list => list.forEach(x => {
    const p = x.paper || x;
    const text = `${p.title} ${p.summary || ""}`.toLowerCase();
    let best = null;
    for (const t of THEMES) {
      const words = t.paperKw.filter(k => text.includes(k));
      if (words.length && (!best || words.length * (weights[t.id] + 0.2) > best.n * (weights[best.t] + 0.2))) best = { t: t.id, n: words.length, words };
    }
    if (!best || (best.n < 2 && (p.upvotes || 0) < 15)) return;
    add({
      id: `paper:${p.id}`, kind: "paper", repo: p.id, sha: null, title: p.title,
      summary: (p.summary || "").replace(/\s+/g, " ").trim().slice(0, 400), extra: { github: p.githubRepo || null },
      size_bytes: null, likes: p.upvotes || 0, trending: 0, lastModified: p.publishedAt, gated: "false", license: null,
      kwHits: best.n, kwWords: best.words,
    }, best.t);
  }));

  for (const q of COLLECTION_QUERIES) {
    run(hf(`/collections?${new URLSearchParams({ q, sort: "trending", limit: "6" })}`, env), list => list.forEach(c => {
      const items = (c.items || []).filter(i => ["model", "dataset", "space", "paper"].includes(i.type)).map(i => ({ type: i.type, id: i.id }));
      if (!items.length) return;
      const text = `${c.title} ${c.description || ""} ${items.map(i => i.id).join(" ")}`.toLowerCase();
      const t = THEMES.map(t => ({ id: t.id, n: t.repoKw.concat(t.paperKw).filter(k => text.includes(k)).length }))
        .sort((a, b) => b.n - a.n || weights[b.id] - weights[a.id])[0];
      add({
        id: `collection:${c.slug}`, kind: "collection", repo: c.slug, sha: null, title: c.title,
        summary: c.description || null, extra: { items, owner: c.owner?.name || null },
        size_bytes: null, likes: c.upvotes || 0, trending: 0, lastModified: c.lastUpdated, gated: "false", license: null,
      }, t.id);
    }));
  }

  const results = await Promise.all(jobs);
  return { candidates: [...out.values()], errors: results.filter(r => r && r.error).map(r => r.error) };
}

function upsertPick(env, c, score, reasons, matched, flags, ts, status = "new") {
  return env.DB.prepare(`INSERT INTO picks (id,kind,title,summary,extra,repo,sha,size_bytes,score,theme,reasons,matched_repos,license,gated,flags,status,first_seen,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, summary=excluded.summary, extra=excluded.extra, sha=excluded.sha,
      size_bytes=COALESCE(excluded.size_bytes, picks.size_bytes), score=excluded.score, theme=excluded.theme, reasons=excluded.reasons,
      matched_repos=excluded.matched_repos, license=excluded.license, gated=excluded.gated, flags=excluded.flags, last_seen=excluded.last_seen`)
    .bind(c.id, c.kind, c.title ?? null, c.summary ?? null, JSON.stringify(c.extra || {}), c.repo, c.sha ?? null, c.size_bytes ?? null,
      score, c.theme, JSON.stringify(reasons), JSON.stringify(matched), c.license ?? null, c.gated ?? null, JSON.stringify(flags), status, ts, ts);
}

async function scan(env, trigger) {
  const started = now();
  const profile = await kvGet(env, "profile");
  const inv = profile?.inventory || [];
  const invBase = new Set(inv.map(baseName));
  const invExact = new Set(inv.map(s => s.toLowerCase()));
  const { w, hits } = themeWeights(profile);
  const { candidates, errors } = await collect(env, w);
  const maxBytes = Number(env.MAX_PICK_GB || 40) * 1e9;

  const QUOTA = { model: 6, dataset: 5, space: 3, paper: 3, collection: 2 };
  const scored = [];
  for (const c of candidates) {
    if (SKIP_NAME.test(`${c.repo} ${c.title || ""}`)) continue;
    if (invExact.has(c.repo.toLowerCase()) || invBase.has(baseName(c.repo))) continue;
    if (c.size_bytes && c.size_bytes > maxBytes) continue;
    if (c.kind === "dataset" && c.size_bytes !== null && c.size_bytes < 50_000) continue; // empty stubs
    const { score, reasons, flags } = scoreCandidate(c, w[c.theme] ?? 0);
    if (score < 35) continue;
    scored.push({ c, score, reasons, flags });
  }
  // Keep the best few of each kind per theme so every theme gets models and datasets, not just papers,
  // and only one quantization variant of any model.
  scored.sort((a, b) => b.score - a.score);
  const taken = {}, variants = new Set(), keep = [];
  for (const s of scored) {
    const v = `${s.c.kind}:${baseName(s.c.repo)}`;
    if (variants.has(v)) continue;
    const k = `${s.c.theme}:${s.c.kind}`;
    if ((taken[k] = (taken[k] || 0) + 1) > (QUOTA[s.c.kind] || 3)) continue;
    variants.add(v); keep.push(s);
  }
  // Safetensors metadata over-counts packed MLX quants, so ask the Hub for real on-disk size.
  await Promise.all(keep.filter(s => s.c.kind === "model").map(async s => {
    try {
      const m = await hf(`/models/${s.c.repo}?expand[]=usedStorage`, env);
      if (m.usedStorage) {
        s.c.size_bytes = m.usedStorage;
        s.flags = s.flags.filter(f => f !== "size-unknown" && f !== "large");
        if (m.usedStorage > 20e9) s.flags.push("large");
      }
    } catch {}
  }));
  const stmts = [];
  for (const s of keep) {
    if (s.c.size_bytes && s.c.size_bytes > maxBytes) continue;
    const theme = THEMES.find(t => t.id === s.c.theme);
    s.reasons.unshift(`fits ${theme.label.toLowerCase()}`);
    stmts.push(upsertPick(env, s.c, s.score, s.reasons, (hits[s.c.theme] || []).slice(0, 4), s.flags, started));
  }
  const kept = stmts.length;
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  const fresh = (await env.DB.prepare("SELECT COUNT(*) n FROM picks WHERE first_seen=?").bind(started).first()).n;

  // Auto-approve a few small, clean, high-scoring models/datasets so the drive fills without a
  // visit to the page. Spaces, papers and collections always wait for you.
  let auto = 0;
  if (env.AUTO_APPROVE === "on") {
    const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
    const used = (await env.DB.prepare("SELECT COUNT(*) n FROM picks WHERE auto=1 AND first_seen>=?").bind(weekAgo).first()).n;
    const room = Math.max(0, Number(env.AUTO_APPROVE_PER_WEEK || 3) - used);
    if (room) {
      const rows = (await env.DB.prepare(`SELECT id FROM picks WHERE status='new' AND flags='[]' AND score>=?
        AND kind IN ('model','dataset') AND size_bytes<=? ORDER BY score DESC LIMIT ?`)
        .bind(Number(env.AUTO_APPROVE_MIN_SCORE || 70), Number(env.AUTO_APPROVE_MAX_GB || 6) * 1e9, room).all()).results;
      for (const r of rows) await env.DB.prepare("UPDATE picks SET status='approved', auto=1 WHERE id=?").bind(r.id).run();
      auto = rows.length;
    }
  }
  const note = errors.length ? `${errors.length} query errors: ${errors.slice(0, 3).join("; ")}` : null;
  await env.DB.prepare("INSERT INTO runs (started,trigger,candidates,new_picks,auto_approved,note) VALUES (?,?,?,?,?,?)")
    .bind(started, trigger, candidates.length, fresh, auto, note).run();
  return { started, trigger, candidates: candidates.length, kept, new_picks: fresh, auto_approved: auto, errors };
}

// Approving a collection queues each of its items as its own pick, sized and scored, for review.
async function expandCollection(env, pick) {
  const extra = JSON.parse(pick.extra || "{}");
  const ts = now();
  const stmts = [];
  for (const it of (extra.items || []).slice(0, 20)) {
    let c = { id: `${it.type}:${it.id}`, kind: it.type, repo: it.id, theme: pick.theme, extra: { from_collection: pick.repo }, gated: "false" };
    try {
      if (it.type === "model") {
        const m = await hf(`/models/${it.id}?${qs({}, ["usedStorage", "sha", "gated", "cardData", "likes", "lastModified", "library_name", "tags", "pipeline_tag"])}`, env);
        Object.assign(c, { sha: m.sha, size_bytes: m.usedStorage || null, gated: String(m.gated), license: m.cardData?.license || null,
          likes: m.likes, lastModified: m.lastModified, summary: m.pipeline_tag || null,
          mlx: m.library_name === "mlx" || (m.tags || []).includes("mlx") });
      } else if (it.type === "dataset") {
        const d = await hf(`/datasets/${it.id}?${qs({}, ["usedStorage", "sha", "gated", "cardData", "likes", "lastModified"])}`, env);
        Object.assign(c, { sha: d.sha, size_bytes: d.usedStorage || null, gated: String(d.gated), likes: d.likes, lastModified: d.lastModified,
          license: d.cardData?.license ? [].concat(d.cardData.license).join(",") : null });
      } else if (it.type === "space") {
        const s = await hf(`/spaces/${it.id}`, env);
        Object.assign(c, { sha: s.sha, title: s.cardData?.title, summary: s.cardData?.short_description, likes: s.likes, lastModified: s.lastModified,
          license: s.cardData?.license || null, sdk: s.sdk, extra: { ...c.extra, sdk: s.sdk } });
      } else if (it.type === "paper") {
        const p = await hf(`/papers/${it.id}`, env);
        Object.assign(c, { title: p.title, summary: (p.summary || "").slice(0, 400), likes: p.upvotes || 0, lastModified: p.publishedAt });
      }
    } catch { /* keep the bare item; the Mac agent resolves size at download time */ }
    const { score, reasons, flags } = scoreCandidate(c, 0.6);
    reasons.unshift(`from collection ${pick.title || pick.repo}`);
    stmts.push(upsertPick(env, c, score, reasons, JSON.parse(pick.matched_repos || "[]"), flags, ts));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await env.DB.prepare("UPDATE picks SET status='stashed', stashed_at=?, stash_path='expanded into its items' WHERE id=?").bind(ts, pick.id).run();
  return stmts.length;
}

const shapePick = r => ({ ...r, reasons: JSON.parse(r.reasons || "[]"), matched_repos: JSON.parse(r.matched_repos || "[]"),
  flags: JSON.parse(r.flags || "[]"), extra: JSON.parse(r.extra || "{}") });

// ---------------- A1 Bench ----------------
// The Mac agent posts one row per model x suite x machine run (agent.py bench). Leaderboards read the latest run per
// model; battles show two models' outputs on the same task, blind, and move an Elo per suite kept in Workers KV.
// Pending battles and the vote log live in D1 so a vote is claimed atomically; KV's elo:<suite> is rebuilt from the
// vote log on every vote, so a stale KV read can never lose an earlier vote.
const BENCH_SUITES = ["gtm-debug", "sql-ga4", "html-json", "rag-notes", "asr", "screen", "gtm-gate"];
const ELO_START = 1000, ELO_K = 32, BATTLE_TTL = 3600;
const RUN_COLS = "id, suite, machine, model, model_path, runtime, bank, ttft_ms, tok_s, peak_rss, load_s, passed, total, score, error, started, created";
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
const randInt = n => crypto.getRandomValues(new Uint32Array(1))[0] % n;

let benchReady = null;    // per isolate: create the tables once, not on every request
async function benchTables(env) {
  if (benchReady === env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS bench_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT UNIQUE, suite TEXT NOT NULL, machine TEXT NOT NULL,
      model TEXT NOT NULL, model_path TEXT, runtime TEXT, bank TEXT, ttft_ms REAL, tok_s REAL, peak_rss INTEGER, load_s REAL,
      passed INTEGER NOT NULL, total INTEGER NOT NULL, score REAL NOT NULL, error TEXT, results TEXT, started TEXT, created TEXT NOT NULL)`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS bench_runs_key ON bench_runs(suite, machine, model, id)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS bench_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, suite TEXT NOT NULL, task_id TEXT,
      model_a TEXT NOT NULL, model_b TEXT NOT NULL, vote TEXT NOT NULL, created TEXT NOT NULL)`),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated TEXT NOT NULL)"),   // holds bench_best
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS bench_battles (id TEXT PRIMARY KEY, suite TEXT NOT NULL, task_id TEXT, a TEXT NOT NULL,
      b TEXT NOT NULL, expires INTEGER NOT NULL)`),
  ]);
  benchReady = env.DB;
}

// Standard Elo: each side's expected score from the rating gap, then a K-sized step toward what happened.
function eloUpdate(ra, rb, vote) {
  const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
  const sa = vote === "a" ? 1 : vote === "b" ? 0 : 0.5;
  return [ra + ELO_K * (sa - ea), rb + ELO_K * ((1 - sa) - (1 - ea))];
}

async function eloTable(env, suite) {
  return (await env.BENCH.get(`elo:${suite}`, "json")) || {};
}
// Replay every vote for a suite in order. Deterministic, so the KV copy always matches the D1 log.
async function rebuildElo(env, suite) {
  const votes = (await env.DB.prepare("SELECT model_a, model_b, vote FROM bench_votes WHERE suite=? ORDER BY id").bind(suite).all()).results;
  const t = {};
  const get = m => (t[m] ||= { elo: ELO_START, n: 0, w: 0, l: 0, t: 0 });
  for (const v of votes) {
    const A = get(v.model_a), B = get(v.model_b);
    [A.elo, B.elo] = eloUpdate(A.elo, B.elo, v.vote);
    A.n++; B.n++;
    if (v.vote === "tie") { A.t++; B.t++; } else { const [w, l] = v.vote === "a" ? [A, B] : [B, A]; w.w++; l.l++; }
  }
  await env.BENCH.put(`elo:${suite}`, JSON.stringify(t));
  return t;
}

async function benchApi(req, env, url, p) {
  await benchTables(env);
  if (p === "/api/bench/runs" && req.method === "POST") {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > 1_000_000) return json({ error: "run too large" }, 413);
    let b; try { b = JSON.parse(raw); } catch { b = null; }
    if (!b || typeof b !== "object") return json({ error: "JSON body required" }, 400);
    if (!BENCH_SUITES.includes(b.suite)) return json({ error: `suite must be one of ${BENCH_SUITES.join(", ")}` }, 400);
    const model = str(b.model, 200), machine = str(b.machine, 40);
    if (!model || !/^[\w.\-]+$/.test(model) || !machine || !/^[\w.\-]+$/.test(machine)) return json({ error: "model and machine required" }, 400);
    const total = Math.max(0, Math.floor(num(b.total) ?? 0)), passed = Math.min(total, Math.max(0, Math.floor(num(b.passed) ?? 0)));
    const results = (Array.isArray(b.results) ? b.results : []).slice(0, 200).map(r => ({
      id: str(r?.id, 80), pass: !!r?.pass, score: num(r?.score), why: str(r?.why, 200), ttft_ms: num(r?.ttft_ms), tok_s: num(r?.tok_s),
      latency_ms: num(r?.latency_ms), output: str(r?.output, 2000) ?? "", prompt: str(r?.prompt, 3000) ?? "" })).filter(r => r.id);
    const score = Math.min(1, Math.max(0, num(b.score) ?? 0));
    // uid makes a re-sent run (posted, then the response timed out) a no-op
    const uid = str(b.uid, 64);
    if (uid) { const dup = await env.DB.prepare("SELECT id FROM bench_runs WHERE uid=?").bind(uid).first(); if (dup) return json({ ok: true, id: dup.id, duplicate: true }); }
    const row = await env.DB.prepare(`INSERT INTO bench_runs (uid, suite, machine, model, model_path, runtime, bank, ttft_ms, tok_s, peak_rss, load_s,
      passed, total, score, error, results, started, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
      .bind(uid, b.suite, machine, model, str(b.model_path, 300), str(b.runtime, 40), str(b.bank, 40), num(b.ttft_ms), num(b.tok_s),
        num(b.peak_rss), num(b.load_s), passed, total, score, str(b.error, 500), JSON.stringify(results), str(b.started, 40), now()).first();
    return json({ ok: true, id: row.id });
  }
  // The agent's recommendation after it searched every model that fits a Mac: best[suite][machine].
  if (p === "/api/bench/best" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || !BENCH_SUITES.includes(b.suite)) return json({ error: "suite required" }, 400);
    const model = str(b.model, 200), machine = str(b.machine, 40);
    if (!model || !/^[\w.\-]+$/.test(model) || !machine || !/^[\w.\-]+$/.test(machine)) return json({ error: "model and machine required" }, 400);
    const pick = {
      model, model_path: str(b.model_path, 300), score: num(b.score), tok_s: num(b.tok_s), peak_rss: num(b.peak_rss),
      passed: num(b.passed), total: num(b.total), why: str(b.why, 300), bank: str(b.bank, 40),
      considered: num(b.considered), ran: num(b.ran), reused: num(b.reused),
      screened_out: (Array.isArray(b.screened_out) ? b.screened_out : []).slice(0, 50)
        .map(x => ({ model: str(x?.model, 200), screen_score: num(x?.screen_score), error: str(x?.error, 200) })).filter(x => x.model),
      at: now(),
    };
    const all = (await kvGet(env, "bench_best")) || {};
    (all[b.suite] ||= {})[machine] = pick;
    await kvSet(env, "bench_best", all);
    return json({ ok: true, best: pick });
  }
  if (p === "/api/bench/run" && req.method === "GET") {
    const r = await env.DB.prepare("SELECT * FROM bench_runs WHERE id=?").bind(Number(url.searchParams.get("id"))).first();
    return r ? json({ ...r, results: JSON.parse(r.results || "[]") }) : json({ error: "not found" }, 404);
  }
  if (p === "/api/bench/leaderboard" && req.method === "GET") {
    const suite = BENCH_SUITES.includes(url.searchParams.get("suite")) ? url.searchParams.get("suite") : null;
    const machine = url.searchParams.get("machine") || null;
    const where = [suite && "suite=?", machine && "machine=?"].filter(Boolean);
    const args = [suite, machine].filter(Boolean);
    // the latest run per model, suite and machine
    const rows = (await env.DB.prepare(`SELECT ${RUN_COLS} FROM bench_runs WHERE id IN (SELECT MAX(id) FROM bench_runs
      ${where.length ? "WHERE " + where.join(" AND ") : ""} GROUP BY suite, machine, model) ORDER BY score DESC, tok_s DESC`).bind(...args).all()).results;
    const elos = {};
    for (const s of [...new Set(rows.map(r => r.suite))]) elos[s] = env.BENCH ? await eloTable(env, s) : {};
    const machines = (await env.DB.prepare("SELECT machine, COUNT(*) n, MAX(created) last FROM bench_runs GROUP BY machine ORDER BY n DESC").all()).results;
    const suites = (await env.DB.prepare("SELECT suite, COUNT(DISTINCT model) models, MAX(created) last FROM bench_runs GROUP BY suite").all()).results;
    return json({
      best: (await kvGet(env, "bench_best")) || {},
      suite, machine, machines, suites: BENCH_SUITES.map(s => ({ id: s, ...(suites.find(x => x.suite === s) || { models: 0, last: null }) })),
      rows: rows.map(r => { const e = elos[r.suite]?.[r.model]; return { ...r, elo: e ? Math.round(e.elo) : null, battles: e?.n || 0 }; }),
    });
  }
  if (p === "/api/bench/battle") {
    if (!env.BENCH) return json({ error: "battles need the BENCH KV namespace" }, 503);
    if (req.method === "GET") {
      const suite = url.searchParams.get("suite");
      if (!BENCH_SUITES.includes(suite)) return json({ error: "suite required" }, 400);
      // only runs of the current task bank, so both answers are to the same prompt
      const latest = await env.DB.prepare("SELECT bank FROM bench_runs WHERE suite=? ORDER BY id DESC LIMIT 1").bind(suite).first();
      const runs = latest ? (await env.DB.prepare(`SELECT model, results FROM bench_runs WHERE id IN
        (SELECT MAX(id) FROM bench_runs WHERE suite=? AND bank IS ? GROUP BY model)`).bind(suite, latest.bank).all()).results : [];
      const byTask = {};
      for (const r of runs) for (const t of JSON.parse(r.results || "[]"))
        if (t.output?.trim()) (byTask[t.id] ||= []).push({ model: r.model, output: t.output, prompt: t.prompt, pass: t.pass, score: t.score });
      const open = Object.values(byTask).filter(c => c.length >= 2);
      if (!open.length) return json({ error: "Battles need two models benchmarked on this suite.", models: runs.length }, 409);
      // prefer tasks where the two answers differ; identical answers make a coin flip
      const differ = open.filter(c => new Set(c.map(x => x.output.trim())).size > 1);
      const pool = differ.length ? differ : open;
      const cands = pool[randInt(pool.length)];
      const i = randInt(cands.length);
      let j = randInt(cands.length - 1); if (j >= i) j++;
      const a = cands[i], bb = cands[j];
      const id = crypto.randomUUID();
      const task = Object.keys(byTask).find(k => byTask[k] === cands);
      await env.DB.prepare("DELETE FROM bench_battles WHERE expires < ?").bind(Date.now()).run();
      await env.DB.prepare("INSERT INTO bench_battles (id, suite, task_id, a, b, expires) VALUES (?,?,?,?,?,?)")
        .bind(id, suite, task, JSON.stringify(a), JSON.stringify(bb), Date.now() + BATTLE_TTL * 1000).run();
      return json({ id, suite, task: { id: task, prompt: a.prompt }, a: { output: a.output }, b: { output: bb.output } });
    }
    if (req.method === "POST") {
      const { id, vote } = await req.json().catch(() => ({}));
      if (!["a", "b", "tie"].includes(vote) || typeof id !== "string") return json({ error: "id and vote (a|b|tie) required" }, 400);
      // claim the battle atomically: of two racing votes, only one gets the row back
      const row = await env.DB.prepare("DELETE FROM bench_battles WHERE id=? AND expires>=? RETURNING *").bind(id, Date.now()).first();
      if (!row) return json({ error: "That battle expired or was already voted on." }, 404);
      const bt = { suite: row.suite, task: row.task_id, a: JSON.parse(row.a), b: JSON.parse(row.b) };
      const prev = await rebuildElo(env, bt.suite);
      const before = [prev[bt.a.model]?.elo ?? ELO_START, prev[bt.b.model]?.elo ?? ELO_START];
      await env.DB.prepare("INSERT INTO bench_votes (suite, task_id, model_a, model_b, vote, created) VALUES (?,?,?,?,?,?)")
        .bind(bt.suite, bt.task, bt.a.model, bt.b.model, vote, now()).run();
      const table = await rebuildElo(env, bt.suite);
      const sideA = table[bt.a.model], sideB = table[bt.b.model];
      const side = (s, x, b4) => ({ model: s.model, pass: s.pass, score: s.score, elo_before: Math.round(b4), elo_after: Math.round(x.elo), record: { w: x.w, l: x.l, t: x.t } });
      return json({ ok: true, vote, suite: bt.suite, task: bt.task, a: side(bt.a, sideA, before[0]), b: side(bt.b, sideB, before[1]) });
    }
  }
  return json({ error: "not found" }, 404);
}

async function api(req, env, url) {
  const p = url.pathname;
  if (p === "/api/health") return json({ ok: true });
  if (!authed(req, env) && !(await accessOk(req, env))) return json({ error: "unauthorized" }, 401);
  if (p.startsWith("/api/bench/")) return benchApi(req, env, url, p);

  if (p === "/api/state" && req.method === "GET") {
    const profile = await kvGet(env, "profile");
    const { w, hits } = themeWeights(profile);
    const counts = (await env.DB.prepare("SELECT status, COUNT(*) n FROM picks GROUP BY status").all()).results;
    const lastRun = await env.DB.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").first();
    return json({
      repos: profile?.repos?.length || 0, profile_updated: profile?.updated || null, free_bytes: profile?.free_bytes ?? null,
      inventory: profile?.inventory?.length || 0,
      themes: THEMES.map(t => ({ id: t.id, label: t.label, weight: Math.round((w[t.id] || 0) * 100) / 100, repos: (hits[t.id] || []).slice(0, 8), keywords: t.repoKw })),
      counts: Object.fromEntries(counts.map(c => [c.status, c.n])), last_run: lastRun,
      updates: await kvGet(env, "updates"),
    });
  }
  if (p === "/api/picks" && req.method === "GET") {
    const status = url.searchParams.get("status");
    const q = status
      ? env.DB.prepare("SELECT * FROM picks WHERE status=? ORDER BY score DESC LIMIT 300").bind(status)
      : env.DB.prepare("SELECT * FROM picks ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'new' THEN 1 WHEN 'stashed' THEN 2 ELSE 3 END, score DESC LIMIT 400");
    let rows = (await q.all()).results.map(shapePick);
    // An agent that can't honor include lists would download whole repos (Gemma Scope is hundreds of GB): hold those back.
    if (status === "approved" && url.searchParams.get("include_ok") !== "1") rows = rows.filter(r => !r.extra?.include);
    return json(rows);
  }
  if (p === "/api/picks/status" && req.method === "POST") {
    const { id, status } = await req.json();
    if (!["new", "approved", "skipped"].includes(status)) return json({ error: "bad status" }, 400);
    const pick = await env.DB.prepare("SELECT * FROM picks WHERE id=?").bind(id).first();
    if (!pick || pick.status === "stashed") return json({ ok: false });
    if (pick.kind === "collection" && status === "approved") return json({ ok: true, expanded: await expandCollection(env, pick) });
    await env.DB.prepare("UPDATE picks SET status=? WHERE id=?").bind(status, id).run();
    return json({ ok: true });
  }
  // Add a specific Hub repo as a pick (from chat or the page). It lands as "new" for review.
  if (p === "/api/picks/add" && req.method === "POST") {
    const { repo, kind, theme, note, source, status, include } = await req.json();
    if (!repo || !["model", "dataset", "space"].includes(kind)) return json({ error: "repo and kind (model|dataset|space) required" }, 400);
    const existing = await env.DB.prepare("SELECT status FROM picks WHERE id=?").bind(`${kind}:${repo}`).first();
    if (existing?.status === "stashed") return json({ ok: true, id: `${kind}:${repo}`, already: "stashed" });
    const fields = kind === "model" ? ["usedStorage", "sha", "gated", "cardData", "likes", "lastModified", "library_name", "tags", "trendingScore"]
      : kind === "dataset" ? ["usedStorage", "sha", "gated", "cardData", "likes", "lastModified", "tags", "trendingScore"]
      : ["usedStorage", "sha", "cardData", "likes", "lastModified", "sdk", "trendingScore"];
    const info = await hf(`/${kind}s/${repo}?${qs({}, fields)}`, env);
    // An include list downloads only part of a repo (one SAE out of hundreds, one weight format out of six).
    const inc = Array.isArray(include) ? include.filter(g => typeof g === "string" && g && !g.includes("..")).slice(0, 20) : [];
    const sized = await treeSize(env, kind, repo, info.sha, inc).catch(() => null);
    const c = {
      id: `${kind}:${repo}`, kind, repo, sha: info.sha, title: info.cardData?.title || null, summary: note || null,
      extra: { added: "chat", sdk: info.sdk, ...(inc.length ? { include: inc } : {}) }, size_bytes: sized ?? info.usedStorage ?? null,
      likes: info.likes, trending: info.trendingScore, lastModified: info.lastModified, gated: String(info.gated ?? false),
      license: info.cardData?.license ? [].concat(info.cardData.license).join(",") : null,
      mlx: info.library_name === "mlx" || (info.tags || []).includes("mlx") || repo.startsWith("mlx-community/"),
      theme: THEMES.some(t => t.id === theme) ? theme : "agents",
    };
    const { score, reasons, flags } = scoreCandidate(c, 1);
    reasons.unshift(source || "added from chat");
    if (note) reasons.push(note);
    await upsertPick(env, c, score, reasons, [], flags, now()).run();
    // The agent can approve a like-for-like newer release of something already on the A1.
    if (status === "approved" && existing?.status !== "skipped")
      await env.DB.prepare("UPDATE picks SET status='approved', auto=1 WHERE id=? AND status IN ('new','approved')").bind(c.id).run();
    return json({ ok: true, id: c.id, score, flags, size_bytes: c.size_bytes, license: c.license });
  }
  if (p === "/api/stashed" && req.method === "POST") {
    const { id, sha, path, size_bytes } = await req.json();
    await env.DB.prepare("UPDATE picks SET status='stashed', stashed_at=?, stashed_sha=?, stash_path=?, size_bytes=COALESCE(?, size_bytes) WHERE id=?")
      .bind(now(), sha ?? null, path ?? null, size_bytes ?? null, id).run();
    return json({ ok: true });
  }
  if (p === "/api/profile" && req.method === "POST") {
    const body = await req.json();
    const repos = (body.repos || []).slice(0, 1000).map(r => ({ name: r.name, description: (r.description || "").slice(0, 200), pushedAt: r.pushedAt }));
    const inventory = (body.inventory || []).slice(0, 3000).map(String);
    await kvSet(env, "profile", { repos, inventory, free_bytes: body.free_bytes ?? null, updated: now() });
    return json({ ok: true, repos: repos.length, inventory: inventory.length });
  }
  if (p === "/api/catalog") {
    if (req.method === "POST") {
      const body = await req.text();
      if (body.length > 1_500_000) return json({ error: "catalog too large" }, 413);
      await env.DB.prepare("INSERT INTO kv (k,v,updated) VALUES ('catalog',?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated=excluded.updated")
        .bind(body, now()).run();
      return json({ ok: true, bytes: body.length });
    }
    return json((await kvGet(env, "catalog")) || { categories: [] });
  }
  // Live A1 activity for the status bar. The agent posts run progress; a 2-minute heartbeat posts presence.
  // "Run now" from the dashboard: the Mac's heartbeat picks the request up within a minute and starts a run.
  if (p === "/api/run-request" && req.method === "POST") {
    const presence = await kvGet(env, "presence");
    const fresh = presence?.at && Date.now() - Date.parse(presence.at) < 4 * 60e3;
    if (!fresh || !presence.present) return json({ ok: false, error: "The A1 isn't plugged in, or the Mac hasn't checked in for a few minutes." }, 409);
    if (presence.busy) return json({ ok: false, error: "A run is already going." }, 409);
    const rr = { state: "pending", at: now() };
    await kvSet(env, "run_request", rr);
    return json({ ok: true, run_request: rr });
  }
  // "Check access" from the dashboard: the Mac's heartbeat re-checks gated repos with its own Hugging Face login.
  if (p === "/api/license-check" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const repos = Array.isArray(body.repos) ? body.repos.filter(r => typeof r === "string").slice(0, 20) : [];
    const presence = await kvGet(env, "presence");
    const lc = { state: "pending", at: now(), repos };
    await kvSet(env, "license_check", lc);
    const fresh = presence?.at && Date.now() - Date.parse(presence.at) < 4 * 60e3;
    return json({ ok: true, license_check: lc, mac_checking_in: !!fresh });
  }
  // Yes/No on a gated repo from the dashboard: the Mac's heartbeat carries it out (submit the acknowledgement, or skip the pick).
  if (p === "/api/license-decision" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const repo = typeof body.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(body.repo) ? body.repo : null;
    const decision = ["yes", "no"].includes(body.decision) ? body.decision : null;
    if (!repo || !decision) return json({ ok: false, error: "repo and decision (yes|no) required" }, 400);
    const kind = ["model", "dataset", "space"].includes(body.kind) ? body.kind : "model";
    const all = (await kvGet(env, "license_decisions")) || {};
    all[repo] = { decision, kind, state: "pending", at: now() };
    await kvSet(env, "license_decisions", all);
    const presence = await kvGet(env, "presence");
    const fresh = presence?.at && Date.now() - Date.parse(presence.at) < 4 * 60e3;
    return json({ ok: true, license_decisions: all, mac_checking_in: !!fresh });
  }
  if (p === "/api/license-decision/ack" && req.method === "POST") {
    const { results } = await req.json();
    const all = (await kvGet(env, "license_decisions")) || {};
    for (const [repo, r] of Object.entries(results || {})) if (all[repo]) all[repo] = { ...all[repo], ...r, state: "done", acked_at: now() };
    await kvSet(env, "license_decisions", all);
    return json({ ok: true });
  }
  if (p === "/api/license-check/ack" && req.method === "POST") {
    const { results, started } = await req.json();
    const lc = await kvGet(env, "license_check");
    await kvSet(env, "license_check", { ...(lc || {}), state: "done", results: results || {}, started: !!started, acked_at: now() });
    return json({ ok: true });
  }
  // Eject / mount from the dashboard. Eject unmounts the volume but leaves the drive connected, so "Mount" can bring it
  // back without touching the cable. Like Run now, the Mac's heartbeat picks the request up within a minute.
  if (p === "/api/drive-request" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const action = ["eject", "mount"].includes(body.action) ? body.action : null;
    if (!action) return json({ ok: false, error: "action must be eject or mount" }, 400);
    const presence = await kvGet(env, "presence");
    const fresh = presence?.at && Date.now() - Date.parse(presence.at) < 4 * 60e3;
    if (!fresh) return json({ ok: false, error: "The Mac hasn't checked in for a few minutes. Is it awake?" }, 409);
    if (action === "eject" && !presence.present) return json({ ok: false, error: "The A1 isn't mounted." }, 409);
    if (action === "eject" && presence.busy) return json({ ok: false, error: "A run is going. Eject when it's idle." }, 409);
    if (action === "mount" && presence.present) return json({ ok: false, error: "The A1 is already mounted." }, 409);
    if (action === "mount" && !presence.attached) return json({ ok: false, error: "The A1 isn't connected to the Mac. Plug it in." }, 409);
    const dr = { action, state: "pending", at: now() };
    await kvSet(env, "drive_request", dr);
    return json({ ok: true, drive_request: dr });
  }
  if (p === "/api/drive-request/ack" && req.method === "POST") {
    const { state, note } = await req.json();
    const dr = await kvGet(env, "drive_request");
    if (dr) await kvSet(env, "drive_request", { ...dr, state: ["done", "busy", "absent", "failed"].includes(state) ? state : "failed", note: note || null, acked_at: now() });
    return json({ ok: true });
  }
  if (p === "/api/run-request/ack" && req.method === "POST") {
    const { state, note } = await req.json();
    const rr = await kvGet(env, "run_request");
    if (rr) await kvSet(env, "run_request", { ...rr, state: ["started", "busy", "absent", "failed"].includes(state) ? state : "failed", note: note || null, acked_at: now() });
    return json({ ok: true });
  }
  if (p === "/api/activity") {
    if (req.method === "POST") {
      const body = await req.json();
      if (body.kind === "presence") {
        await kvSet(env, "presence", { ...body, at: now() });
        // hand a pending dashboard request to the heartbeat (ignored after 10 minutes)
        const rr = await kvGet(env, "run_request");
        const live = rr?.state === "pending" && Date.now() - Date.parse(rr.at) < 10 * 60e3;
        const lc = await kvGet(env, "license_check");
        const lcLive = lc?.state === "pending" && Date.now() - Date.parse(lc.at) < 15 * 60e3;
        const ld = (await kvGet(env, "license_decisions")) || {};
        const pendingLd = Object.fromEntries(Object.entries(ld).filter(([, d]) => d.state === "pending" && Date.now() - Date.parse(d.at) < 60 * 60e3));
        const dr = await kvGet(env, "drive_request");
        const drLive = dr?.state === "pending" && Date.now() - Date.parse(dr.at) < 10 * 60e3;
        return json({ ok: true, run_request: live ? rr : null, license_check: lcLive ? lc : null, license_decisions: pendingLd, drive_request: drLive ? dr : null });
      }
      await kvSet(env, "activity", { ...body, at: now() });
      return json({ ok: true });
    }
    const [activity, presence, run_request, license_check, license_decisions] = await Promise.all([kvGet(env, "activity"), kvGet(env, "presence"), kvGet(env, "run_request"), kvGet(env, "license_check"), kvGet(env, "license_decisions")]);
    // What the next plug-in will download: same order and cap rule as the agent (one over-cap item may go first).
    const approved = (await env.DB.prepare("SELECT repo, kind, size_bytes FROM picks WHERE status='approved' ORDER BY score DESC").all()).results;
    const cap = (presence?.cap_gb || 60) * 1e9;
    // Picks Hugging Face refused (license not accepted) are listed as such and never counted toward a run.
    const granted = new Set(Object.entries(presence?.licenses || {}).filter(([, v]) => v?.access === "granted").map(([r]) => r));
    const blocked = new Set([...(presence?.needs_license || []), ...(activity?.needs_license || [])].filter(r => !granted.has(r)));
    const big = approved.find(x => (x.size_bytes || 0) > cap && !blocked.has(x.repo));
    const ordered = big ? [big, ...approved.filter(x => x !== big)] : approved;
    let spent = 0;
    const next = ordered.map(x => {
      const size = x.size_bytes || 0;
      if (blocked.has(x.repo)) return { repo: x.repo, kind: x.kind, bytes: size, when: "needs license" };
      const fits = !(spent + size > cap && !(spent === 0 && size > cap));
      if (fits) spent += size;
      return { repo: x.repo, kind: x.kind, bytes: size, when: fits ? "next plug-in" : "later" };
    });
    const drive_request = await kvGet(env, "drive_request");
    return json({ activity, presence, next, run_request, drive_request, license_check, license_decisions: license_decisions || {}, licenses: presence?.licenses || {}, hf_user: presence?.hf_user || null, server_time: now() });
  }
  // "I tried this" survey answers from the drive map, one row per stashed item.
  if (p === "/api/notes") {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS notes (path TEXT PRIMARY KEY, name TEXT, role TEXT, kind TEXT,
      answers TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL)`).run();
    if (req.method === "GET") {
      const rows = (await env.DB.prepare("SELECT * FROM notes ORDER BY updated DESC").all()).results;
      return json(Object.fromEntries(rows.map(r => [r.path, { ...r, answers: JSON.parse(r.answers) }])));
    }
    if (req.method === "POST") {
      const { path, name, role, kind, answers } = await req.json();
      const body = JSON.stringify(answers || {});
      if (!path || body.length > 20000) return json({ error: "path required, answers under 20 KB" }, 400);
      const ts = now();
      await env.DB.prepare(`INSERT INTO notes (path,name,role,kind,answers,created,updated) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET name=excluded.name, role=excluded.role, kind=excluded.kind, answers=excluded.answers, updated=excluded.updated`)
        .bind(path, name ?? null, role ?? null, kind ?? null, body, ts, ts).run();
      return json({ ok: true, updated: ts });
    }
    if (req.method === "DELETE") {
      await env.DB.prepare("DELETE FROM notes WHERE path=?").bind(url.searchParams.get("path") || "").run();
      return json({ ok: true });
    }
  }
  // What the agent found when it checked the A1 for newer revisions of stashed items.
  if (p === "/api/updates") {
    if (req.method === "POST") {
      const body = await req.text();
      if (body.length > 400_000) return json({ error: "too large" }, 413);
      await kvSet(env, "updates", JSON.parse(body));
      return json({ ok: true });
    }
    return json((await kvGet(env, "updates")) || {});
  }
  if (p === "/api/scan" && req.method === "POST") {
    // if_stale=1 skips when a scan ran recently: within min_hours (the mount agent passes 1), else 6 days.
    if (url.searchParams.get("if_stale") === "1") {
      const hours = Number(url.searchParams.get("min_hours") || 144);
      const last = await env.DB.prepare("SELECT started FROM runs ORDER BY id DESC LIMIT 1").first();
      if (last && Date.now() - Date.parse(last.started) < hours * 3600e3) return json({ skipped: `scanned within ${hours} h`, last: last.started });
    }
    return json(await scan(env, url.searchParams.get("trigger") || "manual"));
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(req, env, url); } catch (e) { return json({ error: e.message }, 500); }
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(_evt, env, ctx) { ctx.waitUntil(scan(env, "cron")); },
};
