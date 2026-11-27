import "../public/speed-core.js";
import { speedTables } from "./speed.js";
import { speedCheckTables } from "./speed-checks.js";
const CORE = globalThis.SpeedCore;
const ready = new WeakSet();
export async function chipSpecsTables(env) {
  if (ready.has(env.DB)) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS chip_specs (chip TEXT PRIMARY KEY, bandwidth_gbs REAL,
    gpu_tflops REAL, compute_basis TEXT, source_url TEXT NOT NULL, details TEXT NOT NULL)`).run();
  await env.DB.batch(Object.entries(CORE.DEFAULT_SPECS).map(([chip,spec]) => env.DB.prepare(`INSERT OR IGNORE INTO chip_specs
    (chip,bandwidth_gbs,gpu_tflops,compute_basis,source_url,details) VALUES (?,?,?,?,?,?)`).bind(chip,spec.bandwidth_gbs,spec.gpu_tflops,spec.compute_basis,spec.source_url,JSON.stringify(spec))));
  ready.add(env.DB);
}
function parse(body) {
  const s = body.speed, m = body.machine;
  if (!s || typeof s !== "object" || Array.isArray(s) || !m || typeof m !== "object") return {error:"machine and speed objects required"};
  const chip = m.chip === "DGX Spark" ? "DGX Spark" : globalThis.ConsiderCore.chipName(m.chip,m.variant);
  if (!CORE.DEFAULT_SPECS[chip] || !Number.isInteger(m.memory_gb) || m.memory_gb < 8 || m.memory_gb > 1024) return {error:"known speed chip and memory_gb 8–1024 required"};
  const request = {};
  for (const key of ["model","bank","tokenizer","cache_state","target"]) {
    if (typeof s[key] !== "string" || !s[key] || s[key].length > 200) return {error:`speed.${key} required`};
    request[key] = s[key];
  }
  if (!["mlx","omlx","endpoint"].includes(s.target) || !["not_applicable","first-use-unconfirmed","warm-repeat"].includes(s.cache_state)) return {error:"invalid speed target or cache state"};
  for (const key of ["engine_version","precision"]) if (s[key] != null) {
    if (typeof s[key] !== "string" || s[key].length > 80) return {error:`invalid ${key}`};
    request[key] = s[key];
  }
  const calibration = s.calibration || {};
  if (typeof calibration !== "object" || Array.isArray(calibration) || Object.keys(calibration).length > 6) return {error:"invalid calibration"};
  for (const [name,c] of Object.entries(calibration)) {
    if (!CORE.DEFAULT_SPECS[name] || !c || typeof c !== "object" || Array.isArray(c)
      || Object.keys(c).some(k => !["gpu_tflops","compute_basis","compute_source_url","bandwidth_gbs"].includes(k))
      || c.gpu_tflops != null && !(typeof c.gpu_tflops === "number" && Number.isFinite(c.gpu_tflops) && c.gpu_tflops > 0)
      || c.bandwidth_gbs != null && !(typeof c.bandwidth_gbs === "number" && Number.isFinite(c.bandwidth_gbs) && c.bandwidth_gbs > 0)
      || c.gpu_tflops != null && (typeof c.compute_basis !== "string" || !c.compute_basis || c.compute_basis.length > 80)
      || c.compute_source_url != null && (typeof c.compute_source_url !== "string" || !/^https:\/\//.test(c.compute_source_url) || c.compute_source_url.length > 500)) return {error:"calibration requires positive values and explicit common compute basis"};
  }
  const id = m.id || (chip === "DGX Spark" ? "dgx-spark" : globalThis.ConsiderCore.machineId({...m,chip,variant:null}));
  if (typeof id !== "string" || !/^[\w.\-]{1,80}$/.test(id)) return {error:"invalid machine id"};
  let split = null;
  if (s.split != null) {
    const p = s.split;
    if (!p || typeof p !== "object" || Array.isArray(p) || !p.writer || !p.cache || !p.link) return {error:"split requires writer, cache and link"};
    const writer = parse({machine:p.writer,speed:{...s,split:undefined}});
    if (writer.error) return writer;
    if (typeof p.cache.compatible !== "boolean" || typeof p.cache.format !== "string" || p.cache.format.length > 80
      || !Number.isSafeInteger(p.cache.bytes) || p.cache.bytes < 0
      || !["Wi-Fi","2.5GbE","10GbE"].includes(p.link.kind)
      || p.link.effective_gbps != null && !(typeof p.link.effective_gbps === "number" && Number.isFinite(p.link.effective_gbps) && p.link.effective_gbps > 0)
      || p.link.efficiency != null && !(typeof p.link.efficiency === "number" && p.link.efficiency > 0 && p.link.efficiency <= 1)) return {error:"invalid split cache or link declaration"};
    split = {writer:writer.machine,cache:{compatible:p.cache.compatible,format:p.cache.format,bytes:p.cache.bytes},
      link:{kind:p.link.kind,...(p.link.effective_gbps == null ? {} : {effective_gbps:p.link.effective_gbps}),...(p.link.efficiency == null ? {} : {efficiency:p.link.efficiency})}};
  }
  return {machine:{id,chip,memory_gb:m.memory_gb},request,calibration,split};
}
export async function speedConsiderApi(body, env, {json}) {
  const parsed = parse(body);
  if (parsed.error) return json({error:parsed.error},400);
  await speedTables(env);
  await speedCheckTables(env);
  await chipSpecsTables(env);
  const rows = (await env.DB.prepare("SELECT id,payload FROM bench_speed_runs WHERE model=? AND bank=? ORDER BY id DESC LIMIT 2000").bind(parsed.request.model,parsed.request.bank).all()).results || [];
  const runs = rows.map(r => ({...JSON.parse(r.payload),id:r.id}));
  const captured = (await env.DB.prepare("SELECT chip,bandwidth_gbs,gpu_tflops,compute_basis,source_url,details FROM chip_specs").all()).results || [];
  const specs = Object.fromEntries(captured.map(r => [r.chip,{...JSON.parse(r.details),bandwidth_gbs:r.bandwidth_gbs,gpu_tflops:r.gpu_tflops,compute_basis:r.compute_basis,source_url:r.source_url}]));
  const result = {...CORE.estimateSpeed({...parsed,runs,specs}),mode:"speed",request:parsed.request,calibration:parsed.calibration,
    bank_hash:parsed.request.bank,estimate_basis:"Matched measured phases, compute/bandwidth ratios; unknown comparable compute stays unknown"};
  if (parsed.split) {
    const writer = CORE.estimateSpeed({...parsed,machine:parsed.split.writer,runs,specs});
    result.split = Object.fromEntries(Object.entries(CORE.WORKLOADS).map(([name,workload]) => [name, {
      ...CORE.splitEstimate({reader:result.workloads[name].prefill,writer:writer.workloads[name].decode,workload,
        cache:parsed.split.cache,link:parsed.split.link}),reader_machine:parsed.machine.id,writer_machine:writer.machine_id,
      writer_fit:writer.workloads[name].fit,
      ...(writer.workloads[name].fit === false || result.workloads[name].fit === false ? {seconds:null,why:"Reader or writer does not fit this workload"} : {})
    }]));
  }
  const inserted = await env.DB.prepare("INSERT INTO bench_considers(machine_id,bank_hash,request,result,created) VALUES (?,?,?,?,?) RETURNING id")
    .bind(result.machine_id,parsed.request.bank,JSON.stringify(body),JSON.stringify(result),new Date().toISOString()).first();
  return json({...result,consider_id:inserted.id,cached:false});
}
