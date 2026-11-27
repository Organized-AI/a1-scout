import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import "../public/speed-core.js";
const C = globalThis.SpeedCore;
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/speed_consider_parity.json", import.meta.url)));

test("speed compute/bandwidth estimates honor fixture conditions and measured provenance", () => {
  for (const c of fixture.cases) {
    const result = C.estimateSpeed(c.input), agent = result.workloads.agent;
    assert.equal(agent.prefill.tok_s, c.expect.read, c.id);
    assert.equal(agent.decode.tok_s, c.expect.write, c.id);
    assert.equal(agent.seconds, c.expect.seconds, c.id);
    assert.equal(result.fit, c.expect.fit, c.id);
    assert.equal(result.measured, false);
    if (c.expect.prefill_measured !== undefined) assert.equal(agent.prefill.measured, c.expect.prefill_measured);
  }
  const scaled = C.estimateSpeed(fixture.cases[0].input);
  assert.equal(scaled.workloads.chat.seconds, 15);
  assert.equal(scaled.workloads.agent.prefill.measured, false);
  assert.equal(scaled.workloads.agent.prefill.source_uid, "prefill");
  assert.equal(scaled.workloads.agent.prefill.basis, "compute ratio (test_FP16)");
  assert.equal(scaled.workloads.agent.decode.basis, "memory-bandwidth ratio");
});

test("speed requires fit successful rows and chooses nearest prompt then exact machine", () => {
  const input = structuredClone(fixture.cases[0].input);
  input.runs = input.runs.map(r => ({ ...r, fit: false }));
  assert.equal(C.estimateSpeed(input).workloads.agent.seconds, null);
  input.runs = structuredClone(fixture.cases[0].input.runs);
  input.runs.unshift({ ...input.runs[0], uid: "wrong-length", target_prompt_tokens: 1000, prompt_tok_s: 999999 });
  assert.equal(C.estimateSpeed(input).workloads.agent.prefill.source_uid, "prefill");
  input.runs.push({...input.runs.at(-1),uid:"32k-refused",machine:"m4",fit:false,target_prompt_tokens:32000});
  const contextFit=C.estimateSpeed(input);
  assert.equal(contextFit.fit,false);
  assert.equal(contextFit.workloads.agent.fit,true);
  assert.equal(contextFit.workloads.agent.seconds,437.5);
});

test("speed split models explicit compatible cache transfer on each link", () => {
  const input = { reader: { tok_s: 200 }, writer: { tok_s: 40 }, cache: { compatible: true, format: "test-cache-v1", bytes: 1e9 } };
  for (const [link, transfer] of [[{kind:"2.5GbE"},4],[{kind:"10GbE"},1],[{kind:"Wi-Fi",effective_gbps:1},10]]) {
    const result = C.splitEstimate({ ...input, link });
    assert.equal(result.transfer_seconds, transfer);
    assert.equal(result.seconds, (40 + 3.75 + transfer) * 10);
    assert.equal(result.measured, false);
  }
  for (const change of [{cache:{}},{cache:{compatible:false,bytes:1e9,format:"test"}},{link:{kind:"Wi-Fi"}},{reader:{tok_s:null}}])
    assert.equal(C.splitEstimate({ ...input, link:{kind:"10GbE"}, ...change }).seconds, null);
  assert.equal(C.splitEstimate({ ...input, link:{kind:"10GbE"},
    reader:{tok_s:200,conditions:{model:"same",tokenizer:"Qwen3",precision:"q4"}},
    writer:{tok_s:40,conditions:{model:"same",tokenizer:"Qwen3",precision:"fp4"}} }).seconds, null);
});
