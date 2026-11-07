# android-kit.yaml v1

The top-level mapping accepts only `emuLab`, `maestroFlow`, `backend`, `i18n`, and `releaseGate`. Every section is optional and must be an object. Section keys and their validation belong to the respective tool.

The reference below is generated at documentation build time from the sibling packages' exported section schemas and the shared configuration schema. It includes required fields, nested constraints, and whether additional properties are allowed. Select the sections required by your workflow and use their documented properties; configure external prerequisites separately.

`loadConfig(path, { name, schema })` parses YAML, validates the selected tool's section and returns it (or `undefined` when absent). `composeConfigSchema` combines section schemas; the exported `configSchema` is the base schema.

## Configuration schema

<!-- CONFIG_SCHEMA -->

The sibling package roots expose `configSection`, `configSectionSchema`, and `supportedSchemaMajors`; the kit uses these contracts when composing configuration and checking compatibility. They also expose `toolDefinitions()` and `doctor()`. The i18n MCP package supplies the same public integration surface for the JVM linter.
