# Phone parity audit

## Phase 1 status

- Cowork discovery reads only allowlisted metadata, excludes audit logs, keeps folder fingerprints local, and keys subagents separately. Desktop Code scheduled-task metadata now classifies scheduled runs without changing SDK rules.
- Cowork setting follows Claude unless overridden; both Desktop apps group as Claude Desktop, with desktop filter and series.
- Synthetic privacy/layout fixtures pass. Real local Mac preview found 26 Cowork transcripts (names/counts only; no bundles or prompts printed).
- Verification: 87 Node tests and 99 Python tests passed before final chart addition; full suites rerun before commit. Next: single-use phone sign-in.

## Scope and baseline

- Private dashboard only; a1-scout-docs and phone chat capture are out of scope.
- Base: deploy/picks-kind-filter at 599d623 (ancestor of feat/phone-parity); git identity Jordan Hill.
- Baseline: 84 Node tests; 99 Python tests with ~/.venvs/a1-scout/bin/python.
- Bench prerequisite committed separately: normalize stash-relative paths, retaining stash spelling for runner arguments. All 99 Python tests pass.
- The existing Picks kind filter, counts and pagination are reused.

## Desktop features

| Feature | Existing /m | Phone delivery |
|---|---|---|
| Sign in / sign out | Token fallback only | Single-use ten-minute phone link and local QR, plus sign out |
| Drive state, progress, machines | Yes | Retain existing cards and run/drive controls |
| Picks / counts / status / kinds | No | Status and kind chips, paged cards, approve/skip/stash |
| Catalog and add pick | No | Search form and add action |
| License checks and decisions | No | License cards and decision/check actions |
| Scan now | No | Scan button with result feedback |
| Coding sessions, trends, controls | No | Cards, timeframe/app filters, Claude Desktop, sync/connect controls |
| Bench leaderboard and battle | Leaderboard only | Leaderboard plus blind voting |
| Activity, jobs, updates | Partial activity | Activity and jobs cards |
| Notes | No | Read/write notes by path |
| Map (map.js) | No | Responsive desktop view linked from More; large graph has explicit desktop link |
| Lab (lab.js) | No | Explicit desktop link for computer-local model/loop workspace |
| Lessons (lessons.js) | No | Responsive reading layout, linked from More |
| Explain (explain.js) | No | Responsive reading layout, linked from More |
| Waitlist owner tools | No | Explicit dashboard link; public signup/survey remains separate |
| Install / theme | Yes | Keep standalone styling; 44px targets and safe-area gutters |

## API inventory

Internal agent ingestion and acknowledgment routes are not phone UI actions; phone users operate their matching request/status controls. Public waitlist webhooks are not dashboard features.

| Route | Existing /m | Needed on phone |
|---|---|---|
| `/api/activity` | Yes | Matching phone card/action or status view |
| `/api/bench/battle` | No | Matching phone card/action or status view |
| `/api/bench/best` | No | Agent/server integration; retain auth, expose related status or request action |
| `/api/bench/leaderboard` | Yes | Matching phone card/action or status view |
| `/api/bench/run` | No | Agent/server integration; retain auth, expose related status or request action |
| `/api/bench/runs` | No | Agent/server integration; retain auth, expose related status or request action |
| `/api/catalog` | No | Matching phone card/action or status view |
| `/api/drive-request` | Yes | Matching phone card/action or status view |
| `/api/drive-request/ack` | No | Agent/server integration; retain auth, expose related status or request action |
| `/api/health` | No | Matching phone card/action or status view |
| `/api/license-check` | No | License check and decision controls |
| `/api/license-check/ack` | No | Agent/server integration; retain auth, expose related status or request action |
| `/api/license-decision` | No | License check and decision controls |
| `/api/license-decision/ack` | No | Agent/server integration; retain auth, expose related status or request action |
| `/api/notes` | No | Matching phone card/action or status view |
| `/api/picks` | No | Picks/catalog cards and mutations |
| `/api/picks/add` | No | Picks/catalog cards and mutations |
| `/api/picks/counts` | No | Picks/catalog cards and mutations |
| `/api/picks/status` | No | Picks/catalog cards and mutations |
| `/api/profile` | No | Agent/server integration; retain auth, expose related status or request action |
| `/api/run-request` | Yes | Matching phone card/action or status view |
| `/api/run-request/ack` | No | Agent/server integration; retain auth, expose related status or request action |
| `/api/scan` | No | Matching phone card/action or status view |
| `/api/sessions` | No | Coding sessions cards, filters and controls |
| `/api/sessions/alerts/run` | No | Agent/server integration; retain auth, expose related status or request action |
| `/api/sessions/connect` | No | Coding sessions cards, filters and controls |
| `/api/sessions/list` | No | Coding sessions cards, filters and controls |
| `/api/sessions/run` | No | Agent/server integration; retain auth, expose related status or request action |
| `/api/sessions/series` | No | Coding sessions cards, filters and controls |
| `/api/sessions/sync-now` | No | Coding sessions cards, filters and controls |
| `/api/sessions/transcript` | No | Session controls and safe transcript access |
| `/api/sessions/transcripts` | No | Session controls and safe transcript access |
| `/api/sessions/upload` | No | Agent/server integration; retain auth, expose related status or request action |
| `/api/stashed` | No | Agent/server integration; retain auth, expose related status or request action |
| `/api/state` | Yes | Matching phone card/action or status view |
| `/api/updates` | No | Matching phone card/action or status view |
| `/api/waitlist` | No | Public signup/webhook or owner dashboard link |
| `/api/waitlist/apify-hook` | No | Public signup/webhook or owner dashboard link |
| `/api/waitlist/company` | No | Public signup/webhook or owner dashboard link |
| `/api/waitlist/config` | No | Public signup/webhook or owner dashboard link |
| `/api/waitlist/enrich` | No | Public signup/webhook or owner dashboard link |
| `/api/waitlist/survey` | No | Public signup/webhook or owner dashboard link |
| `/api/waitlist/typeform-hook` | No | Public signup/webhook or owner dashboard link |

## Security and layout

- Service worker currently caches /m/ despite private, no-store: remove private-page caching and clear old caches.
- Manifest start_url must be /m. Verify 375px width, 16px gutters, 44px taps, standalone safe areas.
- Cowork metadata allowlist only; no titles, prompts, emails, URLs or folder names in bundles.
- Open question: T3 Claude SDK entrypoints sdk-ts/sdk-cli remain headless actor agent. Do not reclassify in this thread.

## Phase status

- Phase 1: committed safe Cowork collection, scheduled Desktop tasks, settings and Desktop grouping. Local Mac preview found 26 Cowork transcripts; bundles pass privacy validation. SDK actor classification unchanged.
- Phase 2: single-use phone links are hashed in D1, expire after ten minutes, burn atomically and invalidate on token rotation. Desktop generates QR locally; token login remains the fallback. Tests cover reuse races, expiry, wrong codes, rotation and cross-origin mint rejection.

- Phase 0: baseline green after the isolated bench fix; plan copied and route/feature audit recorded. Next: sync PR and Claude Desktop collection.
- Deployment and Mac agent updates have not been performed. Sync PR must not be merged by this agent. Feature PR targets deployed base until sync merges.

