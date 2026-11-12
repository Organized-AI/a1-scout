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

## API inventory (baseline before this branch)

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

- Service worker is now network-only: no fetch interception or cache writes; activation removes legacy a1-shell caches without deleting unrelated caches.
- Manifest start_url is /m. WebKit verified 375px width, 16px gutters, 44px taps and simulated standalone mode. Physical iPhone installation remains a manual check.
- Cowork metadata allowlist only; no titles, prompts, emails, URLs or folder names in bundles.
- Open question: T3 Claude SDK entrypoints sdk-ts/sdk-cli remain headless actor agent. Do not reclassify in this thread.

## Phase status

- Phase 4: Coding cards include actor/app/time filters, paging, sync, collection and transcript consent. Catalog has local search and add-pick; Notes has create/edit/delete; Jobs exposes activity, updates, leaderboard and blind battles; More has scan and license check/decisions. All use existing authenticated APIs. Lessons and Explain use responsive reading/quiz layouts from the existing content. Lab's visual stack editor and Map's spatial treemap retain an explicit full-dashboard/desktop link, with Catalog and learning as phone alternatives. Waitlist owner tools remain on the linked full dashboard; public signup/webhooks are not mobile actions. No agent ingestion/ACK route was duplicated as a phone action.
- Phase 4 verification: 90 Node tests and 99 Python tests pass (plus the Python subtests). WebKit iPhone 15 simulation passed all seven tabs and 26 result screenshots, with no page errors, overflow or visible targets below 44px. Add-pick and scan success responses are synthetic UI fixtures, not upstream service/physical-agent verification. The local Worker handled the other tested actions. Service-worker cleanup/network-only behavior is independently unit tested; browser routing tests block workers so fixtures cannot escape to upstream services.
- Phase 5 verification (November 11, 2026): 90 Node tests and 99 Python tests pass. The WebKit iPhone 15 run covers all seven tabs and 26 result screenshots, including 375px and simulated standalone. Visual review caught a screenshot synchronization race after Skip; the test now waits for the changed count and for loading to finish. Synthetic evidence is in [phone-screenshots/README.md](phone-screenshots/README.md). Real preview screenshots stay outside the repository.
- Uploaded version `479e9865-eec0-40e4-b433-94904f086f6b` (not a production deployment): https://479e9865-a1-scout.jordan-691.workers.dev/m. Enabled Worker preview URLs in Cloudflare and retained `preview_urls: true` in Wrangler; this does not replace production code. Verified signed-out redirect and API 401/no-store, authenticated phone-link redemption, secure HttpOnly cookie, rejected reuse, all seven tabs and their API reads, Claude Desktop chip, no horizontal overflow or page errors. The existing token was read only from the Mac environment; no credentials are recorded here.
- Remaining release gate: human merge of sync PR #9 and feature PR; deploy from the merged branch, check health/mobile/Desktop sessions, then update agents only through existing push/install scripts. No production deploy or Mac agent update has occurred. Physical iPhone Safari/Home Screen installation and camera QR scan remain unverified; browser emulation is not a physical-device check. Add-pick/scan upstream success and physical Mac completion remain outside the synthetic UI verification.

- Phase 3: phone Picks reuse the deployed status/kind filters and exact counts with 20-card paging, license links, reasons and approve/skip/stash controls. Stash queues `approved` through the existing endpoint; only the agent may mark a completed download `stashed`. This intentionally preserves license and download checks rather than claiming a queued item is already on disk.

- Phase 1: committed safe Cowork collection, scheduled Desktop tasks, settings and Desktop grouping. Local Mac preview found 26 Cowork transcripts; bundles pass privacy validation. SDK actor classification unchanged.
- Phase 2: single-use phone links are hashed in D1, expire after ten minutes, burn atomically and invalidate on token rotation. Desktop generates QR locally; token login remains the fallback. Tests cover reuse races, expiry, wrong codes, rotation and cross-origin mint rejection.

- Phase 0: baseline green after the isolated bench fix; plan copied and route/feature audit recorded. Next: sync PR and Claude Desktop collection.
- Deployment and Mac agent updates have not been performed. Sync PR must not be merged by this agent. Feature PR targets deployed base until sync merges.

