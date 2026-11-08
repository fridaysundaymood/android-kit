import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeKit, invokeTool, runStdio } from '@budaknyenyel/kit-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { init, run } from './cli.js';

vi.mock('@budaknyenyel/kit-server', () => {
  const result = {
    schema_version: '1',
    tool: 'kit',
    operation: 'status',
    run_id: 'synthetic',
    status: 'pass',
    summary: 'ok',
    evidence: [],
    artifacts: [],
    started_at: '2026-01-01T00:00:00.000Z',
    duration_ms: 0,
  };
  return {
    invokeKit: vi.fn(async () => result),
    invokeTool: vi.fn(async () => result),
    runStdio: vi.fn(async () => {}),
  };
});

const roots: string[] = [];
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kit-cli-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

it('runs the compiled CLI through a symlink', async () => {
  const root = await temporary();
  const windows = process.platform === 'win32';
  const link = join(root, windows ? 'kit-dist' : 'kit.js');
  await symlink(
    fileURLToPath(
      new URL(windows ? '../dist/' : '../dist/index.js', import.meta.url),
    ),
    link,
    windows ? 'junction' : 'file',
  );
  const executable = windows ? join(link, 'index.js') : link;
  const result = spawnSync(process.execPath, [executable, '--help'], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Usage: kit');
}, 30000);

async function command(args: string[]) {
  const lines: string[] = [];
  const code = await run([...args, '--json'], (line) => lines.push(line));
  return { code, result: JSON.parse(lines.join('\n')) };
}
async function config(root: string) {
  return JSON.parse(
    (await readFile(join(root, 'android-kit.yaml'), 'utf8')).replace(
      /^#[^\n]*\n/gm,
      '',
    ),
  );
}

const profile = {
  image: 'system-images;android-36;google_apis_playstore;x86_64',
  api: 36,
  ramMb: 2048,
  cores: 4,
  gpu: 'host',
  root: false,
  locale: 'en-US',
  density: 420,
};

describe('kit CLI', () => {
  it('prints general and command help without invoking operations', async () => {
    vi.clearAllMocks();
    const lines: string[] = [];
    const print = (line: string) => lines.push(line);
    expect(await run(['--help'], print)).toBe(0);
    for (const name of [
      'init',
      'status',
      'verify',
      'doctor',
      'release plan',
      'tool',
      'mcp',
    ]) {
      expect(lines[0]).toContain(name);
    }
    for (const args of [
      ['init'],
      ['status'],
      ['verify'],
      ['doctor'],
      ['release'],
      ['release', 'plan'],
      ['tool'],
      ['mcp'],
    ]) {
      lines.length = 0;
      expect(await run([...args, '--help'], print)).toBe(0);
      expect(lines[0]).toContain(`Usage: kit ${args.join(' ')}`);
    }
    expect(invokeKit).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(runStdio).not.toHaveBeenCalled();
    lines.length = 0;
    expect(await run(['unknown', '--help'], print)).toBe(2);
    expect(lines[0]).toContain('Unknown command');
  });

  it('prints the package version', async () => {
    const lines: string[] = [];
    const metadata = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(await run(['--version'], (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual([metadata.version]);
  });

  it('detects a synthetic project and refuses to overwrite config', async () => {
    const root = await temporary();
    await mkdir(join(root, 'app/src/main/res/values-in'), { recursive: true });
    await mkdir(join(root, 'supabase'));
    await mkdir(join(root, 'e2e/maestro'), { recursive: true });
    await writeFile(join(root, 'app/build.gradle.kts'), '');
    await writeFile(
      join(root, 'app/src/main/res/values-in/strings.xml'),
      '<resources/>',
    );
    const first = await init(root);
    expect(first.status).toBe('pass');
    expect(first.evidence).toEqual([
      {
        modules: ['app'],
        resources: ['app/src/main/res/values-in/strings.xml'],
        supabase: ['supabase'],
        maestro: ['e2e/maestro'],
        flavors: [],
        variants: ['debug', 'release'],
      },
    ]);
    const expected = {
      emuLab: { build: { variant: 'debug' }, profiles: { default: profile } },
      i18n: { locales: ['in'] },
      maestroFlow: { flowsDir: 'e2e/maestro' },
      backend: { supabaseDir: '.' },
    };
    expect(await config(root)).toEqual(expected);
    expect((await init(root)).status).toBe('blocked');
    expect(await config(root)).toEqual(expected);
  });

  it('only configures detected locales and a single Supabase project', async () => {
    const root = await temporary();
    await mkdir(join(root, 'app/src/main/res/values'), { recursive: true });
    await mkdir(join(root, 'services/api/supabase'), { recursive: true });
    await writeFile(
      join(root, 'app/src/main/res/values/strings.xml'),
      '<resources/>',
    );
    expect((await init(root)).status).toBe('pass');
    expect(await config(root)).toEqual({
      backend: { supabaseDir: 'services/api' },
    });
  });

  it('detects the fixture project without modifying the checkout', async () => {
    const fixture =
      process.env.ANDROID_KIT_FIXTURE ??
      resolve(process.cwd(), '../kit-fixture-app');
    const root = await temporary();
    await cp(fixture, root, {
      recursive: true,
      filter: (source) =>
        !/(?:^|[\\/])(?:\.git|\.gradle|\.android-kit|\.kotlin|build)(?:[\\/]|$)/.test(
          source,
        ),
    });
    const result = await init(root);
    expect(result.status).toBe('pass');
    const found = result.evidence[0] as {
      modules: string[];
      resources: string[];
      supabase: string[];
      maestro: string[];
    };
    expect(found.modules).toContain('app');
    expect(found.resources.some((path) => path.endsWith('/strings.xml'))).toBe(
      true,
    );
    expect(found.supabase).toContain('supabase');
    expect(found.maestro).toContain('e2e/maestro');
    expect(await config(root)).toMatchObject({
      emuLab: {
        build: { variant: 'cleanDebug' },
        profiles: { default: profile },
      },
      maestroFlow: { flowsDir: 'e2e/maestro' },
      backend: { supabaseDir: '.' },
    });
    expect(result.evidence[0]).toMatchObject({
      flavors: ['clean', 'defects'],
      variants: [
        'cleanDebug',
        'cleanRelease',
        'defectsDebug',
        'defectsRelease',
      ],
    });
    expect(await readFile(join(root, 'android-kit.yaml'), 'utf8')).toContain(
      '# Detected Gradle variants: cleanDebug',
    );
  }, 30_000);

  it('rejects malformed options and preserves JSON output and exit codes', async () => {
    expect(await command(['verify', '--scope', 'wrong'])).toMatchObject({
      code: 2,
      result: { status: 'error', classification: 'config' },
    });
    expect(await command(['tool', 'kit_status', '--args', '[]'])).toMatchObject(
      { code: 2, result: { status: 'error' } },
    );
    const root = await temporary();
    expect(await command(['init', '--root', root])).toMatchObject({
      code: 0,
      result: { status: 'pass' },
    });
    expect(await command(['init', '--root', root])).toMatchObject({
      code: 2,
      result: { status: 'blocked' },
    });
  });

  it('routes orchestration and MCP tool names through the shared server operations', async () => {
    const root = await temporary();
    const args = {
      projectRoot: root,
      scope: 'device',
      build: { task: 'synthetic' },
    };
    expect(
      (await command(['verify', '--args', JSON.stringify(args)])).code,
    ).toBe(0);
    expect(invokeKit).toHaveBeenCalledWith('verify', args, undefined, {
      projectRoot: undefined,
      configPath: undefined,
    });
    expect(
      (await command(['verify', '--root', root, '--fail-fast'])).code,
    ).toBe(0);
    expect(invokeKit).toHaveBeenCalledWith(
      'verify',
      {
        projectRoot: root,
        failFast: true,
      },
      undefined,
      { projectRoot: root, configPath: undefined },
    );
    expect((await command(['status', '--fail-fast'])).code).toBe(2);
    expect((await command(['verify', '--fail-fast', '--fail-fast'])).code).toBe(
      2,
    );
    expect(
      (
        await command([
          'release',
          'plan',
          '--root',
          root,
          '--plan',
          '{"name":"synthetic"}',
        ])
      ).code,
    ).toBe(0);
    expect(invokeKit).toHaveBeenCalledWith(
      'release_readiness',
      {
        projectRoot: root,
        plan: { name: 'synthetic' },
      },
      undefined,
      { projectRoot: root, configPath: undefined },
    );
    expect(
      (
        await command([
          'tool',
          'kit_status',
          '--args',
          JSON.stringify({ projectRoot: root }),
        ])
      ).code,
    ).toBe(0);
    expect(invokeTool).toHaveBeenCalledWith('kit_status', {
      projectRoot: root,
    });
    expect(await run(['mcp'], () => {})).toBe(0);
    expect(runStdio).toHaveBeenCalledWith({
      projectRoot: undefined,
      configPath: undefined,
    });
    expect(
      await run(['mcp', '--root', root, '--config', 'release.yaml'], () => {}),
    ).toBe(0);
    expect(runStdio).toHaveBeenCalledWith({
      projectRoot: root,
      configPath: 'release.yaml',
    });
    expect(
      (
        await command([
          'tool',
          'release_status',
          '--root',
          root,
          '--config',
          'release.yaml',
        ])
      ).code,
    ).toBe(0);
    expect(invokeTool).toHaveBeenCalledWith(
      'release_status',
      {},
      {
        projectRoot: root,
        configPath: 'release.yaml',
      },
    );
    for (const key of ['projectRoot', 'config', 'configPath']) {
      expect(
        (
          await command([
            'tool',
            'release_status',
            '--args',
            JSON.stringify({ [key]: root }),
          ])
        ).code,
      ).toBe(2);
    }
  });
});

it('only replaces an existing configuration with init --force', async () => {
  const root = await temporary();
  await writeFile(join(root, 'android-kit.yaml'), 'user: keep\n');
  expect((await command(['init', '--root', root])).result.status).toBe(
    'blocked',
  );
  expect(await readFile(join(root, 'android-kit.yaml'), 'utf8')).toBe(
    'user: keep\n',
  );
  expect(
    (await command(['init', '--root', root, '--force'])).result.status,
  ).toBe('pass');
  expect(await readFile(join(root, 'android-kit.yaml'), 'utf8')).not.toContain(
    'user: keep',
  );
  expect((await command(['status', '--force'])).result.status).toBe('error');
  expect((await command(['init', '--force', '--force'])).result.status).toBe(
    'error',
  );
});
