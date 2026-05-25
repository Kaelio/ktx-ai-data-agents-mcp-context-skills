import { describe, expect, it } from 'vitest';
import { extractReferencedCardIds, serializeCard } from '../../../../../src/context/ingest/adapters/metabase/serialize-card.js';

describe('extractReferencedCardIds', () => {
  it('pulls ids out of template tags with type=card', () => {
    const tags = [
      { name: 'orders', type: 'card', cardReference: 42 },
      { name: 'param', type: 'text' },
    ];
    expect(extractReferencedCardIds(tags, '')).toEqual([42]);
  });

  it('finds `{{#N}}` references in the SQL body even when the tag list lacks cardReference', () => {
    const tags = [{ name: 'orders_ref', type: 'card' }];
    const sql = 'SELECT * FROM ({{#42}}) UNION ALL (SELECT * FROM {{#101}})';
    expect(extractReferencedCardIds(tags, sql).sort((a, b) => a - b)).toEqual([42, 101]);
  });

  it('dedupes card ids across tags and SQL body', () => {
    const tags = [{ name: 'a', type: 'card', cardReference: 42 }];
    const sql = 'SELECT * FROM {{#42}}';
    expect(extractReferencedCardIds(tags, sql)).toEqual([42]);
  });

  it('returns [] when no references exist', () => {
    expect(extractReferencedCardIds([], 'SELECT 1')).toEqual([]);
  });
});

describe('serializeCard', () => {
  const baseCard = {
    id: 7,
    name: 'Daily orders',
    description: 'Orders by day',
    type: 'model',
    database_id: 42,
    collection_id: 5,
    archived: false,
    result_metadata: [
      {
        name: 'order_count',
        display_name: 'Count',
        base_type: 'type/Integer',
        semantic_type: null,
        description: null,
        fk_target_field_id: null,
      },
    ],
  } as const;

  it('returns a valid StagedCardFile with resolved SQL and template tags', () => {
    const staged = serializeCard({
      card: baseCard as any,
      resolvedSql: 'SELECT COUNT(*) AS order_count FROM orders',
      templateTags: [],
      collectionPath: ['Data', 'Orders'],
      resolutionStatus: 'resolved',
    });
    expect(staged.metabaseId).toBe(7);
    expect(staged.name).toBe('Daily orders');
    expect(staged.collectionPath).toEqual(['Data', 'Orders']);
    expect(staged.resolvedSql).toBe('SELECT COUNT(*) AS order_count FROM orders');
    expect(staged.referencedCardIds).toEqual([]);
    expect(staged.resultMetadata).toHaveLength(1);
    expect(staged.resultMetadata[0].name).toBe('order_count');
  });

  it('persists resolutionStatus="resolved" when caller passes it', () => {
    const staged = serializeCard({
      card: baseCard as any,
      resolvedSql: 'SELECT 1',
      templateTags: [],
      collectionPath: [],
      resolutionStatus: 'resolved',
    });

    expect(staged.resolutionStatus).toBe('resolved');
  });

  it('persists resolutionStatus="fallback" when caller passes it', () => {
    const staged = serializeCard({
      card: baseCard as any,
      resolvedSql: 'SELECT * FROM {{#101}}',
      templateTags: [{ name: 'ref', type: 'card', cardReference: 101 }],
      collectionPath: [],
      resolutionStatus: 'fallback',
    });

    expect(staged.resolutionStatus).toBe('fallback');
  });

  it('extracts referencedCardIds from template tags + SQL body', () => {
    const staged = serializeCard({
      card: baseCard as any,
      resolvedSql: 'SELECT * FROM {{#101}}',
      templateTags: [{ name: 'ref', type: 'card', cardReference: 101 }],
      collectionPath: [],
      resolutionStatus: 'resolved',
    });
    expect(staged.referencedCardIds).toEqual([101]);
  });

  it('null description passes through as null, not empty string', () => {
    const staged = serializeCard({
      card: { ...baseCard, description: null } as any,
      resolvedSql: '',
      templateTags: [],
      collectionPath: [],
      resolutionStatus: 'resolved',
    });
    expect(staged.description).toBeNull();
  });

  it('collectionId=`root` stays as the string literal "root"', () => {
    const staged = serializeCard({
      card: { ...baseCard, collection_id: 'root' } as any,
      resolvedSql: '',
      templateTags: [],
      collectionPath: [],
      resolutionStatus: 'resolved',
    });
    expect(staged.collectionId).toBe('root');
  });

  it('persists parameters[] from the input card', () => {
    const out = serializeCard({
      card: {
        id: 1,
        name: 'X',
        description: null,
        type: 'question',
        database_id: 6,
        collection_id: null,
        archived: false,
        result_metadata: [],
        parameters: [
          { id: 'p1', name: 'auction_end', type: 'date/range', slug: 'auction_end', default: null, sectionId: 'date' },
          { id: 'p2', name: 'status', type: 'category', slug: 'status', default: 'active', sectionId: 'string' },
        ],
      } as any,
      resolvedSql: 'SELECT 1',
      templateTags: [],
      collectionPath: [],
      resolutionStatus: 'resolved',
    });
    expect(out.parameters).toHaveLength(2);
    expect(out.parameters?.[0]).toMatchObject({ id: 'p1', name: 'auction_end', type: 'date/range' });
  });

  it('persists field_ref on each result-metadata column', () => {
    const out = serializeCard({
      card: {
        id: 1,
        name: 'X',
        description: null,
        type: 'question',
        database_id: 6,
        collection_id: null,
        archived: false,
        result_metadata: [
          {
            name: 'customer_id',
            base_type: 'type/Integer',
            semantic_type: 'type/FK',
            fk_target_field_id: 42,
            field_ref: ['field', 99, null],
          },
        ],
      } as any,
      resolvedSql: 'SELECT customer_id FROM x',
      templateTags: [],
      collectionPath: [],
      resolutionStatus: 'resolved',
    });
    expect(out.resultMetadata[0].field_ref).toEqual(['field', 99, null]);
  });

  it('persists lastRunAt and dashboardCount when present on the card', () => {
    const out = serializeCard({
      card: {
        id: 1,
        name: 'X',
        description: null,
        type: 'question',
        database_id: 6,
        collection_id: null,
        archived: false,
        result_metadata: [],
        last_run_at: '2026-04-27T10:00:00Z',
        dashboard_count: 3,
      } as any,
      resolvedSql: 'SELECT 1',
      templateTags: [],
      collectionPath: [],
      resolutionStatus: 'resolved',
    });
    expect(out.lastRunAt).toBe('2026-04-27T10:00:00Z');
    expect(out.dashboardCount).toBe(3);
  });

  it('omits the new fields gracefully when the card lacks them', () => {
    const out = serializeCard({
      card: {
        id: 1,
        name: 'X',
        description: null,
        type: 'question',
        database_id: 6,
        collection_id: null,
        archived: false,
        result_metadata: [],
      } as any,
      resolvedSql: 'SELECT 1',
      templateTags: [],
      collectionPath: [],
      resolutionStatus: 'resolved',
    });
    expect(out.parameters).toEqual([]);
    expect(out.lastRunAt).toBeNull();
    expect(out.dashboardCount).toBeNull();
  });
});
