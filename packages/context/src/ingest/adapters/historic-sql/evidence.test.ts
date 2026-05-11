import { describe, expect, it } from 'vitest';
import {
  historicSqlEvidenceEnvelopeSchema,
  historicSqlEvidencePath,
  historicSqlTableUsageEvidenceSchema,
} from './evidence.js';

describe('historic-sql evidence contracts', () => {
  it('validates table usage evidence emitted by table digest WorkUnits', () => {
    const parsed = historicSqlTableUsageEvidenceSchema.parse({
      kind: 'table_usage',
      connectionId: 'warehouse',
      table: 'public.orders',
      rawPath: 'tables/public.orders.json',
      usage: {
        narrative: 'Orders are repeatedly queried for paid/refunded lifecycle analysis.',
        frequencyTier: 'high',
        commonFilters: ['status', 'created_at'],
        commonGroupBys: ['status'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
        staleSince: null,
      },
    });

    expect(parsed.table).toBe('public.orders');
    expect(parsed.usage.frequencyTier).toBe('high');
  });

  it('validates pattern evidence emitted by the patterns WorkUnit', () => {
    const parsed = historicSqlEvidenceEnvelopeSchema.parse({
      kind: 'pattern',
      connectionId: 'warehouse',
      rawPath: 'patterns-input.json',
      pattern: {
        slug: 'order-lifecycle-analysis',
        title: 'Order Lifecycle Analysis',
        narrative: 'Analysts compare order status changes by customer segment.',
        definitionSql: 'select status, count(*) from public.orders group by status',
        tablesInvolved: ['public.orders', 'public.customers'],
        slRefs: ['orders', 'customers'],
        constituentTemplateIds: ['pg:1', 'pg:2'],
      },
    });

    expect(parsed.kind).toBe('pattern');
    expect(parsed.pattern.slug).toBe('order-lifecycle-analysis');
  });

  it('builds a stable ignored evidence path from run and WorkUnit identity', () => {
    expect(historicSqlEvidencePath('run-1', 'historic-sql-table-public-orders')).toBe(
      '.ktx/ingest-evidence/historic-sql/run-1/historic-sql-table-public-orders.json',
    );
  });
});
