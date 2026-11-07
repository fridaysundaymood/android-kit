---

name: android-kit-test
description: Verify an Android project with the kit.
---

# Test

1. Check prerequisites with `kit doctor --json` or MCP `kit_doctor`.
2. Run `kit verify --scope all --json` or MCP `kit_verify` with `{ "scope": "all" }`. Use `device`, `backend`, or `lint` to select a narrower scope when appropriate. Supply `--root <project-root>` or MCP `projectRoot` when needed.
3. Inspect each stage's status, evidence and artifacts. `blocked`, `unsupported`, `flaky`, `fail`, and `error` are not clean passes. Device and backend stages require the corresponding local prerequisites; never substitute a production backend.
