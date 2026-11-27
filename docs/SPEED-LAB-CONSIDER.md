# Speed Lab Consider

`POST /api/bench/consider` retains its dedicated hashed Consider token. A `speed` object selects Speed Lab; requests without it keep the existing quality/fit response.

```json
{
  "machine": {"chip":"M6","memory_gb":32},
  "speed": {
    "model":"Qwen3-0.6B-4bit",
    "bank":"bank-content-hash",
    "tokenizer":"sha256:actual-tokenizer-file-hash",
    "target":"omlx",
    "cache_state":"warm-repeat",
    "engine_version":"0.8.3",
    "precision":"q4"
  }
}
```

`machine.id` optionally names a particular target. DGX Spark is accepted as `{"chip":"DGX Spark","memory_gb":128}`. The response has `mode:"speed"`, `workloads.agent` (8,000 in/150 out/10 turns) and `workloads.chat` (500 in/500 out/one turn). Each workload carries reading/writing rates, measurement provenance, fit and estimated seconds. Workload time assumes the same context size each turn; it does not invent later-turn cache savings.

Baselines match model, bank, actual tokenizer, cache state, target, engine version and precision. Optional version/precision absent means unknown and matches only absent values. Unknown tokenizer never authorizes an estimate. The nearest matching input length supplies each phase, with chip-generation distance breaking ties; only the exact candidate machine and exact length count as measured. Remote client hardware probes never identify a server chip. Successful model-process RSS supplies memory fit when available; client RSS does not. A refusal applies to its tested context: `fit_basis` warns about the conservative top-level refusal flag, and each workload's `fit` controls its time.

Chip specifications are captured in `chip_specs`, mirrored in `schema.sql` and the pure JS/Python defaults. M6 and M5 Max memory configurations resolve their known RAM Scout bandwidth bins; ambiguous configurations produce unknown bandwidth. Apple's sources do not publish comparable GPU TFLOPS, so those cells remain null. Spark's sparse FP4 peak is explicitly `FP4_sparse` and cannot scale an Apple FP32 workload. Consequently a default comparison can estimate writing while leaving reading and total time unknown. This is intentional: no fabricated compute values are used.

For a controlled experiment, `speed.calibration` may supply a map from chip name to `{gpu_tflops,compute_basis,compute_source_url}`. Both chips must have positive values on the same explicitly named precision/basis; a common workload calibration is preferable to comparing theoretical peaks. Optional `bandwidth_gbs` overrides support explicit experimental assumptions. Calibration is returned and persisted with the estimate, not written over the hardware catalog.

To estimate a split, add:

```json
{
  "split": {
    "writer":{"id":"m1","chip":"M1 Pro","memory_gb":16},
    "cache":{"compatible":true,"format":"experimentally-verified-cache-v1","bytes":1000000000},
    "link":{"kind":"10GbE","efficiency":0.8}
  }
}
```

This object belongs inside `speed`. A split is hypothetical until the caller declares a genuinely compatible cache format and its byte size. Reader/writer model, tokenizer and precision conditions must match. Links accept `2.5GbE`, `10GbE`, or `Wi-Fi` with an explicit `effective_gbps`. Default efficiency is 0.8, and transfer happens each turn: `bytes * 8 / (link_Gbps * 1e9 * efficiency)`. No model cache conversion or transfer is performed. An undeclared cache, missing rate, failed fit or unknown link leaves seconds null with a reason.

Estimates are append-only `bench_considers` records. Later successful measurements populate `bench_consider_checks` separately for prefill and decode only when machine, model, bank, actual tokenizer, cache, target, engine, precision and exact prompt length match the recorded conditions. UID retransmissions do not create another check. Error is `(estimate - measured) / measured * 100`; memory observations accompany the check. Runtime table creation is supported; no remote migration or deployment is part of this worktree.

The speed runner preserves the bank's Qwen3 identity separately as `bank_tokenizer`. Local model tokenizer files are hashed; remote targets default to actual tokenizer `unknown` unless `--tokenizer` or `SPEED_TOKENIZER` supplies an explicit identity. Use `--precision` to record the tested precision/quantization.
