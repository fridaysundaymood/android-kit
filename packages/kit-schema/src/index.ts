import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Ajv as AjvType } from 'ajv';
import type { FormatsPlugin } from 'ajv-formats';
import { parse } from 'yaml';

const require = createRequire(import.meta.url);
const Ajv = require('ajv') as typeof AjvType;
const addFormats = require('ajv-formats') as FormatsPlugin;
export const resultSchema = require('../result.v1.json') as Record<
  string,
  unknown
>;
export const configSchema = require('../config.v1.json') as Record<
  string,
  unknown
>;

export type Status =
  | 'pass'
  | 'fail'
  | 'flaky'
  | 'blocked'
  | 'unsupported'
  | 'error';
export type Classification = 'app' | 'test' | 'environment' | 'config';
export type SectionName =
  | 'emuLab'
  | 'maestroFlow'
  | 'backend'
  | 'i18n'
  | 'releaseGate';
export type SectionSchema = Record<string, unknown>;
export interface Result {
  schema_version: '1';
  tool: string;
  operation: string;
  run_id: string;
  status: Status;
  classification?: Classification;
  summary: string;
  evidence: unknown[];
  artifacts: string[];
  started_at: string;
  duration_ms: number;
}
export type ResultBuilder = Omit<
  Result,
  'schema_version' | 'started_at' | 'duration_ms'
> & {
  startedAt: Date;
};

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(resultSchema);

export function validateResult(value: unknown): value is Result {
  return validate(value) as boolean;
}

export function createResult({ startedAt, ...fields }: ResultBuilder): Result {
  const result: Result = {
    ...fields,
    schema_version: '1',
    started_at: startedAt.toISOString(),
    duration_ms: Math.max(0, Date.now() - startedAt.getTime()),
  };
  if (!validateResult(result))
    throw new Error(`Invalid result: ${ajv.errorsText(validate.errors)}`);
  return result;
}

export function exitCodeFor(status: Status): 0 | 1 | 2 {
  switch (status) {
    case 'pass':
      return 0;
    case 'fail':
    case 'flaky':
      return 1;
    case 'error':
    case 'blocked':
    case 'unsupported':
      return 2;
  }
}

export function newRunId(): string {
  return randomUUID();
}

function safePart(value: string): boolean {
  return (
    value.length > 0 && value !== '.' && value !== '..' && !/[\\/:]/.test(value)
  );
}

export function runArtifactDir(
  projectRoot: string,
  runId: string,
  tool: string,
): string {
  if (!safePart(runId) || !safePart(tool))
    throw new Error('Run ID and tool must be single path components');
  return join(projectRoot, '.android-kit', 'runs', runId, tool);
}

export async function writeArtifactIndex(
  projectRoot: string,
  runId: string,
  tool: string,
  artifacts: string[],
): Promise<string> {
  const root = resolve(projectRoot);
  const directory = resolve(runArtifactDir(root, runId, tool));
  const paths = artifacts.map((artifact) => {
    const absolute = resolve(root, artifact);
    const fromDirectory = relative(directory, absolute);
    if (
      isAbsolute(artifact) ||
      !fromDirectory ||
      fromDirectory === '..' ||
      fromDirectory.startsWith(`..${sep}`) ||
      isAbsolute(fromDirectory)
    ) {
      throw new Error(
        'Artifacts must be project-relative paths inside the run artifact directory',
      );
    }
    return relative(root, absolute).split(sep).join('/');
  });
  await mkdir(directory, { recursive: true });
  const index = join(directory, 'index.json');
  await writeFile(
    index,
    `${JSON.stringify({ artifacts: paths }, null, 2)}\n`,
    'utf8',
  );
  return relative(root, index).split(sep).join('/');
}

export function composeConfigSchema(
  sections: Partial<Record<SectionName, SectionSchema>> = {},
): Record<string, unknown> {
  const properties = configSchema.properties as Record<
    SectionName,
    SectionSchema
  >;
  return {
    ...configSchema,
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, base]) => [
        name,
        sections[name as SectionName]
          ? {
              ...base,
              ...sections[name as SectionName],
              type: 'object',
              additionalProperties: false,
            }
          : base,
      ]),
    ),
  };
}

export async function loadConfig<T = Record<string, unknown>>(
  path: string,
  section: { name: SectionName; schema: SectionSchema },
): Promise<T | undefined> {
  const config: unknown = parse(await readFile(path, 'utf8'));
  const validator = ajv.compile(
    composeConfigSchema({ [section.name]: section.schema }),
  );
  if (!validator(config))
    throw new Error(
      `Invalid android-kit configuration: ${ajv.errorsText(validator.errors)}`,
    );
  return (config as Partial<Record<SectionName, T>>)[section.name];
}

export function checkSchemaMajor(supported: number | string): void {
  if (String(supported) !== '1')
    throw new Error(
      `Incompatible kit-schema major: tool supports ${supported}, installed schema major is 1`,
    );
}
