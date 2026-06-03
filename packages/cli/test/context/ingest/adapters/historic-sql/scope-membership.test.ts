import { describe, expect, it } from 'vitest';
import {
  includedQueryHistoryTableRefs,
  isQueryHistoryScopeFloorDisabled,
  shouldFailOpenQueryHistoryScope,
} from '../../../../../src/context/ingest/adapters/historic-sql/scope-membership.js';
import type { KtxTableRef } from '../../../../../src/context/scan/types.js';

function ref(db: string | null, name: string, catalog: string | null = null): KtxTableRef {
  return { catalog, db, name };
}

describe('query-history scope membership', () => {
  it('prefers explicit enabled tables over schema scope', () => {
    const orders = ref('analytics', 'orders');
    const noise = ref('metabase', 'application_table');

    expect(
      includedQueryHistoryTableRefs([orders, noise], {
        enabledTables: [orders],
        enabledSchemas: ['metabase'],
      }),
    ).toEqual([orders]);
  });

  it('matches schema scope by the db component across catalogs', () => {
    const modeled = ref('orbit_analytics', 'orders', 'demo-project');
    const noise = ref('metabase', 'application_table', 'demo-project');

    expect(
      includedQueryHistoryTableRefs([modeled, noise], {
        enabledTables: [],
        enabledSchemas: ['orbit_analytics'],
      }),
    ).toEqual([modeled]);
  });

  it('keeps every touched ref when wildcard scope disables the floor', () => {
    const tables = [ref('analytics', 'orders'), ref('metabase', 'application_table')];

    expect(isQueryHistoryScopeFloorDisabled({ enabledTables: [], enabledSchemas: ['*'] })).toBe(true);
    expect(includedQueryHistoryTableRefs(tables, { enabledTables: [], enabledSchemas: ['*'] })).toEqual(tables);
  });

  it('fails open when no tables, schemas, or wildcard are configured', () => {
    const tables = [ref('metabase', 'application_table')];

    expect(shouldFailOpenQueryHistoryScope({ enabledTables: [], enabledSchemas: [] })).toBe(true);
    expect(includedQueryHistoryTableRefs(tables, { enabledTables: [], enabledSchemas: [] })).toEqual(tables);
  });
});
