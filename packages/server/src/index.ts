import { readFile } from 'node:fs/promises';
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
      return result.status === 'pass';
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
      const steps: [string, Record<string, unknown>][] = [];
      if (scope === 'all' || scope === 'lint' || scope === 'device')
        steps.push(
          ['i18n_lint', object(args.i18n)],
          ['maestro_flow_lint', object(args.maestro)],
        );
      if (scope === 'all' || scope === 'device')
        steps.push(
          ['emu_lab_build', object(args.build)],
          ['emu_lab_run_instrumentation', object(args.instrumentation)],
          ['maestro_flow_run', object(args.maestro)],
        );
      if (scope === 'all' || scope === 'backend')
        steps.push(['backend_run_scenario', object(args.backend)]);
      if (operation === 'release_readiness')
        steps.push(['release_plan_change', { plan: args.plan }]);
      let blockedBy: string | undefined;
      for (const [name, options] of steps) {
        const reason = blockedBy
          ? `Not run because ${blockedBy} did not pass`
          : name === 'release_plan_change' && !args.plan
            ? 'A release plan is required'
            : undefined;
        if (!(await call(name, options, reason)) && !blockedBy)
          blockedBy = name;
      }
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
