---

name: android-kit-triage
description: Interpret and investigate kit verification results.
---

# Triage

1. Run `kit verify --scope all --json` or MCP `kit_verify` with `{ "scope": "all" }`, unless a relevant result is already available.
2. Inspect the failed stage's classification, evidence, and artifact paths under `.android-kit/runs/`. Distinguish app and test failures from environment and configuration problems; do not treat unavailable capabilities as passes.
3. After fixing the cause, repeat the relevant scope with `kit verify --scope <device|backend|lint> --json` or MCP `kit_verify` with `{ "scope": "<device|backend|lint>" }`; replace the placeholder with one scope. Preserve evidence and avoid exposing secrets in reports.
