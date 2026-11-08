import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import * as emu from '@budaknyenyel/emu-lab';
import * as i18n from '@budaknyenyel/i18n-mcp';
import {
  composeConfigSchema,
  createResult,
  newRunId,
  type Result,
  type Status,
  validateResult,
} from '@budaknyenyel/kit-schema';
import * as maestro from '@budaknyenyel/maestro-flow';
import * as backend from '@budaknyenyel/supa-multiuser-harness';
import * as release from '@budaknyenyel/supa-release-gate-mcp';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Ajv as AjvType } from 'ajv';
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
  failFast?: boolean;
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
};
export type ServerOptions = { projectRoot?: string; configPath?: string };
function releaseConfigPath(options: ServerOptions): string {
  return resolve(
    options.projectRoot ??
      process.env.ANDROID_KIT_PROJECT_ROOT ??
      process.cwd(),
    options.configPath ??
      process.env.ANDROID_KIT_RELEASE_CONFIG ??
      'android-kit.yaml',
  );
}
async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  options: ServerOptions,
): Promise<Result> {
  try {
    if (
      name.startsWith('kit_') &&
      kitOperations.includes(name.slice(4) as KitOperation)
    )
      return invokeKit(
        name.slice(4) as KitOperation,
        {
          ...args,
          ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
        } as KitArgs,
        invokeTool,
        options,
      );
    const tool = componentByName.get(name);
    if (tool) {
      if (name.startsWith('release_')) {
        if ('config' in args || 'configPath' in args || 'projectRoot' in args)
          throw new Error('Release configuration is fixed at launch');
        const configured = release
          .toolDefinitions({ configPath: releaseConfigPath(options) })
          .find((candidate) => candidate.name === name);
        if (configured) {
          const properties = configured.inputSchema.properties;
          if (Object.keys(args).some((key) => !Object.hasOwn(properties, key)))
            throw new Error(
              'Unexpected release tool argument; configuration is fixed at launch',
            );
          return await configured.handler(args);
        }
      }
      if (options.projectRoot) {
        const configured = [
          ...emu.toolDefinitions({ projectRoot: options.projectRoot }),
          ...maestro.toolDefinitions({ projectRoot: options.projectRoot }),
          ...backend.toolDefinitions({ projectRoot: options.projectRoot }),
          ...i18n.toolDefinitions({ projectRoot: options.projectRoot }),
        ].find((candidate) => candidate.name === name);
        if (configured) return await configured.handler(args as never);
      }
      if (doctors[name]) return await doctors[name](args);
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
  options: ServerOptions = {},
): Promise<Result> {
  const result: unknown = await dispatchTool(name, args, options);
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
  serverOptions: ServerOptions = {},
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
    if (args.failFast !== undefined && typeof args.failFast !== 'boolean')
      throw new Error('failFast must be a boolean');
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
        : await invoke(
            name,
            name.startsWith('release_') || invoke === invokeTool
              ? options
              : { ...root, ...options },
            serverOptions,
          );
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
      let firstFailure: string | undefined;
      const step = async (
        name: string,
        options: Record<string, unknown> = {},
        dependency?: string,
      ) => {
        const blocker =
          dependency ?? (args.failFast ? firstFailure : undefined);
        const result = await call(
          name,
          options,
          blocker && `Not run because ${blocker} did not pass`,
        );
        if (result.status !== 'pass' && !firstFailure) firstFailure = name;
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
        if (status !== 'pass' && !firstFailure) firstFailure = name;
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
        if (sections && !('maestroFlow' in sections))
          await step('maestro_flow_lint');
        if (!(args.failFast && firstFailure)) {
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
          args.failFast &&
          firstFailure &&
          !flows.length &&
          !(sections && !('maestroFlow' in sections))
        )
          await step('maestro_flow_lint', maestroOptions);
        for (const flow of flows)
          await step('maestro_flow_lint', { ...maestroOptions, flow });
      }
      if (scope === 'all' || scope === 'device') {
        const buildOptions = {
          ...object(emuConfig.build),
          ...object(args.build),
        };
        if (typeof buildOptions.projectRoot === 'string')
          buildOptions.projectRoot = resolve(
            rootPath,
            buildOptions.projectRoot,
          );
        const buildRoot =
          typeof buildOptions.projectRoot === 'string'
            ? buildOptions.projectRoot
            : rootPath;
        if (typeof buildOptions.variant !== 'string') {
          note(
            'emu_lab_build',
            'blocked',
            'Set build.variant to the Gradle variant to verify, for example debug.',
          );
          blockedBy = 'emu_lab_build';
        }
        const build = await step('emu_lab_build', buildOptions, blockedBy);
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
              gradle = await readFile(resolve(buildRoot, module, file), 'utf8');
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
        const instrumentationMissing =
          !apk ||
          !testApk ||
          typeof packageName !== 'string' ||
          typeof runner !== 'string';
        if (instrumentationMissing)
          note(
            'emu_lab_run_instrumentation',
            'blocked',
            'Provide instrumentation.packageName and instrumentation.runner (test package/runner), and build both app and androidTest APKs or set instrumentation.apk and testApk. Dynamic or variant-specific Gradle values require explicit arguments.',
          );
        if (!apk || typeof packageName !== 'string')
          blockedBy = 'emu_lab_build';
        else blockedBy = undefined;
        let leaseId: string | undefined;
        let hadLease = false;
        try {
          if (!blockedBy && !(args.failFast && firstFailure)) {
            const lease = await step(
              'emu_lab_lease_device',
              object(args.lease),
            );
            const value = object(lease.evidence[0]).leaseId;
            if (lease.status === 'pass' && typeof value === 'string' && value)
              leaseId = value;
            else if (lease.status === 'pass') {
              note(
                'emu_lab_lease_device',
                'error',
                'Device lease response did not include a leaseId; cannot safely run or release it.',
              );
              blockedBy = 'emu_lab_lease_device';
            } else blockedBy = 'emu_lab_lease_device';
          }
          if (leaseId) {
            hadLease = true;
            if (!instrumentationMissing)
              await step('emu_lab_run_instrumentation', {
                ...instrumentation,
                apk: resolve(buildRoot, String(apk)),
                testApk: resolve(buildRoot, String(testApk)),
                packageName,
                runner,
                leaseId,
              });
            let replacementAttempted = false;
            let flowBlocker: string | undefined;
            for (const flow of flows) {
              const runFlow = () =>
                call(
                  'maestro_flow_run',
                  {
                    ...maestroOptions,
                    flow,
                    suite: true,
                    emuLab: {
                      databasePath:
                        typeof emuConfig.databasePath === 'string'
                          ? resolve(emuConfig.databasePath)
                          : resolve(rootPath, '.android-kit/emu-lab.sqlite'),
                      leaseId,
                      packageName,
                    },
                  },
                  (flowBlocker ?? (args.failFast ? firstFailure : undefined)) &&
                    `Not run because ${flowBlocker ?? firstFailure} did not pass`,
                );
              const lostDevice = (result: Result) =>
                result.evidence.some((item) =>
                  ['emu-lab-quarantine', 'emu-lab-lease-unavailable'].includes(
                    String(object(item).kind),
                  ),
                );
              let flowResult = await runFlow();
              if (lostDevice(flowResult)) {
                leaseId = undefined;
                flowBlocker = 'the unavailable device lease';
                const interrupted = flowResult;
                interrupted.status = 'blocked';
                interrupted.classification = 'environment';
                if (!replacementAttempted) {
                  replacementAttempted = true;
                  const replacement = await step(
                    'emu_lab_lease_device',
                    object(args.lease),
                  );
                  const value = object(replacement.evidence[0]).leaseId;
                  if (
                    replacement.status === 'pass' &&
                    typeof value === 'string' &&
                    value
                  ) {
                    leaseId = value;
                    const install = await step('emu_lab_install', {
                      apk: resolve(buildRoot, String(apk)),
                      packageName,
                      leaseId,
                    });
                    flowBlocker =
                      install.status === 'pass' ? undefined : 'emu_lab_install';
                    if (!flowBlocker) {
                      results.splice(results.indexOf(interrupted), 1);
                      flowResult = await runFlow();
                      flowResult.evidence.unshift(interrupted);
                      if (lostDevice(flowResult)) {
                        leaseId = undefined;
                        flowBlocker = 'the unavailable device lease';
                        flowResult.status = 'blocked';
                        flowResult.classification = 'environment';
                      }
                    }
                  } else {
                    if (replacement.status === 'pass')
                      note(
                        'emu_lab_lease_device',
                        'error',
                        'Replacement device lease response did not include a leaseId; cannot safely run or release it.',
                      );
                    flowBlocker = 'emu_lab_lease_device';
                  }
                }
              }
              if (flowResult.status !== 'pass' && !firstFailure)
                firstFailure = 'maestro_flow_run';
            }
          }
        } finally {
          if (leaseId) {
            await call('emu_lab_release_device', { leaseId });
          }
        }
        if (!hadLease) {
          const dependency =
            blockedBy ?? (args.failFast ? firstFailure : undefined);
          if (
            !results.some((item) => item.operation === 'emu_lab_lease_device')
          )
            await step('emu_lab_lease_device', object(args.lease), dependency);
          if (
            !results.some(
              (item) => item.operation === 'emu_lab_run_instrumentation',
            )
          )
            await step(
              'emu_lab_run_instrumentation',
              instrumentation,
              dependency,
            );
          await step('maestro_flow_run', maestroOptions, dependency);
        }
      }
      if (scope === 'all' || scope === 'backend') {
        blockedBy = args.failFast ? firstFailure : undefined;
        if (!blockedBy) {
          const status = await step('backend_status');
          const running = object(status.evidence[0]).running;
          if (status.status !== 'pass') blockedBy = 'backend_status';
          else if (typeof running !== 'boolean') {
            note(
              'backend_status',
              'unsupported',
              'Backend status did not report whether the local stack is running.',
            );
            blockedBy = 'backend_status';
          }
          let started = false;
          try {
            if (!blockedBy && !running) {
              const up = await step('backend_stack_up');
              started = up.status === 'pass';
              if (!started) blockedBy = 'backend_stack_up';
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
            await step('backend_stack_verify', {}, blockedBy);
            if (typeof backendOptions.file === 'string')
              await step('backend_run_scenario', backendOptions, blockedBy);
            else if (blockedBy || componentByName.has('backend_default_suite'))
              await step('backend_default_suite', backendOptions, blockedBy);
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
          firstFailure
            ? `Not run because ${firstFailure} did not pass`
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
export function createServer(options: ServerOptions = {}): Server {
  const fixedOptions = {
    projectRoot: resolve(
      options.projectRoot ??
        process.env.ANDROID_KIT_PROJECT_ROOT ??
        process.cwd(),
    ),
    configPath: releaseConfigPath(options),
  };
  const server = new Server(
    { name: 'android-kit', version: '0.1.0' },
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
            scope: {
              type: 'string',
              enum: ['all', 'device', 'backend', 'lint'],
            },
            plan: { type: 'object' },
            failFast: { type: 'boolean' },
            i18n: { type: 'object' },
            maestro: { type: 'object' },
            build: { type: 'object' },
            instrumentation: { type: 'object' },
            backend: { type: 'object' },
          },
          additionalProperties: false,
        },
      })),
      ...componentTools.map(({ name, description, inputSchema }) => {
        if (!name.startsWith('release_'))
          return {
            name,
            description,
            inputSchema: inputSchema as {
              type: 'object';
              [key: string]: unknown;
            },
          };
        const { config, configPath, projectRoot, ...properties } =
          (inputSchema.properties ?? {}) as Record<string, unknown>;
        const required = Array.isArray(inputSchema.required)
          ? inputSchema.required.filter(
              (key) => !['config', 'configPath', 'projectRoot'].includes(key),
            )
          : undefined;
        return {
          name,
          description,
          inputSchema: {
            ...inputSchema,
            type: 'object' as const,
            properties,
            ...(required ? { required } : {}),
            additionalProperties: false,
          },
        };
      }),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    const forbidden = [
      'projectRoot',
      'config',
      'configPath',
      'executable',
      'adbPath',
      'gradlePath',
      'maestroPath',
      'supabasePath',
    ];
    const sections = request.params.name.startsWith('kit_')
      ? ['build', 'instrumentation', 'maestro', 'backend', 'i18n'].map((key) =>
          object(args[key]),
        )
      : [];
    const rejected = [args, ...sections].some((input) =>
      forbidden.some((key) => key in input),
    );
    const result = rejected
      ? failure(
          'kit',
          request.params.name,
          new Error('Launch configuration cannot be changed by a tool call'),
        )
      : await invokeTool(request.params.name, args, fixedOptions);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      structuredContent: { ...result },
      isError: result.status !== 'pass',
    };
  });
  return server;
}
export async function runStdio(options: ServerOptions = {}): Promise<void> {
  await createServer(options).connect(new StdioServerTransport());
}
