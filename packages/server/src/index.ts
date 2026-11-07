import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import * as emu from '@android-kit/emu-lab';
import * as i18n from '@android-kit/i18n-mcp';
import {
  composeConfigSchema,
  createResult,
  newRunId,
  type Result,
  type Status,
  validateResult,
} from '@android-kit/schema';
import * as backend from '@android-kit/supa-multiuser-harness';
import * as release from '@android-kit/supa-release-gate-mcp';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Ajv as AjvType } from 'ajv';
import * as maestro from 'maestro-flow';
import { parse } from 'yaml';

const components = [emu, maestro, backend, release, i18n];
for (const component of components) {
  if (!component.supportedSchemaMajors.includes(1))
    throw new Error(
      `Incompatible kit-schema major for ${component.configSection}: expected 1`,
    );
}
type ComponentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<Result>;
};
const componentTools = [
  ...emu.toolDefinitions(),
  ...maestro.toolDefinitions(),
  ...backend.toolDefinitions(),
  ...release.toolDefinitions(),
  ...i18n.toolDefinitions(),
] as ComponentTool[];
const componentByName = new Map(
  componentTools.map((tool) => [tool.name, tool]),
);
if (componentByName.size !== componentTools.length)
  throw new Error('Duplicate component tool name');
const kitOperations = [
  'status',
  'verify',
  'release_readiness',
  'doctor',
] as const;
type KitOperation = (typeof kitOperations)[number];
export type KitArgs = {
  projectRoot?: string;
  scope?: 'all' | 'device' | 'backend' | 'lint';
  plan?: Record<string, unknown>;
  [key: string]: unknown;
};
export const toolNames = [
  ...kitOperations.map((x) => `kit_${x}`),
  ...componentTools.map((tool) => tool.name),
];
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function failure(
  tool: string,
  operation: string,
  error: unknown,
  startedAt = new Date(),
): Result {
  return createResult({
    tool,
    operation,
    run_id: newRunId(),
    status: 'error',
    classification: 'environment',
    summary: error instanceof Error ? error.message : String(error),
    evidence: [],
    artifacts: [],
    startedAt,
  });
}
const doctors: Record<
  string,
  (args: Record<string, unknown>) => Promise<Result>
> = {
  emu_lab_doctor: (args) => emu.doctor(args),
  maestro_flow_doctor: (args) => maestro.doctor(args),
  backend_doctor: (args) => backend.doctor(args),
  i18n_doctor: (args) =>
    i18n.doctor({
      projectRoot:
        typeof args.projectRoot === 'string' ? args.projectRoot : undefined,
    }),
  release_doctor: (args) =>
    release.doctor({ configPath: releaseConfigPath(args) }),
};
function releaseConfigPath(args: Record<string, unknown>): string {
  return resolve(
    typeof args.projectRoot === 'string' ? args.projectRoot : process.cwd(),
    typeof args.config === 'string' ? args.config : 'android-kit.yaml',
  );
}
async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Result> {
  try {
    if (
      name.startsWith('kit_') &&
      kitOperations.includes(name.slice(4) as KitOperation)
    )
      return invokeKit(name.slice(4) as KitOperation, args as KitArgs);
    const tool = componentByName.get(name);
    if (tool) {
      if (doctors[name]) return await doctors[name](args);
      if (name.startsWith('release_')) {
        const configured = release
          .toolDefinitions({ configPath: releaseConfigPath(args) })
          .find((candidate) => candidate.name === name);
        if (configured) return await configured.handler(args);
      }
      return await tool.handler(args);
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return failure('kit', name, error);
  }
}
export async function invokeTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<Result> {
  const result: unknown = await dispatchTool(name, args);
  return validateResult(result)
    ? result
    : failure(
        'kit',
        name,
        new Error(`Invalid or incompatible result schema from ${name}`),
      );
}
const rank: Record<Status, number> = {
  pass: 0,
  blocked: 1,
  unsupported: 2,
  flaky: 3,
  fail: 4,
  error: 5,
};
const Ajv = createRequire(import.meta.url)('ajv') as typeof AjvType;
const configValidator = new Ajv({ allErrors: true }).compile(
  composeConfigSchema(
    Object.fromEntries(
      components.map((component) => [
        component.configSection,
        component.configSectionSchema,
      ]),
    ),
  ),
);
async function readSections(root: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(resolve(root, 'android-kit.yaml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const config: unknown = parse(text);
  if (!configValidator(config))
    throw new Error(
      `Invalid android-kit configuration: ${JSON.stringify(configValidator.errors)}`,
    );
  return object(config);
}
export async function invokeKit(
  operation: KitOperation,
  args: KitArgs = {},
  invoke: typeof invokeTool = invokeTool,
): Promise<Result> {
  const startedAt = new Date();
  const results: Result[] = [];
  try {
    if (!kitOperations.includes(operation))
      throw new Error(`Unknown kit operation: ${operation}`);
    const scope = args.scope ?? 'all';
    if (!['all', 'device', 'backend', 'lint'].includes(scope))
      throw new Error(`Unknown scope: ${scope}`);
    if (operation === 'release_readiness' && scope !== 'all')
      throw new Error('Release readiness requires full verification');
    const root = { projectRoot: args.projectRoot };
    const sections =
      invoke === invokeTool
        ? await readSections(args.projectRoot ?? process.cwd())
        : undefined;
    const call = async (
      name: string,
      options: Record<string, unknown> = {},
      skipped?: string,
    ) => {
      const section = name.startsWith('emu_lab_')
        ? 'emuLab'
        : name.startsWith('maestro_flow_')
          ? 'maestroFlow'
          : name.startsWith('backend_')
            ? 'backend'
            : name.startsWith('i18n_')
              ? 'i18n'
              : 'releaseGate';
      const missing =
        operation !== 'doctor' && !!sections && !(section in sections);
      const reason = missing ? `Missing ${section} configuration` : skipped;
      const result = reason
        ? createResult({
            tool: {
              emuLab: 'emu-lab',
              maestroFlow: 'maestro-flow',
              backend: 'backend',
              i18n: 'i18n',
              releaseGate: 'release',
            }[section],
            operation: name,
            run_id: newRunId(),
            status: missing ? 'unsupported' : 'blocked',
            classification: 'config',
            summary: reason,
            evidence: [],
            artifacts: [],
            startedAt,
          })
        : await invoke(name, { ...root, ...options });
      results.push(result);
      return result;
    };
    if (operation === 'status') {
      await call('emu_lab_status');
      await call('backend_status');
      await call('i18n_lint', object(args.i18n));
      await call('release_status');
    } else if (operation === 'doctor') {
      for (const name of [
        'emu_lab_doctor',
        'maestro_flow_doctor',
        'backend_doctor',
        'i18n_doctor',
        'release_doctor',
      ])
        await call(name);
    } else {
      const rootPath = args.projectRoot ?? process.cwd();
      const maestroOptions = object(args.maestro);
      const maestroConfig = object(sections?.maestroFlow);
      const emuConfig = object(sections?.emuLab);
      const instrumentation = object(args.instrumentation);
      const backendOptions = object(args.backend);
      let blockedBy: string | undefined;
      const step = async (
        name: string,
        options: Record<string, unknown> = {},
      ) => {
        const result = await call(
          name,
          options,
          blockedBy && `Not run because ${blockedBy} did not pass`,
        );
        if (result.status !== 'pass' && !blockedBy) blockedBy = name;
        return result;
      };
      const note = (name: string, status: Status, summary: string) => {
        const result = createResult({
          tool: 'kit',
          operation: name,
          run_id: newRunId(),
          status,
          classification: 'config',
          summary,
          evidence: [],
          artifacts: [],
          startedAt,
        });
        results.push(result);
        if (status !== 'pass' && !blockedBy) blockedBy = name;
      };
      let flows: string[] = [];
      if (scope === 'all' || scope === 'lint' || scope === 'device') {
        if (!sections || 'i18n' in sections || args.i18n)
          await step('i18n_lint', object(args.i18n));
        const selected = maestroOptions.flow ?? maestroConfig.flow;
        const findFlows = async (directory: string): Promise<string[]> => {
          const entries = await readdir(directory, { withFileTypes: true });
          const paths = await Promise.all(
            entries.map((entry) =>
              entry.isDirectory()
                ? findFlows(resolve(directory, entry.name))
                : Promise.resolve(
                    entry.isFile() && /\.ya?ml$/i.test(entry.name)
                      ? [resolve(directory, entry.name)]
                      : [],
                  ),
            ),
          );
          return paths.flat().sort();
        };
        if (!blockedBy && sections && !('maestroFlow' in sections))
          await step('maestro_flow_lint');
        if (!blockedBy) {
          try {
            flows =
              typeof selected === 'string'
                ? [selected]
                : await findFlows(
                    resolve(
                      rootPath,
                      String(
                        maestroOptions.flowsDir ??
                          maestroConfig.flowsDir ??
                          'e2e/maestro',
                      ),
                    ),
                  );
            if (!flows.length)
              note(
                'maestro_flow_lint',
                'blocked',
                'No Maestro YAML flows found; set maestro.flowsDir or maestro.flow.',
              );
          } catch (error) {
            note(
              'maestro_flow_lint',
              'blocked',
              `Cannot find Maestro flows: ${error instanceof Error ? error.message : String(error)}. Set maestro.flowsDir or maestro.flow.`,
            );
          }
        }
        if (
          blockedBy &&
          !flows.length &&
          !(sections && !('maestroFlow' in sections))
        )
          await step('maestro_flow_lint', maestroOptions);
        for (const flow of flows) {
          const result = await call(
            'maestro_flow_lint',
            { ...maestroOptions, flow },
            blockedBy && `Not run because ${blockedBy} did not pass`,
          );
          if (result.status !== 'pass' && !blockedBy)
            blockedBy = 'maestro_flow_lint';
        }
      }
      if (scope === 'all' || scope === 'device') {
        const buildOptions = {
          ...object(emuConfig.build),
          ...object(args.build),
        };
        if (!blockedBy && typeof buildOptions.variant !== 'string')
          note(
            'emu_lab_build',
            'blocked',
            'Set build.variant to the Gradle variant to verify, for example debug.',
          );
        const build = await step('emu_lab_build', buildOptions);
        const apk =
          typeof instrumentation.apk === 'string'
            ? instrumentation.apk
            : build?.artifacts.find(
                (path) => /\.apk$/i.test(path) && !/androidtest/i.test(path),
              );
        const testApk =
          typeof instrumentation.testApk === 'string'
            ? instrumentation.testApk
            : build?.artifacts.find(
                (path) => /\.apk$/i.test(path) && /androidtest/i.test(path),
              );
        let packageName =
          instrumentation.packageName ??
          maestroOptions.appId ??
          maestroConfig.appId;
        let runner = instrumentation.runner;
        if (typeof packageName !== 'string' || typeof runner !== 'string') {
          const module =
            typeof buildOptions.module === 'string'
              ? buildOptions.module
              : 'app';
          let gradle = '';
          for (const file of ['build.gradle.kts', 'build.gradle']) {
            try {
              gradle = await readFile(resolve(rootPath, module, file), 'utf8');
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
            }
          }
          const literal = (key: string) => {
            const matches = [
              ...gradle.matchAll(
                new RegExp(`\\b${key}\\s*(?:=\\s*)?["']([^"'$]+)["']`, 'g'),
              ),
            ];
            return matches.length === 1 ? matches[0]?.[1] : undefined;
          };
          const applicationId = !/\bapplicationIdSuffix\b/.test(gradle)
            ? literal('applicationId')
            : undefined;
          if (typeof packageName !== 'string') packageName = applicationId;
          const runnerClass = literal('testInstrumentationRunner');
          const testPackage = /\btestApplicationId\b/.test(gradle)
            ? literal('testApplicationId')
            : applicationId
              ? `${applicationId}.test`
              : undefined;
          if (typeof runner !== 'string' && runnerClass && testPackage)
            runner = `${testPackage}/${runnerClass}`;
        }
        if (
          !blockedBy &&
          (!apk ||
            !testApk ||
            typeof packageName !== 'string' ||
            typeof runner !== 'string')
        )
          note(
            'emu_lab_run_instrumentation',
            'blocked',
            'Provide instrumentation.packageName and instrumentation.runner (test package/runner), and build both app and androidTest APKs or set instrumentation.apk and testApk. Dynamic or variant-specific Gradle values require explicit arguments.',
          );
        let leaseId: string | undefined;
        try {
          if (!blockedBy) {
            const lease = await step(
              'emu_lab_lease_device',
              object(args.lease),
            );
            const value = object(lease.evidence[0]).leaseId;
            if (lease.status === 'pass' && typeof value === 'string' && value)
              leaseId = value;
            else if (lease.status === 'pass')
              note(
                'emu_lab_lease_device',
                'error',
                'Device lease response did not include a leaseId; cannot safely run or release it.',
              );
          }
          if (leaseId) {
            await step('emu_lab_run_instrumentation', {
              ...instrumentation,
              apk: resolve(rootPath, String(apk)),
              testApk: resolve(rootPath, String(testApk)),
              packageName,
              runner,
              leaseId,
            });
            if (!blockedBy) {
              for (const flow of flows) {
                const result = await call('maestro_flow_run', {
                  ...maestroOptions,
                  flow,
                  suite: true,
                  emuLab: {
                    databasePath:
                      emuConfig.databasePath ?? '.android-kit/emu-lab.sqlite',
                    leaseId,
                    packageName,
                  },
                });
                if (result.status !== 'pass' && !blockedBy)
                  blockedBy = 'maestro_flow_run';
              }
            }
          }
        } finally {
          if (leaseId) {
            const released = await call('emu_lab_release_device', { leaseId });
            if (released.status !== 'pass' && !blockedBy)
              blockedBy = 'emu_lab_release_device';
          }
        }
        if (!leaseId && blockedBy) {
          if (
            !results.some((item) => item.operation === 'emu_lab_lease_device')
          )
            await step('emu_lab_lease_device', object(args.lease));
          if (
            !results.some(
              (item) => item.operation === 'emu_lab_run_instrumentation',
            )
          )
            await step('emu_lab_run_instrumentation', instrumentation);
          await step('maestro_flow_run', maestroOptions);
        } else if (
          leaseId &&
          blockedBy &&
          !results.some((item) => item.operation === 'maestro_flow_run')
        ) {
          await step('maestro_flow_run', maestroOptions);
        }
      }
      if (scope === 'all' || scope === 'backend') {
        if (!blockedBy) {
          const status = await step('backend_status');
          const running = object(status.evidence[0]).running;
          if (status.status === 'pass' && typeof running !== 'boolean')
            note(
              'backend_status',
              'unsupported',
              'Backend status did not report whether the local stack is running.',
            );
          let started = false;
          try {
            if (!blockedBy && !running) {
              const up = await step('backend_stack_up');
              started = up.status === 'pass';
              if (started)
                results.push(
                  createResult({
                    tool: 'kit',
                    operation: 'backend_ownership',
                    run_id: newRunId(),
                    status: 'pass',
                    summary:
                      'Stack was stopped at preflight; backend API has no atomic ownership token, so concurrent starts can race.',
                    evidence: [],
                    artifacts: [],
                    startedAt,
                  }),
                );
            }
            if (!blockedBy) await step('backend_stack_verify');
            if (typeof backendOptions.file === 'string')
              await step('backend_run_scenario', backendOptions);
            else if (blockedBy || componentByName.has('backend_default_suite'))
              await step('backend_default_suite', backendOptions);
            else
              note(
                'backend_default_suite',
                'unsupported',
                'Default backend suite unavailable in installed harness version.',
              );
          } finally {
            if (started) await call('backend_stack_down');
          }
        } else {
          await step('backend_status');
          await step('backend_stack_verify');
          await step(
            typeof backendOptions.file === 'string'
              ? 'backend_run_scenario'
              : 'backend_default_suite',
            backendOptions,
          );
        }
      }
      if (operation === 'release_readiness')
        await call(
          'release_plan_change',
          { plan: args.plan },
          blockedBy
            ? `Not run because ${blockedBy} did not pass`
            : !args.plan
              ? 'A release plan is required'
              : undefined,
        );
    }
    const status = results.reduce<Status>(
      (worst, result) =>
        rank[result.status] > rank[worst] ? result.status : worst,
      'pass',
    );
    return createResult({
      tool: 'kit',
      operation,
      run_id: newRunId(),
      status,
      summary: `${operation}: ${status}`,
      evidence: results,
      artifacts: results.flatMap((result) => result.artifacts),
      startedAt,
    });
  } catch (error) {
    return failure('kit', operation, error, startedAt);
  }
}
export function createServer(): Server {
  const server = new Server(
    { name: 'android-kit', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...kitOperations.map((operation) => ({
        name: `kit_${operation}`,
        description: `Run kit_${operation}`,
        inputSchema: {
          type: 'object' as const,
          properties: {
            projectRoot: { type: 'string' },
            scope: {
              type: 'string',
              enum: ['all', 'device', 'backend', 'lint'],
            },
            plan: { type: 'object' },
            i18n: { type: 'object' },
            maestro: { type: 'object' },
            build: { type: 'object' },
            instrumentation: { type: 'object' },
            backend: { type: 'object' },
          },
          additionalProperties: true,
        },
      })),
      ...componentTools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema: inputSchema as { type: 'object'; [key: string]: unknown },
      })),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await invokeTool(
      request.params.name,
      request.params.arguments ?? {},
    );
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      structuredContent: { ...result },
      isError: result.status !== 'pass',
    };
  });
  return server;
}
export async function runStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
