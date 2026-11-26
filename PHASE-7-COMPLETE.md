# Phase 7 — Hybrid experiments complete

Added `agent/hybrid_runner.py`, the dedicated Gateway client in `agent/hybrid_gateway.py`, eight synthetic long-write code/report tasks and small locked CLI/bank hooks. Ordinary quality `all` remains unchanged. The default CLI prints a dry-run plan; smoke makes one bounded cloud request only when deliberately requested. Larger paid sweeps require Jordan's prior approval and the explicit sweep option. No paid call was made during implementation.

Implemented all cloud, all local, cloud brief/local write, cloud brief/local write/cloud critique/local revision, and private local brief/cloud write. Strict versioned JSON briefs use authoritative output-token budgets. Private briefs are reconstructed only after approved-public-context validation; unsafe/malformed/private fields fail before a cloud writer call. Separate role histories preserve real second turns within each task/variant/budget cell.

All cloud calls validate the dedicated `a1-scout-bench` Gateway URL and disable payload logging while retaining cost metadata. Costs come from the gateway log detail; missing cost remains unknown. Failed billed calls and review calls are included. Inference timing excludes cost lookup and is labelled accordingly. Rows distinguish requested output caps from actual final usage, retain per-call models/usage/times/costs, and compare exact bank/model/task/budget/turn/machine pairs. Completed paired cells persist under the local bench state directory. No hybrid Worker route was added.

Verification:

- Final full suites: **160 Python tests** passed in 31.187 seconds; **143 Node tests** passed, zero failures or skips.
- Independent review-agent gate: **APPROVE**, no blocking findings. The minor local HTTP response cleanup finding was fixed and covered by the existing CLI/error-path regression test before final verification.

- Focused hybrid tests: 13 passed using fakes only.
- Full matrix: all 16 html-json/long-write tasks, 18 cells, all five variants, 1,440 recorded variant rows.
- Tests cover privacy rejection, real turn histories, strict pass thresholds, failed/missing costs, Gateway routing/headers/log lookup/no redirects, malformed responses and CLI preflight preventing cloud calls on low memory.
- Build gate: Python AST parsing and module compilation pass; fresh SQLite initialization retains six chip seeds; shared JS syntax checks and `git diff --check` pass.
- Architecture gate: two isolated standard-library agent modules, one-way dependencies, small dispatch hooks, no new runtime dependencies or route cycles.

API/operational details are in `docs/SPEED-LAB-HYBRID.md`. Live frontier model validation, gateway credentials/provisioning verification, and any paid hybrid sweep remain external experiments requiring the stated authorization. No deployment or remote migration was run.
