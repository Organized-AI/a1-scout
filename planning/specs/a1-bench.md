# A1 Bench: offline benchmarks for the models on the A1

Measured numbers for the stash: run a fixed task bank against each model, one model at a time, record
speed, memory and quality, and show leaderboards plus blind A/B battles on the dashboard. The Lab uses
measured numbers when they exist and keeps its estimates otherwise.

Agents: `.claude/agents/impl-agent.md` (implement a phase), `test-agent.md` (write and run tests),
`review-agent.md` (review the diff before deploy), `verify-build.md` (here: the test suites, there is no build step).

## Non-goals
- No client data, ever. Banks are synthetic: example.com domains, TEST container IDs, invented notes.
- No writes to the A1. Bench caches (generated audio, the SQLite sample) live in `~/.nvme-stash/bench/`.
- No parallel model loads, no downloads, no network during a run (results queue locally and post later).
- No LLM judge. Scorers are deterministic.

## Phases

### P1 · Task banks and scorers (`tests/bench/`, `agent/bench.py`)
Suites: `gtm-debug`, `sql-ga4`, `html-json`, `rag-notes`, `asr`, `screen`. One JSON object per line:
`{id, type, prompt, ...type fields}`. Types and scorers:

| type | fields | pass | score |
|---|---|---|---|
| `exact` | `answer` (string or list of accepted strings), optional `max_wer` | normalized match, or word error rate <= `max_wer` | 1 - WER against the closest answer |
| `sql_result` | `gold_sql`, optional `ordered` | model SQL's rows equal gold rows on `fixtures/ga4_sample.sql` | 1 pass, 0.25 runs-but-wrong, 0 error |
| `json_schema` | `schema`, optional `expect` (field: value) | valid against schema and every `expect` field matches | share of checks met |
| `click_in_box` | `box` [x0,y0,x1,y1], `screen` [w,h] | parsed click lands inside box | 1 inside, else falls off with distance |

- B1 · Trigger: `bench.load_bank("sql-ga4")` · Expected: list of tasks, each with a known type · Verify: `test_bench.Banks`.
- B2 · Trigger: any bank line · Expected: no non-example domains, no real-looking GTM/GA IDs, no emails outside example.com · Verify: `test_bench.Sanitized`.
- B3 · Trigger: each scorer on right, wrong and malformed output · Expected: pass/score per the table · Verify: `test_bench.Scorers`.

### P2 · `agent.py bench <suite|all> [--fresh] [--model PATH]`
The bench picks the model; you don't have to. With no `--model`:
- B12 · Candidates: every chat model (Whisper for `asr`) on the A1 that fits 75% of this Mac's memory.
- B13 · Models already measured on the current bank and Mac are reused, not rerun (`--fresh` reruns them).
- B14 · More new candidates than `BENCH_FINALISTS` (3): each answers `BENCH_SCREEN_TASKS` (4) spread-out tasks first;
  only the top finalists answer the rest, merged into one full run. Screened-out models post nothing to the leaderboard.
- B15 · `choose_best`: highest score wins; within 5 points of the top, the faster model wins; errored runs never win.
  The pick goes to `POST /api/bench/best` (stored per suite and Mac), shows as "Best for you" on the Bench tab,
  becomes the Lab's default part for that job, and a macOS notification names it.
- `--model PATH` measures one named model and recommends nothing.
- Verify: `test_bench.ChooseBest`, `test_bench.Agent.test_finds_the_best_model_without_being_told_which` and neighbours.

- B4 · Trigger: A1 not mounted (or wrong UUID) · Expected: prints "A1 not present", runs nothing.
- B5 · Trigger: another run holds `~/.nvme-stash/scout.lock` · Expected: prints "another a1-scout run is active", runs nothing.
- B6 · Trigger: bench with N models · Expected: N runner subprocesses, strictly sequential, each loading exactly one model path under `/Volumes/A1/stash`; `--model` outside the stash is refused.
- B7 · Trigger: a run finishes · Expected: row `{suite, machine, model, model_path, runtime, bank, ttft_ms, tok_s, peak_rss, load_s, passed, total, score, results[]}` posted to `POST /api/bench/runs` with `SCOUT_TOKEN`; on network failure it is queued in `~/.nvme-stash/bench/pending.jsonl` and flushed on the next bench.
- Metrics: `load_s` model load wall time; `ttft_ms` median time to first token; `tok_s` median decode tokens/s; `peak_rss` max of the child's `ru_maxrss` (os.wait4) and MLX peak memory; `passed`/`total`; `score` mean 0..1.
- Machine id matches the Lab's (`m1`, `m4`, `m6`, `m5p`) when the chip and memory match; `BENCH_MACHINE` overrides.
- Verify: `test_bench.Agent` with a fake runner, fake api, fake mount and a held lock.

### P3 · Worker
- `bench_runs` (D1): one row per model x suite x machine run. `bench_votes` (D1): battle log for rebuilding Elo.
- B8 · `POST /api/bench/runs`: auth, unknown suite 400, non-finite metrics dropped, results capped (200 tasks, 2 KB output each).
- B9 · `GET /api/bench/leaderboard?suite=&machine=`: latest run per (model, suite, machine), score desc then tok/s, with Elo and battle counts; lists known suites and machines.
- B10 · `GET /api/bench/battle?suite=`: two different models' outputs on the same task, order randomized, names hidden; the pairing waits in KV for an hour.
- B11 · `POST /api/bench/battle {id, vote: a|b|tie}`: one vote per battle (404 after), Elo updated in KV (`elo:<suite>`, K=32, start 1000), vote logged in D1, names revealed.
- Verify: `node --test tests/worker_bench.test.mjs` (D1 shim over node:sqlite, in-memory KV).

### P4 · Dashboard
- `public/bench.js`: `window.BenchView` with `html()`/`wire()` like MapView/LabView. Leaderboard (suite and machine filters) and a blind battle view; GSAP for row entry, metric bars, the vote and the reveal; honors reduced motion.
- `public/lab.js`: tok/s, peak memory and load time come from bench runs for that model on that Mac when they exist (labelled "measured"); the quality test uses the measured pass rate of the matching suite. Otherwise the estimates stand.
- Verify: `node --test tests/lab.test.mjs` (measured beats estimate; estimate when absent).

### P5 · Verify and ship
`python3 -m unittest discover -s tests -v`, `node --test tests/*.test.mjs`, review-agent pass on the diff, `wrangler deploy`.
