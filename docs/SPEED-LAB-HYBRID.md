# Hybrid Speed Lab experiments

The experiment compares `all-cloud`, `all-local`, `hybrid`, `hybrid-review` and `private-hybrid` on the same task and output/brief/turn cell. The ordinary quality benchmark's `all` command remains unchanged. `long-write` is a separate hybrid bank: four code-file and four report JSON tasks with roughly 1k–4k-token requested replies, scored by the existing JSON-schema/expected-field scorer. This checks structure and required content, not arbitrary code correctness or report factual quality.

`agent.py bench hybrid` takes the existing `~/.nvme-stash/scout.lock` and defaults to a dry-run plan. It reads the repository's synthetic html-json and long-write banks, adds a deterministic context from the 8k-token Qwen3 speed bank, and retains the original scoring rules. The actual task follows the padding and takes precedence. Context size is therefore 8k Qwen3 bank tokens **plus** the task/instructions/history; server usage is authoritative for each model. Bank hashes cover task content and the prompt-building source.

The full fake-test sweep is every task × output cap 150/1,000/4,000 × brief cap 250/500/1,000 × turn 1/2 × five variants. `output_budget`, `output_token_cap` and the legacy cell key `output_tokens` are requested caps, not measured reply lengths. `reply_tokens` and each call's usage contain actual counts; early stopping is preserved. Each task/variant/cap/brief/role has a separate conversation history. Turn two includes its own earlier user/assistant exchange; it does not borrow another variant's cache.

Hybrid asks the cloud reader for a small versioned JSON brief, then asks the local model to write from that brief. Review adds a short cloud critique followed by a local revision. Its cost and time include both extra calls. Private hybrid asks the Mac to read the original context, validates its brief against explicit approved public material, and sends only reconstructed public JSON to the cloud writer. An undeclared public context, extra field, unsupported version, unapproved goal/output specification/constraint, private excerpt or missing/oversized authoritative brief token count fails before cloud writing. The repository loader explicitly approves only its authored synthetic tasks; arbitrary tasks passed to the runner require their own `approved_public_context` object.

Each brief has exactly `version:1`, `goal`, `excerpts`, `constraints` and `output_spec`. Private goal/output specification must equal their allowlisted values, constraints must be allowed, and every excerpt must be a substring of an approved public excerpt. The caller is responsible for explicitly approving public material. This prevents unapproved model-produced text from crossing the private boundary; it cannot infer whether a caller's approval was correct.

Cloud traffic must use an existing dedicated Cloudflare AI Gateway named `a1-scout-bench`. Configuration comes from the agent environment, never the repository:

- `HYBRID_GATEWAY_URL`: for example `https://gateway.ai.cloudflare.com/v1/ACCOUNT/a1-scout-bench/openai/chat/completions`, using an OpenAI-compatible provider route.
- `HYBRID_PROVIDER_KEY`: the upstream provider credential.
- `HYBRID_GATEWAY_TOKEN`: the gateway authentication credential.
- `HYBRID_LOGS_TOKEN`: Cloudflare API token with permission to read this account's AI Gateway logs.
- `OMLX_URL`: local OpenAI-compatible URL, default `http://127.0.0.1:8000/v1`.

The client validates the HTTPS gateway host/account/app path, refuses redirects, and sends `cf-aig-collect-log-payload:false` with metadata logging enabled. It captures `cf-aig-log-id` and fetches the dedicated gateway's log detail; `result.cost` is the recorded cloud cost. A missing log, unsupported cost or delayed log is unknown, never zero and never a fabricated price estimate. Failed billed calls keep any available gateway cost. Cost lookup is instrumentation: `time_ms` sums model-call wall times and excludes management API cost lookup. It also excludes small local orchestration/scoring overhead, as its `timing_basis` states.

Cloudflare documents [metadata-only payload logging](https://developers.cloudflare.com/ai-gateway/observability/logging/) and [gateway log detail/cost](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/get/). These headers control Gateway log storage, not a provider's own retention or separately configured Logpush.

A comparison passes only when its exact paired task, bank, model pair, output budget, brief budget and turn match, cost is strictly less than all cloud, inference time is strictly less than all local, and quality is at least all-cloud quality minus 0.02. Missing measurements, errors and unknown cost cannot pass. Baseline rows have no hybrid pass verdict. The JSON scorer's limitations apply equally to each variant.

A live `--smoke --reader-model MODEL` makes **one** small cloud request (32-token cap); it does not run a matrix. Do not repeat it per reader beyond the single authorized smoke. A larger paid run requires Jordan's prior explicit approval and the deliberate `--authorized-sweep --model models/mlx/MODEL --reader-model MODEL` option. That option records intent; it does not grant permission by itself. Local fit is checked before a paid sweep, and low memory produces a local preflight refusal without cloud requests. Never change oMLX's settings or memory guard to force a run.

Results are written only under `~/.nvme-stash/bench/hybrid`, with completed paired cells persisted as the sweep proceeds. No hybrid Worker route, deployment, remote D1 migration or paid live sweep is performed by this implementation.
