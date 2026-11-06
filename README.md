# android-kit

**Build, test, secure, localize, and ship an Android app end to end, from one AI-agent toolkit.**

android-kit combines five focused tools into one MCP server, one skill pack, and one CLI. An AI agent (or you) can go from a code change to a verified release candidate: lint, build once, test on isolated devices, run UI journeys, attack the backend, and prepare a release that waits for your approval.

## Status

> **Planning stage: there is no code to install yet.** The design is in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). The tools ship separately first; the combined kit follows. Star or watch to follow progress.

## The tools

Each one is useful on its own:

| Tool | Does |
|---|---|
| [emu-lab](https://github.com/fridaysundaymood/emu-lab) | Isolated emulators, cached builds, clean app state, test runners, failure triage |
| [maestro-flow](https://github.com/fridaysundaymood/maestro-flow) | Maestro UI flows written from user journeys and your string resources, linted and iterated on devices |
| [supa-multiuser-harness](https://github.com/fridaysundaymood/supa-multiuser-harness) | Local Supabase with verified migrations, fake users, simulated phones, permission and race attacks |
| [indonesian-english-linter](https://github.com/fridaysundaymood/indonesian-english-linter) | Localization linter for display/data boundaries (EN/ID first, any locale pair) |
| [supa-release-gate-mcp](https://github.com/fridaysundaymood/supa-release-gate-mcp) | Plan, dry run, approve, deploy, verify, and record production changes |

## Who it's for

Android developers (Kotlin/Compose, optionally Supabase) who use AI coding agents and want them to test and ship safely, not just write code.

## Planned kit features

- **One MCP server** with all tool libraries mounted, plus `kit_status`, `kit_verify` (lint → build → device tests → UI journeys → backend scenarios → summary), and `kit_release_readiness` (verify, then prepare release plans without executing).
- **Skill pack:** one guide per stage (setup, test, triage, localize, secure, release) telling an agent which tools to call and in what order.
- **CLI:** `kit init`, `kit verify`, `kit release plan`, `kit doctor`.
- **Shared conventions:** one result format, one `android-kit.yaml` config, one artifact folder (`.android-kit/runs/`), and a synthetic sample app every tool is tested against.

## Contributing

The design is open for feedback. Open an issue to question scope, suggest a feature, or discuss an approach before sending a pull request. Use synthetic examples only: no private app code, production data, or credentials.

## License

[MIT](LICENSE)
