# Speed Lab API and offline queue

Speed runs use `/api/bench/speed`, behind the same Scout token, signed session or Cloudflare Access gate as `/api/bench/runs`. Consider-only tokens do not grant access. Rows are timing measurements, never scored quality runs.

## POST /api/bench/speed

Submit one JSON object per measurement. The UTF-8 body limit is 1,000,000 bytes. Required fields:

```json
{
  "uid": "unique-measurement-id",
  "suite": "speed",
  "machine": "m1",
  "model": "Qwen3-0.6B-4bit",
  "target": "omlx",
  "bank": "builder-and-bank-hash",
  "task_id": "speed-agent-release-1000-prefill",
  "phase": "prefill",
  "workload": "agent",
  "fit": true
}
```

`target` is `mlx`, `omlx` or `endpoint`; `phase` is `prefill` or `decode`; `workload` is `agent` or `chat`. `fit` is true, false or null (unknown). A false fit requires a nonempty `reason`. Optional `suite` must be `speed`. UID, machine, bank and task ID are bounded letters/numbers/underscore/dot/hyphen identifiers. Model IDs also allow provider namespaces (`org/model`), colons, `@` and `+`; empty or traversal path components are refused.

Optional fields preserved through a strict allowlist:

- Timing: `ttft_ms`, `latency_ms`, `prompt_tok_s`, `write_tok_s`, `load_s`, `timing_basis`.
- Counts and model metadata: `prompt_tokens`, `reply_tokens`, `target_prompt_tokens`, `max_tokens`, `active_weight_bytes`, `bandwidth_used_gbs`, `tokenizer`, `runtime`, `engine_version`.
- Diagnostics: `reason`, `error`, `started`, `finished`.
- Cache: `cache_state` (`not_applicable`, `first-use-unconfirmed`, `warm-repeat`), `cache_pair_uid`.
- `usage`: provider-specific nonnegative numeric counts, including nested prompt/cache details. Text values are excluded; nesting and keys are bounded.
- `probes`: free RAM, peak RSS, physical memory and cache-read bytes; chip, memory bandwidth and provenance; cache drive/read speed/basis; RAM/RSS/probe scope. Endpoint probes are client measurements, not remote hardware measurements.

Unknown or invalid optional numeric metrics become null. Counts must be nonnegative safe integers. Response text, prompts, credentials and other unrecognized fields are excluded. The runner also removes output before saving local timing rows.

Success is HTTP 200 `{ "ok": true, "id": 1, "duplicate": false }`. Reposting the same UID returns the original ID with `duplicate: true`, preserving the original measurement. The unique constraint and atomic insert make concurrent retransmissions no-ops. No update/delete routes are exposed. Invalid input is HTTP 400; oversized bodies are HTTP 413; other methods are HTTP 405.

## GET /api/bench/speed

Optional exact `machine` and `model` filters use the same identifier rules. Pagination uses `limit` (1–200, default 100) and `before` (positive row ID). Results are newest first:

```json
{ "rows": [], "has_more": false, "next_before": null }
```

Rows flatten the stored validated measurement and add `id` and server `created`. When more rows exist, request the same filters with `before=next_before`. No unbounded list query is available.

## Local durability

`agent.py bench speed` holds `~/.nvme-stash/scout.lock`. Every measurement is first written to `~/.nvme-stash/bench/speed/<uid>.json`, then `speed_upload.publish_rows` flushes `~/.nvme-stash/bench/pending-speed.jsonl` and submits the new rows. Existing Bench retry behavior is reused through a route adapter: network failures and HTTP 5xx remain queued; HTTP 4xx are rejected and the local JSON remains available. Speed rows never enter the quality-run queue. A response lost after insertion is safe to resend because its UID is unchanged.

DDL is mirrored in `schema.sql` and created on first route use, matching the existing Bench pattern. No remote migration or deployment is performed by this worktree.
