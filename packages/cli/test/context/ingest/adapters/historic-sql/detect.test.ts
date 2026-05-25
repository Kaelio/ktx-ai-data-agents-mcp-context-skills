import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectHistoricSqlStagedDir } from '../../../../../src/context/ingest/adapters/historic-sql/detect.js';
import { HISTORIC_SQL_SOURCE_KEY, stagedManifestSchema } from '../../../../../src/context/ingest/adapters/historic-sql/types.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'historic-sql-detect-'));
}

async function writeJson(root: string, relPath: string, value: unknown): Promise<void> {
  const target = join(root, relPath);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function manifest() {
  return stagedManifestSchema.parse({
    source: HISTORIC_SQL_SOURCE_KEY,
    connectionId: 'conn_1',
    dialect: 'postgres',
    fetchedAt: '2026-05-04T12:00:00.000Z',
    windowStart: '2026-02-03T12:00:00.000Z',
    windowEnd: '2026-05-04T12:00:00.000Z',
    snapshotRowCount: 0,
    touchedTableCount: 0,
    parseFailures: 0,
    warnings: [],
    probeWarnings: [],
  });
}

describe('historic-sql staged dir detection', () => {
  it('detects manifest source', async () => {
    const stagedDir = await tempDir();
    await writeJson(stagedDir, 'manifest.json', manifest());

    await expect(detectHistoricSqlStagedDir(stagedDir)).resolves.toBe(true);
  });

  it('detects unified table and patterns structure without manifest', async () => {
    const stagedDir = await tempDir();
    await writeFile(join(stagedDir, 'not-a-match.txt'), 'x', 'utf-8');
    await writeJson(stagedDir, 'patterns-input.json', { templates: [] });
    await writeJson(stagedDir, 'tables/public.orders.json', { table: 'public.orders' });

    await expect(detectHistoricSqlStagedDir(stagedDir)).resolves.toBe(true);
  });

  it('does not detect unrelated directories', async () => {
    const stagedDir = await tempDir();
    await writeJson(stagedDir, 'manifest.json', { source: 'notion' });

    await expect(detectHistoricSqlStagedDir(stagedDir)).resolves.toBe(false);
  });
});
