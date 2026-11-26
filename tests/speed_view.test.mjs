// Browser view contracts in a VM DOM; no server, browser, or model needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const read = f => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const plain = x => JSON.parse(JSON.stringify(x));

function page({ reduced = true } = {}) {
  const elements = new Map(), animations = [];
  const context = { window: {}, console, URLSearchParams, URL, setTimeout, clearTimeout,
    document: { head: { appendChild() {} }, createElement: () => ({}), querySelector: key => elements.get(key) || null, querySelectorAll: () => [] },
    matchMedia: () => ({ matches: reduced }),
    gsap: { fromTo(...args) { animations.push(args); }, from(...args) { animations.push(args); }, to(...args) { animations.push(args); }, set() {} },
  };
  context.window.window = context.window;
  context.window.matchMedia = context.matchMedia;
  context.window.gsap = context.gsap;
  vm.createContext(context);
  for (const f of ["public/consider-core.js", "public/speed-core.js", "public/speed.js", "public/bench.js"]) vm.runInContext(read(f), context);
  return { view: context.window.SpeedView, bench: context.window.BenchView, elements, animations, context };
}
const row = (over = {}) => ({ id: 1, uid: "r1", machine: "m1", model: "fake-q4", bank: "bank1", tokenizer: "Qwen3", precision: "q4",
  target: "mlx", engine_version: "test-1", phase: "prefill", workload: "agent", task_id: "agent-8000", target_prompt_tokens: 8000,
  prompt_tokens: 8000, reply_tokens: 1, max_tokens: 1, prompt_tok_s: 100, write_tok_s: null, ttft_ms: 80000, fit: true,
  cache_state: "not_applicable", probes: { rss_scope: "model-process", peak_rss_bytes: 2 * 2 ** 30, chip: "M1 Pro" }, ...over });

test("Speed renders measured curve/writing units and estimated workloads with provenance", () => {
  const {view}=page();
  view.setData([row(),row({id:2,uid:"read-new",prompt_tok_s:120}),row({id:3,uid:"write",phase:"decode",max_tokens:256,reply_tokens:256,write_tok_s:20})]);
  const data=view.viewModel(),html=view.html();
  assert.equal(data.reading.length,1);
  assert.equal(data.reading[0].uid,"read-new");
  assert.equal(data.writing[0].uid,"write");
  assert.match(html,/Measured prompt-reading curve/);
  assert.match(html,/Measured 20\.0 tok\/s/);
  assert.match(html,/120\.0 tok\/s/);
  assert.match(html,/Estimated workload time/);
  assert.match(html,/Estimated [\d.]+ s/);
  assert.match(html,/TTFT 80000\.0 ms/);
  assert.match(html,/M6|M5 Pro/);
  assert.match(html,/DGX Spark/);
  assert.match(html,/run read-new/);
});

test("Speed keeps incompatible configurations and cache conditions separate", () => {
  const {view}=page();
  const variants=[{model:"other"},{bank:"other"},{tokenizer:"other"},{target:"endpoint"},{engine_version:"other"},{precision:"q8"}];
  view.setData([row(),...variants.map((v,i)=>row({id:i+2,uid:"variant"+i,prompt_tok_s:9999,...v})),row({id:20,uid:"warm",cache_state:"warm-repeat"})]);
  const data=view.viewModel();
  assert.equal(data.options.length,7);
  assert.equal(data.group.rows.length,2);
  assert.equal(data.rows.length,1);
  assert.equal(data.reading[0].prompt_tok_s,100);
  assert.equal(data.request.cache_state,"not_applicable");
});

test("cache comparison requires exact measurement pair and preserves unconfirmed cold label", () => {
  const {view}=page();
  const cold=row({uid:"cold",target:"omlx",cache_state:"first-use-unconfirmed",cache_pair_uid:"pair",ttft_ms:100});
  const warm=row({id:2,uid:"warm",target:"omlx",cache_state:"warm-repeat",cache_pair_uid:"pair",ttft_ms:10,probes:{cache_read_gbs:.5}});
  view.setData([cold,warm,row({...cold,id:3,uid:"wrong-pair",cache_pair_uid:"other"}),row({...warm,id:4,uid:"wrong-count",cache_pair_uid:"other",prompt_tokens:8001})]);
  assert.equal(view.viewModel().pairs.length,1);
  assert.equal(view.viewModel().pairs[0].cold.uid,"cold");
  const html=view.html();
  assert.match(html,/cold not confirmed/);
  assert.match(html,/100\.0 ms/);
  assert.match(html,/10\.0 ms/);
  assert.match(html,/0\.500 GB\/s/);
  assert.match(html,/no cache eviction is performed/i);
});

test("fit failures, unknown counts and error text remain honest and escaped", () => {
  const {view}=page();
  view.setData([row({model:'<img src=x onerror="bad()">',fit:false,reason:"<script>private</script>",prompt_tok_s:null,prompt_tokens:null}),
    row({id:2,uid:"failed",model:'<img src=x onerror="bad()">',fit:null,error:"<b>stream failed</b>",prompt_tok_s:null})]);
  const html=view.html();
  assert.match(html,/Does not fit/);
  assert.match(html,/Run failed/);
  assert.match(html,/&lt;script&gt;private&lt;\/script&gt;/);
  assert.match(html,/&lt;img/);
  assert.doesNotMatch(html,/<script>|<img|<b>stream failed/);
  assert.match(html,/unavailable/);
  assert.match(html,/No successful reading probes/);
  assert.equal(view.viewModel().reading.length,0);
  const empty=page().view.html();
  assert.match(empty,/No speed measurements loaded/);
  assert.match(empty,/bench speed/);
});

test("paginated loading carries filters, deduplicates UIDs and exposes retry after errors", async () => {
  const {view}=page();
  const paths=[];
  const call=async path=>{paths.push(path);return paths.length===1?{rows:[row()],has_more:true,next_before:10}:{rows:[row(),row({id:0,uid:"older"})],has_more:false,next_before:null};};
  await view.load(call,{machine:"m1",model:"org/fake"});
  assert.match(view.html(),/Load older measurements/);
  await view.load(call,{more:true});
  assert.equal(view.viewModel().group.rows.length,2);
  assert.equal(new URL("https://x"+paths[1]).searchParams.get("before"),"10");
  assert.equal(new URL("https://x"+paths[0]).searchParams.get("model"),"org/fake");
  await view.load(async()=>{throw Error("<server unavailable>");});
  assert.match(view.html(),/role="alert"/);
  assert.match(view.html(),/&lt;server unavailable&gt;/);
  assert.match(view.html(),/Refresh to retry/);
  await view.load(async()=>({rows:[],has_more:false,next_before:null}));
  assert.doesNotMatch(view.html(),/role="alert"/);
});

test("Speed tab delegates wiring, scripts load in order and GSAP respects reduced motion", () => {
  for (const reduced of [true,false]) {
    const {view,bench,elements,animations}=page({reduced});
    view.setData([row()]);
    const selectors=new Map();
    let changeWorkload;
    selectors.set("[data-speed-workload]",{addEventListener(type,fn){if(type==="change")changeWorkload=fn;}});
    const root={querySelector:key=>selectors.get(key)||null,querySelectorAll:key=>key==="[data-tab]"?[tab]:[]};
    const tab={dataset:{tab:"speed"}};
    elements.set(".bn",root);elements.set(".sp",root);
    bench.setData({rows:[],suites:[],machines:[]});
    bench.wire(false,()=>{},()=>{});
    tab.onclick();
    assert.match(bench.html(),/aria-label="Speed Lab"/);
    bench.wire(true,()=>{},()=>{});
    assert.equal(animations.length,reduced?0:2);
    changeWorkload({target:{value:"chat"}});
    bench.wire(false,()=>{},()=>{});
    assert.equal(animations.length,reduced?0:4);
  }
  const html=read("public/index.html");
  assert.ok(html.indexOf('src="consider-core.js"')<html.indexOf('src="speed-core.js"'));
  assert.ok(html.indexOf('src="speed-core.js"')<html.indexOf('src="speed.js"'));
  assert.ok(html.indexOf('src="speed.js"')<html.indexOf('src="bench.js"'));
});

