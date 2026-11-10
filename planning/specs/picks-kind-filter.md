# Scout picks: filter by asset type

The Picks list on the Scout tab filters by status only, and it filters in the browser from one capped
list. Add an asset-type filter (models, datasets, Spaces, papers, collections, code) that works together
with the status tabs, with exact counts on every chip, so models, datasets and Spaces can be reviewed on
their own without the row cap hiding anything.

Agents: `.claude/agents/impl-agent.md` (implement a phase), `test-agent.md` (write and run tests),
`verify-build.md` (here: a clean checkout, the test suites and a `wrangler dev` boot; there is no build step).

## What is there today (main @ d91fea0)
- `picks.kind` is `model | dataset | space | paper | collection | code` (`code` comes from `addCodePick`).
- `GET /api/picks` (`src/index.js`, the `p === "/api/picks"` route) takes `?status=` only and caps at
  300 rows with a status, 400 without. The dashboard (`public/index.html` `load()`) fetches the 400-row
  all-status list once and `scoutView()` filters it by status in the browser. With 625 new picks the New tab
  cannot show them all, and after every approve or skip `act()` recomputes the tab counts from that capped array.
- The Mac agent reads `GET /api/picks`, `GET /api/picks?status=approved` and
  `GET /api/picks?status=approved&include_ok=1` (`agent/agent.py`). Those three responses must not change.
- The global `picks` array (all statuses) also feeds the Bench tab's Lab (`lab.js` takes paper suggestions
  from it). It stays as it is; the Scout list gets its own array.

## Non-goals
- No change to who can approve, to `AUTO_APPROVE`, or to `POST /api/picks/status`. No new status writes.
- No schema change, migration or index. No `package.json`, no dependencies. No change under `agent/`.
- No deploy, no `wrangler d1 execute --remote`, no secrets in code, tests or docs.

## Phases

### P1 · API (`src/index.js`)
Constants next to the other top-level constants:
`PICK_KINDS = ["model","dataset","space","paper","collection","code"]`, `PICKS_MAX_LIMIT = 1000`.

`GET /api/picks?status=&kind=&limit=&offset=&include_ok=` (one route, one query builder):
- `status`: absent, empty or `all` = no status filter. Any other value filters `status=?` as today.
- `kind`: absent, empty or `all` = no kind filter. One of `PICK_KINDS` filters `kind=?`.
  Anything else returns 400 `{ error: "kind must be one of model|dataset|space|paper|collection|code" }`
  (a typo like `kind=models` must not return a silently empty list).
- `limit`: absent = the old caps (300 with a status filter, 400 without). Present = an integer 1..1000,
  otherwise 400 `{ error: "limit must be 1-1000" }`.
- `offset`: absent = 0. Present = an integer >= 0, otherwise 400 `{ error: "offset must be 0 or more" }`.
- Order: with a status filter `score DESC`; without one, the existing status priority
  (approved, new, stashed, then the rest) then `score DESC`. Append `, id` as a tiebreaker so pages never
  overlap or skip rows.
- `include_ok`: unchanged. With `status=approved` and no `include_ok=1`, picks whose `extra.include` is set
  are held back, with or without `kind`.
- The response stays a JSON array of shaped picks (`shapePick`). Bind every value; never interpolate input into SQL.

`GET /api/picks/counts` (behind `signedIn()` like every `/api/*` route but `/api/health`):
one `SELECT status, kind, COUNT(*) n FROM picks GROUP BY status, kind`, returned as
```json
{ "total": 1000,
  "by_status": { "new": 625, "approved": 9, "stashed": 300, "skipped": 66 },
  "by_kind": { "model": 400, "dataset": 280, "space": 150, "paper": 120, "collection": 48, "code": 2 },
  "by_status_kind": { "new": { "model": 210, "dataset": 160, "space": 120, "paper": 90, "collection": 45 } } }
```
Raw counts of every row (no `include_ok` hold-back); zero combinations are simply absent.

- K1 · `?kind=model` → only models, every status, status priority then score.
- K2 · `?status=new&kind=dataset` → only new datasets, score desc.
- K3 · 625 new picks, 350 of them models: `?status=new&kind=model&limit=1000` returns all 350 and
  `?status=new&limit=1000` returns all 625 (the old 300 cap would cut both).
- K4 · Unchanged for the agent: `?status=new` caps at 300; no params caps at 400 in status priority;
  `?status=approved` holds back include-list picks and `&include_ok=1` returns them; the same with `&kind=model`.
- K5 · `limit=500&offset=0` then `limit=500&offset=500` → 625 distinct ids in score order, nothing missing.
- K6 · `kind=models`, `limit=0`, `limit=1001`, `limit=abc`, `offset=-1` → 400. `kind=all` and `status=all` → no filter.
- K7 · `/api/picks/counts` → exact numbers per status x kind; each status's kinds sum to `by_status`,
  `by_kind` sums across statuses, `total` = rows in the table; an empty table gives
  `{ total: 0, by_status: {}, by_kind: {}, by_status_kind: {} }`.
- K8 · `/api/picks/counts` and `/api/picks?kind=model` return 401 without credentials or with a wrong token.

### P2 · Dashboard (`public/index.html`)
State: keep `filter` (status, default `new`); add `kindFilter` (default `all`), `scoutPicks` (the server list
for the current selection), `pickCounts` (last `/api/picks/counts`), and a request sequence number.
Keep `picks` and the existing `call("/api/picks")` in `load()` for the Bench/Lab views.

- D1 · Under the status tabs, a TYPE chip row: `all types`, `models`, `datasets`, `spaces`, `papers`,
  `collections`, and `code` only when `pickCounts.by_kind.code > 0` (or it is the selected type).
  Each chip is a `<button type="button" aria-pressed>` in a `role="group" aria-label="Asset type"` container and
  shows its count for the selected status: status `all` uses `by_kind` (and `total` for all types), any other
  status uses `by_status_kind[status]` (and `by_status[status]` for all types). Zero-count chips stay clickable
  but are dimmed. Use a class other than `.tab` for the chips (`wireScout` wires `.tabs .tab` as status tabs).
  Styling follows the existing tokens (`--chip`, `--line`, `--accent`, IBM Plex Mono), a step smaller than the status tabs.
- D2 · Changing status or type fetches from the server with both params:
  `/api/picks?status=<s>&kind=<k>&include_ok=1&limit=1000&offset=0`, leaving out `status` for `all` and `kind`
  for all types, together with `/api/picks/counts`. `include_ok=1` because the dashboard must show every approved
  pick (the hold-back exists for older agents) and so lists match counts. Responses for a superseded selection
  are dropped (sequence number), so fast clicking never shows a stale list.
- D3 · Never a silent undercount: when the rows loaded are fewer than the chip count for the selection, the list
  ends with "Showing X of Y" and a "Show N more" button that fetches the next page (`offset` = rows loaded) and
  appends it. A list response that is not an array (a 400) shows its error in `#list` instead of an empty list.
- D4 · Status-tab counts, the stats row and the nav's `Scout · N` come from `pickCounts.by_status` whenever
  counts are refreshed (set `state.counts` from it); the `picks.reduce(...)` recount in `act()` goes away.
- D5 · URL sync with `history.replaceState` (no history entries): on the Scout view the URL carries
  `?status=<s>` and `&kind=<k>` (no `kind` for all types), e.g. `?status=new&kind=model`; on Map or Bench both
  params are removed; other params and the hash are kept. On load, a valid `status` or `kind` in the URL
  restores the selection and opens the Scout view; invalid values are ignored.
- D6 · GSAP, matching `public/bench.js`: every tween behind `!RM()` (reduced motion gets the end state with no
  animation), `clearProps: "transform,opacity"` on entrances. Type chips pop in on the Scout view's first render
  (scale .7 → 1, stagger .035, `back.out(2)`); the pressed chip or tab pulses (`scale` 1 → 1.06, yoyo, like
  bench.js's vote pulse); chip counts tween from the old number to the new one; the list fades to ~.3 opacity
  while loading, then the new rows rise in (y 12 → 0, opacity, stagger, `power2.out`). Animate at most the first
  24 rows of a list or of an appended page, everywhere `.pick` entrances run, so 600+ rows stay cheap.
- D7 · Changing the selection updates the picks section in place (tabs' and chips' `aria-pressed`, chip counts,
  `#list`) rather than re-rendering the whole page; list wiring (approve/skip buttons, opening a pick's card,
  Show more) is re-applied after every list swap.

### P3 · Collections
Keep the server behavior: approving a collection calls `expandCollection`, which queues its items as `new`
picks and marks the collection `stashed`.
- C1 · In `act()`, when the response has an `expanded` field (check with `"expanded" in r`; zero items is
  still an expansion), refresh `picks` as today, then refetch the current list and the counts, then render.
- C2 · Any other action updates the row locally (dropping it from the list when it no longer matches the
  status filter) and refetches the counts, so the tabs and chips stay exact.
- C3 (API) · After approving a collection with a model, a dataset and a Space in it, `/api/picks/counts`
  shows those three under `new`, the collection under `stashed`, and `?status=new&kind=model` lists the model.

### P4 · Tests (`tests/worker_picks_kind.test.mjs`)
Follow `tests/worker_code_picks.test.mjs` (header comment with the run command, `node:test`,
`node:assert/strict`, `worker.fetch` with `Bearer t`), with D1 as the `node:sqlite` shim from
`tests/worker_bench.test.mjs` loaded with `schema.sql`, so the real SQL runs. One test per K1-K8 and C3;
Hugging Face calls in C3 are stubbed through `globalThis.fetch` and restored.
Verify: `node --test tests/*.test.mjs` and `python3 -m unittest discover -s tests -v` both green; the new file
fails on main without P1.
