import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  patternOutputSchema,
  patternsArraySchema,
  tableUsageOutputSchema,
} from './skill-schemas.js';

describe('historic-sql skill schemas', () => {
  it('accepts table usage output and preserves future keys', () => {
    const parsed = tableUsageOutputSchema.parse({
      narrative: 'Orders are queried for paid/refunded lifecycle analysis.',
      frequencyTier: 'high',
      commonFilters: ['status', 'created_at'],
      commonGroupBys: ['status'],
      commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      staleSince: null,
      analystNote: 'preserve me',
    });

    expect(parsed).toMatchObject({
      narrative: 'Orders are queried for paid/refunded lifecycle analysis.',
      frequencyTier: 'high',
      commonFilters: ['status', 'created_at'],
      commonGroupBys: ['status'],
      commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      staleSince: null,
      analystNote: 'preserve me',
    });
  });

  it('rejects invalid frequency tiers', () => {
    const result = tableUsageOutputSchema.safeParse({
      narrative: 'Orders are queried often.',
      frequencyTier: 'sometimes',
      commonFilters: [],
      commonJoins: [],
    });

    expect(result.success).toBe(false);
  });

  it('accepts pattern outputs used for wiki projection', () => {
    const parsed = patternsArraySchema.parse([
      {
        slug: 'order-lifecycle-analysis',
        title: 'Order Lifecycle Analysis',
        narrative: 'Teams inspect order status by customer and month.',
        definitionSql: 'select status, count(*) from public.orders group by status',
        tablesInvolved: ['public.orders', 'public.customers'],
        slRefs: ['orders', 'customers'],
        constituentTemplateIds: ['template_1', 'template_2'],
      },
    ]);

    expect(parsed[0]).toEqual({
      slug: 'order-lifecycle-analysis',
      title: 'Order Lifecycle Analysis',
      narrative: 'Teams inspect order status by customer and month.',
      definitionSql: 'select status, count(*) from public.orders group by status',
      tablesInvolved: ['public.orders', 'public.customers'],
      slRefs: ['orders', 'customers'],
      constituentTemplateIds: ['template_1', 'template_2'],
    });
  });

  it('exports zod schemas that can produce JSON schema for prompt prefixes', () => {
    const tableUsageJsonSchema = z.toJSONSchema(tableUsageOutputSchema);
    const patternJsonSchema = z.toJSONSchema(patternOutputSchema);

    expect(tableUsageJsonSchema).toMatchObject({ type: 'object' });
    expect(patternJsonSchema).toMatchObject({ type: 'object' });
  });
});
