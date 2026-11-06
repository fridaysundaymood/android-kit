import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkSchemaMajor,
  composeConfigSchema,
  createResult,
  exitCodeFor,
  loadConfig,
  newRunId,
  runArtifactDir,
  validateResult,
  writeArtifactIndex,
} from './index.js';

describe('result contract', () => {
  it('maps every status to its exit code', () => {
    expect(
      ['pass', 'fail', 'flaky', 'blocked', 'unsupported', 'error'].map(
        (status) => exitCodeFor(status as Parameters<typeof exitCodeFor>[0]),
      ),
    ).toEqual([0, 1, 1, 2, 2, 2]);
  });
  it('validates envelopes and rejects absolute or escaping artifacts', () => {
    const result = createResult({
      tool: 'sample',
      operation: 'check',
      run_id: newRunId(),
      status: 'pass',
      summary: 'OK',
      evidence: [],
      artifacts: ['.android-kit/runs/run/sample/log.txt'],
      startedAt: new Date(),
    });
    expect(validateResult(result)).toBe(true);
    expect(validateResult({ ...result, status: 'unknown' })).toBe(false);
    expect(validateResult({ ...result, extra: true })).toBe(false);
    expect(validateResult({ ...result, artifacts: ['/absolute'] })).toBe(false);
    expect(validateResult({ ...result, artifacts: ['../escape'] })).toBe(false);
    expect(validateResult({ ...result, artifacts: ['C:\\absolute'] })).toBe(
      false,
    );
    expect(validateResult({ ...result, started_at: 'not-a-date' })).toBe(false);
  });
  it('refuses incompatible schema majors', () => {
    expect(() => checkSchemaMajor(1)).not.toThrow();
    expect(() => checkSchemaMajor(2)).toThrow(/Incompatible kit-schema major/);
  });
  it('writes project-relative artifact indexes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kit-schema-'));
    try {
      const artifact = '.android-kit/runs/run/sample/log.txt';
      expect(runArtifactDir(root, 'run', 'sample')).toBe(
        join(root, '.android-kit', 'runs', 'run', 'sample'),
      );
      const index = await writeArtifactIndex(root, 'run', 'sample', [artifact]);
      expect(index).toBe('.android-kit/runs/run/sample/index.json');
      expect(JSON.parse(await readFile(join(root, index), 'utf8'))).toEqual({
        artifacts: [artifact],
      });
      await expect(
        writeArtifactIndex(root, 'run', 'sample', ['../outside']),
      ).rejects.toThrow();
      expect(() => runArtifactDir(root, '../run', 'sample')).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('configuration', () => {
  it('loads only the requested section and rejects unknown keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kit-config-'));
    const path = join(root, 'android-kit.yaml');
    const section = {
      name: 'emuLab' as const,
      schema: { properties: { enabled: { type: 'boolean' } } },
    };
    try {
      await writeFile(
        path,
        'emuLab:\n  enabled: true\nbackend:\n  ownedByBackend: true\n',
      );
      expect(await loadConfig(path, section)).toEqual({ enabled: true });
      await writeFile(path, 'emuLab:\n  surprise: true\n');
      await expect(loadConfig(path, section)).rejects.toThrow(
        /additional properties/,
      );
      await writeFile(path, 'unknown: {}\n');
      await expect(loadConfig(path, section)).rejects.toThrow(
        /additional properties/,
      );
      expect(composeConfigSchema({ emuLab: section.schema })).toHaveProperty(
        'properties.emuLab.additionalProperties',
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
