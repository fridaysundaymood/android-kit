# Getting started

The kit composes separately distributed tools through their public APIs. Install Node.js LTS and npm, then install the Android SDK command-line tools and a JDK compatible with your Android project. Device tests also need `adb`, an emulator and an appropriate system image; UI journeys need Maestro. Local backend scenarios need Docker and the Supabase CLI. The i18n MCP package invokes the JVM localization CLI. Release planning requires the relevant release-gate configuration; it does not authorize deployment.

- **Windows:** enable a supported hypervisor for emulator acceleration, install the SDK in a writable path, and put Android platform-tools on `PATH`. Use PowerShell or a shell that can run your Gradle wrapper. Docker Desktop must be running before local Supabase operations.
- **macOS:** install Android SDK platform-tools and an emulator image matching the host architecture. Enable the Docker runtime before local Supabase operations.
- **Linux:** install Android SDK platform-tools and configure KVM access for accelerated emulation. Ensure your user can access the Docker daemon before local Supabase operations.

From a checkout of android-kit:

```sh
npm ci
npm run build
```

In the target project's root, run the installed `kit` executable:

```sh
kit init --json
kit doctor --json
kit status --json
kit verify --json
kit release plan --plan '<JSON object>' --json
```

Use `--root PATH` when operating on a different project. `kit verify --scope SCOPE --json` selects a verification scope. `kit mcp` starts the stdio MCP server; configure an MCP client to launch it as a command, without mixing diagnostic output into its protocol stream. The kit does not install SDKs, start devices, or start a backend merely by being installed. Read `doctor` output for missing prerequisites before starting a requested operation.

Each command's JSON result uses the [result envelope](./kit-schema.md). Treat `blocked` and `unsupported` as incomplete, not as passing checks. Artifacts belong beneath `.android-kit/runs/`; never place credentials or real user data in examples or fixtures.
