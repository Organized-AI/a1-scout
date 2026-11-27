// The shared Considering-a-Mac math (public/consider-core.js), used by the browser and by POST /api/bench/consider.
//   cd ~/nvme-stash/a1-scout && node --test tests/consider_core.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = f => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const ctx = vm.createContext({});
vm.runInContext(read("public/consider-core.js"), ctx);
const C = ctx.ConsiderCore;
const fixture = JSON.parse(read("tests/fixtures/machine_id_parity.json"));

test("machine_id matches agent/bench.py for every fixture case", () => {
  for (const c of fixture.cases) {
    assert.equal(C.machineId({ chip: c.chip, variant: c.variant, memory_gb: c.memory_gb }), c.machine_id, `${c.brand} ${c.memory_gb}GB`);
  }
});

test("the Lab's Macs read Apple's spec bandwidth; M6 depends on memory", () => {
  assert.equal(C.bandwidthForMachine("m1").gbs, 200);      // M1 Pro 16GB
  assert.equal(C.bandwidthForMachine("m4").gbs, 120);
  assert.equal(C.bandwidthForMachine("m6").gbs, 170);      // M6 32GB, the 24/32GB bin
  assert.equal(C.bandwidthForMachine("m5p").gbs, 307);
  assert.equal(C.bandwidthFor({ chip: "M6", memory_gb: 16 }).gbs, 153);   // the 16GB M6 is the lower bin
  assert.equal(C.bandwidthFor({ chip: "M4", variant: "Max", memory_gb: 36 }).gbs, 410);
  assert.equal(C.bandwidthFor({ chip: "M4", variant: "Max", memory_gb: 64 }).gbs, 546);
  assert.equal(C.bandwidthFor({ chip: "M4", variant: "Max", gpu_cores: 32, memory_gb: 64 }).gbs, 410);
  assert.equal(C.bandwidthFor({ chip: "M1", memory_gb: 16 }).gbs, null);   // base M1: Apple gives no figure
  assert.equal(C.bandwidthFor({ chip: "M4 Maxx", memory_gb: 64 }).gbs, null);
});

test("fit uses 75% of memory, and a speed scales by bandwidth", () => {
  const GiB = 2 ** 30;
  assert.equal(C.fitsBytes(11 * GiB, 16), true);   // budget 12 GiB
  assert.equal(C.fitsBytes(13 * GiB, 16), false);
  assert.equal(C.scaleTokS(50, 170, 120), 50 * 170 / 120);
  assert.equal(C.scaleTokS(null, 170, 120), null);
});

test("ratio thresholds: 1.25 faster, 0.8 slower, otherwise about the same", () => {
  assert.equal(C.kindOfRatio(1.25), "faster");
  assert.equal(C.kindOfRatio(0.8), "slower");
  assert.equal(C.kindOfRatio(1.0), "same");
});

test("verdict wording matches the browser's Simulate table", () => {
  const base = { candFits: true, ownedFits: true, ownedLabel: "M1 16GB" };
  assert.equal(C.verdictOf({ ...base, ratio: 2, ownedLabel: "M1 16GB" }).text, "2.0× faster than your M1 16GB");
  assert.equal(C.verdictOf({ ...base, ratio: 0.5 }).text, "2.0× slower than your M1 16GB");
  assert.equal(C.verdictOf({ ...base, ratio: 1.0 }).text, "About the same as your M1 16GB");
  assert.equal(C.verdictOf({ candFits: false, ownedFits: true }).kind, "worse");
  assert.equal(C.verdictOf({ ...base, unlocks: "Runs X, too big for your Macs" }).kind, "unlock");
  assert.equal(C.verdictOf({ candFits: true, ownedFits: false }).kind, "unlock");
});

test("the headline for a set: opens up, faster with nothing new, or little gain", () => {
  const v = (kind, x) => ({ kind, x });
  const opens = C.summaryOf([v("unlock"), v("same"), v("faster", 2)]);
  assert.equal(opens.tone, "good");
  assert.equal(opens.head, "Worth a look: it opens up 1 of 3 workflows");
  const faster = C.summaryOf([v("faster", 2), v("faster", 3), v("same")]);
  assert.equal(faster.tone, "mixed");
  assert.equal(faster.head, "Faster, nothing new: about 2.0× on 2 of 3 workflows");
  const same = C.summaryOf([v("same"), v("same"), v("same")]);
  assert.equal(same.tone, "bad");
  assert.equal(same.head, "Little gain for your workflows");
  assert.equal(C.summaryOf([]).tone, "none");
});

test("work weights come from the sessions, every suite keeps a floor, and they sum to 1", () => {
  const sessions = [{ app: "Claude Code", model: "sql-query" }, { app: "bigquery console", model: "" }, { app: "Cursor", model: "whisper-small" }];
  const w = C.weightsFor(["sql-ga4", "asr", "stape-select"], sessions);
  assert.equal(w["sql-ga4"].signals, 2);
  assert.equal(w["asr"].signals, 1);
  assert.equal(w["stape-select"].signals, 0);
  assert.ok(w["stape-select"].weight > 0);
  const sum = Object.values(w).reduce((a, x) => a + x.weight, 0);
  assert.ok(Math.abs(sum - 1) < 0.01, `sum ${sum}`);
});

test("p95 context and the KV cache must fit in what is left after the model", () => {
  const GiB = 2 ** 30;
  const ps = C.p95([1000, 2000, 3000, 50000]);
  assert.equal(ps, 50000);
  assert.equal(C.contextFits(4 * GiB, 16, 2000).fits, true);
  assert.equal(C.contextFits(10 * GiB, 16, 50000).fits, false);   // 50k tokens × 128 KB = 6.1 GiB, more than 2 GiB left
  assert.equal(C.p95([]), null);
});
