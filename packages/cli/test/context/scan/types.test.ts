import { describe, expect, it } from 'vitest';
import {
  createKtxConnectorCapabilities,
  type KtxEventPropertyDiscovery,
  type KtxEventPropertyDiscoveryInput,
  type KtxEventPropertyValuesInput,
  type KtxEventPropertyValuesResult,
  type KtxEventStreamDiscoveryPort,
  type KtxEventTypeDiscovery,
  type KtxEventTypeDiscoveryInput,
  type KtxNetworkEndpoint,
  type KtxNetworkTunnelPort,
  type KtxQueryResult,
  type KtxScanConnector,
  type KtxScanContext,
  type KtxScanInput,
  type KtxSchemaSnapshot,
} from '../../../src/context/scan/types.js';

describe('KTX scan contract types', () => {
  it('defaults to structural-only connector capabilities', () => {
    expect(createKtxConnectorCapabilities()).toEqual({
      structuralIntrospection: true,
      tableSampling: false,
      columnSampling: false,
      columnStats: false,
      readOnlySql: false,
      nestedAnalysis: false,
      eventStreamDiscovery: false,
      formalForeignKeys: false,
      estimatedRowCounts: false,
    });
  });

  it('keeps structural introspection mandatory when optional capabilities are enabled', () => {
    expect(
      createKtxConnectorCapabilities({
        tableSampling: true,
        readOnlySql: true,
        eventStreamDiscovery: true,
        estimatedRowCounts: true,
      }),
    ).toEqual({
      structuralIntrospection: true,
      tableSampling: true,
      columnSampling: false,
      columnStats: false,
      readOnlySql: true,
      nestedAnalysis: false,
      eventStreamDiscovery: true,
      formalForeignKeys: false,
      estimatedRowCounts: true,
    });
  });

  it('describes the connector surface without requiring enrichment methods', async () => {
    const snapshot: KtxSchemaSnapshot = {
      connectionId: 'warehouse',
      driver: 'postgres',
      extractedAt: '2026-04-29T00:00:00.000Z',
      scope: { schemas: ['public'] },
      metadata: { source: 'unit-test' },
      tables: [
        {
          catalog: null,
          db: 'public',
          name: 'orders',
          kind: 'table',
          comment: 'Customer orders',
          estimatedRows: 42,
          columns: [
            {
              name: 'id',
              nativeType: 'integer',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: 'Primary key',
            },
          ],
          foreignKeys: [],
        },
      ],
    };

    const connector: KtxScanConnector = {
      id: 'test-postgres',
      driver: 'postgres',
      capabilities: createKtxConnectorCapabilities({ estimatedRowCounts: true }),
      async introspect(input: KtxScanInput, ctx: KtxScanContext) {
        expect(input.connectionId).toBe('warehouse');
        expect(ctx.runId).toBe('scan-run-1');
        return snapshot;
      },
    };

    await expect(
      connector.introspect(
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          scope: { schemas: ['public'] },
          mode: 'structural',
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual(snapshot);
  });

  it('models optional event-stream discovery as a connector capability and port', async () => {
    const eventTypes: KtxEventTypeDiscovery[] = [{ value: '$pageview', count: 42 }];
    const propertyKeys: KtxEventPropertyDiscovery[] = [{ key: '$browser', count: 31 }];
    const propertyValues: KtxEventPropertyValuesResult = { values: ['Chrome', 'Safari'], cardinality: 2 };
    const discovery: KtxEventStreamDiscoveryPort = {
      async listEventTypes(input: KtxEventTypeDiscoveryInput) {
        expect(input).toEqual({
          connectionId: 'product',
          table: { catalog: '157881', db: null, name: 'events' },
          eventColumn: 'event',
          limit: 2,
          minCount: 30,
          lookbackDays: 14,
        });
        return eventTypes;
      },
      async listPropertyKeys(input: KtxEventPropertyDiscoveryInput) {
        expect(input).toEqual({
          connectionId: 'product',
          table: { catalog: '157881', db: null, name: 'events' },
          jsonColumn: 'properties',
          sampleSize: 1000,
          limit: 5,
          lookbackDays: 7,
        });
        return propertyKeys;
      },
      async listPropertyValues(input: KtxEventPropertyValuesInput) {
        expect(input).toEqual({
          connectionId: 'product',
          table: { catalog: '157881', db: null, name: 'events' },
          jsonColumn: 'properties',
          propertyKey: '$browser',
          limit: 3,
          maxCardinality: 1000,
          lookbackDays: 30,
        });
        return propertyValues;
      },
    };

    const connector: KtxScanConnector = {
      id: 'clickhouse:product',
      driver: 'clickhouse',
      capabilities: createKtxConnectorCapabilities({ eventStreamDiscovery: true }),
      eventStreamDiscovery: discovery,
      async introspect() {
        return {
          connectionId: 'product',
          driver: 'clickhouse',
          extractedAt: '2026-04-29T00:00:00.000Z',
          scope: { catalogs: ['157881'] },
          metadata: {},
          tables: [],
        };
      },
    };

    await expect(
      connector.eventStreamDiscovery?.listEventTypes(
        {
          connectionId: 'product',
          table: { catalog: '157881', db: null, name: 'events' },
          eventColumn: 'event',
          limit: 2,
          minCount: 30,
          lookbackDays: 14,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual([{ value: '$pageview', count: 42 }]);
    await expect(
      connector.eventStreamDiscovery?.listPropertyKeys(
        {
          connectionId: 'product',
          table: { catalog: '157881', db: null, name: 'events' },
          jsonColumn: 'properties',
          sampleSize: 1000,
          limit: 5,
          lookbackDays: 7,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual([{ key: '$browser', count: 31 }]);
    await expect(
      connector.eventStreamDiscovery?.listPropertyValues(
        {
          connectionId: 'product',
          table: { catalog: '157881', db: null, name: 'events' },
          jsonColumn: 'properties',
          propertyKey: '$browser',
          limit: 3,
          maxCardinality: 1000,
          lookbackDays: 30,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ values: ['Chrome', 'Safari'], cardinality: 2 });
  });

  it('keeps read-only query results separate from schema snapshots', () => {
    const result: KtxQueryResult = {
      headers: ['id', 'amount'],
      headerTypes: ['integer', 'numeric'],
      rows: [[1, 10.5]],
      totalRows: 1,
      rowCount: 1,
    };

    expect(result).toEqual({
      headers: ['id', 'amount'],
      headerTypes: ['integer', 'numeric'],
      rows: [[1, 10.5]],
      totalRows: 1,
      rowCount: 1,
    });
  });

  it('models host-provided network tunnel endpoint resolution without app imports', async () => {
    const endpoint: KtxNetworkEndpoint = {
      host: '127.0.0.1',
      port: 15432,
      close: async () => undefined,
    };
    const tunnelPort: KtxNetworkTunnelPort<{ networkProxy?: { type: 'ssh_tunnel' } }> = {
      async resolveEndpoint(input) {
        expect(input).toEqual({
          connectionId: 'warehouse',
          driver: 'postgres',
          host: 'db.internal',
          port: 5432,
          connection: { networkProxy: { type: 'ssh_tunnel' } },
        });
        return endpoint;
      },
    };

    await expect(
      tunnelPort.resolveEndpoint({
        connectionId: 'warehouse',
        driver: 'postgres',
        host: 'db.internal',
        port: 5432,
        connection: { networkProxy: { type: 'ssh_tunnel' } },
      }),
    ).resolves.toBe(endpoint);
  });
});
