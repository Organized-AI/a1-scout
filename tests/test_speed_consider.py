"""Speed Consider calculations agree across Python and shared JavaScript."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
import speed_consider as C


class SpeedConsiderParity(unittest.TestCase):
    def test_python_javascript_fixture_parity_and_expected_workload_results(self):
        fixture = json.loads((ROOT / "tests/fixtures/speed_consider_parity.json").read_text())
        script = """
require('./public/speed-core.js');let s='';
process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{
 const f=JSON.parse(s);console.log(JSON.stringify(f.cases.map(c=>globalThis.SpeedCore.estimateSpeed(c.input))));
});
"""
        run = subprocess.run(["node", "-e", script], cwd=ROOT, input=json.dumps(fixture), text=True, capture_output=True, check=True)
        js = json.loads(run.stdout)
        for case, expected_js in zip(fixture["cases"], js):
            with self.subTest(case=case["id"]):
                result = C.estimate_speed(**case["input"])
                self.assertEqual(result, expected_js)
                agent = result["workloads"]["agent"]
                self.assertEqual(agent["prefill"]["tok_s"], case["expect"]["read"])
                self.assertEqual(agent["decode"]["tok_s"], case["expect"]["write"])
                self.assertEqual(agent["seconds"], case["expect"]["seconds"])
                self.assertIs(result["fit"], case["expect"]["fit"])

    def test_split_python_javascript_parity_on_three_links_and_unavailable(self):
        inputs = []
        for link in ({"kind": "2.5GbE"}, {"kind": "10GbE"}, {"kind": "Wi-Fi", "effective_gbps": 1}, {"kind": "Wi-Fi"}):
            inputs.append({"reader": {"tok_s": 200}, "writer": {"tok_s": 40}, "link": link,
                           "cache": {"compatible": True, "format": "test-cache-v1", "bytes": 1e9}})
        script = "require('./public/speed-core.js');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(x=>globalThis.SpeedCore.splitEstimate(x)))));"
        run = subprocess.run(["node", "-e", script], cwd=ROOT, input=json.dumps(inputs), text=True, capture_output=True, check=True)
        self.assertEqual([C.split_estimate(i) for i in inputs], json.loads(run.stdout))


if __name__ == "__main__":
    unittest.main()
