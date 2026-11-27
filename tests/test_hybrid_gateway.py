"""Dedicated AI Gateway transport and authoritative cost lookup, entirely fake."""
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error
import urllib.request
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"agent"))
import hybrid_gateway as G

URL="https://gateway.ai.cloudflare.com/v1/account/a1-scout-bench/openai/chat/completions"


class Response:
    def __init__(self,data,headers=None):
        self.raw=json.dumps(data).encode();self.headers=headers or {}
    def read(self,n=-1):return self.raw[:n] if n>=0 else self.raw
    def __enter__(self):return self
    def __exit__(self,*args):pass


class HybridGateway(unittest.TestCase):
    def client(self,opener,clock=None,url=URL):
        return G.GatewayClient(url,provider_key="fake-provider-key",gateway_token="fake-gateway-key",logs_token="fake-logs-key",opener=opener,**({"clock":clock} if clock else {}))

    def test_dedicated_gateway_headers_cost_log_and_no_secret_retention(self):
        calls=[]
        def open_(req,**kwargs):
            calls.append(req)
            if req.get_method()=="POST":return Response({"choices":[{"message":{"content":"synthetic output"}}],"usage":{"prompt_tokens":100,"completion_tokens":20}}, {"cf-aig-log-id":"log-123"})
            return Response({"success":True,"result":{"cost":.0123}})
        clock=iter((0,2))
        result=self.client(open_,lambda:next(clock))(model="fake",messages=[{"role":"user","content":"synthetic"}],max_tokens=20,role="brief")
        self.assertEqual(result["cloud_cost"],.0123)
        self.assertEqual(result["latency_ms"],2000)
        self.assertEqual(result["gateway_log_id"],"log-123")
        self.assertEqual(calls[0].full_url,URL)
        headers={k.lower():v for k,v in calls[0].header_items()}
        self.assertEqual(headers["authorization"],"Bearer fake-provider-key")
        self.assertEqual(headers["cf-aig-authorization"],"Bearer fake-gateway-key")
        self.assertEqual(headers["cf-aig-collect-log-payload"],"false")
        self.assertEqual(headers["cf-aig-collect-log"],"true")
        self.assertEqual(calls[1].full_url,"https://api.cloudflare.com/client/v4/accounts/account/ai-gateway/gateways/a1-scout-bench/logs/log-123")
        self.assertEqual(calls[1].get_header("Authorization"),"Bearer fake-logs-key")
        self.assertNotIn("fake-provider-key",json.dumps(result))
        self.assertNotIn("fake-gateway-key",json.dumps(result))
        self.assertNotIn("fake-logs-key",json.dumps(result))

    def test_unavailable_nonfinite_and_missing_log_cost_remain_unknown(self):
        for value in (None,-1,"0.1",True,float("nan"),float("inf")):
            def open_(req,**kwargs):
                if req.get_method()=="POST":return Response({"choices":[{"message":{"content":"ok"}}]}, {"cf-aig-log-id":"log1"})
                return Response({"success":True,"result":{"cost":value}})
            with self.subTest(value=value):
                self.assertIsNone(self.client(open_)(model="m",messages=[],max_tokens=1,role="answer")["cloud_cost"])
        calls=[]
        def no_log(req,**kwargs):
            calls.append(req)
            return Response({"choices":[{"message":{"content":"ok"}}]})
        self.assertIsNone(self.client(no_log)(model="m",messages=[],max_tokens=1,role="answer")["cloud_cost"])
        self.assertEqual(len(calls),1)

    def test_paid_failed_http_call_keeps_gateway_cost(self):
        def open_(req,**kwargs):
            if req.get_method()=="POST":raise urllib.error.HTTPError(URL,429,"rate limited",{"cf-aig-log-id":"failed-log"},io.BytesIO(b"secret-body"))
            return Response({"success":True,"result":{"cost":.05}})
        result=self.client(open_)(model="m",messages=[],max_tokens=1,role="answer")
        self.assertEqual(result["cloud_cost"],.05)
        self.assertEqual(result["error"],"cloud HTTP 429")
        self.assertNotIn("secret-body",json.dumps(result))

    def test_untrusted_urls_refused_and_default_transport_disables_redirects(self):
        for url in ("http://gateway.ai.cloudflare.com/v1/account/a1-scout-bench/openai/chat/completions",URL.replace("a1-scout-bench","other-app"),
                    URL.replace("gateway.ai.cloudflare.com","evil.example.com"),URL+"?token=secret",URL.replace("https://","https://user:pass@")):
            with self.subTest(url=url),self.assertRaises(ValueError):self.client(lambda *a,**k:None,url=url)
        with mock.patch.object(G.urllib.request,"build_opener",return_value=mock.Mock()) as build:
            G.GatewayClient(URL,provider_key="p",gateway_token="g",logs_token="l")
        self.assertIsInstance(build.call_args.args[0],G.NoRedirect)
        self.assertIsNone(G.NoRedirect().redirect_request(None,None,302,"redirect",{},"https://evil.example.com"))

    def test_malformed_gateway_json_is_error_not_uncaught_exception(self):
        for data in ([],None,{"choices":[]},{"choices":[{"message":{"content":42}}]}):
            with self.subTest(data=data):
                result=self.client(lambda *a,**k:Response(data))(model="m",messages=[],max_tokens=1,role="answer")
                self.assertTrue(result["error"])
                self.assertIsNone(result["cloud_cost"])


if __name__=="__main__":unittest.main()
