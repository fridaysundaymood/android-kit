import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  createResult,
  exitCodeFor,
  newRunId,
  type Result,
} from '@budaknyenyel/kit-schema';
import { invokeKit, invokeTool, runStdio } from '@budaknyenyel/kit-server';

type Scope = 'all' | 'device' | 'backend' | 'lint';
const scopes: Record<string, true> = {
  all: true,
  device: true,
  backend: true,
  lint: true,
};
const ignored: Record<string, true> = {
  '.git': true,
  '.gradle': true,
  '.android-kit': true,
  '.kotlin': true,
  node_modules: true,
  build: true,
  dist: true,
};

const usage = `Usage: kit <command> [options]

Commands:
  init           Detect a project and create its configuration
  status         Show project status
  verify         Run verification
  doctor         Diagnose the project environment
  release plan   Assess release readiness
  tool <name>    Invoke an MCP tool
  mcp            Run the MCP server over stdio

Options:
  --help         Show help
  --version      Show version

Run kit <command> --help for command options.`;

const commandUsage: Record<string, string> = {
  init: 'Usage: kit init [--root <path>] [--force] [--json]',
  status: 'Usage: kit status [--root <path>] [--args <json>] [--json]',
  verify:
    'Usage: kit verify [--root <path>] [--scope <all|device|backend|lint>] [--fail-fast] [--args <json>] [--json]',
  doctor: 'Usage: kit doctor [--root <path>] [--args <json>] [--json]',
  release:
    'Usage: kit release plan [--root <path>] [--config <path>] [--scope <all|device|backend|lint>] [--plan <json>] [--args <json>] [--json]',
  tool: 'Usage: kit tool <name> [--root <path>] [--config <path>] [--args <json>] [--json]',
  mcp: 'Usage: kit mcp [--root <path>] [--config <path>]\n\nRun the MCP server over stdio.',
};

async function detect(root: string): Promise<{
  modules: string[];
  resources: string[];
  supabase: string[];
  maestro: string[];
  flavors: string[];
  variants: string[];
}> {
  const modules: string[] = [];
  const resources: string[] = [];
  const supabase: string[] = [];
  const maestro: string[] = [];
  const flavors = new Set<string>();
  const buildTypes = new Set(['debug', 'release']);
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (ignored[entry.name]) continue;
        if (rel === 'e2e/maestro') maestro.push(rel);
        if (entry.name === 'supabase') {
          supabase.push(rel);
          continue;
        }
        await walk(path);
      } else if (entry.isFile()) {
        if (
          entry.name === 'build.gradle' ||
          entry.name === 'build.gradle.kts'
        ) {
          modules.push(relative(root, dir).replaceAll('\\', '/') || '.');
          const source = await readFile(path, 'utf8');
          for (const [section, names] of [
            ['productFlavors', flavors],
            ['buildTypes', buildTypes],
          ] as const) {
            const block = source.match(
              new RegExp(`\\b${section}\\s*\\{([\\s\\S]*?)(?:\\n\\s*\\}|$)`),
            )?.[1];
            if (!block) continue;
            for (const match of block.matchAll(
              /(?:create|maybeCreate|register)\s*\(\s*["']([\w-]+)["']\s*\)|^\s*([A-Za-z_][\w-]*)\s*\{/gm,
            ))
              names.add(match[1] ?? match[2]!);
          }
        }
        if (
          /^strings[^/]*\.xml$/.test(entry.name) &&
          /(?:^|\/)res\/values(?:-[^/]+)?\//.test(rel)
        )
          resources.push(rel);
      }
    }
  }
  await walk(root);
  return {
    modules: [...new Set(modules)].sort(),
    resources: resources.sort(),
    supabase: supabase.sort(),
    maestro: maestro.sort(),
    flavors: [...flavors].sort(),
    variants: (flavors.size
      ? [...flavors].flatMap((flavor) =>
          [...buildTypes].map(
            (type) => flavor + type[0]!.toUpperCase() + type.slice(1),
          ),
        )
      : modules.length
        ? [...buildTypes]
        : []
    ).sort(),
  };
}

export async function init(
  projectRoot: string,
  options: { force?: boolean } = {},
): Promise<Result> {
  const startedAt = new Date();
  const run_id = newRunId();
  try {
    const root = resolve(projectRoot);
    const found = await detect(root);
    const config: Record<string, unknown> = {};
    if (found.modules.length)
      config.emuLab = {
        build: {
          variant:
            found.variants.find((variant) => /debug$/i.test(variant)) ??
            'debug',
        },
        profiles: {
          default: {
            image: 'system-images;android-36;google_apis_playstore;x86_64',
            api: 36,
            ramMb: 2048,
            cores: 4,
            gpu: 'host',
            root: false,
            locale: 'en-US',
            density: 420,
          },
        },
      };
    const locales = [
      ...new Set(
        found.resources.flatMap((path) => {
          const qualifier = path.match(
            /\/values-([a-z]{2,3})(?:-r([A-Z]{2}|\d{3}))?(?:-|\/)/,
          );
          return qualifier
            ? [qualifier[2] ? `${qualifier[1]}-${qualifier[2]}` : qualifier[1]!]
            : [];
        }),
      ),
    ].sort();
    if (locales.length) config.i18n = { locales };
    if (found.maestro.length)
      config.maestroFlow = { flowsDir: found.maestro[0] };
    if (found.supabase.length === 1) {
      const directory = found.supabase[0];
      config.backend = {
        supabaseDir:
          relative(root, join(root, directory, '..')).replaceAll('\\', '/') ||
          '.',
      };
    }
    const variants = found.variants.length
      ? `# Detected Gradle variants: ${found.variants.join(', ')}\n`
      : '';
    await writeFile(
      join(root, 'android-kit.yaml'),
      `${variants}${JSON.stringify(config, null, 2)}\n`,
      { flag: options.force ? 'w' : 'wx' },
    );
    return createResult({
      tool: 'kit',
      operation: 'init',
      run_id,
      status: 'pass',
      summary: options.force
        ? 'Replaced android-kit.yaml'
        : 'Created android-kit.yaml',
      evidence: [found],
      artifacts: ['android-kit.yaml'],
      startedAt,
    });
  } catch (error) {
    const exists = (error as NodeJS.ErrnoException).code === 'EEXIST';
    return createResult({
      tool: 'kit',
      operation: 'init',
      run_id,
      status: exists ? 'blocked' : 'error',
      classification: exists ? 'config' : 'environment',
      summary: exists
        ? 'android-kit.yaml already exists; it was not changed'
        : String(error),
      evidence: [],
      artifacts: [],
      startedAt,
    });
  }
}

function objectArgument(
  value: string,
  option: string,
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${option} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

export async function run(
  argv: string[],
  output: (line: string) => void = console.log,
): Promise<number> {
  const startedAt = new Date();
  let operation = 'cli';
  try {
    if (argv.length === 1 && argv[0] === '--version') {
      const metadata = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      output(metadata.version);
      return 0;
    }
    if (argv.length === 1 && argv[0] === '--help') {
      output(usage);
      return 0;
    }
    if (
      argv.at(-1) === '--help' &&
      (argv.length === 2 ||
        (argv.length === 3 && argv[0] === 'release' && argv[1] === 'plan'))
    ) {
      const help = commandUsage[argv[0]];
      if (!help) throw new Error(`Unknown command ${argv[0]}`);
      output(help);
      return 0;
    }
    const positional: string[] = [];
    const options: Record<string, string> = {};
    let json = false;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--json') {
        json = true;
        continue;
      }
      if (arg === '--force' || arg === '--fail-fast') {
        if (options[arg] !== undefined)
          throw new Error(`Invalid option ${arg}`);
        options[arg] = 'true';
        continue;
      }
      if (arg.startsWith('--')) {
        if (
          !['--root', '--config', '--scope', '--plan', '--args'].includes(
            arg,
          ) ||
          options[arg] !== undefined ||
          !argv[i + 1] ||
          argv[i + 1].startsWith('--')
        )
          throw new Error(`Invalid option ${arg}`);
        options[arg] = argv[++i];
      } else positional.push(arg);
    }
    operation = positional.join(' ') || 'cli';
    const root = resolve(options['--root'] ?? process.cwd());
    const command = positional[0];
    if (options['--force'] && command !== 'init')
      throw new Error('--force is only valid for init');
    if (options['--fail-fast'] && command !== 'verify')
      throw new Error('--fail-fast is only valid for verify');
    if (options['--config'] && !['mcp', 'tool', 'release'].includes(command))
      throw new Error('--config is only valid for mcp, tool, or release');
    let result: Result;
    if (
      command === 'mcp' &&
      positional.length === 1 &&
      !options['--scope'] &&
      !options['--plan'] &&
      !options['--args'] &&
      !json
    ) {
      await runStdio({
        projectRoot: options['--root'] ? root : undefined,
        configPath: options['--config'],
      });
      return 0;
    }
    if (
      command === 'init' &&
      positional.length === 1 &&
      !options['--scope'] &&
      !options['--plan'] &&
      !options['--args']
    )
      result = await init(root, { force: options['--force'] === 'true' });
    else if (
      command === 'tool' &&
      positional.length === 2 &&
      !options['--scope'] &&
      !options['--plan']
    ) {
      const args = options['--args']
        ? objectArgument(options['--args'], '--args')
        : {};
      if (positional[1].startsWith('release_')) {
        if ('config' in args || 'configPath' in args || 'projectRoot' in args)
          throw new Error('Release configuration is fixed at launch');
        result = await invokeTool(positional[1], args, {
          projectRoot: options['--root'] ? root : undefined,
          configPath: options['--config'],
        });
      } else {
        if (options['--config'])
          throw new Error('--config requires a release tool');
        if (options['--root']) args.projectRoot = root;
        result = await invokeTool(positional[1], args);
      }
    } else {
      const kitOperation =
        command === 'release' &&
        positional[1] === 'plan' &&
        positional.length === 2
          ? 'release_readiness'
          : positional.length === 1 &&
              ['status', 'verify', 'doctor'].includes(command)
            ? command
            : undefined;
      if (
        !kitOperation ||
        (options['--scope'] &&
          kitOperation !== 'verify' &&
          kitOperation !== 'release_readiness') ||
        (options['--plan'] && kitOperation !== 'release_readiness')
      )
        throw new Error(
          'Usage: kit init|status|verify|doctor|release plan|tool <name>|mcp [options]',
        );
      if (options['--scope'] && !scopes[options['--scope']])
        throw new Error('Scope must be all, device, backend, or lint');
      const args = options['--args']
        ? objectArgument(options['--args'], '--args')
        : {};
      result = await invokeKit(
        kitOperation as 'status' | 'verify' | 'doctor' | 'release_readiness',
        {
          ...args,
          ...(options['--fail-fast'] ? { failFast: true } : {}),
          projectRoot: options['--root']
            ? root
            : typeof args.projectRoot === 'string'
              ? args.projectRoot
              : root,
          ...(options['--scope'] ? { scope: options['--scope'] as Scope } : {}),
          ...(options['--plan']
            ? { plan: objectArgument(options['--plan'], '--plan') }
            : {}),
        },
        undefined,
        {
          projectRoot: options['--root'] ? root : undefined,
          configPath: options['--config'],
        },
      );
    }
    output(
      json
        ? JSON.stringify(result)
        : `${result.status.toUpperCase()}: ${result.summary}\n${JSON.stringify(result.evidence, null, 2)}`,
    );
    return exitCodeFor(result.status);
  } catch (error) {
    const result = createResult({
      tool: 'kit',
      operation,
      run_id: newRunId(),
      status: 'error',
      classification: 'config',
      summary: error instanceof Error ? error.message : String(error),
      evidence: [],
      artifacts: [],
      startedAt,
    });
    output(
      argv.includes('--json')
        ? JSON.stringify(result)
        : `ERROR: ${result.summary}`,
    );
    return 2;
  }
}
