import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateResult } from '@android-kit/schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

it('serves prefixed tools and a valid doctor result over stdio', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-kit-mcp-'));
  const client = new Client({
    name: 'android-kit-compat-test',
    version: '1.0.0',
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url)),
      'mcp',
    ],
    cwd: root,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    const prefixes = [
      'kit_',
      'emu_lab_',
      'maestro_flow_',
      'backend_',
      'release_',
      'i18n_',
    ];
    for (const prefix of prefixes) {
      expect(names.some((name) => name.startsWith(prefix))).toBe(true);
    }
    expect(
      names.every((name) => prefixes.some((prefix) => name.startsWith(prefix))),
    ).toBe(true);
    expect(names).toContain('kit_doctor');

    const response = await client.callTool({
      name: 'kit_doctor',
      arguments: { projectRoot: root },
    });
    expect(validateResult(response.structuredContent)).toBe(true);
    expect(response.structuredContent).toMatchObject({
      tool: 'kit',
      operation: 'doctor',
    });
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
