import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import worker from "../src/index.js";

function env() {
  const db = new DatabaseSync(":memory:");
  const plain = x => x ? { ...x } : null;
  const DB = { _db:db, prepare(sql) { let args=[]; const s={ bind(...a){args=a;return s;},async first(){return plain(db.prepare(sql).get(...args));},
    async all(){return {results:db.prepare(sql).all(...args).map(plain)};},async run(){db.prepare(sql).run(...args);return {success:true};} };return s;},
    async batch(a){return Promise.all(a.map(s=>s.run()));} };
  return {DB,SCOUT_TOKEN:"scout",A1_CONSIDER_TOKENS:createHash("sha256").update("consider").digest("hex"),ASSETS:{fetch:()=>new Response("")}};
}
const request = {model:"fake-q4",bank:"bank1",tokenizer:"Qwen3",target:"mlx",cache_state:"not_applicable",engine_version:"test-1",precision:"q4"};
const calibration = {"M1 Pro":{bandwidth_gbs:200,gpu_tflops:5,compute_basis:"test_FP16"},M4:{bandwidth_gbs:400,gpu_tflops:10,compute_basis:"test_FP16"}};
async function call(e,path,body,token="scout") {
  return worker.fetch(new Request("https://x"+path,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)}),e);
}
function run(phase,over={}) {return {uid:phase,suite:"speed",machine:"m1",task_id:"synthetic-"+phase,workload:"agent",phase,fit:true,
  target_prompt_tokens:8000,max_tokens:phase==="prefill"?1:256,prompt_tok_s:phase==="prefill"?100:null,write_tok_s:phase==="decode"?20:null,
  probes:{rss_scope:"model-process",peak_rss_bytes:2*2**30,free_ram_bytes:4*2**30},...request,...over};}
const query = {machine:{id:"m4",chip:"M4",memory_gb:16},speed:{...request,calibration}};

test("speed Consider preserves scoped auth and seeds explicit chip specs",async()=>{
  const e=env();
  assert.equal((await call(e,"/api/bench/consider",query,"scout")).status,401);
  assert.equal((await call(e,"/api/bench/speed",run("prefill"),"consider")).status,401);
  for(const phase of ["prefill","decode"])assert.equal((await call(e,"/api/bench/speed",run(phase))).status,200);
  const response=await call(e,"/api/bench/consider",query,"consider");
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.mode,"speed");
  assert.equal(result.measured,false);
  assert.equal(result.workloads.agent.prefill.tok_s,200);
  assert.equal(result.workloads.agent.decode.tok_s,40);
  assert.equal(result.workloads.agent.seconds,437.5);
  assert.equal(e.DB._db.prepare("SELECT count(*) n FROM chip_specs").get().n,6);
  const spark=await call(e,"/api/bench/consider",{...query,machine:{chip:"DGX Spark",memory_gb:128}},"consider");
  assert.equal(spark.status,200);
  assert.equal((await spark.json()).machine_id,"dgx-spark");
  const split={writer:{chip:"M1 Pro",memory_gb:16,id:"m1"},cache:{compatible:true,format:"test-cache-v1",bytes:1e9},link:{kind:"10GbE",efficiency:.8}};
  const splitResult=await (await call(e,"/api/bench/consider",{...query,speed:{...query.speed,split}},"consider")).json();
  assert.equal(splitResult.split.agent.transfer_seconds,1);
  assert.equal(splitResult.split.agent.seconds,485);
  assert.equal(splitResult.split.agent.reader_machine,"m4");
  assert.equal(splitResult.split.agent.writer_machine,"m1");
  assert.equal(splitResult.split.agent.measured,false);
  split.cache.compatible=false;
  const unavailable=await (await call(e,"/api/bench/consider",{...query,speed:{...query.speed,split}},"consider")).json();
  assert.equal(unavailable.split.agent.seconds,null);
});

test("measured speed arrivals record both phase errors only for exact conditions",async()=>{
  const e=env();
  for(const phase of ["prefill","decode"])await call(e,"/api/bench/speed",run(phase));
  const result=await (await call(e,"/api/bench/consider",query,"consider")).json();
  await call(e,"/api/bench/speed",run("prefill",{uid:"wrong-engine",machine:"m4",engine_version:"test-2"}));
  await call(e,"/api/bench/speed",run("prefill",{uid:"wrong-length",machine:"m4",target_prompt_tokens:4000}));
  assert.equal(e.DB._db.prepare("SELECT count(*) n FROM bench_consider_checks").get().n,0);
  const read=run("prefill",{uid:"read-measured",machine:"m4",prompt_tok_s:180});
  await call(e,"/api/bench/speed",read);
  await call(e,"/api/bench/speed",read);
  await call(e,"/api/bench/speed",run("decode",{uid:"write-measured",machine:"m4",write_tok_s:35}));
  const checks=e.DB._db.prepare("SELECT * FROM bench_consider_checks ORDER BY id").all();
  assert.equal(checks.length,2);
  assert.deepEqual(checks.map(r=>r.phase),["prefill","decode"]);
  assert.deepEqual(checks.map(r=>r.error_pct),[11.1,14.3]);
  assert.equal(checks[0].consider_id,result.consider_id);
  assert.equal(checks[0].bank,"bank1");
  assert.equal(checks[0].engine_version,"test-1");
  assert.equal(checks[0].free_ram_bytes,4*2**30);
});
