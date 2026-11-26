# A1 Bench Speed Lab and hybrid plan

Source: `/Users/supabowl/a1-scout-speed-lab/PLAN.md`, copied from <https://claude.ai/artifact/QWALussvNrDJXBRmZPcvzG>.

## Objective

Measure prompt reading (prefill) and reply writing (decode) separately per machine and model. Use those measurements to compare M6, M5 Pro, DGX Spark and Spark + Mac split setups in Consider. Add a cloud-reader/local-writer hybrid that passes only when it costs less than all cloud, takes less time than all local, and scores within 0.02 of all cloud.

Existing short-prompt TTFT includes load effects, the runner only loads MLX models in process, and Consider scales writing speed by Apple memory bandwidth. Speed Lab adds streamed endpoint measurements, fit records, compute-based prefill estimates and both-phase estimate checks. No phase requires owning a Spark.

## Scope and coordination

Work only in the `feat/speed-lab` T3 worktree, based on unmerged `feat/bench-consider-api`. Do not touch `feat/headroom-bench`, `feat/bench-llama-cpp`, their worktrees, or Jordan's `~/nvme-stash/a1-scout` checkout. Prefer new files (`agent/speed_runner.py`, `agent/hybrid_runner.py`, `src/speed.js`, `public/speed.js`, new tests); keep hooks in `src/index.js`, `schema.sql`, `public/bench.js`, `agent/bench.py` and `agent/agent.py` small to ease the Headroom merge.

Use `.claude/agents/impl-agent.md` for each implementation phase, `test-agent.md` for tests, `review-agent.md` for diff review, and `verify-build.md` plus `verify-architecture.md` as phase gates. Templates already exist, so no applicator installation is needed. Finish each phase with `PHASE-X-COMPLETE.md` describing checks and limitations, and one commit. Author and committer must be Jordan Hill <jordan@bluehighlightedtext.com>; stage explicit paths only. No Co-Authored-By, Claude-Session or generated-by trailers.

Never store keys in the repo, change oMLX settings or its memory guard, run remote D1 migrations, or run `wrangler deploy`. Shipping uses GitOps after merge. Open a draft PR against `feat/bench-consider-api`; retarget to main after the base merges.

## Measurement contract

- Prompt reading: server prompt tokens / TTFT, using a 1-token reply, at 1k/4k/8k/16k/32k input tokens.
- Writing: streamed reply tokens / time from first token to end, using a 256-token reply. Preserve server usage counts and tokenizer identity; compare lengths only with matching tokenizers.
- Record TTFT, both rates, reply count, engine and version, free RAM before, peak RSS, chip, bandwidth, cache drive and read speed. Unknown metrics remain unknown.
- Bandwidth used is write rate × weight bytes per token; for MoE use metadata for active weights, never guess.
- oMLX cold/warm pair repeats the same prompt prefix. Distinguish observed cache conditions from guaranteed eviction; do not alter server settings.
- oMLX 507 and prefill-memory-guard 400 responses become `fit:false` with the server reason.
- Agent workload: 8k input, 150 output, 10 turns. Chat workload: 500 input, 500 output.
- All bench/speed/hybrid entry points hold `~/.nvme-stash/scout.lock`. Never write to the A1 outside its existing stash/cache paths. Local results and unsent rows belong under `~/.nvme-stash/bench`.

## Phase 0 — Setup

Read the source plan and existing bench, runner, agent API/queue/lock, Consider, schema and relevant Python/Worker tests. Write this implementation plan. Run `python3 -m unittest discover -s tests -v` and `node --test tests/*.test.mjs` unchanged; record the baseline counts and failures before feature edits. Gate with template-based test, review, build and architecture checks.

## Phase 1 — Speed bank

Add synthetic agent prompts in `tests/bench/speed.jsonl` at 1k/4k/8k/16k/32k tokens plus chat prompts. A deterministic prompt builder and its source are part of the bank hash. Add a speed suite without a quality score; do not let it enter quality ranking or blind battles. Verify unique IDs, deterministic hashes, synthetic-only content, and Qwen3-tokenizer lengths within 2% of each target.

## Phase 2 — Speed runner

Implement `agent/speed_runner.py` with `mlx` in process, `omlx` (`OMLX_URL`, default `http://127.0.0.1:8000/v1`), and `endpoint` (`--endpoint URL`, OpenAI-compatible) targets. Stream responses and preserve usage counts. Probe memory, peak RSS, chip/bandwidth using the RAM Scout machine table and cache-drive read speed. Measure prefill and decode separately and run an oMLX cold/warm pair. Refuse local model loads when available RAM is below model size plus margin. Use fake clocks, streams and servers to test timing, missing usage, failed streams, low RAM and fit refusals without loading models.

## Phase 3 — Worker storage and queue

Add append-only `bench_speed_runs` D1 storage mirrored in `schema.sql`; a unique UID makes retransmission a no-op. Add `POST /api/bench/speed` with existing `/api/bench/runs` auth and offline queue behavior, and `GET /api/bench/speed?machine=&model=`. New Worker tests cover auth, validation, size limits, persistence, duplicate sends and filtering. Keep route hooks small and do not apply remote migrations.

## Phase 4 — Chip specs and Consider v2

Add D1 `chip_specs` with bandwidth GB/s, GPU TFLOPS and source URLs for M1 Pro, M4, M6, M5 Pro, M5 Max and DGX Spark. Verify published specs against primary sources; mark uncertain/unpublished values explicitly as estimates rather than measured facts. Estimate reading from compute and writing from bandwidth using the nearest compatible measured machine and model. Compute both workload times. Model Spark + Mac cache transfer over Wi-Fi, 2.5 GbE or 10 GbE with explicit cache size and link assumptions. Extend `bench_consider_checks` to record errors for each phase and memory. Keep JS and Python outputs in parity using shared fixtures, including missing specs, no measurements, fit failure and split transfer costs.

## Phase 5 — Bench UI

Add a Speed tab with a prompt-reading curve, writing bars, cold/warm comparison and workload times, plus Consider comparisons for M6/M5 Pro/Spark/split. Use Organized AI styling and GSAP transitions. Label every figure measured or estimated, show units and provenance, and handle empty/failed runs. Implement mostly in `public/speed.js`, with small Bench hooks. Verify UI contract and calculations with tests; visual/browser work follows the available environment's supported tools.

## Phase 6 — Verification and local smoke

Run complete Python and Node suites. Attempt a locked live speed smoke on this Mac with Qwen3-0.6B-4bit only if memory allows; record `fit:false` rows otherwise. Record Consider estimate errors wherever actual measurements exist. Leave jordan-mac-mini runs to Jordan. No remote deployment or paid sweep.

Local context: M1 Pro, 16 GB, supabowl. oMLX 0.8.3 listens only on `http://127.0.0.1:8000/v1`, serves `/Volumes/A1/stash/models/mlx`, and caches in `/Volumes/A1/omlx-cache` with a 50 GB cap. Around 1 GB is free with current apps open. Small candidates are Qwen3-0.6B-4bit and Qwen3-4B-Instruct-2507-4bit; do not close user apps or bypass the guard to force a run.

## Phase 7 — Hybrid

Implement `agent/hybrid_runner.py` with all cloud, all local, hybrid, hybrid + review, and private hybrid. Cloud reader calls go through the dedicated Cloudflare AI Gateway `a1-scout-bench` (one gateway per app), with credentials supplied outside the repo. Handoff uses a small, versioned JSON brief containing goal, excerpts, constraints and output specification. Private hybrid reverses roles: Mac reads, cloud writes only from a brief with client data removed. Test the privacy boundary before cloud submission.

Add a long-write bank with code-file and report tasks producing 1k–4k token replies; use existing scorers for quality. Record variant, reader/writer/reviewer models, brief tokens, turn number, timings, server usage, gateway cloud cost and quality. Missing cost must not become a free-call claim. Sweep output 150/1k/4k tokens × brief 250/500/1k tokens × turn 1/later turns for both html-json and long-write, across all five variants using fakes. Pair each hybrid with matching all-cloud/all-local baselines. Pass requires cost < all cloud AND time < all local AND quality >= all cloud minus 0.02.

Cost hypothesis: `C_cloud = Pin*Nin + Pout*Nout`; `C_hybrid = Pin*Nin + Pout*Nbrief`. Time hypothesis: `T_local = Nin/Rread_mac + Nout/Rwrite_mac`; `T_hybrid = Tfirst_cloud + Nbrief/Rwrite_cloud + Nbrief/Rread_mac + Nout/Rwrite_mac`. These are hypotheses; actual gateway cost and measured time determine passes. Later-turn caching, oversized briefs and lost context can eliminate the benefit.

Tests fake oMLX, remote endpoints and cloud models. Permit at most one small paid smoke per reader model; ask Jordan before a larger live hybrid sweep. Open choices remain the remote NVIDIA endpoint and frontier reader models; fake coverage and implementation must not depend on purchasing access.

## Final acceptance

All eight phases have completion records and passing gates, complete Python/Node suite totals are reported, and the draft PR targets the specified base. Report the draft PR link, live smoke result or fit refusal, estimate checks and remaining Mac/remote/cloud runs. Do not claim an unrun experiment passed.
