import { describe, expect, it } from 'vitest';
import type {
  KtxEnrichedColumn,
  KtxEnrichedSchema,
  KtxEnrichedTable,
  KtxRelationshipEndpoint,
} from './enrichment-types.js';
import type { KtxRelationshipProfileArtifact } from './relationship-profiling.js';
import type { KtxValidatedRelationshipDiscoveryCandidate } from './relationship-validation.js';
import { resolveKtxRelationshipGraph } from './relationship-graph-resolver.js';

function column(tableId: string, name: string, overrides: Partial<KtxEnrichedColumn> = {}): KtxEnrichedColumn {
  const tableRef = overrides.tableRef ?? { catalog: null, db: null, name: tableId };
  return {
    id: `${tableId}.${name}`,
    tableId,
    tableRef,
    name,
    nativeType: overrides.nativeType ?? 'INTEGER',
    normalizedType: overrides.normalizedType ?? 'integer',
    dimensionType: overrides.dimensionType ?? 'number',
    nullable: overrides.nullable ?? true,
    primaryKey: overrides.primaryKey ?? false,
    parentColumnId: null,
    descriptions: {},
    embedding: null,
    sampleValues: null,
    cardinality: null,
    ...overrides,
  };
}

function table(name: string, columns: KtxEnrichedColumn[]): KtxEnrichedTable {
  const ref = { catalog: null, db: null, name };
  return {
    id: name,
    ref,
    enabled: true,
    descriptions: {},
    columns: columns.map((item) => ({ ...item, tableId: name, tableRef: ref })),
  };
}

function schema(overrides: { accountsPrimaryKey?: boolean } = {}): KtxEnrichedSchema {
  return {
    connectionId: 'warehouse',
    tables: [
      table('accounts', [
        column('accounts', 'id', { nullable: false, primaryKey: overrides.accountsPrimaryKey ?? false }),
        column('accounts', 'name', { nativeType: 'TEXT', normalizedType: 'text', dimensionType: 'string' }),
      ]),
      table('account_archive', [column('account_archive', 'id', { nullable: false })]),
      table('users', [
        column('users', 'id', { nullable: false }),
        column('users', 'account_id', { nullable: false }),
      ]),
    ],
    relationships: [],
  };
}

function endpoint(tableName: string, columnName: string): KtxRelationshipEndpoint {
  return {
    tableId: tableName,
    columnIds: [`${tableName}.${columnName}`],
    table: { catalog: null, db: null, name: tableName },
    columns: [columnName],
  };
}

function profiles(): KtxRelationshipProfileArtifact {
  return {
    connectionId: 'warehouse',
    driver: 'sqlite',
    sqlAvailable: true,
    queryCount: 0,
    tables: [
      { table: { catalog: null, db: null, name: 'accounts' }, rowCount: 3 },
      { table: { catalog: null, db: null, name: 'account_archive' }, rowCount: 3 },
      { table: { catalog: null, db: null, name: 'users' }, rowCount: 3 },
    ],
    columns: {
      'accounts.id': {
        table: { catalog: null, db: null, name: 'accounts' },
        column: 'id',
        nativeType: 'INTEGER',
        normalizedType: 'integer',
        rowCount: 3,
        nullCount: 0,
        distinctCount: 3,
        uniquenessRatio: 1,
        nullRate: 0,
        sampleValues: ['1', '2', '3'],
        minTextLength: 1,
        maxTextLength: 1,
      },
      'account_archive.id': {
        table: { catalog: null, db: null, name: 'account_archive' },
        column: 'id',
        nativeType: 'INTEGER',
        normalizedType: 'integer',
        rowCount: 3,
        nullCount: 0,
        distinctCount: 3,
        uniquenessRatio: 1,
        nullRate: 0,
        sampleValues: ['1', '2', '3'],
        minTextLength: 1,
        maxTextLength: 1,
      },
      'users.account_id': {
        table: { catalog: null, db: null, name: 'users' },
        column: 'account_id',
        nativeType: 'INTEGER',
        normalizedType: 'integer',
        rowCount: 3,
        nullCount: 0,
        distinctCount: 3,
        uniquenessRatio: 1,
        nullRate: 0,
        sampleValues: ['1', '2', '3'],
        minTextLength: 1,
        maxTextLength: 1,
      },
    },
    warnings: [],
  };
}

function validatedCandidate(
  overrides: Partial<KtxValidatedRelationshipDiscoveryCandidate> = {},
): KtxValidatedRelationshipDiscoveryCandidate {
  const from = overrides.from ?? endpoint('users', 'account_id');
  const to = overrides.to ?? endpoint('accounts', 'id');
  return {
    id: `${from.tableId}:(${from.columnIds.join(',')})->${to.tableId}:(${to.columnIds.join(',')})`,
    from,
    to,
    relationshipType: 'many_to_one',
    confidence: overrides.confidence ?? 0.95,
    source: overrides.source ?? 'normalized_table_match',
    status: overrides.status ?? 'accepted',
    score: overrides.score ?? 0.96,
    evidence: {
      sourceColumnBase: 'account',
      targetTableBase: to.table.name,
      targetColumnBase: to.columns[0] ?? '',
      targetKeyScore: 0.92,
      nameScore: 0.92,
      reasons: ['foreign_key_suffix', 'normalized_table_name', 'target_key_like'],
      ...overrides.evidence,
    },
    validation: {
      targetUniqueness: 1,
      sourceCoverage: 1,
      violationCount: 0,
      violationRatio: 0,
      sourceNullRate: 0,
      targetNullRate: 0,
      childDistinct: 3,
      parentDistinct: 3,
      overlap: 3,
      checkedValues: 3,
      reasons: ['validation_passed'],
      ...overrides.validation,
    },
    ...overrides,
  };
}

describe('relationship graph resolver', () => {
  it('promotes validated relationship discovery references to accepted relationships and inferred PKs', () => {
    const result = resolveKtxRelationshipGraph({
      schema: schema(),
      profiles: profiles(),
      candidates: [validatedCandidate()],
    });

    expect(result.pks).toContainEqual({
      table: 'accounts',
      columns: ['id'],
      pkScore: expect.any(Number),
      status: 'accepted',
      incomingCandidateCount: 1,
      evidence: {
        declaredPrimaryKey: false,
        targetUniqueness: 1,
        incomingAcceptedCount: 1,
        incomingReviewCount: 0,
        reasons: expect.arrayContaining(['unique_target_column', 'incoming_validated_reference']),
      },
    });
    expect(result.pks.find((pk) => pk.table === 'accounts')?.pkScore).toBeGreaterThanOrEqual(0.85);
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]).toMatchObject({
      from: { table: { name: 'users' }, columns: ['account_id'] },
      to: { table: { name: 'accounts' }, columns: ['id'] },
      status: 'accepted',
      pkScore: expect.any(Number),
      fkScore: expect.any(Number),
      graph: {
        reasons: expect.arrayContaining(['target_pk_score_passed', 'fk_score_passed']),
      },
    });
    expect(result.relationships[0]?.fkScore).toBeGreaterThanOrEqual(0.85);
  });

  it('keeps validation-unavailable candidates in review even when name evidence is strong', () => {
    const result = resolveKtxRelationshipGraph({
      schema: schema(),
      profiles: { ...profiles(), sqlAvailable: false, columns: {}, warnings: ['read_only_sql_unavailable'] },
      candidates: [
        validatedCandidate({
          status: 'review',
          score: 0.57,
          validation: {
            targetUniqueness: 0,
            sourceCoverage: 0,
            violationCount: 0,
            violationRatio: 1,
            sourceNullRate: 0,
            targetNullRate: 0,
            childDistinct: 0,
            parentDistinct: 0,
            overlap: 0,
            checkedValues: 0,
            reasons: ['validation_unavailable'],
          },
        }),
      ],
    });

    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]).toMatchObject({
      status: 'review',
      graph: {
        reasons: expect.arrayContaining(['validation_unavailable_review_only']),
      },
    });
    expect(result.relationships[0]?.fkScore).toBeGreaterThanOrEqual(0.55);
  });

  it('accepts at most one target per source column and rejects the lower-scored conflict loser', () => {
    const winner = validatedCandidate({ confidence: 0.95, score: 0.96 });
    const loser = validatedCandidate({
      from: endpoint('users', 'account_id'),
      to: endpoint('account_archive', 'id'),
      confidence: 0.85,
      score: 0.9,
      evidence: {
        sourceColumnBase: 'account',
        targetTableBase: 'account_archive',
        targetColumnBase: 'id',
        targetKeyScore: 0.92,
        nameScore: 0.78,
        reasons: ['foreign_key_suffix', 'inflection', 'target_key_like'],
      },
    });

    const result = resolveKtxRelationshipGraph({
      schema: schema(),
      profiles: profiles(),
      candidates: [loser, winner],
    });

    expect(result.relationships.map((relationship) => relationship.status)).toEqual(['accepted', 'rejected']);
    expect(result.relationships[0]?.to.table.name).toBe('accounts');
    expect(result.relationships[1]).toMatchObject({
      to: { table: { name: 'account_archive' }, columns: ['id'] },
      status: 'rejected',
      graph: {
        reasons: expect.arrayContaining(['conflict_lost']),
      },
    });
  });

  it('preserves declared primary keys as accepted even without incoming candidates', () => {
    const result = resolveKtxRelationshipGraph({
      schema: schema({ accountsPrimaryKey: true }),
      profiles: profiles(),
      candidates: [],
    });

    expect(result.relationships).toEqual([]);
    expect(result.pks).toContainEqual({
      table: 'accounts',
      columns: ['id'],
      pkScore: 1,
      status: 'accepted',
      incomingCandidateCount: 0,
      evidence: {
        declaredPrimaryKey: true,
        targetUniqueness: 1,
        incomingAcceptedCount: 0,
        incomingReviewCount: 0,
        reasons: ['declared_primary_key'],
      },
    });
  });

  it('infers profile-only key-like columns without incoming relationship candidates', () => {
    const baseSchema = schema();
    const invoices = table('invoices', [
      column('invoices', 'id', { nullable: false }),
      column('invoices', 'invoice_number', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
        nullable: false,
      }),
      column('invoices', 'amount', {
        nativeType: 'INTEGER',
        normalizedType: 'integer',
        dimensionType: 'number',
        nullable: false,
      }),
    ]);
    const baseProfiles = profiles();
    const result = resolveKtxRelationshipGraph({
      schema: { ...baseSchema, tables: [...baseSchema.tables, invoices] },
      profiles: {
        ...baseProfiles,
        tables: [...baseProfiles.tables, { table: invoices.ref, rowCount: 3 }],
        columns: {
          ...baseProfiles.columns,
          'invoices.id': {
            table: invoices.ref,
            column: 'id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            rowCount: 3,
            nullCount: 0,
            distinctCount: 3,
            uniquenessRatio: 1,
            nullRate: 0,
            sampleValues: ['1', '2', '3'],
            minTextLength: 1,
            maxTextLength: 1,
          },
          'invoices.invoice_number': {
            table: invoices.ref,
            column: 'invoice_number',
            nativeType: 'TEXT',
            normalizedType: 'text',
            rowCount: 3,
            nullCount: 0,
            distinctCount: 3,
            uniquenessRatio: 1,
            nullRate: 0,
            sampleValues: ['INV-1', 'INV-2', 'INV-3'],
            minTextLength: 5,
            maxTextLength: 5,
          },
          'invoices.amount': {
            table: invoices.ref,
            column: 'amount',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            rowCount: 3,
            nullCount: 0,
            distinctCount: 2,
            uniquenessRatio: 2 / 3,
            nullRate: 0,
            sampleValues: ['100', '200'],
            minTextLength: 3,
            maxTextLength: 3,
          },
        },
      },
      candidates: [],
    });

    expect(result.relationships).toEqual([]);
    expect(result.pks).toContainEqual({
      table: 'invoices',
      columns: ['id'],
      pkScore: 1,
      status: 'accepted',
      incomingCandidateCount: 0,
      evidence: {
        declaredPrimaryKey: false,
        targetUniqueness: 1,
        incomingAcceptedCount: 0,
        incomingReviewCount: 0,
        reasons: expect.arrayContaining([
          'unique_target_column',
          'profile_key_name',
          'not_null_profile',
          'profile_only_primary_key',
          'no_incoming_references',
        ]),
      },
    });
    expect(result.pks).toContainEqual(
      expect.objectContaining({
        table: 'invoices',
        columns: ['invoice_number'],
        status: 'review',
        evidence: expect.objectContaining({
          reasons: expect.arrayContaining(['profile_only_primary_key', 'weak_name_profile_key']),
        }),
      }),
    );
    expect(result.pks.some((pk) => pk.table === 'invoices' && pk.columns[0] === 'amount')).toBe(false);
  });

  it('pins single-incoming column_suffix_match resolver scores', () => {
    const schema = {
      connectionId: 'warehouse',
      relationships: [],
      tables: [
        {
          id: 'plans-id',
          ref: { catalog: null, db: null, name: 'stg_plans' },
          enabled: true,
          descriptions: {},
          columns: [
            {
              id: 'plan-code-col',
              tableId: 'plans-id',
              tableRef: { catalog: null, db: null, name: 'stg_plans' },
              name: 'plan_code',
              nativeType: 'TEXT',
              normalizedType: 'text',
              dimensionType: 'string',
              nullable: false,
              primaryKey: false,
              parentColumnId: null,
              descriptions: {},
              embedding: null,
              sampleValues: null,
              cardinality: null,
            },
          ],
        },
        {
          id: 'segments-id',
          ref: { catalog: null, db: null, name: 'mart_account_segments' },
          enabled: true,
          descriptions: {},
          columns: [
            {
              id: 'current-plan-code-col',
              tableId: 'segments-id',
              tableRef: { catalog: null, db: null, name: 'mart_account_segments' },
              name: 'current_plan_code',
              nativeType: 'TEXT',
              normalizedType: 'text',
              dimensionType: 'string',
              nullable: false,
              primaryKey: false,
              parentColumnId: null,
              descriptions: {},
              embedding: null,
              sampleValues: null,
              cardinality: null,
            },
          ],
        },
      ],
    } satisfies KtxEnrichedSchema;
    const profiles = {
      connectionId: 'warehouse',
      driver: 'sqlite' as const,
      sqlAvailable: true,
      queryCount: 0,
      tables: [],
      warnings: [],
      columns: {
        'stg_plans.plan_code': {
          table: { catalog: null, db: null, name: 'stg_plans' },
          column: 'plan_code',
          nativeType: 'TEXT',
          normalizedType: 'text',
          rowCount: 4,
          nullCount: 0,
          distinctCount: 4,
          uniquenessRatio: 1,
          nullRate: 0,
          sampleValues: ['basic', 'enterprise', 'free', 'pro'],
          minTextLength: 4,
          maxTextLength: 10,
        },
      },
    };
    const result = resolveKtxRelationshipGraph({
      schema,
      profiles,
      candidates: [
        {
          id: 'segments:(current_plan_code)->plans:(plan_code)',
          from: {
            tableId: 'segments-id',
            columnIds: ['current-plan-code-col'],
            table: { catalog: null, db: null, name: 'mart_account_segments' },
            columns: ['current_plan_code'],
          },
          to: {
            tableId: 'plans-id',
            columnIds: ['plan-code-col'],
            table: { catalog: null, db: null, name: 'stg_plans' },
            columns: ['plan_code'],
          },
          relationshipType: 'many_to_one',
          confidence: 0.902,
          source: 'column_suffix_match',
          evidence: {
            sourceColumnBase: 'current_plan',
            targetTableBase: 'plan',
            targetColumnBase: 'plan_code',
            targetKeyScore: 0.86,
            nameScore: 0.78,
            reasons: ['column_suffix_match', 'profile_unique_target'],
          },
          status: 'accepted',
          score: 0.98,
          validation: {
            targetUniqueness: 1,
            sourceCoverage: 1,
            violationCount: 0,
            violationRatio: 0,
            sourceNullRate: 0,
            targetNullRate: 0,
            childDistinct: 4,
            parentDistinct: 4,
            overlap: 4,
            checkedValues: 4,
            reasons: ['validation_passed'],
          },
        },
      ],
    });

    expect(result.pks).toEqual([
      expect.objectContaining({
        table: 'stg_plans',
        columns: ['plan_code'],
        pkScore: 0.922,
        status: 'accepted',
      }),
    ]);
    expect(result.relationships).toEqual([
      expect.objectContaining({
        source: 'column_suffix_match',
        status: 'accepted',
        pkScore: 0.922,
        fkScore: 0.953,
      }),
    ]);
  });

  it('keeps strong profile-only primary key evidence when name evidence is weak', () => {
    const baseSchema = schema();
    baseSchema.tables.push(
      table('events', [
        column('events', 'warehouse_key', {
          nullable: false,
          primaryKey: false,
          nativeType: 'INTEGER',
          normalizedType: 'integer',
        }),
      ]),
    );

    const baseProfiles = profiles();
    baseProfiles.tables.push({ table: { catalog: null, db: null, name: 'events' }, rowCount: 3 });
    baseProfiles.columns['events.warehouse_key'] = {
      table: { catalog: null, db: null, name: 'events' },
      column: 'warehouse_key',
      nativeType: 'INTEGER',
      normalizedType: 'integer',
      rowCount: 3,
      nullCount: 0,
      distinctCount: 3,
      uniquenessRatio: 1,
      nullRate: 0,
      sampleValues: ['100', '101', '102'],
      minTextLength: 3,
      maxTextLength: 3,
    };

    const result = resolveKtxRelationshipGraph({
      schema: baseSchema,
      profiles: baseProfiles,
      candidates: [],
    });

    expect(result.pks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'events',
          columns: ['warehouse_key'],
          status: 'review',
          evidence: expect.objectContaining({
            reasons: expect.arrayContaining(['profile_only_primary_key', 'weak_name_profile_key']),
          }),
        }),
      ]),
    );
  });

  it('keeps strong profile-only primary key evidence when the column is not key-shaped', () => {
    const baseSchema = schema();
    baseSchema.tables.push(
      table('events', [
        column('events', 'opaque_reference', {
          nullable: false,
          primaryKey: false,
          nativeType: 'INTEGER',
          normalizedType: 'integer',
        }),
      ]),
    );

    const baseProfiles = profiles();
    baseProfiles.tables.push({ table: { catalog: null, db: null, name: 'events' }, rowCount: 3 });
    baseProfiles.columns['events.opaque_reference'] = {
      table: { catalog: null, db: null, name: 'events' },
      column: 'opaque_reference',
      nativeType: 'INTEGER',
      normalizedType: 'integer',
      rowCount: 3,
      nullCount: 0,
      distinctCount: 3,
      uniquenessRatio: 1,
      nullRate: 0,
      sampleValues: ['100', '101', '102'],
      minTextLength: 3,
      maxTextLength: 3,
    };

    const result = resolveKtxRelationshipGraph({
      schema: baseSchema,
      profiles: baseProfiles,
      candidates: [],
    });

    const inferredPk = result.pks.find((candidate) => candidate.table === 'events');
    expect(inferredPk).toMatchObject({
      table: 'events',
      columns: ['opaque_reference'],
      status: 'review',
      evidence: expect.objectContaining({
        reasons: expect.arrayContaining(['profile_only_primary_key', 'weak_name_profile_key']),
      }),
    });
    expect(inferredPk?.pkScore).toBeGreaterThanOrEqual(0.55);
  });
});
