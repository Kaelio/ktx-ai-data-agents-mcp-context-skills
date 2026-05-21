import type { KtxLocalProject } from './context/project/project.js';
import { createKtxConnectorCapabilities, type KtxScanConnector } from './context/scan/types.js';
import { describe, expect, it, vi } from 'vitest';
import { createKtxCliIngestQueryExecutor } from './ingest-query-executor.js';

function project(): KtxLocalProject {
  return {
    projectDir: '/tmp/ktx-query-project',
    config: {
      project: 'warehouse',
      connections: {
        warehouse: { driver: 'postgres', url: 'postgresql://readonly@example.test/db' },
      },
    },
  } as unknown as KtxLocalProject;
}

function connector(overrides: Partial<KtxScanConnector> = {}): KtxScanConnector {
  return {
    id: 'warehouse',
    driver: 'postgres',
    capabilities: createKtxConnectorCapabilities({ readOnlySql: true }),
    async introspect() {
      throw new Error('introspect is not used by this test');
    },
    executeReadOnly: vi.fn(async () => ({
      headers: ['answer'],
      rows: [[1]],
      totalRows: 1,
      rowCount: 1,
    })),
    cleanup: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('createKtxCliIngestQueryExecutor', () => {
  it('executes read-only SQL through the scan connector and cleans it up', async () => {
    const scanConnector = connector();
    const createConnector = vi.fn(async () => scanConnector);
    const executor = createKtxCliIngestQueryExecutor(project(), { createConnector });

    await expect(
      executor.execute({
        connectionId: 'warehouse',
        connection: { driver: 'postgres', url: 'postgresql://readonly@example.test/db' },
        projectDir: '/tmp/ktx-query-project',
        sql: 'select 1',
        maxRows: 5,
      }),
    ).resolves.toMatchObject({
      headers: ['answer'],
      rows: [[1]],
      totalRows: 1,
      command: 'SELECT',
      rowCount: 1,
    });

    expect(createConnector).toHaveBeenCalledWith(project(), 'warehouse');
    expect(scanConnector.executeReadOnly).toHaveBeenCalledWith(
      { connectionId: 'warehouse', sql: 'select 1', maxRows: 5 },
      { runId: 'ingest-sql-execution' },
    );
    expect(scanConnector.cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects connectors without read-only SQL support', async () => {
    const scanConnector = connector({
      capabilities: createKtxConnectorCapabilities({ readOnlySql: false }),
      executeReadOnly: undefined,
    });
    const executor = createKtxCliIngestQueryExecutor(project(), {
      createConnector: vi.fn(async () => scanConnector),
    });

    await expect(
      executor.execute({
        connectionId: 'warehouse',
        connection: { driver: 'postgres' },
        projectDir: '/tmp/ktx-query-project',
        sql: 'select 1',
      }),
    ).rejects.toThrow('Connection "warehouse" driver "postgres" does not support read-only SQL execution.');
    expect(scanConnector.cleanup).toHaveBeenCalledTimes(1);
  });
});
