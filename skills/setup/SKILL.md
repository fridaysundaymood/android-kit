---

name: android-kit-setup
description: Initialize an Android project and inspect kit prerequisites.
---

# Setup

1. In the project root run `kit init --json`. Initialization has no MCP equivalent; it detects project features and creates an editable config without overwriting an existing one. Review the generated defaults before running verification.
2. Run `kit doctor --json`, or call MCP `kit_doctor` with `{ "projectRoot": "<project-root>" }`. Resolve missing prerequisites using the returned details.
3. Run `kit status --json`, or call MCP `kit_status` with the same `projectRoot`. Inspect backend status and pending release plans alongside the other results. A blocked or unsupported result is not a pass.

Use `--root <project-root>` on CLI commands when outside the project. Do not start devices or backends unless the requested work needs them.
