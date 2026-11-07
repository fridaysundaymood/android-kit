import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolDefinitions as emuTools } from '@android-kit/emu-lab';
import { toolDefinitions as i18nTools } from '@android-kit/i18n-mcp';
import { createResult, type Result, type Status } from '@android-kit/schema';
import { toolDefinitions as backendTools } from '@android-kit/supa-multiuser-harness';
import { toolDefinitions as releaseTools } from '@android-kit/supa-release-gate-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { toolDefinitions as maestroTools } from 'maestro-flow';
import { describe, expect, it } from 'vitest';
import { createServer, invokeKit, toolNames } from './index.js';

function result(name: string, status: Status = 'pass'): Result {
  return createResult({
    tool: name,
    operation: name,
    run_id: 'test',
    status,
    summary: status,
    evidence: [],
    artifacts: [],
    startedAt: new Date(),
  });
}
function recorder(fail?: string, running = false, unsupported?: string) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    invoke: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      const output = result(
        name,
        name === fail ? 'fail' : name === unsupported ? 'unsupported' : 'pass',
      );
      if (name === 'emu_lab_build')
        output.artifacts.push('app.apk', 'androidTest.apk');
      if (name === 'emu_lab_lease_device')
        output.evidence.push({ leaseId: 'lease-1' });
      if (name === 'backend_status') output.evidence.push({ running });
      return output;
    },
  };
}
describe('kit orchestration', () => {
  it('runs device and backend lifecycle in order and releases owned resources', async () => {
    const mock = recorder();
    const output = await invokeKit(
      'verify',
      {
        build: { variant: 'debug' },
        instrumentation: {
          packageName: 'dev.example',
          runner: 'dev.example.test/Runner',
        },
        maestro: { flow: 'flow.yaml' },
        backend: { file: 'scenario.yaml' },
      },
      mock.invoke,
    );
    expect(output.status).toBe('pass');
    expect(mock.calls.map(({ name }) => name)).toEqual([
      'i18n_lint',
      'maestro_flow_lint',
      'emu_lab_build',
      'emu_lab_lease_device',
      'emu_lab_run_instrumentation',
      'maestro_flow_run',
      'emu_lab_release_device',
      'backend_status',
      'backend_stack_up',
      'backend_stack_verify',
      'backend_run_scenario',
      'backend_stack_down',
    ]);
    expect(
      mock.calls.find(({ name }) => name === 'emu_lab_release_device')?.args
        .leaseId,
    ).toBe('lease-1');
    expect(
      mock.calls.find(({ name }) => name === 'maestro_flow_run')?.args.emuLab,
    ).toEqual(expect.objectContaining({ leaseId: 'lease-1' }));
  });
  it('releases a lease after instrumentation failure', async () => {
    const mock = recorder('emu_lab_run_instrumentation');
    const output = await invokeKit(
      'verify',
      {
        scope: 'device',
        build: { variant: 'debug' },
        instrumentation: {
          packageName: 'dev.example',
          runner: 'dev.example.test/Runner',
        },
        maestro: { flow: 'flow.yaml' },
      },
      mock.invoke,
    );
    expect(output.status).toBe('fail');
    expect(mock.calls.at(-1)?.name).toBe('emu_lab_release_device');
  });
  it('runs every discovered flow even if one fails, then releases the lease', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'kit-flows-'));
    try {
      await mkdir(join(projectRoot, 'flows'));
      await writeFile(join(projectRoot, 'flows', 'a.yaml'), 'appId: example');
      await writeFile(join(projectRoot, 'flows', 'b.yaml'), 'appId: example');
      const mock = recorder('maestro_flow_run');
      const output = await invokeKit(
        'verify',
        {
          projectRoot,
          scope: 'device',
          build: { variant: 'debug' },
          instrumentation: {
            packageName: 'dev.example',
            runner: 'dev.example.test/Runner',
          },
          maestro: { flowsDir: 'flows' },
        },
        mock.invoke,
      );
      expect(output.status).toBe('fail');
      expect(
        mock.calls.filter(({ name }) => name === 'maestro_flow_run'),
      ).toHaveLength(2);
      expect(mock.calls.at(-1)?.name).toBe('emu_lab_release_device');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
  it('derives literal Gradle instrumentation settings for a fixture', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'kit-gradle-'));
    try {
      await mkdir(join(projectRoot, 'app'));
      await writeFile(
        join(projectRoot, 'app', 'build.gradle.kts'),
        'android { defaultConfig { applicationId = "dev.example"; testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner" } }',
      );
      const mock = recorder();
      const output = await invokeKit(
        'verify',
        {
          projectRoot,
          scope: 'device',
          build: { variant: 'debug' },
          maestro: { flow: 'flow.yaml' },
        },
        mock.invoke,
      );
      expect(output.status).toBe('pass');
      expect(
        mock.calls.find(({ name }) => name === 'emu_lab_run_instrumentation')
          ?.args,
      ).toEqual(
        expect.objectContaining({
          packageName: 'dev.example',
          runner: 'dev.example.test/androidx.test.runner.AndroidJUnitRunner',
        }),
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
  it('stops a started stack on failure and reports unsupported absent suite', async () => {
    const mock = recorder('backend_stack_verify');
    expect(
      (await invokeKit('verify', { scope: 'backend' }, mock.invoke)).status,
    ).toBe('fail');
    expect(mock.calls.at(-1)?.name).toBe('backend_stack_down');
    const other = recorder(undefined, false, 'backend_run_attacks');
    expect(
      (await invokeKit('verify', { scope: 'backend' }, other.invoke)).status,
    ).toBe('unsupported');
    expect(other.calls.at(-1)?.name).toBe('backend_stack_down');
  });
  it('does not stop an already running stack', async () => {
    const mock = recorder(undefined, true);
    expect(
      (
        await invokeKit(
          'verify',
          { scope: 'backend', backend: { file: 'scenario.yaml' } },
          mock.invoke,
        )
      ).status,
    ).toBe('pass');
    expect(mock.calls.map(({ name }) => name)).toEqual([
      'backend_status',
      'backend_stack_verify',
      'backend_run_scenario',
    ]);
  });
  it('rejects unknown scopes', async () => {
    expect(
      (
        await invokeKit(
          'verify',
          { scope: 'invalid' as 'all' },
          recorder().invoke,
        )
      ).status,
    ).toBe('error');
  });
  it('uses component status and doctor operations', async () => {
    const mock = recorder();
    expect(emuTools().map((tool) => tool.name)).toContain('emu_lab_status');
    await invokeKit('status', {}, mock.invoke);
    expect(mock.calls.map((call) => call.name)).toEqual([
      'emu_lab_status',
      'backend_status',
      'i18n_lint',
      'release_status',
    ]);
    mock.calls.length = 0;
    await invokeKit('doctor', {}, mock.invoke);
    expect(mock.calls.map((call) => call.name)).toEqual([
      'emu_lab_doctor',
      'maestro_flow_doctor',
      'backend_doctor',
      'i18n_doctor',
      'release_doctor',
    ]);
  });
  it('reports missing sections without starting component tools', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'kit-server-'));
    try {
      const output = await invokeKit('verify', { projectRoot });
      expect(output.status).toBe('unsupported');
      expect(output.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: 'maestro_flow_lint',
            status: 'unsupported',
          }),
        ]),
      );
      const status = await invokeKit('status', { projectRoot });
      expect(
        (status.evidence as Result[]).map(({ tool, operation, status }) => ({
          tool,
          operation,
          status,
        })),
      ).toEqual([
        { tool: 'emu-lab', operation: 'emu_lab_status', status: 'unsupported' },
        { tool: 'backend', operation: 'backend_status', status: 'unsupported' },
        { tool: 'i18n', operation: 'i18n_lint', status: 'unsupported' },
        { tool: 'release', operation: 'release_status', status: 'unsupported' },
      ]);
      await writeFile(
        join(projectRoot, 'android-kit.yaml'),
        'emuLab:\\n  unexpected: true\\n',
      );
      expect((await invokeKit('verify', { projectRoot })).status).toBe('error');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
  it('runs every doctor even without component configuration', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'kit-doctor-'));
    try {
      const output = await invokeKit('doctor', { projectRoot });
      expect(output.evidence).toHaveLength(5);
      for (const item of output.evidence as Result[]) {
        expect(item.summary).not.toMatch(/^Missing .* configuration$/);
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 60_000);
  it('validates the i18n section with its public schema', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'kit-i18n-'));
    try {
      await writeFile(
        join(projectRoot, 'android-kit.yaml'),
        'i18n:\n  domains:\n    sample:\n      localizer: example\n',
      );
      const output = await invokeKit('verify', { projectRoot });
      expect(output.status).toBe('error');
      expect(output.summary).toContain('Invalid android-kit configuration');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
  it('lists the public component descriptions and input schemas unchanged', async () => {
    const server = createServer();
    const client = new Client({ name: 'kit-test', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const { tools } = await client.listTools();
      const definitions = [
        ...emuTools(),
        ...maestroTools(),
        ...backendTools(),
        ...releaseTools(),
        ...i18nTools(),
      ];
      for (const { name, description, inputSchema } of definitions) {
        expect(tools.find((tool) => tool.name === name)).toEqual({
          name,
          description,
          inputSchema,
        });
      }
      expect(tools.map((tool) => tool.name)).toEqual(toolNames);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('exposes the direct component tools and orchestration', () => {
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'kit_verify',
        'kit_release_readiness',
        'emu_lab_build',
        'maestro_flow_run',
        'backend_run_scenario',
        'i18n_lint',
        'release_plan_change',
      ]),
    );
    expect(new Set(toolNames).size).toBe(toolNames.length);
  });
});
