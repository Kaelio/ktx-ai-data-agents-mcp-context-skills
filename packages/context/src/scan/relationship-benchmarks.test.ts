import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  KtxRelationshipBenchmarkExpectedLinks,
  KtxRelationshipBenchmarkFixture,
} from './relationship-benchmarks.js';
import {
  currentKtxRelationshipBenchmarkDetector,
  loadKtxRelationshipBenchmarkFixture,
  loadKtxRelationshipBenchmarkFixtures,
  maskKtxRelationshipBenchmarkSnapshot,
  runKtxRelationshipBenchmarkCase,
  runKtxRelationshipBenchmarkSuite,
} from './relationship-benchmarks.js';
import type { KtxSchemaSnapshot } from './types.js';

const EXPECTED_LINKS: KtxRelationshipBenchmarkExpectedLinks = {
  expectedPks: [
    { table: 'accounts', columns: ['id'] },
    { table: 'users', columns: ['id'] },
  ],
  expectedLinks: [
    {
      fromTable: 'users',
      fromColumns: ['account_id'],
      toTable: 'accounts',
      toColumns: ['id'],
      relationship: 'many_to_one',
    },
  ],
};

const CHECKED_IN_FIXTURE_ORIGINS = {
  abbreviated_legacy_no_declared_constraints: 'synthetic',
  adventureworks_oltp_with_declared_metadata: 'public',
  adventureworkslt_with_declared_metadata: 'public',
  analytical_warehouse_no_naming_convention: 'synthetic',
  chinook_with_declared_metadata: 'public',
  composite_keys_no_declared_constraints: 'synthetic',
  demo_b2b_declared_metadata: 'synthetic',
  demo_b2b_no_declared_constraints: 'synthetic',
  mixed_case_within_schema_no_declared_constraints: 'synthetic',
  natural_keys_no_declared_constraints: 'synthetic',
  non_english_naming_no_declared_constraints: 'synthetic',
  northwind_with_declared_metadata: 'public',
  orbit_style_product_no_declared_constraints: 'synthetic',
  plan_code_no_declared_constraints: 'synthetic',
  polymorphic_partial_overlap_no_declared_constraints: 'synthetic',
  sakila_with_declared_metadata: 'public',
  scale_stress_no_declared_constraints: 'synthetic',
  semantic_embedding_aliases_no_declared_constraints: 'synthetic',
} as const;

function runAdHocRelationshipBenchmarks(): boolean {
  return process.env.KTX_RUN_RELATIONSHIP_BENCHMARKS === '1';
}

const adHocRelationshipBenchmarkIt = runAdHocRelationshipBenchmarks() ? it : it.skip;

function snapshot(): KtxSchemaSnapshot {
  return {
    connectionId: 'warehouse',
    driver: 'sqlite',
    extractedAt: '2026-05-07T00:00:00.000Z',
    scope: {},
    metadata: {},
    tables: [
      {
        catalog: null,
        db: 'main',
        name: 'accounts',
        kind: 'table',
        comment: null,
        estimatedRows: 2,
        columns: [
          {
            name: 'id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: true,
            comment: null,
          },
          {
            name: 'name',
            nativeType: 'TEXT',
            normalizedType: 'text',
            dimensionType: 'string',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
        ],
        foreignKeys: [],
      },
      {
        catalog: null,
        db: 'main',
        name: 'users',
        kind: 'table',
        comment: null,
        estimatedRows: 3,
        columns: [
          {
            name: 'id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: true,
            comment: null,
          },
          {
            name: 'account_id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
        ],
        foreignKeys: [
          {
            fromColumn: 'account_id',
            toCatalog: null,
            toDb: 'main',
            toTable: 'accounts',
            toColumn: 'id',
            constraintName: 'users_account_id_fkey',
          },
        ],
      },
    ],
  };
}

describe('relationship benchmarks', () => {
  it('keeps the current benchmark detector on the relationship-discovery path only', async () => {
    const source = await readFile(new URL('relationship-benchmarks.ts', import.meta.url), 'utf-8');

    expect(source).not.toMatch(/KtxRelationshipDetector/);
    expect(source).not.toMatch(/relationship-detection\.js/);
    expect(source).not.toMatch(/\bacceptedLinks\b/);
    expect(source).toMatch(/generateKtxRelationshipDiscoveryCandidates/);
    expect(source).toMatch(/validateKtxRelationshipDiscoveryCandidates/);
    expect(source).toMatch(/resolveKtxRelationshipGraph/);
  });

  it('scores the current detector with declared metadata present', async () => {
    const result = await runKtxRelationshipBenchmarkCase({
      fixture: {
        id: 'mini_declared',
        name: 'Mini declared fixture',
        tier: 'unit',
        origin: 'synthetic',
        snapshot: snapshot(),
        expected: EXPECTED_LINKS,
        defaultModes: ['metadata_present'],
        dataPath: null,
        columnEmbeddings: {},
      },
      mode: 'metadata_present',
      detector: currentKtxRelationshipBenchmarkDetector(),
    });

    expect(result.metrics.pkRecall).toBe(1);
    expect(result.metrics.pkPrecision).toBe(1);
    expect(result.metrics.fkRecall).toBe(1);
    expect(result.metrics.fkPrecision).toBe(1);
    expect(result.falseNegatives.fk).toEqual([]);
    expect(result.predicted.fk).toEqual(['users.(account_id)->accounts.(id)']);
  });

  it('keeps no-declared-constraint misses in benchmark metrics', async () => {
    const result = await runKtxRelationshipBenchmarkCase({
      fixture: {
        id: 'mini_no_declared',
        name: 'Mini no declared fixture',
        tier: 'unit',
        origin: 'synthetic',
        snapshot: snapshot(),
        expected: EXPECTED_LINKS,
        defaultModes: ['declared_pks_and_declared_fks_removed'],
        dataPath: null,
        columnEmbeddings: {},
      },
      mode: 'declared_pks_and_declared_fks_removed',
      detector: currentKtxRelationshipBenchmarkDetector(),
    });

    expect(result.metrics.pkRecall).toBe(0.5);
    expect(result.metrics.fkRecall).toBe(0);
    expect(result.metrics.reviewRecall).toBe(1);
    expect(result.metrics.acceptedOrReviewRecall).toBe(1);
    expect(result.falseNegatives.pk).toEqual(['users.(id)']);
    expect(result.falseNegatives.fk).toEqual([]);
    expect(result.predicted.acceptedFk).toEqual([]);
    expect(result.predicted.reviewFk).toEqual(['users.(account_id)->accounts.(id)']);
  });

  it('keeps composite ground truth in recall denominators and skipped-composite buckets', async () => {
    const compositeExpected: KtxRelationshipBenchmarkExpectedLinks = {
      expectedPks: [{ table: 'order_lines', columns: ['order_id', 'line_number'] }],
      expectedLinks: [
        {
          fromTable: 'order_line_allocations',
          fromColumns: ['order_id', 'line_number'],
          toTable: 'order_lines',
          toColumns: ['order_id', 'line_number'],
          relationship: 'many_to_one',
        },
      ],
    };
    const emptyDetector = {
      async detect() {
        return {
          pks: [],
          links: [],
          validationBlocked: false,
          sqlQueries: 0,
          llmCalls: 0,
          runtimeSeconds: 0.001,
        };
      },
    };

    const result = await runKtxRelationshipBenchmarkCase({
      fixture: {
        id: 'composite_no_declared',
        name: 'Composite relationship fixture without declared constraints',
        tier: 'row_bearing',
        origin: 'synthetic',
        snapshot: snapshot(),
        expected: compositeExpected,
        defaultModes: ['declared_pks_and_declared_fks_removed'],
        dataPath: null,
        columnEmbeddings: {},
      },
      mode: 'declared_pks_and_declared_fks_removed',
      detector: emptyDetector,
    });

    expect(result.expected.pk).toEqual(['order_lines.(order_id,line_number)']);
    expect(result.expected.fk).toEqual([
      'order_line_allocations.(order_id,line_number)->order_lines.(order_id,line_number)',
    ]);
    expect(result.metrics.pkRecall).toBe(0);
    expect(result.metrics.fkRecall).toBe(0);
    expect(result.falseNegatives.pk).toEqual(['order_lines.(order_id,line_number)']);
    expect(result.falseNegatives.fk).toEqual([
      'order_line_allocations.(order_id,line_number)->order_lines.(order_id,line_number)',
    ]);
    expect(result.skippedComposite).toEqual({
      pk: ['order_lines.(order_id,line_number)'],
      fk: ['order_line_allocations.(order_id,line_number)->order_lines.(order_id,line_number)'],
    });
  });

  it('loads the composite-key fixture and accepts composite ground truth as headline evidence', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const fixture = await loadKtxRelationshipBenchmarkFixture(
      join(fixtureRoot.pathname, 'composite_keys_no_declared_constraints'),
    );

    expect(fixture.tier).toBe('row_bearing');
    expect(fixture.defaultModes).toEqual([
      'declared_pks_and_declared_fks_removed',
      'llm_disabled',
      'profiling_disabled',
      'validation_disabled',
      'embeddings_disabled',
    ]);
    expect(fixture.dataPath).toMatch(/composite_keys_no_declared_constraints\/data\.sqlite$/);

    const suite = await runKtxRelationshipBenchmarkSuite({
      fixtures: [fixture],
      detector: currentKtxRelationshipBenchmarkDetector(),
    });
    const headline = suite.cases.find(
      (item) =>
        item.fixtureId === 'composite_keys_no_declared_constraints' &&
        item.mode === 'declared_pks_and_declared_fks_removed',
    );
    const profilingDisabled = suite.cases.find(
      (item) => item.fixtureId === 'composite_keys_no_declared_constraints' && item.mode === 'profiling_disabled',
    );
    const validationDisabled = suite.cases.find(
      (item) => item.fixtureId === 'composite_keys_no_declared_constraints' && item.mode === 'validation_disabled',
    );
    const compositePks = [
      'order_line_allocations.(order_id,line_number,warehouse_code)',
      'order_lines.(order_id,line_number)',
    ];
    const compositeFk = ['order_line_allocations.(order_id,line_number)->order_lines.(order_id,line_number)'];

    expect(headline?.expected.pk).toEqual(compositePks);
    expect(headline?.expected.fk).toEqual(compositeFk);
    expect(headline?.predicted.pk).toEqual(compositePks);
    expect(headline?.predicted.acceptedFk).toEqual(compositeFk);
    expect(headline?.predicted.reviewFk).toEqual([]);
    expect(headline?.metrics.pkRecall).toBe(1);
    expect(headline?.metrics.fkRecall).toBe(1);
    expect(headline?.metrics.acceptedOrReviewRecall).toBe(1);
    expect(headline?.metrics.acceptedFalsePositiveCount).toBe(0);
    expect(headline?.falseNegatives.pk).toEqual([]);
    expect(headline?.falseNegatives.fk).toEqual([]);
    expect(headline?.skippedComposite).toEqual({
      pk: [],
      fk: [],
    });
    expect(profilingDisabled?.validationBlocked).toBe(true);
    expect(validationDisabled?.validationBlocked).toBe(true);
    expect(suite.validationBlockedCases).toEqual([
      'composite_keys_no_declared_constraints:profiling_disabled',
      'composite_keys_no_declared_constraints:validation_disabled',
    ]);
    expect(suite.aggregate.headlineCaseCount).toBe(1);
    expect(suite.aggregate.headlinePkRecall).toBe(1);
    expect(suite.aggregate.headlineFkRecall).toBe(1);
  });

  it('counts formal metadata links in metadata-present mode without SQL validation', async () => {
    const source = snapshot();
    const fixture: KtxRelationshipBenchmarkFixture = {
      id: 'declared_without_sql',
      name: 'Declared relationships without SQL validation',
      tier: 'unit',
      origin: 'synthetic',
      snapshot: {
        ...source,
        tables: source.tables.map((table) =>
          table.name === 'accounts'
            ? {
                ...table,
                columns: table.columns.map((column) =>
                  column.name === 'id' ? { ...column, primaryKey: true } : column,
                ),
              }
            : table.name === 'users'
              ? {
                  ...table,
                  foreignKeys: [
                    {
                      fromColumn: 'account_id',
                      toCatalog: null,
                      toDb: null,
                      toTable: 'accounts',
                      toColumn: 'id',
                      constraintName: 'users_account_id_fkey',
                    },
                  ],
                }
              : table,
        ),
      },
      expected: EXPECTED_LINKS,
      defaultModes: ['metadata_present'],
      dataPath: null,
      columnEmbeddings: {},
    };

    const result = await runKtxRelationshipBenchmarkCase({
      fixture,
      mode: 'metadata_present',
    });

    expect(result.validationBlocked).toBe(false);
    expect(result.predicted.acceptedFk).toEqual(['users.(account_id)->accounts.(id)']);
    expect(result.metrics.fkRecall).toBe(1);
    expect(result.metrics.fkPrecision).toBe(1);
  });

  it('masks primary keys and foreign keys independently', () => {
    const pksRemoved = maskKtxRelationshipBenchmarkSnapshot(snapshot(), 'declared_pks_removed');
    const fksRemoved = maskKtxRelationshipBenchmarkSnapshot(snapshot(), 'declared_fks_removed');

    expect(pksRemoved.tables.flatMap((table) => table.columns.filter((column) => column.primaryKey))).toEqual([]);
    expect(pksRemoved.tables.find((table) => table.name === 'users')?.foreignKeys).toHaveLength(1);
    expect(fksRemoved.tables.find((table) => table.name === 'accounts')?.columns[0]?.primaryKey).toBe(true);
    expect(fksRemoved.tables.find((table) => table.name === 'users')?.foreignKeys).toEqual([]);
  });

  it('loads fixture.yaml, snapshot.json, and expected-links.yaml from a fixture directory', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'ktx-relationship-fixture-'));
    try {
      await writeFile(
        join(fixtureDir, 'fixture.yaml'),
        [
          'id: mini_loaded',
          'name: Mini loaded fixture',
          'tier: unit',
          'origin: synthetic',
          'validationBudget: 3',
          'defaultModes:',
          '  - metadata_present',
          '  - declared_pks_and_declared_fks_removed',
          '',
        ].join('\n'),
      );
      await writeFile(join(fixtureDir, 'snapshot.json'), `${JSON.stringify(snapshot(), null, 2)}\n`);
      await writeFile(
        join(fixtureDir, 'column-embeddings.json'),
        `${JSON.stringify(
          {
            'accounts.id': [1, 0, 0],
            'users.account_id': [0.99, 0.01, 0],
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(fixtureDir, 'expected-links.yaml'),
        [
          'expectedPks:',
          '  - table: accounts',
          '    columns: [id]',
          '  - table: users',
          '    columns: [id]',
          'expectedLinks:',
          '  - fromTable: users',
          '    fromColumns: [account_id]',
          '    toTable: accounts',
          '    toColumns: [id]',
          '    relationship: many_to_one',
          '',
        ].join('\n'),
      );

      await expect(loadKtxRelationshipBenchmarkFixture(fixtureDir)).resolves.toMatchObject({
        id: 'mini_loaded',
        origin: 'synthetic',
        validationBudget: 3,
        defaultModes: ['metadata_present', 'declared_pks_and_declared_fks_removed'],
        columnEmbeddings: {
          'accounts.id': [1, 0, 0],
          'users.account_id': [0.99, 0.01, 0],
        },
        expected: {
          expectedLinks: [
            {
              fromTable: 'users',
              fromColumns: ['account_id'],
              toTable: 'accounts',
              toColumns: ['id'],
              relationship: 'many_to_one',
            },
          ],
        },
      });
      await expect(readFile(join(fixtureDir, 'snapshot.json'), 'utf-8')).resolves.toContain(
        '"connectionId": "warehouse"',
      );
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it('passes fixture validation budgets into benchmark detectors', async () => {
    const seenBudgets: unknown[] = [];
    const detector = {
      async detect(input: { validationBudget?: number | 'all' }) {
        seenBudgets.push(input.validationBudget);
        return {
          pks: [],
          links: [],
          validationBlocked: false,
          sqlQueries: 0,
          llmCalls: 0,
          runtimeSeconds: 0.001,
        };
      },
    };

    await runKtxRelationshipBenchmarkSuite({
      fixtures: [
        {
          id: 'budgeted_fixture',
          name: 'Budgeted fixture',
          tier: 'row_bearing',
          origin: 'synthetic',
          validationBudget: 0,
          snapshot: snapshot(),
          expected: EXPECTED_LINKS,
          defaultModes: ['declared_pks_and_declared_fks_removed'],
          dataPath: null,
          columnEmbeddings: {},
        },
        {
          id: 'unbudgeted_fixture',
          name: 'Unbudgeted fixture',
          tier: 'row_bearing',
          origin: 'synthetic',
          snapshot: snapshot(),
          expected: EXPECTED_LINKS,
          defaultModes: ['metadata_present'],
          dataPath: null,
          columnEmbeddings: {},
        },
      ],
      detector,
    });

    expect(seenBudgets).toEqual([0, undefined]);
  });

  it('requires relationship benchmark fixture origin provenance', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'ktx-relationship-missing-origin-'));
    try {
      await writeFile(
        join(fixtureDir, 'fixture.yaml'),
        [
          'id: missing_origin',
          'name: Missing origin fixture',
          'tier: unit',
          'defaultModes:',
          '  - metadata_present',
          '',
        ].join('\n'),
      );
      await writeFile(join(fixtureDir, 'snapshot.json'), `${JSON.stringify(snapshot(), null, 2)}\n`);
      await writeFile(
        join(fixtureDir, 'expected-links.yaml'),
        ['expectedPks:', '  - table: accounts', '    columns: [id]', 'expectedLinks: []', ''].join('\n'),
      );

      await expect(loadKtxRelationshipBenchmarkFixture(fixtureDir)).rejects.toThrow(/origin/);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it('loads all benchmark fixture directories in stable order', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'ktx-relationship-fixture-root-'));

    async function writeFixtureDir(dirName: string, fixtureId: string): Promise<void> {
      const fixtureDir = join(fixtureRoot, dirName);
      await mkdir(fixtureDir);
      await writeFile(
        join(fixtureDir, 'fixture.yaml'),
        [
          `id: ${fixtureId}`,
          `name: ${fixtureId}`,
          'tier: unit',
          'origin: synthetic',
          'defaultModes:',
          '  - metadata_present',
          '',
        ].join('\n'),
      );
      await writeFile(join(fixtureDir, 'snapshot.json'), `${JSON.stringify(snapshot(), null, 2)}\n`);
      await writeFile(
        join(fixtureDir, 'expected-links.yaml'),
        [
          'expectedPks:',
          '  - table: accounts',
          '    columns: [id]',
          '  - table: users',
          '    columns: [id]',
          'expectedLinks:',
          '  - fromTable: users',
          '    fromColumns: [account_id]',
          '    toTable: accounts',
          '    toColumns: [id]',
          '    relationship: many_to_one',
          '',
        ].join('\n'),
      );
    }

    try {
      await writeFixtureDir('z_fixture', 'z_fixture');
      await writeFixtureDir('a_fixture', 'a_fixture');

      await expect(loadKtxRelationshipBenchmarkFixtures(fixtureRoot)).resolves.toMatchObject([
        { id: 'a_fixture', origin: 'synthetic' },
        { id: 'z_fixture', origin: 'synthetic' },
      ]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('loads every checked-in relationship benchmark fixture with explicit provenance', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const fixtureDirs = (await readdir(fixtureRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    expect(fixtureDirs).toEqual(Object.keys(CHECKED_IN_FIXTURE_ORIGINS).sort());

    const fixtures = await loadKtxRelationshipBenchmarkFixtures(fixtureRoot.pathname);
    expect(Object.fromEntries(fixtures.map((fixture) => [fixture.id, fixture.origin]))).toEqual(
      CHECKED_IN_FIXTURE_ORIGINS,
    );
  });

  it('loads May 8 evidence-fusion adversarial fixtures as reported synthetic evidence', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const fixtures = await loadKtxRelationshipBenchmarkFixtures(fixtureRoot.pathname);
    const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
    const adversarialIds = [
      'non_english_naming_no_declared_constraints',
      'abbreviated_legacy_no_declared_constraints',
      'analytical_warehouse_no_naming_convention',
      'mixed_case_within_schema_no_declared_constraints',
      'polymorphic_partial_overlap_no_declared_constraints',
    ];

    for (const fixtureId of adversarialIds) {
      const fixture = byId.get(fixtureId);
      expect(fixture, fixtureId).toBeDefined();
      expect(fixture?.origin).toBe('synthetic');
      expect(fixture?.tier).toBe('row_bearing');
      expect(fixture?.thresholdEligible).toBe(false);
      expect(fixture?.defaultModes).toEqual(['declared_pks_and_declared_fks_removed']);
      expect(fixture?.dataPath).toMatch(/data\.sqlite$/);
      expect(fixture?.expected.expectedPks.length).toBeGreaterThan(0);
      expect(fixture?.expected.expectedLinks.length).toBeGreaterThan(0);
    }

    expect(
      byId
        .get('polymorphic_partial_overlap_no_declared_constraints')
        ?.expected.expectedLinks.filter(
          (link) => link.fromTable === 'activity_events' && link.fromColumns.join(',') === 'entity_id',
        ),
    ).toHaveLength(2);
  });

  it('loads the May 8 scale stress fixture with bounded benchmark validation', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const fixture = await loadKtxRelationshipBenchmarkFixture(
      join(fixtureRoot.pathname, 'scale_stress_no_declared_constraints'),
    );

    expect(fixture.origin).toBe('synthetic');
    expect(fixture.tier).toBe('row_bearing');
    expect(fixture.thresholdEligible).toBe(false);
    expect(fixture.defaultModes).toEqual(['declared_pks_and_declared_fks_removed']);
    expect(fixture.validationBudget).toBe(800);
    expect(fixture.snapshot.tables).toHaveLength(400);
    expect(fixture.snapshot.tables.every((table) => table.columns.length === 50)).toBe(true);
    expect(fixture.expected.expectedPks).toHaveLength(20);
    expect(fixture.expected.expectedLinks).toHaveLength(1900);
  });

  adHocRelationshipBenchmarkIt('runs the scale stress fixture inside the benchmark validation budget', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const fixture = await loadKtxRelationshipBenchmarkFixture(
      join(fixtureRoot.pathname, 'scale_stress_no_declared_constraints'),
    );

    const result = await runKtxRelationshipBenchmarkCase({
      fixture,
      mode: 'declared_pks_and_declared_fks_removed',
      detector: currentKtxRelationshipBenchmarkDetector(),
    });

    expect(result.metrics.runtimeSeconds).toBeLessThan(60);
    expect(result.metrics.sqlQueries).toBeLessThanOrEqual(800);
    expect(result.validationBlocked).toBe(false);
  }, 60_000);

  it('aggregates suite metrics without hiding validation-blocked cases', async () => {
    const suite = await runKtxRelationshipBenchmarkSuite({
      fixtures: [
        {
          id: 'mini_declared',
          name: 'Mini declared fixture',
          tier: 'unit',
          origin: 'synthetic',
          snapshot: snapshot(),
          expected: EXPECTED_LINKS,
          defaultModes: ['metadata_present'],
          dataPath: null,
          columnEmbeddings: {},
        },
        {
          id: 'mini_no_declared',
          name: 'Mini no declared fixture',
          tier: 'row_bearing',
          origin: 'synthetic',
          snapshot: snapshot(),
          expected: EXPECTED_LINKS,
          defaultModes: ['declared_pks_and_declared_fks_removed', 'validation_disabled'],
          dataPath: null,
          columnEmbeddings: {},
        },
      ],
      detector: currentKtxRelationshipBenchmarkDetector(),
    });

    expect(suite.cases.map((item) => `${item.fixtureId}:${item.mode}`)).toEqual([
      'mini_declared:metadata_present',
      'mini_no_declared:declared_pks_and_declared_fks_removed',
      'mini_no_declared:validation_disabled',
    ]);
    expect(suite.validationBlockedCases).toEqual(['mini_no_declared:validation_disabled']);
    expect(suite.aggregate.caseCount).toBe(3);
    expect(suite.aggregate.headlineCaseCount).toBe(1);
    expect(suite.aggregate.headlineFkRecall).toBe(0);
    expect(suite.aggregate.headlineAcceptedOrReviewRecall).toBe(1);
  });

  it('keeps smoke fixtures out of headline threshold metrics', async () => {
    const detector = {
      async detect() {
        return {
          pks: [
            { table: 'accounts', columns: ['id'], score: 1, status: 'accepted' as const },
            { table: 'users', columns: ['id'], score: 1, status: 'accepted' as const },
          ],
          links: [
            {
              fromTable: 'users',
              fromColumns: ['account_id'],
              toTable: 'accounts',
              toColumns: ['id'],
              relationship: 'many_to_one' as const,
              score: 1,
              status: 'accepted' as const,
              source: 'test',
            },
          ],
          validationBlocked: false,
          sqlQueries: 1,
          llmCalls: 0,
          runtimeSeconds: 0.001,
        };
      },
    };

    const suite = await runKtxRelationshipBenchmarkSuite({
      fixtures: [
        {
          id: 'smoke_no_declared',
          name: 'Smoke no declared fixture',
          tier: 'smoke',
          origin: 'synthetic',
          snapshot: snapshot(),
          expected: EXPECTED_LINKS,
          defaultModes: ['declared_pks_and_declared_fks_removed'],
          dataPath: null,
          columnEmbeddings: {},
        },
        {
          id: 'row_bearing_no_declared',
          name: 'Row-bearing no declared fixture',
          tier: 'row_bearing',
          origin: 'synthetic',
          snapshot: snapshot(),
          expected: EXPECTED_LINKS,
          defaultModes: ['declared_pks_and_declared_fks_removed'],
          dataPath: null,
          columnEmbeddings: {},
        },
      ],
      detector,
    });

    expect(suite.aggregate.caseCount).toBe(2);
    expect(suite.aggregate.headlineCaseCount).toBe(1);
    expect(suite.aggregate.headlineFkRecall).toBe(1);
    expect(suite.aggregate.headlinePkRecall).toBe(1);
  });

  it('counts product fixtures as headline evidence only when threshold eligible', async () => {
    const detector = {
      async detect() {
        return {
          pks: [
            { table: 'accounts', columns: ['id'], score: 1, status: 'accepted' as const },
            { table: 'users', columns: ['id'], score: 1, status: 'accepted' as const },
          ],
          links: [
            {
              fromTable: 'users',
              fromColumns: ['account_id'],
              toTable: 'accounts',
              toColumns: ['id'],
              relationship: 'many_to_one' as const,
              score: 1,
              status: 'accepted' as const,
              source: 'test',
            },
          ],
          validationBlocked: false,
          sqlQueries: 1,
          llmCalls: 0,
          runtimeSeconds: 0.001,
        };
      },
    };

    const suite = await runKtxRelationshipBenchmarkSuite({
      fixtures: [
        {
          id: 'product_not_curated',
          name: 'Product fixture without curated threshold evidence',
          tier: 'product',
          origin: 'synthetic',
          snapshot: snapshot(),
          expected: EXPECTED_LINKS,
          defaultModes: ['declared_pks_and_declared_fks_removed'],
          dataPath: null,
          columnEmbeddings: {},
        },
        {
          id: 'product_curated',
          name: 'Product fixture with curated threshold evidence',
          tier: 'product',
          origin: 'synthetic',
          thresholdEligible: true,
          snapshot: snapshot(),
          expected: EXPECTED_LINKS,
          defaultModes: ['declared_pks_and_declared_fks_removed'],
          dataPath: null,
          columnEmbeddings: {},
        },
        {
          id: 'smoke_even_if_marked',
          name: 'Smoke fixture remains excluded',
          tier: 'smoke',
          origin: 'synthetic',
          thresholdEligible: true,
          snapshot: snapshot(),
          expected: EXPECTED_LINKS,
          defaultModes: ['declared_pks_and_declared_fks_removed'],
          dataPath: null,
          columnEmbeddings: {},
        },
      ],
      detector,
    });

    expect(suite.aggregate.caseCount).toBe(3);
    expect(suite.aggregate.headlineCaseCount).toBe(1);
    expect(suite.aggregate.headlinePkRecall).toBe(1);
    expect(suite.aggregate.headlineFkRecall).toBe(1);
  });

  it('loads the packaged B2B demo fixtures and records the current relationship-discovery baseline', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const declared = await loadKtxRelationshipBenchmarkFixture(
      join(fixtureRoot.pathname, 'demo_b2b_declared_metadata'),
    );
    const noDeclared = await loadKtxRelationshipBenchmarkFixture(
      join(fixtureRoot.pathname, 'demo_b2b_no_declared_constraints'),
    );

    expect(declared.tier).toBe('smoke');
    expect(noDeclared.tier).toBe('smoke');
    expect(declared.defaultModes).toEqual([
      'metadata_present',
      'declared_fks_removed',
      'declared_pks_removed',
      'declared_pks_and_declared_fks_removed',
      'llm_disabled',
      'profiling_disabled',
      'validation_disabled',
      'embeddings_disabled',
    ]);
    expect(noDeclared.defaultModes).toEqual([
      'declared_pks_and_declared_fks_removed',
      'profiling_disabled',
      'validation_disabled',
      'llm_disabled',
      'embeddings_disabled',
    ]);

    const suite = await runKtxRelationshipBenchmarkSuite({
      fixtures: [declared, noDeclared],
      detector: currentKtxRelationshipBenchmarkDetector(),
    });

    const declaredCase = suite.cases.find(
      (item) => item.fixtureId === 'demo_b2b_declared_metadata' && item.mode === 'metadata_present',
    );
    const noDeclaredCase = suite.cases.find(
      (item) =>
        item.fixtureId === 'demo_b2b_no_declared_constraints' && item.mode === 'declared_pks_and_declared_fks_removed',
    );
    const profilingDisabledCase = suite.cases.find(
      (item) => item.fixtureId === 'demo_b2b_no_declared_constraints' && item.mode === 'profiling_disabled',
    );

    expect(declaredCase?.expected.fk).toHaveLength(7);
    expect(declaredCase?.metrics.fkRecall).toBe(1);
    expect(declaredCase?.metrics.pkRecall).toBe(1);
    expect(noDeclaredCase?.expected.fk).toHaveLength(7);
    expect(noDeclaredCase?.metrics.fkRecall).toBe(1);
    expect(noDeclaredCase?.metrics.fkPrecision).toBe(1);
    expect(noDeclaredCase?.metrics.pkRecall).toBe(1);
    expect(noDeclaredCase?.falseNegatives.pk).toEqual([]);
    expect(noDeclaredCase?.metrics.reviewRecall).toBe(0);
    expect(noDeclaredCase?.metrics.acceptedOrReviewRecall).toBe(1);
    expect(noDeclaredCase?.metrics.acceptedFalsePositiveCount).toBe(0);
    expect(noDeclaredCase?.predicted.acceptedFk).toEqual([
      'invoices.(account_id)->accounts.(id)',
      'opportunities.(account_id)->accounts.(id)',
      'product_events.(account_id)->accounts.(id)',
      'product_events.(user_id)->users.(id)',
      'subscriptions.(account_id)->accounts.(id)',
      'support_tickets.(account_id)->accounts.(id)',
      'users.(account_id)->accounts.(id)',
    ]);
    expect(noDeclaredCase?.predicted.reviewFk).toEqual([]);
    expect(noDeclaredCase?.falseNegatives.fk).toEqual([]);
    expect(profilingDisabledCase?.validationBlocked).toBe(true);
    expect(profilingDisabledCase?.metrics.fkRecall).toBe(0);
    expect(profilingDisabledCase?.metrics.acceptedOrReviewRecall).toBe(1);
    expect(suite.aggregate.headlineCaseCount).toBe(0);
    expect(suite.aggregate.headlineFkRecall).toBe(0);
    expect(suite.aggregate.headlineAcceptedOrReviewRecall).toBe(0);
    expect(suite.validationBlockedCases).toEqual([
      'demo_b2b_declared_metadata:profiling_disabled',
      'demo_b2b_declared_metadata:validation_disabled',
      'demo_b2b_no_declared_constraints:profiling_disabled',
      'demo_b2b_no_declared_constraints:validation_disabled',
    ]);
  });

  it('loads the public Chinook benchmark fixture with declared metadata', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const fixture = await loadKtxRelationshipBenchmarkFixture(
      join(fixtureRoot.pathname, 'chinook_with_declared_metadata'),
    );
    expect(fixture.tier).toBe('row_bearing');
    expect(fixture.thresholdEligible).toBe(true);
    expect(fixture.defaultModes).toContain('metadata_present');
    expect(fixture.defaultModes).toContain('declared_pks_and_declared_fks_removed');
    expect(fixture.snapshot.tables.length).toBeGreaterThanOrEqual(11);
    expect(fixture.expected.expectedLinks.length).toBeGreaterThanOrEqual(8);

    const albumArtist = fixture.expected.expectedLinks.find(
      (link) => link.fromTable === 'Album' && link.toTable === 'Artist',
    );
    expect(albumArtist).toBeDefined();
  });

  it('loads the public Northwind benchmark fixture with declared metadata', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const fixture = await loadKtxRelationshipBenchmarkFixture(
      join(fixtureRoot.pathname, 'northwind_with_declared_metadata'),
    );
    expect(fixture.tier).toBe('row_bearing');
    expect(fixture.thresholdEligible).toBe(true);
    expect(fixture.snapshot.tables.length).toBeGreaterThanOrEqual(13);
    expect(fixture.expected.expectedLinks.length).toBeGreaterThanOrEqual(11);

    const orderCustomer = fixture.expected.expectedLinks.find(
      (link) => ['Orders', 'orders'].includes(link.fromTable) && ['Customers', 'customers'].includes(link.toTable),
    );
    expect(orderCustomer).toBeDefined();
  });

  it('loads the public Sakila benchmark fixture with declared metadata', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const fixture = await loadKtxRelationshipBenchmarkFixture(
      join(fixtureRoot.pathname, 'sakila_with_declared_metadata'),
    );
    expect(fixture.tier).toBe('row_bearing');
    expect(fixture.thresholdEligible).toBe(true);
    expect(fixture.snapshot.tables.length).toBeGreaterThanOrEqual(16);
    expect(fixture.expected.expectedLinks.length).toBeGreaterThanOrEqual(14);

    const filmLanguage = fixture.expected.expectedLinks.find(
      (link) => link.fromTable === 'film' && link.toTable === 'language',
    );
    expect(filmLanguage).toBeDefined();
  });

  it('loads the public AdventureWorksLT benchmark fixture with declared metadata', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const fixture = await loadKtxRelationshipBenchmarkFixture(
      join(fixtureRoot.pathname, 'adventureworkslt_with_declared_metadata'),
    );

    expect(fixture.id).toBe('adventureworkslt_with_declared_metadata');
    expect(fixture.name).toBe('AdventureWorksLT (SQLite, declared metadata)');
    expect(fixture.tier).toBe('row_bearing');
    expect(fixture.thresholdEligible).toBe(true);
    expect(fixture.defaultModes).toEqual([
      'metadata_present',
      'declared_pks_and_declared_fks_removed',
      'declared_pks_removed',
      'declared_fks_removed',
      'profiling_disabled',
      'validation_disabled',
      'llm_disabled',
      'embeddings_disabled',
    ]);
    expect(fixture.snapshot.tables).toHaveLength(12);
    expect(fixture.expected.expectedPks).toHaveLength(12);
    expect(fixture.expected.expectedLinks).toHaveLength(12);

    const customerAddressPk = fixture.expected.expectedPks.find((pk) => pk.table === 'CustomerAddress');
    expect(customerAddressPk?.columns).toEqual(['CustomerID', 'AddressID']);

    const modelDescriptionPk = fixture.expected.expectedPks.find((pk) => pk.table === 'ProductModelProductDescription');
    expect(modelDescriptionPk?.columns).toEqual(['ProductModelID', 'ProductDescriptionID', 'Culture']);

    expect(fixture.expected.expectedLinks).toContainEqual({
      fromTable: 'CustomerAddress',
      fromColumns: ['CustomerID'],
      toTable: 'Customer',
      toColumns: ['CustomerID'],
      relationship: 'many_to_one',
    });
    expect(fixture.expected.expectedLinks).toContainEqual({
      fromTable: 'ProductCategory',
      fromColumns: ['ParentProductCategoryID'],
      toTable: 'ProductCategory',
      toColumns: ['ProductCategoryID'],
      relationship: 'many_to_one',
    });
    expect(fixture.expected.expectedLinks).toContainEqual({
      fromTable: 'SalesOrderDetail',
      fromColumns: ['SalesOrderID'],
      toTable: 'SalesOrderHeader',
      toColumns: ['SalesOrderID'],
      relationship: 'many_to_one',
    });
    expect(fixture.expected.expectedLinks).toContainEqual({
      fromTable: 'SalesOrderHeader',
      fromColumns: ['CustomerID'],
      toTable: 'Customer',
      toColumns: ['CustomerID'],
      relationship: 'many_to_one',
    });
  });

  it('loads the full AdventureWorks OLTP benchmark fixture with declared metadata', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const fixture = await loadKtxRelationshipBenchmarkFixture(
      join(fixtureRoot.pathname, 'adventureworks_oltp_with_declared_metadata'),
    );

    expect(fixture.id).toBe('adventureworks_oltp_with_declared_metadata');
    expect(fixture.name).toBe('AdventureWorks OLTP (SQL Server 2022, declared metadata)');
    expect(fixture.tier).toBe('row_bearing');
    expect(fixture.thresholdEligible).toBe(true);
    expect(fixture.defaultModes).toEqual([
      'metadata_present',
      'declared_pks_and_declared_fks_removed',
      'declared_pks_removed',
      'declared_fks_removed',
      'profiling_disabled',
      'validation_disabled',
      'llm_disabled',
      'embeddings_disabled',
    ]);
    expect(
      fixture.dataPath === null || fixture.dataPath.endsWith('/adventureworks_oltp_with_declared_metadata/data.sqlite'),
    ).toBe(true);
    expect(fixture.snapshot.driver).toBe('sqlite');
    expect(fixture.snapshot.metadata.source_driver).toBe('sqlserver');
    expect(fixture.snapshot.tables).toHaveLength(71);
    expect(fixture.expected.expectedPks).toHaveLength(71);
    expect(fixture.expected.expectedLinks).toHaveLength(90);

    expect(fixture.expected.expectedPks).toContainEqual({
      table: 'Sales.SalesOrderDetail',
      columns: ['SalesOrderID', 'SalesOrderDetailID'],
    });
    expect(fixture.expected.expectedPks).toContainEqual({
      table: 'Sales.SalesOrderHeaderSalesReason',
      columns: ['SalesOrderID', 'SalesReasonID'],
    });
    expect(fixture.expected.expectedLinks).toContainEqual({
      fromTable: 'Sales.SalesOrderHeader',
      fromColumns: ['CustomerID'],
      toTable: 'Sales.Customer',
      toColumns: ['CustomerID'],
      relationship: 'many_to_one',
    });
    expect(fixture.expected.expectedLinks).toContainEqual({
      fromTable: 'Sales.SalesOrderDetail',
      fromColumns: ['SalesOrderID'],
      toTable: 'Sales.SalesOrderHeader',
      toColumns: ['SalesOrderID'],
      relationship: 'many_to_one',
    });
    expect(fixture.expected.expectedLinks).toContainEqual({
      fromTable: 'Production.Product',
      fromColumns: ['ProductSubcategoryID'],
      toTable: 'Production.ProductSubcategory',
      toColumns: ['ProductSubcategoryID'],
      relationship: 'many_to_one',
    });
  });

  it('loads the row-bearing natural-key fixture and counts it as headline evidence', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const naturalKeys = await loadKtxRelationshipBenchmarkFixture(
      join(fixtureRoot.pathname, 'natural_keys_no_declared_constraints'),
    );

    expect(naturalKeys.tier).toBe('row_bearing');
    expect(naturalKeys.defaultModes).toEqual([
      'declared_pks_and_declared_fks_removed',
      'llm_disabled',
      'profiling_disabled',
      'validation_disabled',
      'embeddings_disabled',
    ]);

    const suite = await runKtxRelationshipBenchmarkSuite({
      fixtures: [naturalKeys],
      detector: currentKtxRelationshipBenchmarkDetector(),
    });
    const headline = suite.cases.find(
      (item) =>
        item.fixtureId === 'natural_keys_no_declared_constraints' &&
        item.mode === 'declared_pks_and_declared_fks_removed',
    );

    expect(headline?.metrics.pkRecall).toBe(1);
    expect(headline?.metrics.fkRecall).toBe(1);
    expect(headline?.metrics.acceptedFalsePositiveCount).toBe(0);
    expect(headline?.predicted.acceptedFk).toEqual(['fct_accounts.(country_code)->dim_countries.(iso_code)']);
    expect(headline?.falseNegatives.fk).toEqual([]);
    expect(suite.aggregate.headlineCaseCount).toBe(1);
    expect(suite.aggregate.headlineFkRecall).toBe(1);
  });

  it('accepts plan-code suffix relationships only when validation is available', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const fixture = await loadKtxRelationshipBenchmarkFixture(
      join(fixtureRoot.pathname, 'plan_code_no_declared_constraints'),
    );

    expect(fixture.tier).toBe('row_bearing');
    expect(fixture.defaultModes).toEqual([
      'declared_pks_and_declared_fks_removed',
      'llm_disabled',
      'profiling_disabled',
      'validation_disabled',
      'embeddings_disabled',
    ]);

    const suite = await runKtxRelationshipBenchmarkSuite({
      fixtures: [fixture],
      detector: currentKtxRelationshipBenchmarkDetector(),
    });
    const expectedAccepted = [
      'mart_account_segments.(current_plan_code)->stg_plans.(plan_code)',
      'mart_account_segments.(normalized_plan_code)->stg_plans.(plan_code)',
      'stg_plan_segment_mapping.(canonical_plan_code)->stg_plans.(plan_code)',
      'stg_plans.(canonical_plan_code)->stg_plans.(plan_code)',
    ];
    const headline = suite.cases.find(
      (item) =>
        item.fixtureId === 'plan_code_no_declared_constraints' && item.mode === 'declared_pks_and_declared_fks_removed',
    );
    const llmDisabled = suite.cases.find(
      (item) => item.fixtureId === 'plan_code_no_declared_constraints' && item.mode === 'llm_disabled',
    );
    const embeddingsDisabled = suite.cases.find(
      (item) => item.fixtureId === 'plan_code_no_declared_constraints' && item.mode === 'embeddings_disabled',
    );
    const validationDisabled = suite.cases.find(
      (item) => item.fixtureId === 'plan_code_no_declared_constraints' && item.mode === 'validation_disabled',
    );
    const profilingDisabled = suite.cases.find(
      (item) => item.fixtureId === 'plan_code_no_declared_constraints' && item.mode === 'profiling_disabled',
    );

    expect(headline?.predicted.acceptedFk).toEqual(expectedAccepted);
    expect(headline?.predicted.reviewFk).toEqual([]);
    expect(headline?.metrics.fkRecall).toBe(1);
    expect(headline?.metrics.fkPrecision).toBe(1);
    expect(headline?.metrics.acceptedFalsePositiveCount).toBe(0);
    expect(llmDisabled?.predicted.acceptedFk).toEqual(expectedAccepted);
    expect(embeddingsDisabled?.predicted.acceptedFk).toEqual(expectedAccepted);
    expect(validationDisabled?.predicted.acceptedFk).toEqual([]);
    expect(validationDisabled?.predicted.reviewFk).toEqual(expectedAccepted);
    expect(validationDisabled?.validationBlocked).toBe(true);
    expect(validationDisabled?.metrics.reviewRecall).toBe(1);
    expect(validationDisabled?.metrics.acceptedOrReviewRecall).toBe(1);
    expect(profilingDisabled?.predicted.acceptedFk).toEqual([]);
    expect(profilingDisabled?.validationBlocked).toBe(true);
    expect(suite.aggregate.headlineCaseCount).toBe(1);
    expect(suite.aggregate.headlineFkRecall).toBe(1);
    expect(suite.aggregate.headlineAcceptedOrReviewRecall).toBe(1);
  });

  it('uses embedding fixtures for semantic alias relationship benchmark cases', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const fixture = await loadKtxRelationshipBenchmarkFixture(
      join(fixtureRoot.pathname, 'semantic_embedding_aliases_no_declared_constraints'),
    );

    expect(fixture.columnEmbeddings).toMatchObject({
      'customers.id': [1, 0, 0],
      'orders.buyer_ref': [0.995, 0.005, 0],
    });

    const withEmbeddings = await runKtxRelationshipBenchmarkCase({
      fixture,
      mode: 'declared_pks_and_declared_fks_removed',
      detector: currentKtxRelationshipBenchmarkDetector(),
    });
    const withoutEmbeddings = await runKtxRelationshipBenchmarkCase({
      fixture,
      mode: 'embeddings_disabled',
      detector: currentKtxRelationshipBenchmarkDetector(),
    });

    expect(withEmbeddings.predicted.acceptedFk).toEqual(['orders.(buyer_ref)->customers.(id)']);
    expect(withEmbeddings.metrics.fkRecall).toBe(1);
    expect(withEmbeddings.metrics.acceptedFalsePositiveCount).toBe(0);
    expect(withEmbeddings.falseNegatives.fk).toEqual([]);
    expect(withoutEmbeddings.predicted.acceptedFk).toEqual([]);
    expect(withoutEmbeddings.metrics.fkRecall).toBe(0);
    expect(withoutEmbeddings.falseNegatives.fk).toEqual(['orders.(buyer_ref)->customers.(id)']);
  });

  it('loads the Orbit-style product fixture as curated relationship-discovery benchmark evidence', async () => {
    const fixtureRoot = new URL('../../test/fixtures/relationship-benchmarks/', import.meta.url);
    const fixture = await loadKtxRelationshipBenchmarkFixture(
      join(fixtureRoot.pathname, 'orbit_style_product_no_declared_constraints'),
    );

    expect(fixture.tier).toBe('product');
    expect(fixture.thresholdEligible).toBe(true);
    expect(fixture.defaultModes).toEqual([
      'declared_pks_and_declared_fks_removed',
      'llm_disabled',
      'profiling_disabled',
      'validation_disabled',
      'embeddings_disabled',
    ]);

    const suite = await runKtxRelationshipBenchmarkSuite({
      fixtures: [fixture],
      detector: currentKtxRelationshipBenchmarkDetector(),
    });
    const headline = suite.cases.find(
      (item) =>
        item.fixtureId === 'orbit_style_product_no_declared_constraints' &&
        item.mode === 'declared_pks_and_declared_fks_removed',
    );
    const validationDisabled = suite.cases.find(
      (item) => item.fixtureId === 'orbit_style_product_no_declared_constraints' && item.mode === 'validation_disabled',
    );

    expect(headline?.expected.fk).toHaveLength(9);
    expect(headline?.metrics.pkRecall).toBe(1);
    expect(headline?.metrics.fkRecall).toBe(1);
    expect(headline?.metrics.acceptedFalsePositiveCount).toBe(0);
    expect(headline?.predicted.acceptedFk).toEqual([
      'dim_users.(account_id)->dim_accounts.(id)',
      'dim_workspaces.(account_id)->dim_accounts.(id)',
      'dim_workspaces.(user_id)->dim_users.(id)',
      'fct_invoices.(account_id)->dim_accounts.(id)',
      'fct_product_events.(account_id)->dim_accounts.(id)',
      'fct_product_events.(user_id)->dim_users.(id)',
      'fct_product_events.(workspace_id)->dim_workspaces.(id)',
      'support_tickets.(account_id)->dim_accounts.(id)',
      'support_tickets.(user_id)->dim_users.(id)',
    ]);
    expect(headline?.falseNegatives.fk).toEqual([]);
    expect(validationDisabled?.validationBlocked).toBe(true);
    expect(suite.aggregate.headlineCaseCount).toBe(1);
    expect(suite.aggregate.headlineFkRecall).toBe(1);
    expect(suite.aggregate.headlinePkRecall).toBe(1);
  });
});
