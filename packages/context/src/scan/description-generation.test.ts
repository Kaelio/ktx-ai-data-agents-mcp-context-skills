import { describe, expect, it, vi } from 'vitest';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from 'ai';
import {
  buildKtxColumnDescriptionPrompt,
  buildKtxDataSourceDescriptionPrompt,
  buildKtxTableDescriptionPrompt,
  type KtxDescriptionCachePort,
  KtxDescriptionGenerator,
} from './description-generation.js';
import { createKtxConnectorCapabilities, type KtxScanConnector } from './types.js';

function createCache(initial: Record<string, string> = {}): KtxDescriptionCachePort {
  const data = new Map(Object.entries(initial));
  return {
    buildTableKey: (table) => [table.catalog, table.db, table.name].filter(Boolean).join('.'),
    buildColumnKey: (table, columnName) => [table.catalog, table.db, table.name, columnName].filter(Boolean).join('.'),
    buildConnectionKey: (connectionName) => `__connection:${connectionName}`,
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

function createLlmProvider(text = 'generated description') {
  vi.mocked(generateText).mockResolvedValue({ text } as never);
  return {
    getModel: vi.fn().mockReturnValue({ modelId: 'claude-sonnet-4-6', provider: 'anthropic' }),
    getModelByName: vi.fn(),
    cacheMarker: vi.fn(),
    repairToolCallHandler: vi.fn(),
    thinkingProviderOptions: vi.fn(),
    telemetryConfig: vi.fn(),
    promptCachingConfig: vi.fn(() => ({
      enabled: false,
      systemTtl: '1h',
      toolsTtl: '1h',
      historyTtl: '5m',
      cacheSystem: true,
      cacheTools: true,
      cacheHistory: true,
      vertexFallbackTo5m: false,
    })),
    activeBackend: vi.fn(() => 'anthropic'),
  } as any;
}

function createFailingLlmProvider(message = 'timeout exceeded when trying to connect') {
  vi.mocked(generateText).mockRejectedValue(new Error(message) as never);
  return {
    getModel: vi.fn().mockReturnValue({ modelId: 'claude-sonnet-4-6', provider: 'anthropic' }),
    getModelByName: vi.fn(),
    cacheMarker: vi.fn(),
    repairToolCallHandler: vi.fn(),
    thinkingProviderOptions: vi.fn(),
    telemetryConfig: vi.fn(),
    promptCachingConfig: vi.fn(() => ({
      enabled: false,
      systemTtl: '1h',
      toolsTtl: '1h',
      historyTtl: '5m',
      cacheSystem: true,
      cacheTools: true,
      cacheHistory: true,
      vertexFallbackTo5m: false,
    })),
    activeBackend: vi.fn(() => 'anthropic'),
  } as any;
}

function createConnector(): KtxScanConnector {
  return {
    id: 'test-connector',
    driver: 'postgres',
    capabilities: createKtxConnectorCapabilities({
      tableSampling: true,
      columnSampling: true,
      nestedAnalysis: true,
    }),
    introspect: vi.fn(async () => {
      throw new Error('introspection is not used by description generation');
    }),
    sampleColumn: vi.fn(async () => ({
      values: ['paid', 'refunded', null],
      nullCount: 1,
      distinctCount: 2,
    })),
    sampleTable: vi.fn(async () => ({
      headers: ['id', 'status', 'amount'],
      rows: [
        [1, 'paid', 20],
        [2, 'refunded', 10],
      ],
      totalRows: 2,
    })),
  };
}

describe('KTX description prompt builders', () => {
  it('builds column prompts with sample values, source descriptions, and nested BigQuery guidance', () => {
    const { system, user } = buildKtxColumnDescriptionPrompt({
      columnName: 'payload',
      columnValues: [{ nested: true }, '[1,2]'],
      tableContext: 'Table: events | Columns: payload | Data source: BIGQUERY',
      dataSourceType: 'BIGQUERY',
      supportsNestedAnalysis: true,
      rawDescriptions: { db: 'Raw event payload', ai: 'Old AI text', user: 'User text' },
      maxWords: 12,
    });

    expect(user).toContain(
      '<table_context> Table: events | Columns: payload | Data source: BIGQUERY </table_context>',
    );
    expect(user).toContain('<column_name> payload </column_name>');
    expect(user).toContain('<sample_values> [object Object], [1,2] </sample_values>');
    expect(user).toContain('<db_documentation> Raw event payload </db_documentation>');
    expect(user).not.toContain('Old AI text');
    expect(user).not.toContain('User text');
    expect(system).toContain('nested/structured data');
    expect(system).toContain('12 words or less');
    expect(user).not.toContain('12 words or less');
  });

  it('builds table and data-source prompts from sampled rows', () => {
    const sample = {
      headers: ['id', 'status'],
      rows: [
        [1, 'paid'],
        [2, 'refunded'],
      ],
      totalRows: 2,
    };

    const table = buildKtxTableDescriptionPrompt({
      tableName: 'orders',
      sampleData: sample,
      dataSourceType: 'POSTGRESQL',
      rawDescriptions: { dbt: 'Fact table for commerce orders' },
    });
    expect(table.user).toContain('status: paid, refunded');
    expect(table.system).toContain('Analyze database tables');

    const datasource = buildKtxDataSourceDescriptionPrompt({
      tableSamples: [['orders', sample]],
      dataSourceType: 'POSTGRESQL',
    });
    expect(datasource.user).toContain('orders (2 columns, 2 sample rows)');
    expect(datasource.system).toContain('Analyze databases');
  });
});

describe('KtxDescriptionGenerator', () => {
  it('generates column descriptions with pre-fetched values, cache hits, and word-limit metadata', async () => {
    const cache = createCache({ 'warehouse.public.orders.cached_status': 'Cached status description' });
    const llmProvider = createLlmProvider('Payment state');
    const connector = createConnector();
    const generator = new KtxDescriptionGenerator({
      llmProvider,
      cache,
      settings: {
        columnMaxWords: 12,
        tableMaxWords: 18,
        dataSourceMaxWords: 24,
        temperature: 0.2,
        concurrencyLimit: 2,
      },
    });

    const result = await generator.generateColumnDescriptions({
      connectionId: 'conn-1',
      connector,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: {
        catalog: 'warehouse',
        db: 'public',
        name: 'orders',
        columns: [
          { name: 'status', sampleValues: ['paid', 'refunded'], rawDescriptions: { db: 'Payment lifecycle' } },
          { name: 'cached_status', sampleValues: ['open'] },
        ],
      },
      skipExisting: false,
      existingDescriptions: {},
    });

    expect(result).toEqual({
      columnDescriptions: [
        ['status', 'Payment state'],
        ['cached_status', 'Cached status description'],
      ],
      processedColumns: ['status'],
      skippedColumns: ['cached_status'],
    });
    expect(connector.sampleColumn).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.2,
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Please provide a concise description in 12 words or less.'),
          }),
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('<column_name> status </column_name>'),
          }),
        ]),
      }),
    );
  });

  it('samples through the connector when column values are not pre-fetched', async () => {
    const connector = createConnector();
    const generator = new KtxDescriptionGenerator({
      llmProvider: createLlmProvider('Current order state'),
      settings: {
        columnMaxWords: 12,
        tableMaxWords: 18,
        dataSourceMaxWords: 24,
      },
    });

    const result = await generator.generateColumnDescriptions({
      connectionId: 'conn-1',
      connector,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: {
        catalog: null,
        db: 'public',
        name: 'orders',
        columns: [{ name: 'status' }],
      },
    });

    expect(connector.sampleColumn).toHaveBeenCalledWith(
      {
        connectionId: 'conn-1',
        table: { catalog: null, db: 'public', name: 'orders' },
        column: 'status',
        limit: 50,
      },
      { runId: 'run-1' },
    );
    expect(result.columnDescriptions).toEqual([['status', 'Current order state']]);
  });

  it('samples through a description sampling port without requiring structural introspection', async () => {
    const sampler = {
      id: 'description-sampler:conn-1',
      sampleColumn: vi.fn(async () => ({
        values: ['paid', 'refunded'],
        nullCount: null,
        distinctCount: null,
      })),
      sampleTable: vi.fn(async () => ({
        headers: ['id', 'status'],
        rows: [[1, 'paid']],
        totalRows: 1,
      })),
    };
    const generator = new KtxDescriptionGenerator({
      llmProvider: createLlmProvider('Generated through sampler'),
      settings: {
        columnMaxWords: 12,
        tableMaxWords: 18,
        dataSourceMaxWords: 24,
      },
    });

    const result = await generator.generateColumnDescriptions({
      connectionId: 'conn-1',
      connector: sampler,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: {
        catalog: null,
        db: 'public',
        name: 'orders',
        columns: [{ name: 'status' }],
      },
    });

    expect(result.columnDescriptions).toEqual([['status', 'Generated through sampler']]);
    expect(sampler.sampleColumn).toHaveBeenCalledWith(
      {
        connectionId: 'conn-1',
        table: { catalog: null, db: 'public', name: 'orders' },
        column: 'status',
        limit: 50,
      },
      { runId: 'run-1' },
    );
    expect('introspect' in sampler).toBe(false);
  });

  it('does not turn LLM failures into generated descriptions', async () => {
    const cache = createCache();
    const connector = createConnector();
    const generator = new KtxDescriptionGenerator({
      llmProvider: createFailingLlmProvider(),
      cache,
      settings: {
        columnMaxWords: 12,
        tableMaxWords: 18,
        dataSourceMaxWords: 24,
      },
    });

    const columnResult = await generator.generateColumnDescriptions({
      connectionId: 'conn-1',
      connector,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: {
        catalog: null,
        db: 'public',
        name: 'orders',
        columns: [{ name: 'status' }],
      },
    });

    await expect(
      generator.generateTableDescription({
        connectionId: 'conn-1',
        connector,
        context: { runId: 'run-1' },
        dataSourceType: 'POSTGRESQL',
        table: { catalog: null, db: 'public', name: 'orders' },
      }),
    ).resolves.toBeNull();

    expect(columnResult).toEqual({
      columnDescriptions: [['status', null]],
      processedColumns: [],
      skippedColumns: [],
    });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('generates and caches table and data-source descriptions', async () => {
    const cache = createCache();
    const connector = createConnector();
    const generator = new KtxDescriptionGenerator({
      llmProvider: createLlmProvider('Commerce orders'),
      cache,
      settings: {
        columnMaxWords: 12,
        tableMaxWords: 18,
        dataSourceMaxWords: 24,
        concurrencyLimit: 2,
      },
    });

    await expect(
      generator.generateTableDescription({
        connectionId: 'conn-1',
        connector,
        context: { runId: 'run-1' },
        dataSourceType: 'POSTGRESQL',
        table: { catalog: 'warehouse', db: 'public', name: 'orders', rawDescriptions: { db: 'Raw orders' } },
      }),
    ).resolves.toBe('Commerce orders');

    await expect(
      generator.generateDataSourceDescription({
        connectionId: 'conn-1',
        connector,
        context: { runId: 'run-1' },
        dataSourceType: 'POSTGRESQL',
        tables: [
          { catalog: 'warehouse', db: 'public', name: 'orders' },
          { catalog: 'warehouse', db: 'public', name: 'customers' },
        ],
        connectionName: 'Warehouse',
      }),
    ).resolves.toBe('Commerce orders');

    expect(cache.set).toHaveBeenCalledWith('warehouse.public.orders', 'Commerce orders');
    expect(cache.set).toHaveBeenCalledWith('__connection:Warehouse', 'Commerce orders');
  });
});
