# Synthetic fixture walkthrough

The sibling [kit-fixture-app](https://github.com/fridaysundaymood/kit-fixture-app) is a synthetic task board with `clean` and intentionally broken `defects` flavors. Read its `README.md` and `DEFECTS.md` before interpreting results. Never deploy its defect migrations to a real project.

1. Clone the fixture and install its documented JDK 21 and Android SDK prerequisites. From its root, run `kit init --json` (MCP has no initialization equivalent), then `kit doctor --json` (MCP: `kit_doctor` with `projectRoot` pointing at the fixture).
2. Run `kit verify --scope lint --json` (MCP: `kit_verify` with `scope: "lint"`). Compare findings with the documented defects rather than treating the defects flavor as a production app.
3. When a suitable isolated device and Maestro are available, run `kit verify --scope device --json` (MCP: `kit_verify` with `scope: "device"`). The fixture README identifies clean journeys and the deliberately stale selector.
4. For backend scenarios, start only a disposable local Supabase stack as described by the fixture, then run `kit verify --scope backend --json` (MCP: `kit_verify` with `scope: "backend"`). Its optional defect SQL is outside the normal migration directory.
5. Read each result's status, evidence, and artifact paths. Fixes should be evaluated against both the clean baseline and the documented defect; blocked stages require their stated prerequisites, not a pass assumption.

Use `--root PATH` or MCP's `projectRoot` when your current directory is not the fixture. These commands may build or run tests; merely reading this guide does not start an emulator or backend.
