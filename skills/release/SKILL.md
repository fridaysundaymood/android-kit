---

name: android-kit-release
description: Check release readiness and prepare release plans.
---

# Release

1. Run `kit verify --scope all --json` or MCP `kit_verify` with `{ "scope": "all" }`. Review failures and blocked or unsupported stages before planning.
2. Run `kit release plan --plan '<JSON object>' --json` or MCP `kit_release_readiness` with a valid release-gate plan in its `plan` argument. A missing plan is blocked.
3. Inspect returned verification, plan and evidence. Planning is not approval or execution. Any production write must use the release gate's explicit dry-run, approval, execution, and verification workflow; never infer approval from a readiness result.
