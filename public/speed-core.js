// Pure Speed Lab math shared by the Worker and Bench. Python parity: speed_consider.py.
(function (root) {
  "use strict";
  const APPLE_REASON = "No comparable published GPU TFLOPS; supply a measured calibration with an explicit common precision/basis";
  const DEFAULT_SPECS = {
    "M1 Pro": { bandwidth_gbs: 200, gpu_tflops: null, compute_basis: null, compute_reason: APPLE_REASON, source_url: "https://support.apple.com/kb/SP854" },
    "M4": { bandwidth_gbs: 120, gpu_tflops: null, compute_basis: null, compute_reason: APPLE_REASON, source_url: "https://support.apple.com/en-us/121555" },
    "M6": { bandwidth_gbs: 170, gpu_tflops: null, compute_basis: null, compute_reason: APPLE_REASON, bandwidth_basis: "up to 170 GB/s; 32GB configuration", source_url: "https://support.apple.com/en-us/148299" },
    "M5 Pro": { bandwidth_gbs: 307, gpu_tflops: null, compute_basis: null, compute_reason: APPLE_REASON, source_url: "https://www.apple.com/newsroom/2026/03/apple-introduces-macbook-pro-with-all-new-m5-pro-and-m5-max/" },
    "M5 Max": { bandwidth_gbs: 614, gpu_tflops: null, compute_basis: null, compute_reason: APPLE_REASON, bandwidth_basis: "upper 614 GB/s bin", source_url: "https://www.apple.com/newsroom/2026/03/apple-introduces-macbook-pro-with-all-new-m5-pro-and-m5-max/" },
    "DGX Spark": { bandwidth_gbs: 273, gpu_tflops: 1000, compute_basis: "FP4_sparse", compute_reason: "Sparse FP4 peak is not comparable to Apple GPU FP32", source_url: "https://docs.nvidia.com/dgx/dgx-spark/hardware.html", compute_source_url: "https://www.nvidia.com/en-us/products/workstations/dgx-spark/" },
  };
  const MACHINE_CHIPS = { m1: "M1 Pro", m4: "M4", m6: "M6", m5p: "M5 Pro", "m5-max-128gb": "M5 Max", "dgx-spark": "DGX Spark" };
  const WORKLOADS = { agent: { input_tokens: 8000, output_tokens: 150, turns: 10 }, chat: { input_tokens: 500, output_tokens: 500, turns: 1 } };
  const positive = n => typeof n === "number" && Number.isFinite(n) && n > 0;
  const round = n => Math.round(n * 1e6) / 1e6;
  const chipOf = row => row.chip || MACHINE_CHIPS[row.machine] || (row.probes?.probe_scope !== "client" ? row.probes?.chip : null);
  const generation = chip => Number((chip?.match(/^M(\d+)/) || [])[1]) || 100;
  function specFor(chip, machine, specs, calibration) {
    const spec = { ...(specs[chip] || {}), ...(calibration[chip] || {}) };
    if (spec.bandwidth_basis === DEFAULT_SPECS[chip]?.bandwidth_basis && !calibration[chip]?.bandwidth_gbs && machine?.memory_gb) {
      if (chip === "M6") spec.bandwidth_gbs = machine.memory_gb === 16 ? 153 : [24,32].includes(machine.memory_gb) ? 170 : null;
      if (chip === "M5 Max") spec.bandwidth_gbs = machine.memory_gb === 36 ? 460 : [48,64,128].includes(machine.memory_gb) ? 614 : null;
    }
    return spec;
  }
  function matches(row, request) {
    return typeof request.tokenizer === "string" && request.tokenizer !== "unknown" && row.fit === true && !row.error && ["model", "bank", "tokenizer", "cache_state", "target"].every(k => row[k] === request[k])
      && ["engine_version", "precision"].every(k => (row[k] ?? null) === (request[k] ?? null));
  }
  function phaseEstimate(phase, input, machine, request, runs, specs, calibration) {
    const metric = phase === "prefill" ? "prompt_tok_s" : "write_tok_s";
    const dest = specFor(machine.chip, machine, specs, calibration);
    const candidates = runs.filter(r => matches(r, request) && r.phase === phase && positive(r[metric]) && positive(r.target_prompt_tokens));
    candidates.sort((a, b) => Math.abs(a.target_prompt_tokens - input) - Math.abs(b.target_prompt_tokens - input)
      || Number(b.machine === machine.id) - Number(a.machine === machine.id)
      || Math.abs(generation(chipOf(a)) - generation(machine.chip)) - Math.abs(generation(chipOf(b)) - generation(machine.chip))
      || (b.id || 0) - (a.id || 0));
    for (const row of candidates) {
      const chip = chipOf(row), source = specFor(chip, {memory_gb: row.probes?.probe_scope !== "client" && row.probes?.memory_bytes ? row.probes.memory_bytes / 2 ** 30 : null}, specs, calibration);
      const direct = row.machine === machine.id && row.target_prompt_tokens === input;
      let ratio, basis;
      if (direct) { ratio = 1; basis = "exact matching measured run"; }
      else if (phase === "decode" && positive(dest.bandwidth_gbs) && positive(source.bandwidth_gbs)) {
        ratio = dest.bandwidth_gbs / source.bandwidth_gbs; basis = "memory-bandwidth ratio";
      } else if (phase === "prefill" && chip === machine.chip && chip) {
        ratio = 1; basis = "same chip; nearest prompt length";
      } else if (phase === "prefill" && positive(dest.gpu_tflops) && positive(source.gpu_tflops)
          && dest.compute_basis && dest.compute_basis === source.compute_basis) {
        ratio = dest.gpu_tflops / source.gpu_tflops; basis = `compute ratio (${dest.compute_basis})`;
      } else continue;
      return { tok_s: round(row[metric] * ratio), measured: direct, basis, source_uid: row.uid || null,
        source_machine: row.machine, source_prompt_tokens: row.target_prompt_tokens, input_tokens: input,
        source_url: phase === "prefill" ? dest.compute_source_url || dest.source_url || null : dest.source_url || null,
        conditions: { ...request, phase, target_prompt_tokens: input } };
    }
    return { tok_s: null, measured: false, basis: phase === "prefill" ? "No compatible measured run or comparable compute calibration" : "No compatible measured run or bandwidth specification",
      source_uid: null, source_machine: null, source_prompt_tokens: null, input_tokens: input, source_url: null,
      conditions: { ...request, phase, target_prompt_tokens: input } };
  }
  function estimateSpeed({ machine, request, runs, specs = DEFAULT_SPECS, calibration = {} }) {
    const matching = runs.filter(r => matches(r, request));
    const peaks = matching.filter(r => r.probes?.rss_scope === "model-process").map(r => r.probes.peak_rss_bytes).filter(positive);
    const need = peaks.length ? Math.max(...peaks) : null;
    const refused = runs.some(r => r.machine === machine.id && r.fit === false && matches({ ...r, fit: true, error: null }, request));
    const fit = refused ? false : need && positive(machine.memory_gb) ? need <= machine.memory_gb * 2 ** 30 * 0.75 : null;
    const workloads = {};
    for (const [name, workload] of Object.entries(WORKLOADS)) {
      const prefill = phaseEstimate("prefill", workload.input_tokens, machine, request, runs, specs, calibration);
      const decode = phaseEstimate("decode", workload.input_tokens, machine, request, runs, specs, calibration);
      const contextRefused = runs.some(r => r.machine === machine.id && r.fit === false && r.target_prompt_tokens === workload.input_tokens && matches({ ...r, fit: true, error: null }, request));
      const workloadFit = contextRefused ? false : need && positive(machine.memory_gb) ? need <= machine.memory_gb * 2 ** 30 * 0.75 : null;
      const seconds = workloadFit !== false && positive(prefill.tok_s) && positive(decode.tok_s)
        ? round((workload.input_tokens / prefill.tok_s + workload.output_tokens / decode.tok_s) * workload.turns) : null;
      workloads[name] = { ...workload, prefill, decode, seconds, fit: workloadFit, measured: false,
        basis: "estimated workload; equal context each turn, cache condition selected explicitly" };
    }
    return { machine_id: machine.id, chip: machine.chip, measured: false, fit, required_memory_bytes: need, fit_basis: refused ? "A tested context was refused; see each workload fit for context-specific applicability" : "Model-process peak RSS where measured; otherwise unknown", workloads };
  }
  function splitEstimate({ reader, writer, workload = WORKLOADS.agent, link = {}, cache = {} }) {
    const fail = why => ({ seconds: null, transfer_seconds: null, measured: false, why });
    if (cache.compatible !== true || !cache.format || !positive(cache.bytes)) return fail("Compatible cache format and cache bytes must be explicitly declared");
    if (reader?.conditions && writer?.conditions && ["model", "tokenizer", "precision"].some(k => reader.conditions[k] !== writer.conditions[k])) return fail("Reader and writer cache conditions differ");
    if (!positive(reader?.tok_s) || !positive(writer?.tok_s)) return fail("Reader and writer rates are required");
    const gbps = link.kind === "2.5GbE" ? 2.5 : link.kind === "10GbE" ? 10 : link.kind === "Wi-Fi" ? link.effective_gbps : null;
    const efficiency = link.efficiency == null ? 0.8 : link.efficiency;
    if (!positive(gbps) || !positive(efficiency) || efficiency > 1) return fail("A known link rate and efficiency are required; Wi-Fi needs effective_gbps");
    const transfer = cache.bytes * 8 / (gbps * 1e9 * efficiency);
    return { seconds: round((workload.input_tokens / reader.tok_s + transfer + workload.output_tokens / writer.tok_s) * workload.turns),
      transfer_seconds: round(transfer), measured: false, why: null,
      basis: "estimated compatible-cache transfer each turn", cache_format: cache.format, link_gbps: gbps, link_efficiency: efficiency };
  }
  root.SpeedCore = Object.freeze({ DEFAULT_SPECS, MACHINE_CHIPS, WORKLOADS, estimateSpeed, splitEstimate, matches });
})(typeof window !== "undefined" ? window : globalThis);
