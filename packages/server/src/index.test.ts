import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
function recorder(fail?: string) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    invoke: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      return result(name, name === fail ? 'fail' : 'pass');
    },
  };
}
describe('kit orchestration', () => {
  it('runs verification in order, forwarding stage options', async () => {
    const mock = recorder();
    const output = await invokeKit(
      'verify',
      {
        projectRoot: '/project',
        build: { variant: 'debug' },
        instrumentation: { leaseId: 'lease' },
        maestro: { flow: 'flow.yaml' },
        backend: { file: 'scenario.yaml' },
      },
      mock.invoke,
    );
    expect(output.status).toBe('pass');
    expect(mock.calls.map((call) => call.name)).toEqual([
      'i18n_lint',
      'maestro_flow_lint',
      'emu_lab_build',
      'emu_lab_run_instrumentation',
      'maestro_flow_run',
      'backend_run_scenario',
    ]);
    expect(mock.calls[2].args).toEqual({
      projectRoot: '/project',
      variant: 'debug',
    });
    expect(output.evidence).toHaveLength(6);
  });
  it('stops after a failed prerequisite and does not plan a release', async () => {
    const mock = recorder('emu_lab_build');
    const output = await invokeKit(
      'release_readiness',
      { plan: { provider: 'supabase' } },
      mock.invoke,
    );
    expect(output.status).toBe('fail');
    expect(output.evidence).toHaveLength(7);
    expect(
      (output.evidence as Result[]).slice(3).map((item) => item.status),
    ).toEqual(['blocked', 'blocked', 'blocked', 'blocked']);
    expect(
      (output.evidence as Result[]).slice(3).map(({ tool, operation }) => ({
        tool,
        operation,
      })),
    ).toEqual([
      { tool: 'emu-lab', operation: 'emu_lab_run_instrumentation' },
      { tool: 'maestro-flow', operation: 'maestro_flow_run' },
      { tool: 'backend', operation: 'backend_run_scenario' },
      { tool: 'release', operation: 'release_plan_change' },
    ]);
    expect(mock.calls.map((call) => call.name)).toEqual([
      'i18n_lint',
      'maestro_flow_lint',
      'emu_lab_build',
    ]);
  });
  it('prepares a plan only after verification, never executes it', async () => {
    const mock = recorder();
    const output = await invokeKit(
      'release_readiness',
      { plan: { provider: 'play' } },
      mock.invoke,
    );
    expect(output.status).toBe('pass');
    expect(mock.calls.at(-1)).toEqual({
      name: 'release_plan_change',
      args: { projectRoot: undefined, plan: { provider: 'play' } },
    });
    expect(mock.calls.some((call) => call.name === 'release_execute')).toBe(
      false,
    );
  });
  it('blocks readiness without a plan', async () => {
    const mock = recorder();
    const output = await invokeKit('release_readiness', {}, mock.invoke);
    expect(output.status).toBe('blocked');
    expect(mock.calls.some((call) => call.name === 'release_plan_change')).toBe(
      false,
    );
  });
  it('respects scope and rejects unknown scopes', async () => {
    const mock = recorder();
    expect(
      (
        await invokeKit(
          'verify',
          { scope: 'backend', backend: { file: 'scenario.yaml' } },
          mock.invoke,
        )
      ).status,
    ).toBe('pass');
    expect(mock.calls.map((call) => call.name)).toEqual([
      'backend_run_scenario',
    ]);
    expect(
      (await invokeKit('verify', { scope: 'invalid' as 'all' }, mock.invoke))
        .status,
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
      expect((output.evidence as Result[]).map((item) => item.status)).toEqual(
        Array(6).fill('unsupported'),
      );
      expect(
        (output.evidence as Result[]).map(({ tool, operation }) => ({
          tool,
          operation,
        })),
      ).toEqual([
        { tool: 'i18n', operation: 'i18n_lint' },
        { tool: 'maestro-flow', operation: 'maestro_flow_lint' },
        { tool: 'emu-lab', operation: 'emu_lab_build' },
        { tool: 'emu-lab', operation: 'emu_lab_run_instrumentation' },
        { tool: 'maestro-flow', operation: 'maestro_flow_run' },
        { tool: 'backend', operation: 'backend_run_scenario' },
      ]);
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
