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
