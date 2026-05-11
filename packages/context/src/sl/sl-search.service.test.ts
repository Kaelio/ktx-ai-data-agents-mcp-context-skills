import { describe, expect, it, vi } from 'vitest';
import { buildSemanticLayerSourceSearchText, SlSearchService } from './sl-search.service.js';
import type { SemanticLayerSource } from './types.js';

describe('SlSearchService', () => {
  it('builds search text from source, columns, measures, and joins', () => {
    const service = new SlSearchService(
      { maxBatchSize: 16, computeEmbedding: vi.fn(), computeEmbeddingsBulk: vi.fn() },
      {
        upsertSources: vi.fn(),
        getExistingSearchTexts: vi.fn(),
        deleteStale: vi.fn(),
        deleteByConnection: vi.fn(),
        deleteByConnectionAndName: vi.fn(),
        search: vi.fn(),
      },
    );
    const source: SemanticLayerSource = {
      name: 'orders',
      descriptions: { user: 'Customer orders' },
      table: 'public.orders',
      grain: ['id'],
      columns: [
        { name: 'id', type: 'string' },
        { name: 'amount', type: 'number', descriptions: { user: 'Order amount' } },
      ],
      measures: [{ name: 'revenue', expr: 'sum(amount)', description: 'Gross revenue' }],
      joins: [{ to: 'customers', on: 'orders.customer_id = customers.id', relationship: 'many_to_one' }],
    };

    expect(service.buildSearchText(source)).toContain('orders');
    expect(service.buildSearchText(source)).toContain('Customer orders');
    expect(service.buildSearchText(source)).toContain('amount (number) Order amount');
    expect(service.buildSearchText(source)).toContain('measure: revenue sum(amount) Gross revenue');
    expect(service.buildSearchText(source)).toContain('join: customers (many_to_one)');
  });

  it('exports the same canonical search text builder used by SlSearchService', () => {
    const service = new SlSearchService(
      { maxBatchSize: 16, computeEmbedding: vi.fn(), computeEmbeddingsBulk: vi.fn() },
      {
        upsertSources: vi.fn(),
        getExistingSearchTexts: vi.fn(),
        deleteStale: vi.fn(),
        deleteByConnection: vi.fn(),
        deleteByConnectionAndName: vi.fn(),
        search: vi.fn(),
      },
    );
    const source: SemanticLayerSource = {
      name: 'orders',
      descriptions: { user: 'Customer orders' },
      table: 'public.orders',
      grain: ['id'],
      columns: [
        {
          name: 'status',
          type: 'string',
          enum_values: { dbt: ['paid', 'refunded'] },
          constraints: { dbt: { not_null: true } },
        },
      ],
      joins: [{ to: 'customers', on: 'orders.customer_id = customers.id', relationship: 'many_to_one' }],
      measures: [{ name: 'total_revenue', expr: 'sum(revenue)', description: 'Gross revenue' }],
      tags: { dbt: ['finance'] },
    };

    expect(buildSemanticLayerSourceSearchText(source)).toBe(service.buildSearchText(source));
    expect(buildSemanticLayerSourceSearchText(source)).toContain('dbt values: paid, refunded');
    expect(buildSemanticLayerSourceSearchText(source)).toContain('measure: total_revenue sum(revenue) Gross revenue');
    expect(buildSemanticLayerSourceSearchText(source)).toContain('dbt tags: finance');
  });

  it('includes dbt enum, not_null, and unique tokens for columns', () => {
    const service = new SlSearchService(
      { maxBatchSize: 16, computeEmbedding: vi.fn(), computeEmbeddingsBulk: vi.fn() },
      {
        upsertSources: vi.fn(),
        getExistingSearchTexts: vi.fn(),
        deleteStale: vi.fn(),
        deleteByConnection: vi.fn(),
        deleteByConnectionAndName: vi.fn(),
        search: vi.fn(),
      },
    );
    const source: SemanticLayerSource = {
      name: 'src_orders',
      table: 'public.orders',
      grain: [],
      columns: [
        {
          name: 'status',
          type: 'string',
          descriptions: {},
          enum_values: { dbt: ['a', 'b'] },
          constraints: { dbt: { not_null: true, unique: true } },
        },
      ],
      joins: [],
      measures: [],
    };
    const text = service.buildSearchText(source);
    expect(text).toContain('dbt values: a, b');
    expect(text).toContain('not_null');
    expect(text).toContain('unique');
  });

  it('includes dbt default time token for MetricFlow agg_time_dimension', () => {
    const service = new SlSearchService(
      { maxBatchSize: 16, computeEmbedding: vi.fn(), computeEmbeddingsBulk: vi.fn() },
      {
        upsertSources: vi.fn(),
        getExistingSearchTexts: vi.fn(),
        deleteStale: vi.fn(),
        deleteByConnection: vi.fn(),
        deleteByConnectionAndName: vi.fn(),
        search: vi.fn(),
      },
    );
    const source: SemanticLayerSource = {
      name: 'orders',
      table: 'public.orders',
      grain: ['id'],
      columns: [{ name: 'id', type: 'number' }],
      joins: [],
      measures: [],
      default_time_dimension: { dbt: 'order_date' },
    };
    expect(service.buildSearchText(source)).toContain('dbt default time: order_date');
  });

  it('includes dbt table tags and freshness from manifest-backed source', () => {
    const service = new SlSearchService(
      { maxBatchSize: 16, computeEmbedding: vi.fn(), computeEmbeddingsBulk: vi.fn() },
      {
        upsertSources: vi.fn(),
        getExistingSearchTexts: vi.fn(),
        deleteStale: vi.fn(),
        deleteByConnection: vi.fn(),
        deleteByConnectionAndName: vi.fn(),
        search: vi.fn(),
      },
    );
    const source: SemanticLayerSource = {
      name: 'customers',
      table: 'jaffle.customers',
      grain: ['id'],
      columns: [{ name: 'id', type: 'number' }],
      joins: [],
      measures: [],
      tags: { dbt: ['raw', 'core'] },
      freshness: {
        dbt: {
          loaded_at_field: 'updated_at',
          raw: { warn_after: { count: 12, period: 'hour' } },
        },
      },
    };
    const text = service.buildSearchText(source);
    expect(text).toContain('dbt tags: raw, core');
    expect(text).toContain('dbt freshness:');
    expect(text).toContain('loaded_at=updated_at');
    expect(text).toContain('warn_after');
  });

  it('includes historic SQL usage in semantic-layer search text', () => {
    const source: SemanticLayerSource = {
      name: 'orders',
      descriptions: { user: 'Customer orders' },
      table: 'public.orders',
      grain: ['order_id'],
      columns: [{ name: 'order_id', type: 'string' }],
      joins: [],
      measures: [],
      usage: {
        narrative: 'Analysts inspect paid and refunded order lifecycle trends by customer segment.',
        frequencyTier: 'high',
        commonFilters: ['status', 'created_at'],
        commonGroupBys: ['customer_segment'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
        staleSince: '2026-05-01T00:00:00.000Z',
      },
    };

    const text = buildSemanticLayerSourceSearchText(source);

    expect(text).toContain('usage: Analysts inspect paid and refunded order lifecycle trends by customer segment.');
    expect(text).toContain('frequency: high');
    expect(text).toContain('commonly filtered by: status, created_at');
    expect(text).toContain('commonly grouped by: customer_segment');
    expect(text).toContain('commonly joined to public.customers on customer_id');
    expect(text).toContain('stale since 2026-05-01T00:00:00.000Z');
  });

  it('preserves FTS snippets returned by the source index', async () => {
    const service = new SlSearchService(
      {
        maxBatchSize: 16,
        computeEmbedding: vi.fn(async () => [1, 0]),
        computeEmbeddingsBulk: vi.fn(),
      },
      {
        upsertSources: vi.fn(),
        getExistingSearchTexts: vi.fn(),
        deleteStale: vi.fn(),
        deleteByConnection: vi.fn(),
        deleteByConnectionAndName: vi.fn(),
        search: vi.fn(async () => [
          {
            sourceName: 'orders',
            rrfScore: 0.75,
            snippet: 'usage: paid <mark>order</mark> lifecycle',
          },
        ]),
      },
    );

    await expect(service.search('warehouse', 'order lifecycle', 10)).resolves.toEqual([
      {
        sourceName: 'orders',
        score: 0.75,
        snippet: 'usage: paid <mark>order</mark> lifecycle',
      },
    ]);
  });
});
