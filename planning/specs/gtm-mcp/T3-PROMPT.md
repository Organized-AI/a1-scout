# T3 Code prompts — A1 Bench GTM MCP suites

Open `/Users/supabowl/nvme-stash/a1-scout` as a project in T3 Code. One thread per phase.
With Claude Code as the provider, run with permissions skipped (`claude --dangerously-skip-permissions`) or full access;
the stash-guard hook still applies.

## P1

```text
Read planning/specs/a1-bench.md, then planning/specs/a1-bench-gtm-mcp.md. Use the agents in .claude/agents
(impl-agent to build, test-agent for tests, review-agent on the diff).

Do P1 only:
- Move planning/specs/gtm-mcp/gtm-mcp.jsonl and gtm-mcp-gate.jsonl to tests/bench/, and gtm-mcp-tools.json to
  tests/bench/fixtures/. Do not edit task content; if a check fails, report it instead.
- Register the suites, the tool_call type, MAX_TOKENS, runner_tasks prompt rendering and score_tool_call exactly as
  the spec's table says. Add ideal() for tool_call in tests/test_bench.py.
- Add the three suites to BENCH_SUITES in src/index.js and labels in public/bench.js.
- Make M1 to M6 pass. Run python3 -m unittest discover -s tests -v and node --test tests/*.test.mjs.
- Commit "bench: gtm-mcp suites (P1)". Do not deploy. Stop and report.
```

## P2

```text
Read planning/specs/a1-bench-gtm-mcp.md. Do P2 only: agent/gtm_policy.py (policy_oracle with table tests from the
gate bank golds), `agent.py bench combo gtm-mcp`, combo rows and choose_best rules, the --online jev-gateway gate.
One model loaded at a time; no network without --online. Make M7 to M10 pass, run both test suites, commit
"bench: planner x gate combos (P2)". Stop and report.
```

## P3

```text
Read planning/specs/a1-bench-gtm-mcp.md. Do P3 only: rubric variants in tests/bench/rubrics/gtm-mcp-gate/, the
--rubric flag, rubric name in the bank hash. Seed two rubrics: "v1" (the bank's questions) and "v1-terse" (same
ids, shorter instructions). Make M11 pass, run both suites, commit "bench: gate rubric lab (P3)". Stop and report.
```

## P4

```text
Read planning/specs/a1-bench-gtm-mcp.md. Do P4 only: tests/bench/make_gtm_mcp.py and `agent.py bench export
gtm-mcp`. Write the mlx_lm.lora command in the export README for the best gtm-mcp planner on this Mac. Make M12
pass, run both suites, commit "bench: gtm-mcp fine-tune export (P4)". Stop and report.
```

## P5 and P6

```text
Read planning/specs/a1-bench-gtm-mcp.md. Do P5 (dashboard) and P6 (verify): GSAP for the combo board rows and the
unsafe_allowed column, honoring reduced motion. Run both suites, review-agent pass on the diff, wrangler deploy,
commit "bench: gtm-mcp dashboard (P5-P6)". Stop and report.
```

## Running it after P1-P4

```bash
python3 agent/agent.py bench gtm-mcp              # every chat model that fits this Mac plans the 20 tasks
python3 agent/agent.py bench gtm-mcp-gate         # every decision model judges the 20 gate cases
python3 agent/agent.py bench combo gtm-mcp        # every planner x gate, offline
python3 agent/agent.py bench combo gtm-mcp --online   # adds Jev through jev-gateway
python3 agent/agent.py bench gtm-mcp-gate --rubric v1-terse   # rubric experiment
python3 agent/agent.py bench export gtm-mcp --format mlx-lora --from both
```
