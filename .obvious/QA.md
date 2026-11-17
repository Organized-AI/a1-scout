# QA guide — a1-scout

A PR is proven when all of these hold:

1. `node --test tests/*.test.mjs` passes. Paste the summary line (tests, pass, fail) into the PR.
2. If the PR touches `agent/`, `python3 -m unittest discover -s tests -v` passes too.
3. The new test fails on `main` without the change (say so in the PR, or explain why it is a test-only item).
4. No secret, token, email address or Tailscale device name appears in the diff, the tests or the PR text.
5. Every `/api/*` route except `/api/health` still returns 401 without credentials. `tests/worker_private.test.mjs` covers this; it must stay green.

## Smoke-testing `/mcp` locally (MCP PRs only)

Create `.dev.vars` (never committed) with throwaway values:

```
SCOUT_TOKEN=dev-scout-token
MCP_TOKEN=dev-mcp-token
```

Then run `npx wrangler dev` and:

```bash
curl -s localhost:8787/mcp -H "authorization: Bearer dev-mcp-token" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"qa","version":"0"}}}'
curl -s localhost:8787/mcp -H "authorization: Bearer dev-mcp-token" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -s -o /dev/null -w "%{http_code}\n" localhost:8787/api/state -H "authorization: Bearer dev-mcp-token"   # must print 401
```

If `wrangler dev` cannot start in the sandbox, say so in the PR and rely on the `node --test` suite.
