# android-kit.yaml v1

The top-level mapping accepts only `emuLab`, `maestroFlow`, `backend`, `i18n`, and `releaseGate`. Every section is optional and must be an object. Section keys and their validation belong to the respective tool.

Synthetic example (the section keys here are illustrative, not a tool's published options):

```yaml
emuLab:
  enabled: true
backend:
  enabled: false
```

Tools provide their section schema as a JSON Schema object. For example, `loadConfig(path, { name: 'emuLab', schema: { properties: { enabled: { type: 'boolean' } } } })` parses YAML, rejects unknown top-level and emuLab keys, and returns only emuLab (or undefined when absent). Other sections need not be installed or validated by that tool beyond their being objects. `composeConfigSchema({ emuLab: schema })` produces a schema that can be composed with other tools' schemas; registered sections reject unknown keys. Schemas may specify required keys and nested validation. The exported `configSchema` is the base schema.
