# android-kit.yaml v1

The top-level mapping accepts only `emuLab`, `maestroFlow`, `backend`, `i18n`, and `releaseGate`. Every section is optional and must be an object. Section keys and their validation belong to the respective tool.

The reference below is generated at documentation build time from the sibling packages' exported section schemas and the shared configuration schema. It includes required fields, nested constraints, and whether additional properties are allowed. Select the sections required by your workflow and use their documented properties; configure external prerequisites separately.

`kit init` detects Gradle modules, resource locales, Maestro flows and Supabase projects. For detected Android modules it writes an editable `emuLab.profiles.default` emulator profile and `emuLab.build.variant`: the first alphabetic detected debug variant, or `debug` if none is found. It adds `maestroFlow.flowsDir`, `backend.supabaseDir` for a single Supabase project, and `i18n.locales` when locale resources are found. Detected Gradle flavors and variants appear in init evidence; statically detected variants also appear in a YAML comment. Discovery is best-effort, not a Gradle evaluation. Review the generated settings for your project; existing files are never overwritten.

`loadConfig(path, { name, schema })` parses YAML, validates the selected tool's section and returns it (or `undefined` when absent). `composeConfigSchema` combines section schemas; the exported `configSchema` is the base schema.

## Configuration schema

<!-- CONFIG_SCHEMA -->

The sibling package roots expose `configSection`, `configSectionSchema`, and `supportedSchemaMajors`; the kit uses these contracts when composing configuration and checking compatibility. They also expose `toolDefinitions()` and `doctor()`. The i18n MCP package supplies the same public integration surface for the JVM linter.
