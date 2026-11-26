CREATE TABLE IF NOT EXISTS picks (
  id TEXT PRIMARY KEY,              -- "<kind>:<repo>"
  kind TEXT NOT NULL,               -- model | dataset | space | paper | collection
  title TEXT,                       -- papers, collections, spaces: human title
  summary TEXT,                     -- one-paragraph description when the Hub gives one
  extra TEXT,                       -- JSON: sdk, collection items, github repo, etc.
  repo TEXT NOT NULL,
  sha TEXT,
  size_bytes INTEGER,
  score REAL NOT NULL,
  theme TEXT,
  reasons TEXT,                     -- JSON array of short strings
  matched_repos TEXT,               -- JSON array of Organized-AI repo names
  license TEXT,
  gated TEXT,
  flags TEXT,                       -- JSON array: gated, non-commercial, large, no-license
  status TEXT NOT NULL DEFAULT 'new', -- new | approved | skipped | stashed
  auto INTEGER NOT NULL DEFAULT 0,  -- 1 if auto-approved
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  stashed_at TEXT,
  stashed_sha TEXT,
  stash_path TEXT
);
CREATE INDEX IF NOT EXISTS picks_status ON picks(status, score DESC);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started TEXT NOT NULL,
  trigger TEXT NOT NULL,
  candidates INTEGER,
  new_picks INTEGER,
  auto_approved INTEGER,
  note TEXT
);

-- "I tried this" survey answers from the drive map (also created on first use by the Worker).
CREATE TABLE IF NOT EXISTS notes (
  path TEXT PRIMARY KEY,      -- stash-relative path of the item
  name TEXT, role TEXT, kind TEXT,
  answers TEXT NOT NULL,      -- JSON {question id: answer}
  created TEXT NOT NULL, updated TEXT NOT NULL
);

-- A1 Bench (also created on first use by the Worker). One row per model x suite x machine run from `agent.py bench`.
CREATE TABLE IF NOT EXISTS bench_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT UNIQUE,   -- uid: set by the agent, makes re-sent runs no-ops
  suite TEXT NOT NULL, machine TEXT NOT NULL, model TEXT NOT NULL, model_path TEXT, runtime TEXT,
  bank TEXT,                  -- content hash of the task bank, so runs compare like for like
  ttft_ms REAL, tok_s REAL, peak_rss INTEGER, load_s REAL,
  passed INTEGER NOT NULL, total INTEGER NOT NULL, score REAL NOT NULL,
  error TEXT,
  results TEXT,               -- JSON [{id, pass, score, why, ttft_ms, tok_s, output, prompt}], feeds the battles
  started TEXT, created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bench_runs_key ON bench_runs(suite, machine, model, id);
-- Pending blind battles (an hour each); a vote claims its row with DELETE … RETURNING, so one vote per battle.
CREATE TABLE IF NOT EXISTS bench_battles (id TEXT PRIMARY KEY, suite TEXT NOT NULL, task_id TEXT, a TEXT NOT NULL, b TEXT NOT NULL, expires INTEGER NOT NULL);
-- Battle votes; Elo ratings live in Workers KV (elo:<suite>), rebuilt from this log on every vote.
CREATE TABLE IF NOT EXISTS bench_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, suite TEXT NOT NULL, task_id TEXT,
  model_a TEXT NOT NULL, model_b TEXT NOT NULL, vote TEXT NOT NULL, created TEXT NOT NULL
);

-- Public docs waitlist (scout.organizedai.vip/docs). Survey answers are JSON.
CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, token TEXT NOT NULL,
  source TEXT, referrer TEXT, ip_hash TEXT, country TEXT, survey TEXT, survey_at TEXT, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS waitlist_ip ON waitlist(ip_hash, created);

-- Company enrichment for waitlist sign-ups (Context.dev brand + homepage, Apify crawl).
CREATE TABLE IF NOT EXISTS companies (
  domain TEXT PRIMARY KEY, status TEXT NOT NULL, brand TEXT, homepage TEXT, pages TEXT,
  apify_run TEXT, apify_status TEXT, errors TEXT, requested TEXT NOT NULL, updated TEXT NOT NULL);
-- waitlist also gets company_domain and domain_source (added at runtime with ALTER TABLE).

-- Coding-session alerts (also created on first use by the Worker): Monday cron compares the last complete week with the
-- 4 before it. One row per (week, metric); detail is a JSON list of names for new_tools / new_llms.
CREATE TABLE IF NOT EXISTS session_alerts (week TEXT NOT NULL, metric TEXT NOT NULL, value REAL, baseline REAL, change REAL,
  baseline_weeks INTEGER NOT NULL, flag INTEGER NOT NULL, tone TEXT NOT NULL, detail TEXT, created TEXT NOT NULL, PRIMARY KEY (week, metric));

-- Considering a Mac (POST /api/bench/consider, src/consider.js). Both are append-only: rows are never updated or deleted.
-- bench_considers: one row per answer (the request spec, the result, the bank hash it was computed from).
CREATE TABLE IF NOT EXISTS bench_considers (id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL,
  bank_hash TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS bench_considers_machine ON bench_considers(machine_id, id);
-- bench_consider_checks: when a real bench run arrives for a considered Mac, how far the estimate was from it.
CREATE TABLE IF NOT EXISTS bench_consider_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, consider_id INTEGER NOT NULL,
  machine_id TEXT NOT NULL, suite TEXT NOT NULL, model TEXT NOT NULL, est_tok_s REAL, measured_tok_s REAL, error_pct REAL, created TEXT NOT NULL,
  phase TEXT, bank TEXT, tokenizer TEXT, target_prompt_tokens INTEGER, cache_state TEXT, target TEXT, engine_version TEXT,
  peak_rss_bytes INTEGER, free_ram_bytes INTEGER, run_uid TEXT);

-- Speed Lab: append-only measurements, separate from scored quality runs.
-- UID uniquely identifies an offline retransmission; payload is a validated row.
CREATE TABLE IF NOT EXISTS bench_speed_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE,
  machine TEXT NOT NULL, model TEXT NOT NULL, target TEXT NOT NULL, phase TEXT NOT NULL, bank TEXT NOT NULL,
  fit INTEGER, ttft_ms REAL, prompt_tok_s REAL, write_tok_s REAL, prompt_tokens INTEGER, reply_tokens INTEGER,
  free_ram_bytes INTEGER, peak_rss_bytes INTEGER, payload TEXT NOT NULL, started TEXT, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS bench_speed_runs_key ON bench_speed_runs(machine, model, phase, bank, id);

-- Speed Lab hardware specs. Compute precision is explicit; Apple TFLOPS unknown.
CREATE TABLE IF NOT EXISTS chip_specs (chip TEXT PRIMARY KEY, bandwidth_gbs REAL,
  gpu_tflops REAL, compute_basis TEXT, source_url TEXT NOT NULL, details TEXT NOT NULL);
INSERT OR IGNORE INTO chip_specs (chip,bandwidth_gbs,gpu_tflops,compute_basis,source_url,details) VALUES ('M1 Pro',200,NULL,NULL,'https://support.apple.com/kb/SP854','{"bandwidth_gbs":200,"gpu_tflops":null,"compute_basis":null,"compute_reason":"No comparable published GPU TFLOPS; supply a measured calibration with an explicit common precision/basis","source_url":"https://support.apple.com/kb/SP854"}');
INSERT OR IGNORE INTO chip_specs (chip,bandwidth_gbs,gpu_tflops,compute_basis,source_url,details) VALUES ('M4',120,NULL,NULL,'https://support.apple.com/en-us/121555','{"bandwidth_gbs":120,"gpu_tflops":null,"compute_basis":null,"compute_reason":"No comparable published GPU TFLOPS; supply a measured calibration with an explicit common precision/basis","source_url":"https://support.apple.com/en-us/121555"}');
INSERT OR IGNORE INTO chip_specs (chip,bandwidth_gbs,gpu_tflops,compute_basis,source_url,details) VALUES ('M6',170,NULL,NULL,'https://support.apple.com/en-us/148299','{"bandwidth_gbs":170,"gpu_tflops":null,"compute_basis":null,"compute_reason":"No comparable published GPU TFLOPS; supply a measured calibration with an explicit common precision/basis","bandwidth_basis":"up to 170 GB/s; 32GB configuration","source_url":"https://support.apple.com/en-us/148299"}');
INSERT OR IGNORE INTO chip_specs (chip,bandwidth_gbs,gpu_tflops,compute_basis,source_url,details) VALUES ('M5 Pro',307,NULL,NULL,'https://www.apple.com/newsroom/2026/03/apple-introduces-macbook-pro-with-all-new-m5-pro-and-m5-max/','{"bandwidth_gbs":307,"gpu_tflops":null,"compute_basis":null,"compute_reason":"No comparable published GPU TFLOPS; supply a measured calibration with an explicit common precision/basis","source_url":"https://www.apple.com/newsroom/2026/03/apple-introduces-macbook-pro-with-all-new-m5-pro-and-m5-max/"}');
INSERT OR IGNORE INTO chip_specs (chip,bandwidth_gbs,gpu_tflops,compute_basis,source_url,details) VALUES ('M5 Max',614,NULL,NULL,'https://www.apple.com/newsroom/2026/03/apple-introduces-macbook-pro-with-all-new-m5-pro-and-m5-max/','{"bandwidth_gbs":614,"gpu_tflops":null,"compute_basis":null,"compute_reason":"No comparable published GPU TFLOPS; supply a measured calibration with an explicit common precision/basis","bandwidth_basis":"upper 614 GB/s bin","source_url":"https://www.apple.com/newsroom/2026/03/apple-introduces-macbook-pro-with-all-new-m5-pro-and-m5-max/"}');
INSERT OR IGNORE INTO chip_specs (chip,bandwidth_gbs,gpu_tflops,compute_basis,source_url,details) VALUES ('DGX Spark',273,1000,'FP4_sparse','https://docs.nvidia.com/dgx/dgx-spark/hardware.html','{"bandwidth_gbs":273,"gpu_tflops":1000,"compute_basis":"FP4_sparse","compute_reason":"Sparse FP4 peak is not comparable to Apple GPU FP32","source_url":"https://docs.nvidia.com/dgx/dgx-spark/hardware.html","compute_source_url":"https://www.nvidia.com/en-us/products/workstations/dgx-spark/"}');
