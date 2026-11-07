# Templates

Copy `android-kit.yaml` to the target project and add settings documented by each tool you use. The empty sections do not configure tool-specific operations.

Copy `verify.yml` to `.github/workflows/` only after adding `@android-kit/cli` to the project's npm dependencies and installing the selected tools and their prerequisites in CI. Add `--args '<JSON object>'` to pass the component options required by your project; see the [lifecycle guide](../docs/lifecycle.md). The workflow does not provision devices or a backend. A blocked or unsupported result is not a successful verification.
