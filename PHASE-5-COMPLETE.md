# Phase 5 complete — Bench Speed UI

## Implementation

Added `public/speed.js` and a Speed subtab in Bench's measured view, with ordered script loading in `public/index.html`.

The view shows measured prompt-reading curves using server token counts, measured reply-writing bars, exact first-use/warm cache pairs, fit/refusal diagnostics, estimated agent/chat workload times, and M6/M5 Pro/DGX Spark comparisons. Hypothetical Spark + Mac link estimates require explicit compatible-cache declarations, cache bytes and Wi-Fi throughput. Split writers are restricted to Apple chips.

Measurement configurations keep model, bank, actual tokenizer, target, engine version and precision separate. Cache conditions are selected explicitly; cache pairs require the same measurement UID, machine, task, configuration and counts. Every timing panel labels measured versus estimated figures, units and available provenance. Missing compute, memory fit or transfer compatibility remains unavailable with an explanation.

Machine/model filters use bounded pagination, preserve retry after failures and deduplicate retransmissions by UID. Dynamic content is escaped. GSAP runs after data/control transitions and respects reduced motion. Existing Organized AI colors, typography and panel conventions are reused.

## Template gates

- impl-agent: requested panels, filtering and minimal integration hooks implemented.
- test-agent: `node --test tests/speed_view.test.mjs` — **6 passed**, no failures or skips. Coverage includes labels/provenance, configuration separation, exact cache pairs, escaped fit/error states, pagination/retry and Bench/script/GSAP integration.
- Regression checks: `node --test tests/lab_bench.test.mjs tests/jobs.test.mjs tests/consider_core.test.mjs` — **17 passed**, no failures or skips.
- review-agent: main-agent review approved after Apple-only split writer, actual transition animation, uniform numeric-value escaping and color fallback fixes.
- verify-build: changed JavaScript and inline index script pass `node --check`; SpeedCore → SpeedView → Bench script order verified; `git diff --check` passes. This project has no package build artifact step.
- verify-architecture: new UI module is self-contained, below 600 lines, has no dependency cycle and uses small Bench/index hooks. No shared UI refactor.

## Limits

No browser rendering or visual screenshot QA was performed. UI behavior is verified with VM-based contract tests and static checks. Default cross-chip reading estimates remain unknown without comparable measured compute calibration; this prevents invented performance claims. No deployment or remote migration was run.
