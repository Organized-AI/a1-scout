# Coding sessions: public connector parity, weekly alerts, long series

Builds on the live coding-session sync (`src/sessions.js`, `agent/agent.py sync_sessions`, `agent/scout-connect/`,
`public/sessions.js`). Public connector: `~/a1-scout-docs/connect/`.

Agents: `.claude/agents/impl-agent.md` (implement a phase), `test-agent.md` (write and run tests),
`review-agent.md` (review the diff before deploy), `verify-build.md` (here: the test suites plus the .mcpb build).

## Non-goals
- The a1-scout Worker never claims `scout.organizedai.vip` (it belongs to a1-scout-docs; claiming it breaks pairing).
- No prompts, code, paths or names leave a Mac. New fields are numbers and model names, re-checked by `rules.mjs`.
- No new UI on the public site.

## P2 · Public connector parity (`~/a1-scout-docs/connect/core/collect.mjs`)
Port from `agent/scout-connect/collect.mjs` (it is the public file plus these; `rules.mjs` is already identical):
- C1 · Claude tokens: one API message is logged on several lines repeating `usage`; count each `message.id` once,
  last value wins; skip `<synthetic>`. Expected `observations.tokens = {input, output, cache_read, cache_write}`.
- C2 · Codex tokens: `event_msg/token_count` carries running totals; keep the largest; `input` excludes `cached_input_tokens`.
- C3 · `observations.llms`: model name -> count (turn_context for Codex, per message for Claude), at most 8, names match `MODEL_RE`.
- C4 · `observations.active_minutes`: 5-minute slots with any event x 5.
- C5 · `observations.subagents`: sidechain user lines with no parent.
- C6 · Session id: files under `<session>/subagents/` and Codex `rollout-..._<uuid>.jsonl` continuations reuse another
  file's session id; key them `<id>:<file name>` so they don't overwrite the original session.
- Verify: `cd ~/a1-scout-docs/connect && node --test test/*.test.mjs`; bundle still passes `findPrivacyProblem`;
  `scripts/build-mcpb.sh` produces `public/download/a1-scout.mcpb`; deploy a1-scout-docs (its own `routes` keep the domain).

## P3 · Weekly alerts (`src/sessions.js`, cron in `src/index.js`, `public/sessions.js`)
On the Monday 13:00 UTC cron (with the scan), and again Tuesday 13:00 UTC for Macs that synced late, compare the last complete ISO week with the 4 weeks before it.
- A1 · Metrics: `tokens` (total of in/out/cache read/cache write), `cache_hit`, `error_rate` (errors / tool calls),
  `tokens_per_prompt`, `new_tools`, `new_llms`. Baseline = average over trailing weeks that had sessions; ratios are
  pooled (sum of numerators / sum of denominators) so a quiet week doesn't swing them.
- A2 · `new_tools` / `new_llms`: names used in the latest week and in none of the 4 trailing weeks.
- A3b · Rates compare in points, so a 0 baseline (no errors, no cache) still flags; a week with tokens but no cache
  reads is 0%, not null.
- A3 · One row per (week, metric) in D1 `session_alerts`, upserted, so a re-run replaces. `flag` marks rows past the
  thresholds in `alertFlag()`; `tone` is good / bad / info.
- A4 · `POST /api/sessions/alerts/run[?week=YYYY-MM-DD]` recomputes now (signed in; only complete weeks, else 400). `GET /api/sessions` returns `alerts` for the latest week.
- A5 · The Sessions tab shows the alerts first: one card per metric, flagged ones highlighted, GSAP stagger + count-up,
  nothing animated under `prefers-reduced-motion`.
- Verify: `tests/worker_sessions.test.mjs` (seeded weeks -> expected rows, re-run idempotent, no data -> no rows).

## P4 · Long series and cold storage
- S1 · `GET /api/sessions/series?days=N` (N ≤ 3650, default 365): daily totals by session start day.
  Analytics Engine keeps data for 3 months, so: days inside the AE window (last 85, for margin) come from the AE SQL API
  (`CF_ACCOUNT_ID`, `CF_AE_TOKEN` secrets, token scope Account Analytics Read); older days, and every day when AE is
  unset or errors, come from D1 `sessions`. D1 is also counted inside the AE window and wins any day AE undercounts
  (AE takes 250 points per invocation; the upload writes at most 250 and logs `ae_skipped`). Each day says its `source`.
- S2 · AE points written from now on carry `blob7` = session digest (16 hex). AE queries take `max()` per session and
  day, then sum, because every re-sync writes the session's cumulative totals again. Points without `blob7` are skipped.
- S3 · R2 lifecycle on `a1-scout-sessions`: objects older than 180 days move to Infrequent Access
  (`wrangler r2 bucket lifecycle add a1-scout-sessions sessions-ia-180 sessions/ --ia-transition-days 180`).
- Verify: worker test with a fake AE fetch (dedupe, merge, D1 fallback); `wrangler r2 bucket lifecycle list`.

## Ship
`node --test tests/*.test.mjs`, `npx wrangler deploy`, commit to `private-domain`.
