# android-kit

A proposed end-to-end toolkit for building Android apps with AI agents: one MCP server and skill pack that combines device testing, UI journeys, multi-user backend testing, localization linting and gated releases. Each part is also available as its own repo:

- [emu-lab](https://github.com/fridaysundaymood/emu-lab) - leased Android emulators, isolated builds, test runners, failure triage
- [maestro-flow](https://github.com/fridaysundaymood/maestro-flow) - Maestro flows from user journeys
- [supa-multiuser-harness](https://github.com/fridaysundaymood/supa-multiuser-harness) - local Supabase, multi-user scenarios, permission and race attacks
- [indonesian-english-linter](https://github.com/fridaysundaymood/indonesian-english-linter) - EN/ID display localization linter
- [supa-release-gate-mcp](https://github.com/fridaysundaymood/supa-release-gate-mcp) - plan, approve, deploy, verify

## Status

**Planning only; not implemented yet.** See the [implementation plan](IMPLEMENTATION_PLAN.md), especially the composability rules every tool follows.

## Contributing

Contributions to the plan are welcome. Open an issue to discuss substantial changes. Use synthetic examples and fixtures, never private app data.

## License

[MIT](LICENSE)
