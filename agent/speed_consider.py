"""Pure Speed Lab estimates. Kept in parity with public/speed-core.js fixtures."""
import math

APPLE_REASON = "No comparable published GPU TFLOPS; supply a measured calibration with an explicit common precision/basis"
APPLE_RELEASE = "https://www.apple.com/newsroom/2026/03/apple-introduces-macbook-pro-with-all-new-m5-pro-and-m5-max/"
DEFAULT_SPECS = {
    "M1 Pro": dict(bandwidth_gbs=200, gpu_tflops=None, compute_basis=None, compute_reason=APPLE_REASON, source_url="https://support.apple.com/kb/SP854"),
    "M4": dict(bandwidth_gbs=120, gpu_tflops=None, compute_basis=None, compute_reason=APPLE_REASON, source_url="https://support.apple.com/en-us/121555"),
    "M6": dict(bandwidth_gbs=170, gpu_tflops=None, compute_basis=None, compute_reason=APPLE_REASON, bandwidth_basis="up to 170 GB/s; 32GB configuration", source_url="https://support.apple.com/en-us/148299"),
    "M5 Pro": dict(bandwidth_gbs=307, gpu_tflops=None, compute_basis=None, compute_reason=APPLE_REASON, source_url=APPLE_RELEASE),
    "M5 Max": dict(bandwidth_gbs=614, gpu_tflops=None, compute_basis=None, compute_reason=APPLE_REASON, bandwidth_basis="upper 614 GB/s bin", source_url=APPLE_RELEASE),
    "DGX Spark": dict(bandwidth_gbs=273, gpu_tflops=1000, compute_basis="FP4_sparse", compute_reason="Sparse FP4 peak is not comparable to Apple GPU FP32", source_url="https://docs.nvidia.com/dgx/dgx-spark/hardware.html", compute_source_url="https://www.nvidia.com/en-us/products/workstations/dgx-spark/"),
}
MACHINE_CHIPS = {"m1": "M1 Pro", "m4": "M4", "m6": "M6", "m5p": "M5 Pro", "m5-max-128gb": "M5 Max", "dgx-spark": "DGX Spark"}
WORKLOADS = {"agent": dict(input_tokens=8000, output_tokens=150, turns=10), "chat": dict(input_tokens=500, output_tokens=500, turns=1)}


def positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def rounded(value):
    return math.floor(value * 1e6 + .5) / 1e6


def chip_of(row):
    probes = row.get("probes") or {}
    return row.get("chip") or MACHINE_CHIPS.get(row.get("machine")) or (probes.get("chip") if probes.get("probe_scope") != "client" else None)


def generation(chip):
    import re
    match = re.match(r"^M(\d+)", chip or "")
    return int(match.group(1)) if match else 100


def spec_for(chip, specs, calibration, machine=None):
    spec = {**specs.get(chip, {}), **calibration.get(chip, {})}
    gb = (machine or {}).get("memory_gb")
    if spec.get("bandwidth_basis") == DEFAULT_SPECS.get(chip, {}).get("bandwidth_basis") and not calibration.get(chip, {}).get("bandwidth_gbs") and gb:
        if chip == "M6":
            spec["bandwidth_gbs"] = 153 if gb == 16 else 170 if gb in (24, 32) else None
        if chip == "M5 Max":
            spec["bandwidth_gbs"] = 460 if gb == 36 else 614 if gb in (48, 64, 128) else None
    return spec


def matches(row, request):
    return (isinstance(request.get("tokenizer"), str) and request["tokenizer"] != "unknown"
            and row.get("fit") is True and not row.get("error")
            and all(row.get(k) == request.get(k) for k in ("model", "bank", "tokenizer", "cache_state", "target"))
            and all(row.get(k) == request.get(k) for k in ("engine_version", "precision")))


def phase_estimate(phase, input_tokens, machine, request, runs, specs, calibration):
    metric = "prompt_tok_s" if phase == "prefill" else "write_tok_s"
    dest = spec_for(machine["chip"], specs, calibration, machine)
    candidates = [r for r in runs if matches(r, request) and r.get("phase") == phase and positive(r.get(metric)) and positive(r.get("target_prompt_tokens"))]
    candidates.sort(key=lambda r: (abs(r["target_prompt_tokens"] - input_tokens), -(r["machine"] == machine["id"]), abs(generation(chip_of(r)) - generation(machine["chip"])), -(r.get("id") or 0)))
    conditions = {**request, "phase": phase, "target_prompt_tokens": input_tokens}
    for row in candidates:
        chip = chip_of(row)
        probes = row.get("probes") or {}
        source = spec_for(chip, specs, calibration, {"memory_gb": probes.get("memory_bytes", 0) / 2 ** 30 if probes.get("probe_scope") != "client" else None})
        direct = row["machine"] == machine["id"] and row["target_prompt_tokens"] == input_tokens
        if direct:
            ratio, basis = 1, "exact matching measured run"
        elif phase == "decode" and positive(dest.get("bandwidth_gbs")) and positive(source.get("bandwidth_gbs")):
            ratio, basis = dest["bandwidth_gbs"] / source["bandwidth_gbs"], "memory-bandwidth ratio"
        elif phase == "prefill" and chip == machine["chip"] and chip:
            ratio, basis = 1, "same chip; nearest prompt length"
        elif (phase == "prefill" and positive(dest.get("gpu_tflops")) and positive(source.get("gpu_tflops"))
              and dest.get("compute_basis") and dest["compute_basis"] == source.get("compute_basis")):
            ratio, basis = dest["gpu_tflops"] / source["gpu_tflops"], f"compute ratio ({dest['compute_basis']})"
        else:
            continue
        return dict(tok_s=rounded(row[metric] * ratio), measured=direct, basis=basis, source_uid=row.get("uid"),
                    source_machine=row["machine"], source_prompt_tokens=row["target_prompt_tokens"], input_tokens=input_tokens,
                    source_url=(dest.get("compute_source_url") or dest.get("source_url")) if phase == "prefill" else dest.get("source_url"), conditions=conditions)
    return dict(tok_s=None, measured=False, basis="No compatible measured run or comparable compute calibration" if phase == "prefill" else "No compatible measured run or bandwidth specification",
                source_uid=None, source_machine=None, source_prompt_tokens=None, input_tokens=input_tokens, source_url=None, conditions=conditions)


def estimate_speed(data=None, *, machine=None, request=None, runs=None, specs=None, calibration=None):
    if data is not None:
        machine, request, runs = data["machine"], data["request"], data["runs"]
        specs, calibration = data.get("specs"), data.get("calibration")
    specs = DEFAULT_SPECS if specs is None else specs
    calibration = calibration or {}
    peaks = [r["probes"]["peak_rss_bytes"] for r in runs if matches(r, request) and (r.get("probes") or {}).get("rss_scope") == "model-process" and positive(r["probes"].get("peak_rss_bytes"))]
    need = max(peaks) if peaks else None
    refused = any(r.get("machine") == machine["id"] and r.get("fit") is False and matches({**r, "fit": True, "error": None}, request) for r in runs)
    fit = False if refused else need <= machine["memory_gb"] * 2 ** 30 * .75 if need and positive(machine.get("memory_gb")) else None
    workloads = {}
    for name, workload in WORKLOADS.items():
        prefill = phase_estimate("prefill", workload["input_tokens"], machine, request, runs, specs, calibration)
        decode = phase_estimate("decode", workload["input_tokens"], machine, request, runs, specs, calibration)
        context_refused = any(r.get("machine") == machine["id"] and r.get("fit") is False and r.get("target_prompt_tokens") == workload["input_tokens"] and matches({**r, "fit": True, "error": None}, request) for r in runs)
        workload_fit = False if context_refused else need <= machine["memory_gb"] * 2 ** 30 * .75 if need and positive(machine.get("memory_gb")) else None
        seconds = rounded((workload["input_tokens"] / prefill["tok_s"] + workload["output_tokens"] / decode["tok_s"]) * workload["turns"]) if workload_fit is not False and positive(prefill["tok_s"]) and positive(decode["tok_s"]) else None
        workloads[name] = {**workload, "prefill": prefill, "decode": decode, "seconds": seconds, "fit": workload_fit, "measured": False,
                           "basis": "estimated workload; equal context each turn, cache condition selected explicitly"}
    return dict(machine_id=machine["id"], chip=machine["chip"], measured=False, fit=fit, required_memory_bytes=need, fit_basis="A tested context was refused; see each workload fit for context-specific applicability" if refused else "Model-process peak RSS where measured; otherwise unknown", workloads=workloads)


def split_estimate(data):
    reader, writer = data.get("reader") or {}, data.get("writer") or {}
    workload, link, cache = data.get("workload", WORKLOADS["agent"]), data.get("link") or {}, data.get("cache") or {}
    def fail(why):
        return dict(seconds=None, transfer_seconds=None, measured=False, why=why)
    if cache.get("compatible") is not True or not cache.get("format") or not positive(cache.get("bytes")):
        return fail("Compatible cache format and cache bytes must be explicitly declared")
    if reader.get("conditions") and writer.get("conditions") and any(reader["conditions"].get(k) != writer["conditions"].get(k) for k in ("model", "tokenizer", "precision")):
        return fail("Reader and writer cache conditions differ")
    if not positive(reader.get("tok_s")) or not positive(writer.get("tok_s")):
        return fail("Reader and writer rates are required")
    gbps = {"2.5GbE": 2.5, "10GbE": 10}.get(link.get("kind"), link.get("effective_gbps") if link.get("kind") == "Wi-Fi" else None)
    efficiency = link.get("efficiency", .8)
    if not positive(gbps) or not positive(efficiency) or efficiency > 1:
        return fail("A known link rate and efficiency are required; Wi-Fi needs effective_gbps")
    transfer = cache["bytes"] * 8 / (gbps * 1e9 * efficiency)
    return dict(seconds=rounded((workload["input_tokens"] / reader["tok_s"] + transfer + workload["output_tokens"] / writer["tok_s"]) * workload["turns"]),
                transfer_seconds=rounded(transfer), measured=False, why=None, basis="estimated compatible-cache transfer each turn", cache_format=cache["format"], link_gbps=gbps, link_efficiency=efficiency)
