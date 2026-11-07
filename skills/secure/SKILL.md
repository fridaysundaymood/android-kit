---

name: android-kit-secure
description: Exercise multi-user backend isolation using synthetic data.
---

# Secure

1. Check setup with `kit doctor --json` or MCP `kit_doctor`. Use only a verified disposable local backend and synthetic identities; do not target linked or remote projects.
2. Run `kit verify --scope backend --json` or MCP `kit_verify` with `{ "scope": "backend" }`.
3. Review scenario and attack evidence, correct policy or application defects, then repeat the same CLI command or MCP call. A blocked or unsupported scenario is not proof of security.
