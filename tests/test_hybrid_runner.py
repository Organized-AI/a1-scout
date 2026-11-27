"""Full hybrid experiment sweeps through fake cloud/local models only."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
import bench as B
import hybrid_runner as H


def schema_value(schema):
    if "const" in schema:
        return schema["const"]
    if "enum" in schema:
        return schema["enum"][0]
    kind = schema.get("type")
    if kind == "object":
        return {key: schema_value(value) for key, value in schema.get("properties", {}).items() if key in schema.get("required", [])}
    if kind == "array":
        return [schema_value(schema.get("items", {})) for _ in range(schema.get("minItems", 0))]
    if kind in ("number", "integer"):
        return schema.get("minimum", 0)
    if kind == "boolean":
        return True
    pattern=schema.get("pattern","")
    value="2026-11-03" if pattern==r"^\d{4}-\d{2}-\d{2}$" else "def synthetic(): pass\nRisk: synthetic fixture. " if pattern else "synthetic"
    return value + "x" * max(0,schema.get("minLength",0)-len(value))


def gold_output(task):
    if task["type"] == "exact":
        value = task["answer"]
        return value[0] if isinstance(value, list) else value
    result = schema_value(task["schema"])
    for path, value in task.get("expect", {}).items():
        keys = path.split(".")
        obj = result
        for key in keys[:-1]:
            obj = obj[int(key)] if isinstance(obj, list) else obj[key]
        if isinstance(obj, list):
            obj[int(keys[-1])] = value
        else:
            obj[keys[-1]] = value
    return json.dumps(result)


PUBLIC = {"version":1,"goal":"public goal","excerpts":["approved public fact"],"constraints":["JSON only"],"output_spec":"public JSON"}


class HybridRunner(unittest.TestCase):
    def task(self):
        return {"id":"synthetic", "suite":"html-json", "type":"exact", "answer":"correct", "prompt":"Client SECRET-CONTEXT and approved public fact", "approved_public_context":copy.deepcopy(PUBLIC)}

    def clients(self, task, *, mutate=None):
        calls=[]
        gold=gold_output(task)
        approved=task.get("approved_public_context",PUBLIC)
        def client(where):
            def call(**kwargs):
                calls.append({"where":where,**copy.deepcopy(kwargs)})
                role=kwargs["role"]
                output=json.dumps(approved) if role=="brief" else "use the brief" if role=="review" else gold
                result={"output":output,"usage":{"prompt_tokens":5000,"completion_tokens":50},"latency_ms":100 if where=="cloud" else 1000,
                        "cloud_cost":.1 if where=="cloud" else 0,"gateway_log_id":"fake-log" if where=="cloud" else None}
                if mutate:mutate(where,kwargs,result)
                return result
            return call
        return client("cloud"),client("local"),calls

    def sweep(self, task=None, **kwargs):
        task=task or self.task()
        cloud,local,calls=self.clients(task,mutate=kwargs.pop("mutate",None))
        rows=H.run_sweep([task],cloud,local,reader_model="cloud-reader",writer_model="mac-writer",**kwargs)
        return rows,calls

    def test_each_bank_task_runs_all_five_variants_across_eighteen_cells(self):
        tasks=H.load_tasks()
        self.assertEqual({t["suite"] for t in tasks},{"html-json","long-write"})
        count=0
        for task in tasks:
            with self.subTest(task=task["id"]):
                self.assertEqual(task["context_tokens"],8000)
                self.assertGreater(len(task["prompt"]),20000)
                cloud,local,calls=self.clients(task)
                rows=H.run_sweep([task],cloud,local,reader_model="cloud",writer_model="local")
                self.assertEqual(len(rows),90)
                self.assertEqual({(r["output_tokens"],r["brief_budget"],r["turn"],r["variant"]) for r in rows},
                                 {(o,b,t,v) for o in (150,1000,4000) for b in (250,500,1000) for t in (1,2) for v in H.VARIANTS})
                for row in rows:
                    self.assertIsNone(row["error"],row)
                    self.assertTrue(row["quality_pass"],row["why"])
                    self.assertEqual(row["score"],B.score(task,row["output"])[1])
                    self.assertEqual(row["output_budget"],row["output_token_cap"])
                    self.assertEqual(row["reply_tokens"],50)
                    self.assertTrue(row["bank"])
                    self.assertEqual(row["cloud_cost"],sum(c["cloud_cost"] for c in row["calls"]))
                    self.assertEqual(row["time_ms"],sum(c["latency_ms"] for c in row["calls"]))
                count+=len(rows)
        self.assertGreater(count,0)
        print(f"Fake hybrid sweep verified {len(tasks)} tasks / {count} variant rows")

    def test_pass_rule_is_strict_paired_and_unknown_cost_never_passes(self):
        cell={"task_id":"t","suite":"html-json","bank":"b1","reader_model":"cloud","writer_model":"local","output_tokens":1000,"brief_budget":250,"turn":1}
        cloud={**cell,"cloud_cost":1,"time_ms":100,"score":1}
        local={**cell,"cloud_cost":0,"time_ms":1000,"score":1}
        hybrid={**cell,"cloud_cost":.5,"time_ms":500,"score":.98}
        self.assertTrue(H.evaluate(hybrid,cloud,local))
        for change in ({"cloud_cost":1},{"time_ms":1000},{"score":.979},{"cloud_cost":None},{"cloud_cost":float("nan")},
                       {"cloud_cost":float("inf")},{"time_ms":None},{"error":"failed"},{"turn":2},{"bank":"b2"},{"reader_model":"other"},{"writer_model":"other"}):
            self.assertFalse(H.evaluate({**hybrid,**change},cloud,local),change)

    def test_brief_schema_and_server_token_budget_are_required(self):
        self.assertEqual(H.validate_brief(json.dumps(PUBLIC),{"completion_tokens":250},250),PUBLIC)
        for tokens in (None,True,0,251,"250"):
            with self.subTest(tokens=tokens),self.assertRaises(ValueError):
                H.validate_brief(json.dumps(PUBLIC),{"completion_tokens":tokens},250)
        for change in ({"version":True},{"version":2},{"extra":"secret"},{"goal":""},{"constraints":"not a list"},{"excerpts":[1]}):
            with self.subTest(change=change),self.assertRaises(ValueError):
                H.validate_brief(json.dumps({**PUBLIC,**change}),{"completion_tokens":50},250)
        for change in ({"version":True},{"constraints":"JSON only"},{"excerpts":[1]}):
            with self.subTest(approved=change),self.assertRaises(ValueError):
                H.validate_brief(json.dumps(PUBLIC),{"completion_tokens":50},250,{**PUBLIC,**change})

    def test_review_and_failed_cloud_calls_keep_real_costs_and_missing_cost_is_unknown(self):
        rows,_=self.sweep(outputs=(1000,),briefs=(250,),turns=(1,))
        review=next(r for r in rows if r["variant"]=="hybrid-review")
        self.assertAlmostEqual(review["cloud_cost"],.2)
        self.assertEqual([c["role"] for c in review["calls"]],["brief","write","review","revise"])
        def fail(where,kwargs,result):
            if where=="cloud" and kwargs["role"]=="review":result.update(error="paid failed call",cloud_cost=.3)
        rows,_=self.sweep(outputs=(1000,),briefs=(250,),turns=(1,),mutate=fail)
        review=next(r for r in rows if r["variant"]=="hybrid-review")
        self.assertAlmostEqual(review["cloud_cost"],.4)
        self.assertIsNotNone(review["error"])
        self.assertFalse(review["pass"])
        for invalid in (None,float("nan"),float("inf")):
            def missing(where,kwargs,result):
                if where=="cloud":result["cloud_cost"]=invalid
            rows,_=self.sweep(outputs=(1000,),briefs=(250,),turns=(1,),mutate=missing)
            self.assertTrue(all(r["cloud_cost"] is None for r in rows if r["variant"]!="all-local"))
            self.assertTrue(all(r["pass"] is False for r in rows if r["variant"] in H.VARIANTS[2:]))

    def test_turn_two_has_only_its_own_prior_role_history(self):
        _,calls=self.sweep(outputs=(150,1000),briefs=(250,500),turns=(1,2))
        lengths=[len(c["messages"]) for c in calls]
        self.assertEqual(set(lengths),{1,3})
        self.assertEqual(lengths.count(1),lengths.count(3))
        for call in calls:
            if len(call["messages"])==3:
                self.assertEqual([m["role"] for m in call["messages"]],["user","assistant","user"])
                if call["role"]=="brief":self.assertIn('"version"',call["messages"][1]["content"])
                if call["role"]=="review":self.assertEqual(call["messages"][1]["content"],"use the brief")

    def test_private_hybrid_removes_client_context_from_all_cloud_turns(self):
        rows,calls=self.sweep(outputs=(1000,),briefs=(250,),turns=(1,2))
        private=[r for r in rows if r["variant"]=="private-hybrid"]
        self.assertTrue(all(r["error"] is None for r in private))
        cloud_writes=[c for c in calls if c["where"]=="cloud" and c["role"]=="write"]
        self.assertEqual(len(cloud_writes),2)
        self.assertNotIn("SECRET-CONTEXT",json.dumps(cloud_writes))
        self.assertIn("approved public fact",json.dumps(cloud_writes))

    def test_private_brief_rejects_secret_in_every_field_before_cloud_write(self):
        for change in ({"goal":"SECRET-CONTEXT"},{"output_spec":"SECRET-CONTEXT"},{"constraints":["SECRET-CONTEXT"]},
                       {"excerpts":["SECRET-CONTEXT"]},{"secret":"SECRET-CONTEXT"}):
            def mutate(where,kwargs,result):
                if where=="local" and kwargs["role"]=="brief":result["output"]=json.dumps({**PUBLIC,**change})
            rows,calls=self.sweep(outputs=(1000,),briefs=(250,),turns=(1,2),mutate=mutate)
            with self.subTest(change=change):
                self.assertTrue(all(r["error"] for r in rows if r["variant"]=="private-hybrid"))
                self.assertFalse(any(c["where"]=="cloud" and c["role"]=="write" for c in calls))
        task=self.task();task.pop("approved_public_context")
        rows,calls=self.sweep(task,outputs=(1000,),briefs=(250,),turns=(1,))
        self.assertTrue(next(r for r in rows if r["variant"]=="private-hybrid")["error"])

    def test_cli_defaults_to_dry_run_and_local_preflight_prevents_paid_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            A=SimpleNamespace(STATE_DIR=Path(tmp),ENV={"BENCH_MACHINE":"fake","HYBRID_GATEWAY_URL":"fake","HYBRID_PROVIDER_KEY":"fake","HYBRID_GATEWAY_TOKEN":"fake","HYBRID_LOGS_TOKEN":"fake"})
            with mock.patch.object(H,"GatewayClient") as gateway:
                self.assertTrue(H.main([],A)["dry_run"])
                gateway.assert_not_called()
                with mock.patch.object(H.bench,"resolve_model",return_value=Path(tmp)/"fake-model"),mock.patch.object(H.speed_runner,"memory_guard",return_value="insufficient RAM"),mock.patch.object(H.speed_runner,"free_ram_bytes",return_value=1):
                    result=H.main(["--authorized-sweep","--reader-model","fake-reader","--model","fake-model"],A)
                gateway.return_value.assert_not_called()
                self.assertFalse(result[0]["fit"])
                self.assertEqual(result[0]["cloud_cost"],0)
                self.assertEqual(len(list((Path(tmp)/"bench/hybrid").glob("*.json"))),1)

        # An HTTP refusal is propagated without leaving its response open.
        import io
        import urllib.error
        body = io.BytesIO(b'memory guard')
        refusal = urllib.error.HTTPError('http://fake/v1/chat/completions', 507, 'guard', {}, body)
        client = H.LocalClient('http://fake/v1', '/fake/model', opener=mock.Mock(side_effect=refusal))
        with mock.patch.object(H.speed_runner, 'memory_guard', return_value=None), mock.patch.object(H.speed_runner, 'free_ram_bytes', return_value=1):
            with self.assertRaises(urllib.error.HTTPError):
                client(model='fake', messages=[], max_tokens=1, role='write')
        self.assertTrue(body.closed)


if __name__=="__main__":
    unittest.main()
