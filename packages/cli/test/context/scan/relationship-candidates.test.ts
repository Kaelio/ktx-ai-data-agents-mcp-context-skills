import { describe, expect, it } from 'vitest';
import type { KtxEnrichedColumn, KtxEnrichedSchema, KtxEnrichedTable } from '../../../src/context/scan/enrichment-types.js';
import { normalizeKtxRelationshipName } from '../../../src/context/scan/relationship-name-similarity.js';
import {
  generateKtxRelationshipDiscoveryCandidates,
  inferKtxRelationshipTargetPks,
  mergeKtxRelationshipDiscoveryCandidates,
} from '../../../src/context/scan/relationship-candidates.js';
import type { KtxRelationshipProfileArtifact } from '../../../src/context/scan/relationship-profiling.js';

function column(
  tableId: string,
  id: string,
  name: string,
  options: Partial<KtxEnrichedColumn> = {},
): KtxEnrichedColumn {
  const tableRef = options.tableRef ?? { catalog: null, db: 'public', name: tableId };
  return {
    id,
    tableId,
    tableRef,
    name,
    nativeType: options.nativeType ?? 'INTEGER',
    normalizedType: options.normalizedType ?? 'integer',
    dimensionType: options.dimensionType ?? 'number',
    nullable: options.nullable ?? true,
    primaryKey: options.primaryKey ?? false,
    parentColumnId: options.parentColumnId ?? null,
    descriptions: options.descriptions ?? {},
    embedding: options.embedding ?? null,
    sampleValues: options.sampleValues ?? null,
    cardinality: options.cardinality ?? null,
  };
}

function table(id: string, name: string, columns: KtxEnrichedColumn[]): KtxEnrichedTable {
  const ref = { catalog: null, db: 'public', name };
  return {
    id,
    ref,
    enabled: true,
    descriptions: {},
    columns: columns.map((item) => ({ ...item, tableId: id, tableRef: ref })),
  };
}

function schema(tables: KtxEnrichedTable[]): KtxEnrichedSchema {
  return {
    connectionId: 'warehouse',
    tables,
    relationships: [],
  };
}

function planCodeProfiles(): KtxRelationshipProfileArtifact {
  return {
    connectionId: 'warehouse',
    driver: 'sqlite',
    sqlAvailable: true,
    queryCount: 0,
    tables: [
      { table: { catalog: null, db: 'public', name: 'stg_plans' }, rowCount: 4 },
      { table: { catalog: null, db: 'public', name: 'mart_account_segments' }, rowCount: 4 },
      { table: { catalog: null, db: 'public', name: 'stg_plan_segment_mapping' }, rowCount: 4 },
    ],
    warnings: [],
    columns: {
      'stg_plans.plan_code': {
        table: { catalog: null, db: 'public', name: 'stg_plans' },
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
      'stg_plans.created_at': {
        table: { catalog: null, db: 'public', name: 'stg_plans' },
        column: 'created_at',
        nativeType: 'TEXT',
        normalizedType: 'text',
        rowCount: 4,
        nullCount: 0,
        distinctCount: 4,
        uniquenessRatio: 1,
        nullRate: 0,
        sampleValues: ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04'],
        minTextLength: 10,
        maxTextLength: 10,
      },
      'stg_plans.email': {
        table: { catalog: null, db: 'public', name: 'stg_plans' },
        column: 'email',
        nativeType: 'TEXT',
        normalizedType: 'text',
        rowCount: 4,
        nullCount: 0,
        distinctCount: 4,
        uniquenessRatio: 1,
        nullRate: 0,
        sampleValues: ['a@example.test', 'b@example.test', 'c@example.test', 'd@example.test'],
        minTextLength: 14,
        maxTextLength: 14,
      },
      'stg_plans.is_deleted': {
        table: { catalog: null, db: 'public', name: 'stg_plans' },
        column: 'is_deleted',
        nativeType: 'TEXT',
        normalizedType: 'text',
        rowCount: 4,
        nullCount: 0,
        distinctCount: 4,
        uniquenessRatio: 1,
        nullRate: 0,
        sampleValues: ['deleted-a', 'deleted-b', 'deleted-c', 'deleted-d'],
        minTextLength: 9,
        maxTextLength: 9,
      },
      'mart_account_segments.current_plan_code': {
        table: { catalog: null, db: 'public', name: 'mart_account_segments' },
        column: 'current_plan_code',
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
      'mart_account_segments.normalized_plan_code': {
        table: { catalog: null, db: 'public', name: 'mart_account_segments' },
        column: 'normalized_plan_code',
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
      'stg_plan_segment_mapping.canonical_plan_code': {
        table: { catalog: null, db: 'public', name: 'stg_plan_segment_mapping' },
        column: 'canonical_plan_code',
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
      'stg_plans.canonical_plan_code': {
        table: { catalog: null, db: 'public', name: 'stg_plans' },
        column: 'canonical_plan_code',
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
}

describe('relationship discovery candidates', () => {
  it('normalizes warehouse prefixes and emits review candidates without declared primary keys', () => {
    const accounts = table('accounts-id', 'dim_accounts', [
      column('accounts-id', 'accounts-id-col', 'id', { primaryKey: false }),
      column('accounts-id', 'accounts-name-col', 'account_name', { nativeType: 'TEXT', normalizedType: 'text' }),
    ]);
    const invoices = table('invoices-id', 'fct_invoices', [
      column('invoices-id', 'invoice-id-col', 'id', { primaryKey: false }),
      column('invoices-id', 'account-id-col', 'account_id', { primaryKey: false }),
    ]);

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([accounts, invoices]));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      from: { tableId: 'invoices-id', columnIds: ['account-id-col'], columns: ['account_id'] },
      to: { tableId: 'accounts-id', columnIds: ['accounts-id-col'], columns: ['id'] },
      relationshipType: 'many_to_one',
      status: 'review',
      source: 'normalized_table_match',
      evidence: {
        sourceColumnBase: 'account',
        targetTableBase: 'account',
        targetKeyScore: 0.92,
      },
    });
    expect(candidates[0]?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(candidates[0]?.evidence.signalVector).toMatchObject({
      nameSimilarity: 0.92,
      typeCompatibility: 1,
      valueOverlap: 0,
      embeddingSimilarity: 0,
      profileUniqueness: 0.92,
    });
    expect(candidates[0]?.evidence.scoreBreakdown?.score).toBe(candidates[0]?.confidence);
    expect(candidates[0]?.evidence.scoreBreakdown?.contributions.nameSimilarity).toBeGreaterThan(0);
    expect(candidates[0]?.evidence.reasons).toEqual(
      expect.arrayContaining(['foreign_key_suffix', 'normalized_table_name', 'target_key_like']),
    );
  });

  it('generates candidates for PascalCase ID columns without declared keys', () => {
    const artists = table('artist-id', 'Artist', [
      column('artist-id', 'artist-id-col', 'ArtistId', { primaryKey: false }),
      column('artist-id', 'artist-name-col', 'Name', { nativeType: 'TEXT', normalizedType: 'text' }),
    ]);
    const albums = table('album-id', 'Album', [
      column('album-id', 'album-id-col', 'AlbumId', { primaryKey: false }),
      column('album-id', 'artist-id-fk-col', 'ArtistId', { primaryKey: false }),
    ]);

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([artists, albums]));

    expect(
      candidates.map(
        (candidate) =>
          `${candidate.from.table.name}.${candidate.from.columns[0]}->${candidate.to.table.name}.${candidate.to.columns[0]}`,
      ),
    ).toEqual(['Album.ArtistId->Artist.ArtistId']);
    expect(candidates[0]).toMatchObject({
      source: 'normalized_table_match',
      evidence: {
        sourceColumnBase: 'artist',
        targetTableBase: 'artist',
        targetColumnBase: 'artist_id',
        targetKeyScore: 0.9,
        reasons: expect.arrayContaining(['foreign_key_suffix', 'normalized_table_name', 'target_key_like']),
      },
    });
    expect(candidates[0]?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('uses the locality cap before scanning parent tables', () => {
    const accounts = table('accounts-id', 'accounts', [column('accounts-id', 'accounts-id-col', 'id')]);
    const invoices = table('invoices-id', 'invoices', [
      column('invoices-id', 'invoice-id-col', 'id'),
      column('invoices-id', 'account-id-col', 'account_id'),
    ]);

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([accounts, invoices]), {
      maxCandidateParentTables: 0,
    });

    expect(candidates).toEqual([]);
  });

  it('keeps the nearest parent when the locality cap is one', () => {
    const artists = table('artist-id', 'Artist', [
      column('artist-id', 'artist-id-col', 'ArtistId', { primaryKey: false }),
      column('artist-id', 'artist-name-col', 'Name', { nativeType: 'TEXT', normalizedType: 'text' }),
    ]);
    const albums = table('album-id', 'Album', [
      column('album-id', 'album-id-col', 'AlbumId', { primaryKey: false }),
      column('album-id', 'artist-id-fk-col', 'ArtistId', { primaryKey: false }),
    ]);
    const fillerTables = Array.from({ length: 25 }, (_, index) =>
      table(`filler-${index}`, `WarehouseFiller${index}`, [
        column(`filler-${index}`, `filler-${index}-id`, 'WarehouseFillerId', { primaryKey: false }),
      ]),
    );

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([albums, ...fillerTables, artists]), {
      maxCandidateParentTables: 1,
    });

    expect(
      candidates.map(
        (candidate) =>
          `${candidate.from.table.name}.${candidate.from.columns[0]}->${candidate.to.table.name}.${candidate.to.columns[0]}`,
      ),
    ).toEqual(['Album.ArtistId->Artist.ArtistId']);
  });

  it('uses final table tokens from dotted parent table names', () => {
    const customers = table('customer-id', 'SalesLT.Customer', [
      column('customer-id', 'customer-id-col', 'CustomerID', { primaryKey: false }),
      column('customer-id', 'customer-name-col', 'CustomerName', { nativeType: 'TEXT', normalizedType: 'text' }),
    ]);
    const orders = table('order-id', 'SalesLT.SalesOrderHeader', [
      column('order-id', 'order-id-col', 'SalesOrderID', { primaryKey: false }),
      column('order-id', 'customer-id-fk-col', 'CustomerID', { primaryKey: false }),
    ]);

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([customers, orders]));

    expect(
      candidates.map(
        (candidate) =>
          `${candidate.from.table.name}.${candidate.from.columns[0]}->${candidate.to.table.name}.${candidate.to.columns[0]}`,
      ),
    ).toEqual(['SalesLT.SalesOrderHeader.CustomerID->SalesLT.Customer.CustomerID']);
    expect(candidates[0]).toMatchObject({
      evidence: {
        sourceColumnBase: 'customer',
        targetTableBase: 'sales_lt_customer',
        targetColumnBase: 'customer_id',
        targetKeyScore: 0.9,
        reasons: expect.arrayContaining(['foreign_key_suffix', 'inflection', 'target_key_like']),
      },
    });
  });

  it('emits lower-confidence parent-table-name candidates when the target key name differs from the table name', () => {
    const customerAccounts = table('customer-account-id', 'crm.CustomerAccount', [
      column('customer-account-id', 'business-entity-id-col', 'BusinessEntityID', { primaryKey: true }),
      column('customer-account-id', 'account-name-col', 'AccountName', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
    ]);
    const subscriptions = table('subscriptions-id', 'fct_subscriptions', [
      column('subscriptions-id', 'subscription-id-col', 'SubscriptionID', { primaryKey: false }),
      column('subscriptions-id', 'customer-account-id-col', 'CustomerAccountID', { primaryKey: false }),
    ]);

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([customerAccounts, subscriptions]));

    expect(
      candidates.map(
        (candidate) =>
          `${candidate.from.table.name}.${candidate.from.columns[0]}->${candidate.to.table.name}.${candidate.to.columns[0]}`,
      ),
    ).toEqual(['fct_subscriptions.CustomerAccountID->crm.CustomerAccount.BusinessEntityID']);
    expect(candidates[0]).toMatchObject({
      source: 'parent_table_name_match',
      relationshipType: 'many_to_one',
      status: 'review',
      evidence: {
        sourceColumnBase: 'customer_account',
        targetTableBase: 'crm_customer_account',
        targetColumnBase: 'business_entity_id',
        targetKeyScore: 1,
        nameScore: 0.82,
        reasons: expect.arrayContaining(['foreign_key_suffix', 'parent_table_name_match', 'target_key_like']),
      },
    });
    expect(candidates[0]?.evidence.signalVector).toMatchObject({
      nameSimilarity: 0.82,
      typeCompatibility: 1,
    });
    expect(candidates[0]?.evidence.scoreBreakdown?.score).toBe(candidates[0]?.confidence);
  });

  it('does not emit parent-table-name candidates when the target key type is incompatible', () => {
    const customerAccounts = table('customer-account-id', 'crm.CustomerAccount', [
      column('customer-account-id', 'business-entity-id-col', 'BusinessEntityID', {
        primaryKey: true,
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
    ]);
    const subscriptions = table('subscriptions-id', 'fct_subscriptions', [
      column('subscriptions-id', 'customer-account-id-col', 'CustomerAccountID', {
        primaryKey: false,
        nativeType: 'INTEGER',
        normalizedType: 'integer',
        dimensionType: 'number',
      }),
    ]);

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([customerAccounts, subscriptions]));

    expect(
      candidates.map(
        (candidate) =>
          `${candidate.from.table.name}.${candidate.from.columns[0]}->${candidate.to.table.name}.${candidate.to.columns[0]}`,
      ),
    ).not.toContain('fct_subscriptions.CustomerAccountID->crm.CustomerAccount.BusinessEntityID');
  });

  it('does not use parent-table-name matching to create same-table same-column self-links', () => {
    const customerAccounts = table('customer-account-id', 'crm.CustomerAccount', [
      column('customer-account-id', 'customer-account-id-col', 'CustomerAccountID', { primaryKey: false }),
      column('customer-account-id', 'account-name-col', 'AccountName', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
    ]);

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([customerAccounts]));

    expect(
      candidates.map(
        (candidate) =>
          `${candidate.from.table.name}.${candidate.from.columns[0]}->${candidate.to.table.name}.${candidate.to.columns[0]}`,
      ),
    ).not.toContain('crm.CustomerAccount.CustomerAccountID->crm.CustomerAccount.CustomerAccountID');
  });

  it('uses profile evidence to generate natural-key candidates without id-like target names', () => {
    const countries = table('countries-id', 'dim_countries', [
      column('countries-id', 'countries-code-col', 'iso_code', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
      column('countries-id', 'countries-name-col', 'name', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
    ]);
    const accounts = table('accounts-id', 'fct_accounts', [
      column('accounts-id', 'account-id-col', 'id', { primaryKey: false }),
      column('accounts-id', 'country-code-col', 'country_code', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
    ]);
    const profiles = {
      connectionId: 'warehouse',
      driver: 'sqlite',
      sqlAvailable: true,
      queryCount: 0,
      tables: [],
      warnings: [],
      columns: {
        'dim_countries.iso_code': {
          table: { catalog: null, db: 'public', name: 'dim_countries' },
          column: 'iso_code',
          nativeType: 'TEXT',
          normalizedType: 'text',
          rowCount: 3,
          nullCount: 0,
          distinctCount: 3,
          uniquenessRatio: 1,
          nullRate: 0,
          sampleValues: ['DE', 'FR', 'US'],
          minTextLength: 2,
          maxTextLength: 2,
        },
        'fct_accounts.country_code': {
          table: { catalog: null, db: 'public', name: 'fct_accounts' },
          column: 'country_code',
          nativeType: 'TEXT',
          normalizedType: 'text',
          rowCount: 4,
          nullCount: 0,
          distinctCount: 3,
          uniquenessRatio: 0.75,
          nullRate: 0,
          sampleValues: ['FR', 'US'],
          minTextLength: 2,
          maxTextLength: 2,
        },
      },
    } satisfies KtxRelationshipProfileArtifact;

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([countries, accounts]), { profiles });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source: 'profile_match',
      from: { tableId: 'accounts-id', columnIds: ['country-code-col'], columns: ['country_code'] },
      to: { tableId: 'countries-id', columnIds: ['countries-code-col'], columns: ['iso_code'] },
      evidence: {
        sourceColumnBase: 'country',
        targetTableBase: 'country',
        targetColumnBase: 'iso_code',
        targetKeyScore: 0.86,
      },
    });
    expect(candidates[0]?.confidence).toBeGreaterThanOrEqual(0.78);
    expect(candidates[0]?.evidence.reasons).toEqual(
      expect.arrayContaining([
        'foreign_key_code_suffix',
        'normalized_table_name',
        'profile_unique_target',
        'profile_sample_overlap',
      ]),
    );
  });

  it('drops same-table same-column self-links using ordered endpoint equality', () => {
    const accounts = table('accounts-id', 'stg_accounts', [
      column('accounts-id', 'accounts-account-id-col', 'account_id', { primaryKey: false }),
      column('accounts-id', 'accounts-name-col', 'account_name', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
    ]);

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([accounts]));

    expect(
      candidates.map(
        (candidate) =>
          `${candidate.from.table.name}.${candidate.from.columns[0]}->${candidate.to.table.name}.${candidate.to.columns[0]}`,
      ),
    ).not.toContain('stg_accounts.account_id->stg_accounts.account_id');
  });

  it('keeps legitimate same-table different-column self-references', () => {
    const employees = table('employees-id', 'employees', [
      column('employees-id', 'employees-id-col', 'id', { primaryKey: false }),
      column('employees-id', 'employees-parent-id-col', 'parent_id', { primaryKey: false }),
    ]);

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([employees]));

    expect(
      candidates.map(
        (candidate) =>
          `${candidate.from.table.name}.${candidate.from.columns[0]}->${candidate.to.table.name}.${candidate.to.columns[0]}`,
      ),
    ).toContain('employees.parent_id->employees.id');
    expect(candidates[0]).toMatchObject({
      source: 'self_reference',
      evidence: {
        reasons: expect.arrayContaining(['self_reference']),
      },
    });
  });

  it('emits column_suffix_match candidates for relationship-key-shaped trailing target columns', () => {
    const plans = table('plans-id', 'stg_plans', [
      column('plans-id', 'plans-plan-code-col', 'plan_code', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
      column('plans-id', 'plans-canonical-plan-code-col', 'canonical_plan_code', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
      column('plans-id', 'plans-created-at-col', 'created_at', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
      column('plans-id', 'plans-email-col', 'email', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
      column('plans-id', 'plans-is-deleted-col', 'is_deleted', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
    ]);
    const accountSegments = table('account-segments-id', 'mart_account_segments', [
      column('account-segments-id', 'current-plan-code-col', 'current_plan_code', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
      column('account-segments-id', 'normalized-plan-code-col', 'normalized_plan_code', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
      column('account-segments-id', 'source-created-at-col', 'source_created_at', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
      column('account-segments-id', 'billing-email-col', 'billing_email', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
      column('account-segments-id', 'source-is-deleted-col', 'source_is_deleted', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
    ]);
    const mapping = table('mapping-id', 'stg_plan_segment_mapping', [
      column('mapping-id', 'mapping-canonical-plan-code-col', 'canonical_plan_code', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
    ]);

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([plans, accountSegments, mapping]), {
      profiles: planCodeProfiles(),
    });
    const candidateKeys = candidates.map(
      (candidate) =>
        `${candidate.from.table.name}.${candidate.from.columns[0]}->${candidate.to.table.name}.${candidate.to.columns[0]}`,
    );

    expect(candidateKeys).toEqual([
      'mart_account_segments.current_plan_code->stg_plans.plan_code',
      'mart_account_segments.normalized_plan_code->stg_plans.plan_code',
      'stg_plan_segment_mapping.canonical_plan_code->stg_plans.plan_code',
      'stg_plans.canonical_plan_code->stg_plans.plan_code',
    ]);
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'column_suffix_match',
          confidence: expect.any(Number),
          evidence: expect.objectContaining({
            nameScore: 0.78,
            targetKeyScore: 0.86,
            reasons: expect.arrayContaining(['column_suffix_match', 'profile_unique_target']),
          }),
        }),
      ]),
    );
    expect(candidateKeys).not.toContain('mart_account_segments.source_created_at->stg_plans.created_at');
    expect(candidateKeys).not.toContain('mart_account_segments.billing_email->stg_plans.email');
    expect(candidateKeys).not.toContain('mart_account_segments.source_is_deleted->stg_plans.is_deleted');
    const suffixCandidate = candidates.find(
      (candidate) => candidate.from.table.name === 'mart_account_segments' && candidate.from.columns[0] === 'current_plan_code',
    );
    expect(suffixCandidate?.confidence).toBe(suffixCandidate?.evidence.scoreBreakdown?.score);
    expect(suffixCandidate?.evidence.signalVector).toMatchObject({
      nameSimilarity: 0.78,
      typeCompatibility: 1,
      valueOverlap: 1,
      profileUniqueness: 1,
      profileNullRate: 1,
    });
  });

  it('does not suffix-match bare single-token targets or incompatible target types', () => {
    const users = table('users-id', 'users', [
      column('users-id', 'users-id-col', 'id', { primaryKey: false }),
      column('users-id', 'users-account-id-col', 'account_id', { primaryKey: false }),
    ]);
    const plans = table('plans-id', 'plans', [
      column('plans-id', 'plans-plan-code-col', 'plan_code', {
        nativeType: 'INTEGER',
        normalizedType: 'integer',
        dimensionType: 'number',
      }),
    ]);
    const accounts = table('accounts-id', 'accounts', [
      column('accounts-id', 'current-plan-code-col', 'current_plan_code', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
    ]);
    const profiles = {
      ...planCodeProfiles(),
      columns: {
        ...planCodeProfiles().columns,
        'users.id': {
          table: { catalog: null, db: 'public', name: 'users' },
          column: 'id',
          nativeType: 'INTEGER',
          normalizedType: 'integer',
          rowCount: 2,
          nullCount: 0,
          distinctCount: 2,
          uniquenessRatio: 1,
          nullRate: 0,
          sampleValues: ['1', '2'],
          minTextLength: 1,
          maxTextLength: 1,
        },
        'plans.plan_code': {
          table: { catalog: null, db: 'public', name: 'plans' },
          column: 'plan_code',
          nativeType: 'INTEGER',
          normalizedType: 'integer',
          rowCount: 2,
          nullCount: 0,
          distinctCount: 2,
          uniquenessRatio: 1,
          nullRate: 0,
          sampleValues: ['1', '2'],
          minTextLength: 1,
          maxTextLength: 1,
        },
      },
    } satisfies KtxRelationshipProfileArtifact;

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([users, plans, accounts]), { profiles });
    const candidateKeys = candidates.map(
      (candidate) =>
        `${candidate.from.table.name}.${candidate.from.columns[0]}->${candidate.to.table.name}.${candidate.to.columns[0]}`,
    );

    expect(candidateKeys).not.toContain('users.account_id->users.id');
    expect(candidateKeys).not.toContain('accounts.current_plan_code->plans.plan_code');
  });

  it('uses column embeddings as a recall source for non-standard source names', () => {
    const customers = table('customers-id', 'customers', [
      column('customers-id', 'customers-id-col', 'id', {
        primaryKey: false,
        embedding: [1, 0, 0],
      }),
      column('customers-id', 'customers-name-col', 'name', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
        embedding: [0, 1, 0],
      }),
    ]);
    const orders = table('orders-id', 'orders', [
      column('orders-id', 'orders-id-col', 'id', {
        primaryKey: false,
        embedding: [0, 0, 1],
      }),
      column('orders-id', 'buyer-ref-col', 'buyer_ref', {
        primaryKey: false,
        embedding: [0.995, 0.005, 0],
      }),
    ]);

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([customers, orders]), {
      embeddingSimilarityThreshold: 0.95,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source: 'embedding_similarity',
      from: { tableId: 'orders-id', columnIds: ['buyer-ref-col'], columns: ['buyer_ref'] },
      to: { tableId: 'customers-id', columnIds: ['customers-id-col'], columns: ['id'] },
      relationshipType: 'many_to_one',
      status: 'review',
      evidence: {
        sourceColumnBase: 'buyer_ref',
        targetTableBase: 'customer',
        targetColumnBase: 'id',
        targetKeyScore: 0.92,
        embeddingSimilarity: expect.any(Number),
      },
    });
    expect(candidates[0]?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(candidates[0]?.evidence.reasons).toEqual(
      expect.arrayContaining(['embedding_similarity', 'target_key_like']),
    );
  });

  it('singularizes names and caps candidates per source column deterministically', () => {
    const accounts = table('accounts-id', 'accounts', [column('accounts-id', 'accounts-id-col', 'id')]);
    const archivedAccounts = table('archived-accounts-id', 'accounts_archive', [
      column('archived-accounts-id', 'archived-accounts-id-col', 'id'),
    ]);
    const events = table('events-id', 'product_events', [
      column('events-id', 'event-id-col', 'id'),
      column('events-id', 'account-id-col', 'account_id'),
    ]);

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([events, archivedAccounts, accounts]), {
      maxCandidatesPerColumn: 1,
    });

    expect(
      candidates.map(
        (candidate) =>
          `${candidate.from.table.name}.${candidate.from.columns[0]}->${candidate.to.table.name}.${candidate.to.columns[0]}`,
      ),
    ).toEqual(['product_events.account_id->accounts.id']);
  });

  it('infers target primary-key candidates from incoming review links', () => {
    const accounts = table('accounts-id', 'accounts', [column('accounts-id', 'accounts-id-col', 'id')]);
    const users = table('users-id', 'users', [column('users-id', 'users-id-col', 'id')]);
    const events = table('events-id', 'product_events', [
      column('events-id', 'event-id-col', 'id'),
      column('events-id', 'account-id-col', 'account_id'),
      column('events-id', 'user-id-col', 'user_id'),
    ]);

    const candidates = generateKtxRelationshipDiscoveryCandidates(schema([accounts, users, events]));
    const inferredPks = inferKtxRelationshipTargetPks(candidates);

    expect(inferredPks).toEqual([
      {
        table: 'accounts',
        columns: ['id'],
        score: expect.any(Number),
        status: 'review',
        incomingCandidateCount: 1,
      },
      {
        table: 'users',
        columns: ['id'],
        score: expect.any(Number),
        status: 'review',
        incomingCandidateCount: 1,
      },
    ]);
    expect(inferredPks.every((pk) => pk.score >= 0.8)).toBe(true);
  });

  it('does not generate candidates from primary-key source columns or incompatible target types', () => {
    const accounts = table('accounts-id', 'accounts', [
      column('accounts-id', 'accounts-id-col', 'id', { nativeType: 'TEXT', normalizedType: 'text' }),
    ]);
    const invoices = table('invoices-id', 'invoices', [
      column('invoices-id', 'invoice-id-col', 'id', { primaryKey: true }),
      column('invoices-id', 'account-id-col', 'account_id', { nativeType: 'INTEGER', normalizedType: 'integer' }),
    ]);

    expect(generateKtxRelationshipDiscoveryCandidates(schema([accounts, invoices]))).toEqual([]);
  });

  it('normalizes layer prefixes, punctuation, plural forms, and non-plural trailing s words', () => {
    expect(normalizeKtxRelationshipName('mart__Sales_Accounts')).toMatchObject({
      normalized: 'sales_accounts',
      singular: 'sales_account',
      tokens: ['sales', 'accounts'],
    });
    expect(normalizeKtxRelationshipName('dim_users')).toMatchObject({
      normalized: 'users',
      singular: 'user',
      tokens: ['users'],
    });
    expect(normalizeKtxRelationshipName('Address')).toMatchObject({
      normalized: 'address',
      singular: 'address',
      plural: 'addresses',
      tokens: ['address'],
    });
  });

  it('merges duplicate deterministic and LLM proposal candidates without losing LLM rationale', () => {
    const accounts = table('accounts-id', 'accounts', [column('accounts-id', 'accounts-id-col', 'id')]);
    const invoices = table('invoices-id', 'invoices', [column('invoices-id', 'account-id-col', 'account_id')]);
    const [deterministic] = generateKtxRelationshipDiscoveryCandidates(schema([accounts, invoices]));
    if (!deterministic) {
      throw new Error('Expected deterministic relationship candidate');
    }
    const llmCandidate = {
      ...deterministic,
      confidence: 0.99,
      source: 'llm_proposal' as const,
      evidence: {
        ...deterministic.evidence,
        reasons: ['llm_proposal', 'llm_pk_proposal'],
        llmConfidence: 0.89,
        llmRationale: 'Invoices point at the owning account dimension.',
      },
    };

    const merged = mergeKtxRelationshipDiscoveryCandidates([deterministic, llmCandidate]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: deterministic.id,
      source: 'normalized_table_match',
      confidence: 0.99,
      evidence: {
        llmConfidence: 0.89,
        llmRationale: 'Invoices point at the owning account dimension.',
      },
    });
    expect(merged[0]?.evidence.reasons).toEqual(
      expect.arrayContaining(['foreign_key_suffix', 'normalized_table_name', 'target_key_like', 'llm_proposal']),
    );
  });
});
