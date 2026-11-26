"""Dedicated a1-scout-bench Gateway access; credentials are supplied in memory.

Cost is read from the gateway log, never inferred from an unversioned price list.
No request/response payload logging; metadata logging remains on for cost lookup.
"""
import json
import math
import re
import time
import urllib.error
import urllib.parse
import urllib.request

GATEWAY = "a1-scout-bench"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


class GatewayClient:
    def __init__(self, url, *, provider_key, gateway_token, logs_token, opener=None, clock=time.perf_counter):
        parsed = urllib.parse.urlsplit(url)
        parts = parsed.path.strip("/").split("/")
        if (parsed.scheme != "https" or parsed.hostname != "gateway.ai.cloudflare.com" or parsed.port is not None
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or len(parts) < 5 or parts[0] != "v1" or parts[2] != GATEWAY
                or parts[-2:] != ["chat", "completions"] or not all(re.fullmatch(r"[\w-]+", p) for p in parts)):
            raise ValueError("cloud URL must use the dedicated a1-scout-bench Cloudflare Gateway")
        if not all(isinstance(k, str) and k for k in (provider_key, gateway_token, logs_token)):
            raise ValueError("provider, gateway and log credentials required outside the repo")
        self.url, self.account = url, parts[1]
        self.provider_key, self.gateway_token, self.logs_token = provider_key, gateway_token, logs_token
        self.opener = opener or urllib.request.build_opener(NoRedirect()).open
        self.clock = clock

    def cost(self, log_id):
        if not isinstance(log_id, str) or not re.fullmatch(r"[\w-]{1,200}", log_id):
            return None
        url = f"https://api.cloudflare.com/client/v4/accounts/{self.account}/ai-gateway/gateways/{GATEWAY}/logs/{log_id}"
        request = urllib.request.Request(url, headers={"authorization": "Bearer " + self.logs_token})
        try:
            with self.opener(request, timeout=15) as response:
                data = json.loads(response.read(1_000_000))
            value = (data.get("result") or {}).get("cost")
            return value if data.get("success") is not False and number(value) else None
        except urllib.error.HTTPError as exc:
            exc.close()
            return None
        except (OSError, ValueError, AttributeError):
            return None

    def __call__(self, *, model, messages, max_tokens, role):
        body = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": 0, "stream": False}
        request = urllib.request.Request(self.url, data=json.dumps(body).encode(), method="POST", headers={
            "content-type": "application/json", "authorization": "Bearer " + self.provider_key,
            "cf-aig-authorization": "Bearer " + self.gateway_token,
            "cf-aig-collect-log": "true", "cf-aig-collect-log-payload": "false"})
        started, log_id, error, data = self.clock(), None, None, {}
        try:
            with self.opener(request, timeout=180) as response:
                log_id = response.headers.get("cf-aig-log-id")
                raw = response.read(8_000_001)
                if len(raw) > 8_000_000:
                    raise ValueError("response too large")
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise ValueError("response object required")
        except urllib.error.HTTPError as exc:
            log_id = exc.headers.get("cf-aig-log-id") if exc.headers else None
            error = f"cloud HTTP {exc.code}"
            exc.close()
        except (OSError, ValueError) as exc:
            error = f"cloud request failed ({type(exc).__name__})"
            data = {}
        latency = (self.clock() - started) * 1000
        cost = self.cost(log_id)
        try:
            output = data["choices"][0]["message"]["content"]
            if not isinstance(output, str):
                raise ValueError("text required")
        except (KeyError, IndexError, TypeError, ValueError):
            output = ""
            error = error or "cloud response missing text"
        return {"output": output, "usage": data.get("usage") or {}, "latency_ms": latency,
                "cloud_cost": cost, "gateway_log_id": log_id, "gateway": GATEWAY, "error": error,
                "timing_basis": "inference wall time; cost-log lookup excluded"}
