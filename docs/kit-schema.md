# kit-schema v1

The workspace package `@android-kit/schema` supplies the shared result and configuration contracts. During development, install it via a relative `file:` dependency to `packages/kit-schema`; build it before consuming it.

A result has `schema_version: "1"`, `tool`, `operation`, `run_id`, `status`, optional `classification`, `summary`, `evidence`, `artifacts`, `started_at` (ISO date-time), and nonnegative `duration_ms`. Artifact paths are relative to the project root. Evidence entries are tool-defined. See `result.v1.json` for the complete schema.

Use `createResult({ ..., startedAt })` with a `Date` captured before the operation. `validateResult(value)` is a type guard. `exitCodeFor(status)` returns 0 for pass, 1 for fail or flaky, and 2 for error, blocked, or unsupported. `checkSchemaMajor(1)` rejects incompatible supported majors. `newRunId()` generates a UUID.

`runArtifactDir(projectRoot, runId, tool)` returns the run directory. `writeArtifactIndex(projectRoot, runId, tool, artifacts)` writes `index.json`, returning its project-relative path. Entries must be project-relative paths inside that tool's run directory. The writer records paths; it does not create artifact files.

See [android-kit.yaml](android-kit-yaml.md) for configuration composition and loading.
