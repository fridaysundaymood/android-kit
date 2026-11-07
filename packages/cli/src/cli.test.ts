import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { invokeKit, invokeTool, runStdio } from '@android-kit/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { init, run } from './cli.js';

vi.mock('@android-kit/server', () => {
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

async function command(args: string[]) {
  const lines: string[] = [];
  const code = await run([...args, '--json'], (line) => lines.push(line));
  return { code, result: JSON.parse(lines.join('\n')) };
}

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
      },
    ]);
    expect(await readFile(join(root, 'android-kit.yaml'), 'utf8')).toBe('{}\n');
    expect((await init(root)).status).toBe('blocked');
    expect(await readFile(join(root, 'android-kit.yaml'), 'utf8')).toBe('{}\n');
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
  });

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
    expect(invokeKit).toHaveBeenCalledWith('verify', args);
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
    expect(invokeKit).toHaveBeenCalledWith('release_readiness', {
      projectRoot: root,
      plan: { name: 'synthetic' },
    });
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
    expect(runStdio).toHaveBeenCalled();
  });
});
