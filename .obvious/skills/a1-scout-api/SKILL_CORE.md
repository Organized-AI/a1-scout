## Invariants

- Every `/api/*` route except `/api/health` stays behind `signedIn()`.
- Only a human sets a pick to `approved` (outside the existing `AUTO_APPROVE` path). Approval triggers a real download on the Mac.
- No secret in code, tests, logs or PR text. No deploys.

## Key commands

| Task | Command |
|---|---|
| Worker tests | `node --test tests/*.test.mjs` |
| Mac agent tests | `python3 -m unittest discover -s tests -v` |
| Local Worker | `npx wrangler dev` (throwaway `.dev.vars`) |
