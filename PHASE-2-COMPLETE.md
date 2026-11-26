# Phase 2 complete

Added streamed MLX, oMLX and OpenAI-compatible endpoint runner with authoritative usage, separate prompt/write rates, engine discovery, free RAM and scoped RSS/hardware/cache-read probes. Local loads check weights plus a 512 MiB margin. oMLX 507/prefill guard 400 become fit:false; first-use cache state remains unconfirmed and each repeated pair has an isolated prefix. Standalone and agent entry points hold scout.lock. --smoke limits to one 1k reading request. Results stay under ~/.nvme-stash/bench/speed.

- test-agent: 19/19 new fake-clock/model/server tests pass, no skips or live inference.
- review-agent (parent independent review): APPROVE after fixing remote model IDs, cache-pair isolation, terminal SSE validation and remote probe scope.
- verify-build: 17 Python sources parse, Worker syntax and fresh local SQLite schema pass; diff check clean.
- verify-architecture: COMPLIANT, one new runner and three-line hook under existing lock/mount gate.

Server RSS and unknown model active weights remain unknown; observed client TTFT includes queue/transport. No server settings changed, cache eviction, A1 writes, deployments or migrations. Upload is Phase 3.
