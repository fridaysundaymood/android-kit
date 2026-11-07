---

name: android-kit-localize
description: Find and resolve Android localization boundary issues.
---

# Localize

1. Run `kit verify --scope lint --json` or MCP `kit_verify` with `{ "scope": "lint" }`.
2. Review i18n findings at the display boundary and fix source or string resources, retaining stable data identifiers. Do not translate identifiers used as data.
3. Repeat `kit verify --scope lint --json` or MCP `kit_verify` with `{ "scope": "lint" }` and inspect the evidence. Missing JVM linter prerequisites are blocked or unsupported, not a successful lint.
