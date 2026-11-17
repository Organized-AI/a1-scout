# AGENTS.md — a1-scout

A1 Scout is a private Cloudflare Worker (`src/index.js`, config `wrangler.jsonc`, schema `schema.sql`, dashboard in `public/`) plus a Python Mac agent (`agent/`) that fill an offline AI stash on a 2TB NVMe drive called "the A1". The Worker scores Hugging Face picks and stores them in D1; the Mac agent downloads approved picks when the A1 is plugged in.

## Commands

- Worker tests: `node --test tests/*.test.mjs` (no `package.json`, no dependencies; copy the pattern in `tests/worker_private.test.mjs`)
- Mac agent tests: `python3 -m unittest discover -s tests -v`
- Local Worker: `npx wrangler dev` with a `.dev.vars` file holding throwaway values (never real tokens)

## Rules

1. Never print, log, commit or paste a secret: `SCOUT_TOKEN`, `MCP_TOKEN`, `HF_TOKEN`, `GITHUB_TOKEN`, or any other token or key. Secrets live in `wrangler secret` only.
2. Every `/api/*` route except `/api/health` must stay behind `signedIn()` in `src/index.js`. Do not change what `signedIn()`, `authed()`, the session cookie check or `accessOk()` accept unless the spec names that change.
3. Approving a pick queues a real download on the Mac. Never add code that sets status `approved` outside the existing `AUTO_APPROVE` path.
4. Worker PRs do not edit `agent/`, and agent PRs do not edit `src/`. Any API response field the Mac agent reads must stay backward compatible.
5. Never run `wrangler deploy`, `wrangler secret put` or `wrangler d1 execute --remote`. Deploys are done by a human.
6. Do not add `package.json` or dependencies unless the spec asks for them.
7. One concern per PR. Every PR states the test command it ran and the result.
