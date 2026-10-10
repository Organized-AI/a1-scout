---
name: A1 Scout Worker API
description: Route map, auth model, D1 tables and test pattern for the a1-scout Cloudflare Worker in src/index.js
triggers:
  - a1-scout
  - picks
  - mcp
  - src/index.js
  - signedIn
  - wrangler
---

## Layout

- `src/index.js` — the whole Worker: auth, Hugging Face scan and scoring, picks, bench, Mac agent coordination, routing.
- `wrangler.jsonc` — `main: src/index.js`; assets `./public` with `run_worker_first: true`; D1 binding `DB` (database `a1-scout`); KV binding `BENCH` (Elo tables); cron `0 13 * * 1` (Monday scan).
- `schema.sql` — creates `picks`, `kv`, `runs`, `notes`, `bench_runs`, `bench_battles`, `bench_votes` (plus tables for features not on `main`).
- `public/` — the signed-in dashboard. `agent/` — the Python Mac agent. `tests/` — `*.test.mjs` (Worker) and `test_*.py` (agent).

## Request flow

`fetch(req, env)`: `/api/*` → `withPrivate(await api(req, env, url))` inside a try/catch that returns 500 with `e.message`; `/robots.txt` (disallow all); `/login`; `/logout`; everything else needs `signedIn()` and is served from `env.ASSETS`.

`api(req, env, url)`: `/api/health` (public) → `401` unless `signedIn()` → `/api/bench/*` via `benchApi()` → the routes below.

`signedIn(req, env)` is true for any of: `Authorization: Bearer ${env.SCOUT_TOKEN}` (the Mac agent), the `scout_session` cookie (a SHA-256 of the token, set by `POST /login`), or a valid Cloudflare Access JWT for `env.ACCESS_EMAIL`.

## Routes (behind signedIn)

| Route | Who calls it | Notes |
|---|---|---|
| `GET /api/state` | dashboard | theme weights, pick counts by status, last run |
| `GET /api/picks?status=` | dashboard, Mac agent | Mac agent reads `status=approved` to download |
| `POST /api/picks/status` | dashboard | `{id, status}`; `approved` on a collection expands it |
| `POST /api/picks/add` | dashboard, chat | `{repo, kind, theme, note, source, status, include}` |
| `POST /api/stashed` | Mac agent | marks a pick stashed after download |
| `POST /api/profile` | Mac agent | repos + drive inventory |
| `GET/POST /api/catalog` | dashboard / Mac agent | drive map, ≤ 1.5 MB |
| `GET/POST /api/activity` | dashboard / Mac agent | POST `kind:"presence"` is the Mac heartbeat and returns pending requests |
| `POST /api/run-request`, `/api/drive-request` (+ `/ack`) | dashboard / Mac agent | make the Mac run, eject or mount — never automate |
| `POST /api/license-check`, `/api/license-decision` (+ `/ack`) | dashboard / Mac agent | gated Hugging Face repos |
| `GET/POST/DELETE /api/notes` | dashboard | drive-map notes keyed by path |
| `GET/POST /api/updates` | dashboard / Mac agent | newer versions of stashed items |
| `POST /api/scan` | dashboard, cron | `?if_stale=1&min_hours=` skips recent scans |
| `/api/bench/*` | Mac agent, dashboard | runs, best, leaderboard, battles (Elo in KV `BENCH`) |

## Writing tests

Copy `tests/worker_private.test.mjs`: `import worker from "../src/index.js"`, build a plain `env` (`SCOUT_TOKEN`, fake `ASSETS`, a fake `DB` whose `prepare().bind().first()/all()/run()` return canned rows), and call `worker.fetch(new Request("https://scout.example/..."), env)`. Run `node --test tests/*.test.mjs`. No network.
