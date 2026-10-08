// Coding-session sync for the A1 agent: read this Mac's Claude and Codex sessions with the same reader and privacy
// filter as the public Scout connector and print the bundles as JSON. The agent uploads them to the A1 Worker and only
// then advances the cursor (cursor.json in SCOUT_HOME), so a failed upload is retried on the next loop.
//   SCOUT_HOME=~/.nvme-stash/scout-sessions node agent/scout-connect/sessions.mjs [--all] [--transcripts]
// --all          every session in the lookback window, ignoring the cursor and the 5,000-per-run cap (backfills)
// --transcripts  also pack each of those sessions' full log, credential-scrubbed and gzipped, into SCOUT_HOME/outbox
// Projects left out in the Claude Desktop extension (~/.scout/settings.json) stay left out here too.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { collect, loadSettings, toBundles, STATE_DIR } from "./collect.mjs";
import { packTranscript } from "./transcripts.mjs";

const all = process.argv.includes("--all"), withTranscripts = process.argv.includes("--transcripts");
let ext = {};
try { ext = JSON.parse(readFileSync(join(homedir(), ".scout", "settings.json"), "utf8")); } catch {}
const base = loadSettings();
const settings = {
  ...base,
  sources: [ext.claude !== false && "claude", ext.codex !== false && "codex"].filter(Boolean),
  exclude: [...new Set([...base.exclude, ...(ext.exclude || [])])],
};
const { rows, files, seen, skipped, filesScanned } = collect({ onlyChanged: !all, settings, limit: all ? Infinity : 5000 });
const transcripts = withTranscripts ? files.map(f => packTranscript(f, join(STATE_DIR, "outbox"))) : [];
process.stdout.write(JSON.stringify({
  sessions: rows.length, files_scanned: filesScanned, skipped, sources: settings.sources, excluded_patterns: settings.exclude.length,
  seen, bundles: rows.length ? toBundles(rows) : [], transcripts,
}));
