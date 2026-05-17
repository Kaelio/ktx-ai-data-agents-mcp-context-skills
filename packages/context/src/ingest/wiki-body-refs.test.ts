import { describe, expect, it } from 'vitest';
import { findInvalidWikiBodyRefs, parseWikiBodyRefs } from './wiki-body-refs.js';

const sources = [
  {
    name: 'mart_account_segments',
    grain: ['account_id'],
    columns: [
      { name: 'account_id', type: 'string' },
      { name: 'segment', type: 'string' },
    ],
    joins: [],
    measures: [{ name: 'total_contract_arr', expr: 'sum(contract_arr)' }],
    segments: [{ name: 'enterprise', expr: "segment = 'enterprise'" }],
    table: 'analytics.mart_account_segments',
  },
];

describe('wiki body refs', () => {
  it('parses only explicit inline-code body references outside fenced blocks', () => {
    const body = [
      'Valid `mart_account_segments.total_contract_arr` and `source:mart_account_segments`.',
      'Also `warehouse/mart_account_segments.segment` and `table:analytics.mart_account_segments`.',
      'Ignore prose mart_account_segments.total_contract_arr_cents.',
      'Ignore `single_token`.',
      '```sql',
      'select `mart_account_segments.total_contract_arr_cents`',
      '```',
    ].join('\n');

    expect(parseWikiBodyRefs(body)).toEqual([
      { kind: 'sl_entity', connectionId: null, sourceName: 'mart_account_segments', entityName: 'total_contract_arr' },
      { kind: 'sl_source', connectionId: null, sourceName: 'mart_account_segments' },
      { kind: 'sl_entity', connectionId: 'warehouse', sourceName: 'mart_account_segments', entityName: 'segment' },
      { kind: 'table', connectionId: null, tableRef: 'analytics.mart_account_segments' },
    ]);
  });

  it('rejects stale inline-code semantic-layer references', async () => {
    const invalid = await findInvalidWikiBodyRefs({
      pageKey: 'account-segments',
      body: 'ARR is documented as `mart_account_segments.total_contract_arr_cents`.',
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => sources,
      tableExists: async () => true,
    });

    expect(invalid).toEqual([
      'account-segments: unknown semantic-layer entity mart_account_segments.total_contract_arr_cents',
    ]);
  });

  it('validates source, dimension, segment, measure, and table references', async () => {
    const invalid = await findInvalidWikiBodyRefs({
      pageKey: 'account-segments',
      body: [
        '`mart_account_segments.total_contract_arr`',
        '`mart_account_segments.segment`',
        '`mart_account_segments.enterprise`',
        '`source:mart_account_segments`',
        '`table:analytics.mart_account_segments`',
      ].join('\n'),
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => sources,
      tableExists: async (_connectionId, tableRef) => tableRef === 'analytics.mart_account_segments',
    });

    expect(invalid).toEqual([]);
  });

  it('ignores two-part inline code when the source is not visible', async () => {
    const invalid = await findInvalidWikiBodyRefs({
      pageKey: 'engineering-notes',
      body: [
        'A version token like `node.v22` is not a semantic-layer reference.',
        'A raw table must use `table:analytics.mart_account_segments`.',
      ].join('\n'),
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => sources,
      tableExists: async (_connectionId, tableRef) => tableRef === 'analytics.mart_account_segments',
    });

    expect(invalid).toEqual([]);
  });

  it('still rejects explicit missing source and table references', async () => {
    const invalid = await findInvalidWikiBodyRefs({
      pageKey: 'account-segments',
      body: [
        '`source:missing_source`',
        '`warehouse/source:missing_source`',
        '`table:analytics.missing_table`',
      ].join('\n'),
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => sources,
      tableExists: async () => false,
    });

    expect(invalid).toEqual([
      'account-segments: unknown semantic-layer source missing_source',
      'account-segments: unknown semantic-layer source warehouse/missing_source',
      'account-segments: unknown raw table analytics.missing_table',
    ]);
  });
});
