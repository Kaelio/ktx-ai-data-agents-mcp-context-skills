import { describe, expect, it, vi } from 'vitest';
import type { MetricFlowParseResult } from '../../../../../src/context/ingest/adapters/metricflow/deep-parse.js';
import { importMetricflowSemanticModels } from '../../../../../src/context/ingest/adapters/metricflow/import-semantic-models.js';

const DBT_SYSTEM_EMAIL = ['system@kae', 'lio.dev'].join('');

function parseResult(): MetricFlowParseResult {
  return {
    semanticModels: [
      {
        name: 'orders',
        description: 'Orders',
        modelRef: 'orders',
        dimensions: [{ name: 'status', column: 'status', type: 'string', label: 'Status' }],
        measures: [{ type: 'simple', name: 'order_count', column: 'id', aggregation: 'count' }],
        entities: [{ name: 'customer', type: 'foreign', expr: 'customer_id' }],
        defaultTimeDimension: null,
      },
    ],
    crossModelMetrics: [
      {
        name: 'global_revenue',
        label: null,
        description: 'Revenue everywhere',
        type: 'derived',
        expr: 'sum(revenue)',
        dependsOn: [{ metricName: 'orders' }],
        filter: null,
      },
    ],
    relationships: [{ fromTable: 'orders', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id' }],
    warnings: ['parser warning'],
  };
}

describe('importMetricflowSemanticModels', () => {
  it('writes semantic models through a worktree-scoped semantic layer service and returns touched sources', async () => {
    const scoped = {
      getManifestEntry: vi.fn().mockResolvedValue(null),
      isManifestBacked: vi.fn().mockResolvedValue(false),
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
      loadSource: vi.fn().mockResolvedValue(null),
      writeSource: vi.fn().mockResolvedValue({ warnings: [] }),
    };
    const semanticLayerService = {
      forWorktree: vi.fn().mockReturnValue(scoped),
      getManifestEntry: vi.fn(),
      isManifestBacked: vi.fn(),
      loadAllSources: vi.fn(),
      loadSource: vi.fn(),
      writeSource: vi.fn(),
    };

    const result = await importMetricflowSemanticModels(
      { semanticLayerService },
      {
        connectionId: 'warehouse-1',
        parseResult: parseResult(),
        targetSchema: null,
        hostTables: [
          { id: 'orders-table', name: 'orders', catalog: null, db: null, columns: [{ id: 'c1', name: 'customer_id' }] },
          { id: 'customers-table', name: 'customers', catalog: null, db: null, columns: [{ id: 'c2', name: 'id' }] },
        ],
        workdir: '/tmp/session-worktree',
      },
    );

    expect(semanticLayerService.forWorktree).toHaveBeenCalledWith('/tmp/session-worktree');
    expect(scoped.writeSource).toHaveBeenCalledTimes(2);
    expect(scoped.writeSource).toHaveBeenNthCalledWith(
      1,
      'warehouse-1',
      expect.objectContaining({ name: 'orders' }),
      'dbt MetricFlow',
      DBT_SYSTEM_EMAIL,
      'dbt MetricFlow sync: create source orders',
      { skipValidation: true },
    );
    expect(scoped.writeSource).toHaveBeenNthCalledWith(
      2,
      'warehouse-1',
      expect.objectContaining({ name: 'global-revenue' }),
      'dbt MetricFlow',
      DBT_SYSTEM_EMAIL,
      'dbt MetricFlow sync: create cross-model source global-revenue',
      { skipValidation: true },
    );
    expect(result).toEqual({
      sourcesCreated: 1,
      sourcesUpdated: 0,
      sourcesSkipped: 0,
      crossModelSourcesCreated: 1,
      relationshipsImported: 0,
      warnings: ['parser warning'],
      errors: [],
      touchedSources: [
        { connectionId: 'warehouse-1', sourceName: 'global-revenue' },
        { connectionId: 'warehouse-1', sourceName: 'orders' },
      ],
    });
  });

  it('updates count when an existing semantic model source exists', async () => {
    const scoped = {
      getManifestEntry: vi.fn().mockResolvedValue(null),
      isManifestBacked: vi.fn().mockResolvedValue(false),
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
      loadSource: vi.fn().mockImplementation((connectionId: string, sourceName: string) =>
        Promise.resolve(sourceName === 'orders' ? { name: 'orders' } : null),
      ),
      writeSource: vi.fn().mockResolvedValue({ warnings: [] }),
    };
    const semanticLayerService = {
      forWorktree: vi.fn().mockReturnValue(scoped),
      getManifestEntry: vi.fn(),
      isManifestBacked: vi.fn(),
      loadAllSources: vi.fn(),
      loadSource: vi.fn(),
      writeSource: vi.fn(),
    };

    const result = await importMetricflowSemanticModels(
      { semanticLayerService },
      {
        connectionId: 'warehouse-1',
        parseResult: { ...parseResult(), crossModelMetrics: [], relationships: [] },
        targetSchema: null,
        hostTables: [],
        workdir: '/tmp/session-worktree',
      },
    );

    expect(result.sourcesCreated).toBe(0);
    expect(result.sourcesUpdated).toBe(1);
    expect(result.crossModelSourcesCreated).toBe(0);
  });

  it('keeps domain write failures structured and continues processing', async () => {
    const scoped = {
      getManifestEntry: vi.fn().mockResolvedValue(null),
      isManifestBacked: vi.fn().mockResolvedValue(false),
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
      loadSource: vi.fn().mockResolvedValue(null),
      writeSource: vi.fn().mockRejectedValueOnce(new Error('cannot write orders')).mockResolvedValue({ warnings: [] }),
    };
    const semanticLayerService = {
      forWorktree: vi.fn().mockReturnValue(scoped),
      getManifestEntry: vi.fn(),
      isManifestBacked: vi.fn(),
      loadAllSources: vi.fn(),
      loadSource: vi.fn(),
      writeSource: vi.fn(),
    };

    const result = await importMetricflowSemanticModels(
      { semanticLayerService },
      {
        connectionId: 'warehouse-1',
        parseResult: parseResult(),
        targetSchema: null,
        hostTables: [],
        workdir: '/tmp/session-worktree',
      },
    );

    expect(result.sourcesSkipped).toBe(1);
    expect(result.crossModelSourcesCreated).toBe(1);
    expect(result.errors).toEqual(["Failed to import semantic model 'orders': cannot write orders"]);
    expect(result.touchedSources).toEqual([{ connectionId: 'warehouse-1', sourceName: 'global-revenue' }]);
  });

  it('writes manifest-backed semantic models as overlays', async () => {
    const manifestOrders = {
      name: 'orders',
      table: 'analytics.orders',
      grain: ['id'],
      columns: [
        { name: 'id', type: 'string' },
        { name: 'customer_id', type: 'string' },
      ],
      joins: [],
      measures: [],
      descriptions: { db: 'Orders table from scan' },
    };
    const written: Array<{ name: string; table?: string; columns?: unknown[]; joins?: unknown[] }> = [];
    const scoped = {
      getManifestEntry: vi.fn().mockImplementation(async (_connectionId: string, sourceName: string) => {
        return sourceName === 'orders' ? manifestOrders : null;
      }),
      isManifestBacked: vi.fn().mockImplementation(async (_connectionId: string, sourceName: string) => {
        return sourceName === 'orders';
      }),
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
      loadSource: vi.fn().mockResolvedValue(null),
      writeSource: vi.fn().mockImplementation(async (_connectionId: string, source: (typeof written)[number]) => {
        written.push(source);
        return { warnings: [] };
      }),
    };
    const semanticLayerService = {
      forWorktree: vi.fn().mockReturnValue(scoped),
      getManifestEntry: vi.fn(),
      isManifestBacked: vi.fn(),
      loadAllSources: vi.fn(),
      loadSource: vi.fn(),
      writeSource: vi.fn(),
    };

    const result = await importMetricflowSemanticModels(
      { semanticLayerService },
      {
        connectionId: 'warehouse-1',
        parseResult: {
          ...parseResult(),
          semanticModels: [
            parseResult().semanticModels[0],
            {
              name: 'customers',
              description: null,
              modelRef: 'customers',
              dimensions: [{ name: 'id', column: 'id', type: 'string' }],
              measures: [],
              entities: [],
              defaultTimeDimension: null,
            },
          ],
          crossModelMetrics: [],
        },
        targetSchema: null,
        hostTables: [
          {
            id: 'orders-table',
            name: 'orders',
            catalog: null,
            db: null,
            columns: [
              { id: 'c1', name: 'customer_id' },
              { id: 'c2', name: 'id' },
            ],
          },
          { id: 'customers-table', name: 'customers', catalog: null, db: null, columns: [{ id: 'c3', name: 'id' }] },
        ],
        workdir: '/tmp/session-worktree',
      },
    );

    expect(written[0]).toMatchObject({
      name: 'orders',
      joins: [{ to: 'customers', on: 'orders.customer_id = customers.id', relationship: 'many_to_one' }],
      descriptions: { dbt: 'Orders' },
    });
    expect(written[0]).not.toHaveProperty('table');
    expect(written[0]).not.toHaveProperty('columns');
    expect(result.sourcesUpdated).toBe(1);
    expect(result.relationshipsImported).toBe(1);
  });

  it('drops joins whose keys are absent from manifest-backed source columns', async () => {
    const scoped = {
      getManifestEntry: vi.fn().mockResolvedValue({
        name: 'orders',
        table: 'analytics.orders',
        grain: ['id'],
        columns: [{ name: 'id', type: 'string' }],
        joins: [],
        measures: [],
      }),
      isManifestBacked: vi.fn().mockImplementation(async (_connectionId: string, sourceName: string) => {
        return sourceName === 'orders';
      }),
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
      loadSource: vi.fn().mockResolvedValue(null),
      writeSource: vi.fn().mockResolvedValue({ warnings: [] }),
    };
    const semanticLayerService = {
      forWorktree: vi.fn().mockReturnValue(scoped),
      getManifestEntry: vi.fn(),
      isManifestBacked: vi.fn(),
      loadAllSources: vi.fn(),
      loadSource: vi.fn(),
      writeSource: vi.fn(),
    };

    const result = await importMetricflowSemanticModels(
      { semanticLayerService },
      {
        connectionId: 'warehouse-1',
        parseResult: { ...parseResult(), crossModelMetrics: [] },
        targetSchema: null,
        hostTables: [
          { id: 'orders-table', name: 'orders', catalog: null, db: null, columns: [{ id: 'c1', name: 'id' }] },
          { id: 'customers-table', name: 'customers', catalog: null, db: null, columns: [{ id: 'c2', name: 'id' }] },
        ],
        workdir: '/tmp/session-worktree',
      },
    );

    expect(scoped.writeSource).toHaveBeenCalledWith(
      'warehouse-1',
      expect.not.objectContaining({ joins: expect.anything() }),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      { skipValidation: true },
    );
    expect(result.relationshipsImported).toBe(0);
  });

  it('repairs earlier sources when a later related model fails to write', async () => {
    const written: Array<{ name: string; joins?: unknown[] }> = [];
    const scoped = {
      getManifestEntry: vi.fn().mockResolvedValue(null),
      isManifestBacked: vi.fn().mockResolvedValue(false),
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
      loadSource: vi.fn().mockResolvedValue(null),
      writeSource: vi
        .fn()
        .mockImplementationOnce(async (_connectionId: string, source: (typeof written)[number]) => {
          written.push(source);
          return { warnings: [] };
        })
        .mockRejectedValueOnce(new Error('disk full'))
        .mockImplementation(async (_connectionId: string, source: (typeof written)[number]) => {
          written.push(source);
          return { warnings: [] };
        }),
    };
    const semanticLayerService = {
      forWorktree: vi.fn().mockReturnValue(scoped),
      getManifestEntry: vi.fn(),
      isManifestBacked: vi.fn(),
      loadAllSources: vi.fn(),
      loadSource: vi.fn(),
      writeSource: vi.fn(),
    };

    const result = await importMetricflowSemanticModels(
      { semanticLayerService },
      {
        connectionId: 'warehouse-1',
        parseResult: {
          ...parseResult(),
          semanticModels: [
            parseResult().semanticModels[0],
            {
              name: 'customers',
              description: null,
              modelRef: 'customers',
              dimensions: [{ name: 'id', column: 'id', type: 'string' }],
              measures: [],
              entities: [],
              defaultTimeDimension: null,
            },
          ],
          crossModelMetrics: [],
        },
        targetSchema: null,
        hostTables: [
          {
            id: 'orders-table',
            name: 'orders',
            catalog: null,
            db: null,
            columns: [
              { id: 'c1', name: 'customer_id' },
              { id: 'c2', name: 'id' },
            ],
          },
          { id: 'customers-table', name: 'customers', catalog: null, db: null, columns: [{ id: 'c3', name: 'id' }] },
        ],
        workdir: '/tmp/session-worktree',
      },
    );

    expect(result.sourcesCreated).toBe(1);
    expect(result.sourcesSkipped).toBe(1);
    expect(result.relationshipsImported).toBe(0);
    expect(result.errors).toContain("Failed to import semantic model 'customers': disk full");
    expect(written.filter((source) => source.name === 'orders')).toHaveLength(2);
    expect(written[written.length - 1]).toMatchObject({ name: 'orders', joins: [] });
  });
});
