import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KtxCliIo } from './cli-runtime.js';
import { runKtxSourceMapping } from './source-mapping.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    } satisfies KtxCliIo,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('source mapping commands', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-source-mapping-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(metabaseMappings: string[]): Promise<void> {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '  metabase:',
        '    driver: metabase',
        '    api_url: https://metabase.example.com',
        ...metabaseMappings,
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  it('fails Metabase validation when no sync-enabled target mapping exists', async () => {
    await writeConfig([]);
    const io = makeIo();

    await expect(
      runKtxSourceMapping({ command: 'validate', projectDir: tempDir, connectionId: 'metabase' }, io.io),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('no sync-enabled mappings with a target connection for Metabase connection metabase');
  });

  it('passes Metabase validation when a sync-enabled target mapping exists', async () => {
    await writeConfig([
      '    mappings:',
      '      databaseMappings:',
      '        "3": warehouse',
      '      syncEnabled:',
      '        "3": true',
    ]);
    const io = makeIo();

    await expect(
      runKtxSourceMapping({ command: 'validate', projectDir: tempDir, connectionId: 'metabase' }, io.io),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Mapping validation passed: metabase');
  });
});
