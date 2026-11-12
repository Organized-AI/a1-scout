# Phone verification screenshots

Captured November 11, 2026 using Playwright WebKit with `devices["iPhone 15"]`
against local `wrangler dev`. All data is synthetic. Images are full-page captures,
resized to 393px wide for review; `26-375px.webp` was captured at 375px.
No production data, sign-in codes, tokens or remote screenshots are committed.

Run again with the external Playwright installation and local test token:

```sh
PHONE_TEST_TOKEN=phone-local-test-only \
PLAYWRIGHT_MODULE=/tmp/a1-phone-browser/node_modules/playwright \
node tests/phone.e2e.mjs
```

The script refuses non-local targets and creates local D1 fixtures. It verifies
single-use link sign-in, simulated standalone mode, no horizontal overflow,
visible controls at least 44px high, and no JavaScript page errors.
Worker cache cleanup and network-only behavior are tested separately in
`tests/phone_shell.test.mjs`; browser routing blocks service workers so mock
requests cannot reach upstream services.

| Coverage | Screenshots |
|---|---|
| A1, run request, drive request | [01](01-home.webp), [02](02-run-request.webp), [03](03-drive-request.webp) |
| Picks, paging, approve, skip, stash queue, kind filter | [04](04-picks.webp), [05](05-picks-paged.webp), [06](06-pick-approved.webp), [07](07-pick-skipped.webp), [08](08-pick-stash-queued.webp), [09](09-picks-kind-filter.webp) |
| Coding/Desktop group, sync, collection | [10](10-coding-desktop.webp), [11](11-coding-sync.webp), [12](12-coding-connect.webp) |
| Catalog search, add-pick UI | [13](13-catalog.webp), [14](14-catalog-add-ui-fixture.webp) |
| Notes create, edit, delete | [15](15-notes-saved.webp), [16](16-notes-edited.webp), [17](17-notes-deleted.webp) |
| Jobs, battle, vote | [18](18-jobs.webp), [19](19-battle.webp), [20](20-battle-voted.webp) |
| More, scan UI, license check/decision, lesson quiz, narrow viewport | [21](21-more.webp), [22](22-scan-ui-fixture.webp), [23](23-license-check.webp), [24](24-license-decision.webp), [25](25-lesson-quiz.webp), [26](26-375px.webp) |

Add-pick and scan success responses are mocked UI fixtures, not claims of
upstream discovery or physical-agent execution. License/run/drive actions
verify queued requests only, not a physical Mac completing them.
Physical iPhone installation, camera QR scanning, and Mac execution remain
post-merge checks. The desktop QR widget was separately generated and its link
redeemed in local WebKit; no external QR service is used.
