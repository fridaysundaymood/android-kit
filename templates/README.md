# Templates

Prefer `kit init --json` in the target project to detect features and generate editable settings. It does not overwrite an existing configuration. Alternatively copy `android-kit.yaml` and add settings documented by each tool you use. The empty sections do not configure tool-specific operations.

Copy `verify.yml` to `.github/workflows/` only after adding `@android-kit/cli` to the project's npm dependencies and installing the selected tools and their prerequisites in CI. Add `--args '<JSON object>'` to pass component options required by your project; see the [lifecycle guide](../docs/lifecycle.md). The example runs lint only; device and backend scopes can lease a device or start a disposable local backend. A blocked or unsupported result is not a successful verification.
