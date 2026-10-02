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
