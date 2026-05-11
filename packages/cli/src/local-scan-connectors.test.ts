import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject, loadKtxProject } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKtxCliScanConnector } from './local-scan-connectors.js';

const bigQueryMock = vi.hoisted(() => ({
  constructorInputs: [] as Array<{
    connectionId: string;
    connection: unknown;
    maxBytesBilled?: number | string;
  }>,
}));

vi.mock('@ktx/connector-bigquery', () => ({
  isKtxBigQueryConnectionConfig: (connection: { driver?: unknown } | undefined) =>
    String(connection?.driver ?? '').toLowerCase() === 'bigquery',
  KtxBigQueryScanConnector: class {
    readonly id: string;
    readonly driver = 'bigquery';

    constructor(options: { connectionId: string; connection: unknown; maxBytesBilled?: number | string }) {
      bigQueryMock.constructorInputs.push(options);
      this.id = `bigquery:${options.connectionId}`;
    }
  },
}));

describe('createKtxCliScanConnector', () => {
  let tempDir: string;

  beforeEach(async () => {
    bigQueryMock.constructorInputs.length = 0;
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-scan-connector-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a native sqlite connector from standalone config', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: sqlite',
        '    path: warehouse.db',
        '    readonly: true',
        '',
      ].join('\n'),
      'utf-8',
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const connector = await createKtxCliScanConnector(project, 'warehouse');

    expect(connector.id).toBe('sqlite:warehouse');
    expect(connector.driver).toBe('sqlite');
  });

  it.each([
    ['maxBytesBilled', '    maxBytesBilled: 123456789', 123456789],
    ['max_bytes_billed', '    max_bytes_billed: "987654321"', '987654321'],
  ])('passes BigQuery %s from standalone config', async (_label, byteCapLine, expectedMaxBytesBilled) => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: bigquery',
        '    dataset_id: analytics',
        '    readonly: true',
        byteCapLine,
        '',
      ].join('\n'),
      'utf-8',
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const connector = await createKtxCliScanConnector(project, 'warehouse');

    expect(connector.id).toBe('bigquery:warehouse');
    expect(connector.driver).toBe('bigquery');
    expect(bigQueryMock.constructorInputs).toEqual([
      expect.objectContaining({
        connectionId: 'warehouse',
        maxBytesBilled: expectedMaxBytesBilled,
      }),
    ]);
  });

  it('throws for structural daemon-only fallback configs', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: duckdb',
        '    path: warehouse.duckdb',
        '',
      ].join('\n'),
      'utf-8',
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    await expect(createKtxCliScanConnector(project, 'warehouse')).rejects.toThrow(
      'Connection "warehouse" uses driver "duckdb", which has no native standalone KTX scan connector',
    );
  });

  it('throws a clear error when the connection block has no driver field', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    type: postgres',
        '    url: postgresql://example/db',
        '    readonly: true',
        '',
      ].join('\n'),
      'utf-8',
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    await expect(createKtxCliScanConnector(project, 'warehouse')).rejects.toThrow(
      'Connection "warehouse" has no `driver` field in ktx.yaml',
    );
  });
});
