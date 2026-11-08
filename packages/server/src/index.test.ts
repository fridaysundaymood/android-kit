import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolDefinitions as emuTools } from '@budaknyenyel/emu-lab';
import { toolDefinitions as i18nTools } from '@budaknyenyel/i18n-mcp';
import {
  createResult,
  type Result,
  type Status,
} from '@budaknyenyel/kit-schema';
import { toolDefinitions as maestroTools } from '@budaknyenyel/maestro-flow';
import { toolDefinitions as backendTools } from '@budaknyenyel/supa-multiuser-harness';
import { toolDefinitions as releaseTools } from '@budaknyenyel/supa-release-gate-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createServer, invokeKit, toolNames } from './index.js';

it('pins release configuration at server creation and rejects per-call overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kit-release-config-'));
  const other = await mkdtemp(join(tmpdir(), 'kit-release-other-'));
  const { publicKey } = generateKeyPairSync('ed25519');
  const config = JSON.stringify({
    releaseGate: {
      directory: 'ledger',
      approvalDirectory: 'approvals',
      trustedPublicKeys: {
        test: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
      policies: [
        {
          provider: 'synthetic',
          target: 'app',
          operation: 'release',
          id: 'test',
          mode: 'write',
        },
      ],
    },
  });
  const server = createServer({
    projectRoot: root,
    configPath: 'trusted.yaml',
  });
  const client = new Client({
    name: 'release-security-test',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await writeFile(join(root, 'trusted.yaml'), config, { mode: 0o600 });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();
    expect(
      tools.find((tool) => tool.name === 'release_status')?.inputSchema
        .additionalProperties,
    ).toBe(false);
    const properties = tools.find((tool) => tool.name === 'release_status')
      ?.inputSchema.properties;
    expect(properties).not.toHaveProperty('config');
    expect(properties).not.toHaveProperty('configPath');
    expect(properties).not.toHaveProperty('projectRoot');
    expect(
      (await client.callTool({ name: 'release_status', arguments: {} }))
        .structuredContent,
    ).toMatchObject({ status: 'pass' });
    for (const args of [
      { projectRoot: other },
      { config: 'other.yaml' },
      { configPath: join(other, 'other.yaml') },
    ]) {
      const result = await client.callTool({
        name: 'release_status',
        arguments: args,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 'error' });
    }
    for (const name of [
      'kit_doctor',
      'emu_lab_doctor',
      'maestro_flow_doctor',
      'backend_doctor',
      'i18n_doctor',
    ]) {
      const result = await client.callTool({
        name,
        arguments: { projectRoot: other },
      });
      expect(result.isError).toBe(true);
    }
    expect(
      (await client.callTool({ name: 'release_status', arguments: {} }))
        .structuredContent,
    ).toMatchObject({ status: 'pass' });
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
}, 30_000);

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
    ).toEqual(
      expect.objectContaining({
        leaseId: 'lease-1',
        databasePath: join(process.cwd(), '.android-kit', 'emu-lab.sqlite'),
      }),
    );
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
        mock.calls.find(({ name }) => name === 'maestro_flow_run')?.args.emuLab,
      ).toEqual(
        expect.objectContaining({
          databasePath: join(projectRoot, '.android-kit', 'emu-lab.sqlite'),
        }),
      );
      expect(
        mock.calls.filter(({ name }) => name === 'maestro_flow_run'),
      ).toHaveLength(2);
      expect(mock.calls.at(-1)?.name).toBe('emu_lab_release_device');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
  it.each([
    ['emu-lab-quarantine', true, true],
    ['emu-lab-quarantine', false, false],
    ['emu-lab-quarantine', true, false],
    ['emu-lab-lease-unavailable', true, true],
  ] as const)(
    'replaces a suite lease after %s (lease: %s, install: %s)',
    async (kind, replacementSucceeds, installSucceeds) => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'kit-recovery-'));
      try {
        await mkdir(join(projectRoot, 'flows'));
        for (const name of ['a', 'b', 'c'])
          await writeFile(
            join(projectRoot, 'flows', `${name}.yaml`),
            'appId: example',
          );
        const mock = recorder();
        let leases = 0;
        let runs = 0;
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
          async (name, args) => {
            const response = await mock.invoke(name, args);
            if (name === 'emu_lab_lease_device') {
              leases++;
              response.evidence =
                leases === 1
                  ? [{ leaseId: 'lease-1' }]
                  : replacementSucceeds
                    ? [{ leaseId: 'lease-2' }]
                    : [];
              if (leases === 2 && !replacementSucceeds)
                response.status = 'error';
            }
            if (name === 'emu_lab_install' && !installSucceeds)
              response.status = 'error';
            if (name === 'maestro_flow_run' && ++runs === 1) {
              response.status = 'error';
              response.classification = 'environment';
              response.evidence = [
                {
                  kind,
                  reason: 'synthetic device failure',
                },
              ];
            }
            return response;
          },
        );
        const flowResults = output.evidence.filter(
          (item): item is Result =>
            !!item &&
            typeof item === 'object' &&
            'operation' in item &&
            item.operation === 'maestro_flow_run',
        );
        expect(flowResults.map((item) => item.status)).toEqual(
          replacementSucceeds && installSucceeds
            ? ['pass', 'pass', 'pass']
            : ['blocked', 'blocked', 'blocked'],
        );
        const interrupted =
          replacementSucceeds && installSucceeds
            ? (flowResults[0]?.evidence[0] as Result)
            : flowResults[0];
        expect(interrupted?.classification).toBe('environment');
        expect(interrupted?.evidence).toContainEqual(
          expect.objectContaining({ kind }),
        );
        expect(leases).toBe(2);
        expect(runs).toBe(replacementSucceeds && installSucceeds ? 4 : 1);
        expect(
          mock.calls
            .filter(({ name }) => name === 'maestro_flow_run')
            .map(({ args }) => {
              const target = args.emuLab;
              return target && typeof target === 'object' && 'leaseId' in target
                ? target.leaseId
                : undefined;
            }),
        ).toEqual(
          replacementSucceeds && installSucceeds
            ? ['lease-1', 'lease-2', 'lease-2', 'lease-2']
            : ['lease-1'],
        );
        expect(
          mock.calls
            .filter(({ name }) => name === 'emu_lab_release_device')
            .map(({ args }) => args.leaseId),
        ).toEqual(replacementSucceeds ? ['lease-2'] : []);
        const installs = mock.calls.filter(
          ({ name }) => name === 'emu_lab_install',
        );
        expect(installs).toHaveLength(replacementSucceeds ? 1 : 0);
        if (replacementSucceeds)
          expect(installs[0]?.args).toMatchObject({
            apk: join(projectRoot, 'app.apk'),
            packageName: 'dev.example',
            leaseId: 'lease-2',
          });
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    },
  );
  it.each([false, true])(
    'retries a lost final flow; retry loss: %s',
    async (retryLosesDevice) => {
      const mock = recorder();
      let leases = 0;
      let runs = 0;
      const output = await invokeKit(
        'verify',
        {
          scope: 'device',
          failFast: true,
          build: { variant: 'debug' },
          instrumentation: {
            packageName: 'dev.example',
            runner: 'dev.example.test/Runner',
          },
          maestro: { flow: 'last.yaml' },
        },
        async (name, args) => {
          const response = await mock.invoke(name, args);
          if (name === 'emu_lab_lease_device')
            response.evidence = [{ leaseId: `lease-${++leases}` }];
          if (
            name === 'maestro_flow_run' &&
            (++runs === 1 || retryLosesDevice)
          ) {
            response.status = 'error';
            response.classification = 'environment';
            response.evidence = [{ kind: 'emu-lab-quarantine' }];
          }
          return response;
        },
      );
      expect(output.status).toBe(retryLosesDevice ? 'blocked' : 'pass');
      expect(runs).toBe(2);
      expect(leases).toBe(2);
      expect(
        mock.calls.filter(({ name }) => name === 'emu_lab_install'),
      ).toHaveLength(1);
      expect(
        mock.calls.filter(({ name }) => name === 'emu_lab_release_device'),
      ).toHaveLength(retryLosesDevice ? 0 : 1);
    },
  );
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
  it('stops a started stack on failure and runs the default suite', async () => {
    const mock = recorder('backend_stack_verify');
    expect(
      (await invokeKit('verify', { scope: 'backend' }, mock.invoke)).status,
    ).toBe('fail');
    expect(mock.calls.at(-1)?.name).toBe('backend_stack_down');
    const other = recorder();
    expect(
      (await invokeKit('verify', { scope: 'backend' }, other.invoke)).status,
    ).toBe('pass');
    expect(other.calls.map(({ name }) => name)).toContain(
      'backend_default_suite',
    );
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
  it('continues independent backend checks after a device build failure', async () => {
    const mock = recorder('emu_lab_build');
    const output = await invokeKit(
      'verify',
      {
        scope: 'all',
        build: { variant: 'debug' },
        maestro: { flow: 'flow.yaml' },
      },
      mock.invoke,
    );
    const invoked = mock.calls.map(({ name }) => name);
    expect(output.status).toBe('fail');
    expect(invoked).not.toContain('emu_lab_lease_device');
    expect(invoked).toContain('backend_default_suite');
    expect(invoked).toContain('backend_stack_down');
  });

  it('skips independent checks after a failure when failFast is enabled', async () => {
    const mock = recorder('i18n_lint');
    const output = await invokeKit(
      'verify',
      {
        scope: 'all',
        failFast: true,
        build: { variant: 'debug' },
        maestro: { flow: 'flow.yaml' },
      },
      mock.invoke,
    );
    expect(output.status).toBe('fail');
    expect(mock.calls.map(({ name }) => name)).toEqual(['i18n_lint']);
  });

  it('uses the build project root for Gradle settings and relative APK artifacts', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'kit-build-root-'));
    const buildRoot = join(projectRoot, 'nested');
    try {
      await mkdir(join(buildRoot, 'app'), { recursive: true });
      await writeFile(
        join(buildRoot, 'app', 'build.gradle.kts'),
        'android { defaultConfig { applicationId = "dev.synthetic"; testInstrumentationRunner = "dev.synthetic.Runner" } }',
      );
      const mock = recorder();
      const output = await invokeKit(
        'verify',
        {
          projectRoot,
          scope: 'device',
          build: { projectRoot: buildRoot, variant: 'debug' },
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
          apk: join(buildRoot, 'app.apk'),
          testApk: join(buildRoot, 'androidTest.apk'),
          packageName: 'dev.synthetic',
          runner: 'dev.synthetic.test/dev.synthetic.Runner',
        }),
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('routes the default suite through the harness tool definition', async () => {
    expect(backendTools().map(({ name }) => name)).toContain(
      'backend_default_suite',
    );
    const mock = recorder();
    const output = await invokeKit('verify', { scope: 'backend' }, mock.invoke);
    expect(output.status).toBe('pass');
    expect(mock.calls.map(({ name }) => name)).toContain(
      'backend_default_suite',
    );
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
