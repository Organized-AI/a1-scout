# Phase 4 — Chip specifications and Consider v2 complete

Added shared pure Speed Lab math in `public/speed-core.js`, Python parity in `agent/speed_consider.py`, six sourced chip specifications in D1/schema seeds, optional authenticated `body.speed` Consider mode, compatible-cache split estimates and append-only arrival checks for both phases. Small hooks preserve the existing Consider route and Speed storage behavior. `docs/SPEED-LAB-CONSIDER.md` describes the API and assumptions.

Reading scales only with comparable compute precision/basis or same-chip measurements; Apple GPU TFLOPS remain null and Spark FP4 sparse never silently compares to FP32. Writing scales by bandwidth, with known M6/M5 Max memory bins. Estimates match actual tokenizer, model, bank, cache, target, engine, precision and nearest prompt length. Exact candidate/length observations alone are measured. Context-specific workload fit controls timing. Splits require explicit cache compatibility/format/bytes and link assumptions. Endpoint tokenizer defaults to unknown, with Qwen3 bank provenance retained separately; local tokenizer files are hashed.

Checks:

- Review-agent gate (parent independent diff review): APPROVE after strict engine/tokenizer matching, context-specific fit, exposed split API and sourced catalog checks.

- Focused Python Speed suites: 33 passed, including real Qwen3 bank regeneration and JS/Python parity.
- Focused Node core/Speed Worker/Speed Consider/legacy Consider suites: 21 passed.
- Build: 21 Python files AST parsed; new/changed Worker and pure JS files passed syntax checks; fresh SQLite schema initialized and contained six chip seeds; `git diff --check` clean.
- Architecture: one-way imports; standalone arrival-check module avoids route cycles; source files fit existing agent/public/src/test boundaries. No new dependency installation or bundler is required.
- Independent test-agent covers shared fixtures, missing data/specs, precision and condition mismatches, fit refusals, link transfers, auth, hardware seeds, and phase checks.

No remote D1 migration, deployment, paid call or live inference. Default total-workload estimates remain unknown where comparable prefill measurements/calibration do not exist. A Spark + Mac split remains hypothetical until an actual compatible-cache transfer has been demonstrated; this phase estimates declared experiments only.
