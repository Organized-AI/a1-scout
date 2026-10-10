# A1 Scout — orientation for Autobuild

A1 Scout is Jordan Hill's private tool for building an offline AI stash. A Cloudflare Worker (`src/index.js`) scans the Hugging Face Hub every Monday, scores models, datasets, Spaces, papers and collections against the Organized-AI GitHub repos, and stores them as picks in D1. Jordan approves picks in the dashboard (`public/`), and a Mac agent (`agent/agent.py`, `agent/bench.py`) downloads approved picks onto the A1 drive and reports presence, the drive catalog and bench results back to the Worker.

Appropriate automated work: small, tested Worker changes; the MCP endpoint described in the A1 Scout MCP specs; input validation; tests; docs. Not appropriate without an explicit spec: anything that changes authentication, makes the Mac download, eject or mount, or edits the Mac agent. Read `AGENTS.md` and load the `repo-a1-scout-api` skill before changing `src/`.
