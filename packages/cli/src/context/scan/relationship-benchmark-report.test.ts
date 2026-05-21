import { describe, expect, it } from 'vitest';
import {
  buildKtxRelationshipBenchmarkReport,
  formatKtxRelationshipBenchmarkReportMarkdown,
} from './relationship-benchmark-report.js';
import type {
  KtxRelationshipBenchmarkCaseResult,
  KtxRelationshipBenchmarkFixture,
  KtxRelationshipBenchmarkSuiteResult,
} from './relationship-benchmarks.js';

type CaseResultOverrides = Omit<Partial<KtxRelationshipBenchmarkCaseResult>, 'metrics'> & {
  metrics?: Partial<KtxRelationshipBenchmarkCaseResult['metrics']>;
};

function caseResult(overrides: CaseResultOverrides = {}): KtxRelationshipBenchmarkCaseResult {
  return {
    fixtureId: overrides.fixtureId ?? 'demo_b2b_no_declared_constraints',
    mode: overrides.mode ?? 'declared_pks_and_declared_fks_removed',
    metrics: {
      pkPrecision: 1,
      pkRecall: 0.5,
      pkF1: 0.6666666666666666,
      fkPrecision: 1,
      fkRecall: 1,
      fkF1: 1,
      acceptedFalsePositiveCount: 0,
      reviewRecall: 0,
      acceptedOrReviewRecall: 1,
      runtimeSeconds: 0.012345,
      sqlQueries: 14,
      llmCalls: 0,
      ...(overrides.metrics ?? {}),
    },
    expected: overrides.expected ?? {
      pk: ['accounts.(id)', 'users.(id)'],
      fk: ['users.(account_id)->accounts.(id)'],
    },
    predicted: overrides.predicted ?? {
      pk: ['accounts.(id)'],
      fk: ['users.(account_id)->accounts.(id)'],
      acceptedFk: ['users.(account_id)->accounts.(id)'],
      reviewFk: [],
    },
    falsePositives: overrides.falsePositives ?? { pk: [], fk: [] },
    falseNegatives: overrides.falseNegatives ?? { pk: ['users.(id)'], fk: [] },
    skippedComposite: overrides.skippedComposite ?? { pk: [], fk: [] },
    validationBlocked: overrides.validationBlocked ?? false,
  };
}

function fixture(overrides: Partial<KtxRelationshipBenchmarkFixture> = {}): KtxRelationshipBenchmarkFixture {
  return {
    id: overrides.id ?? 'demo_b2b_no_declared_constraints',
    name: overrides.name ?? 'Packaged B2B demo with declared PK and FK metadata masked',
    tier: overrides.tier ?? 'smoke',
    origin: overrides.origin ?? 'synthetic',
    thresholdEligible: overrides.thresholdEligible,
    validationBudget: overrides.validationBudget,
    snapshot: overrides.snapshot ?? {
      connectionId: 'demo_b2b',
      driver: 'sqlite',
      extractedAt: '2026-05-07T00:00:00.000Z',
      scope: {},
      metadata: {},
      tables: [],
    },
    expected: overrides.expected ?? { expectedPks: [], expectedLinks: [] },
    defaultModes: overrides.defaultModes ?? ['declared_pks_and_declared_fks_removed', 'validation_disabled'],
    dataPath: overrides.dataPath ?? '/tmp/demo.sqlite',
    columnEmbeddings: overrides.columnEmbeddings ?? {},
  };
}

describe('relationship benchmark report', () => {
  it('classifies run, validation-blocked, and not-run benchmark cases', () => {
    const suite: KtxRelationshipBenchmarkSuiteResult = {
      cases: [
        caseResult(),
        caseResult({
          mode: 'validation_disabled',
          validationBlocked: true,
          metrics: { fkRecall: 0, acceptedOrReviewRecall: 1, sqlQueries: 0 },
          predicted: {
            pk: ['accounts.(id)'],
            fk: ['users.(account_id)->accounts.(id)'],
            acceptedFk: [],
            reviewFk: ['users.(account_id)->accounts.(id)'],
          },
        }),
      ],
      validationBlockedCases: ['demo_b2b_no_declared_constraints:validation_disabled'],
      aggregate: {
        caseCount: 2,
        headlineCaseCount: 1,
        headlinePkRecall: 0.5,
        headlineFkRecall: 1,
        headlineAcceptedOrReviewRecall: 1,
        meanPkRecall: 0.5,
        meanFkRecall: 0.5,
        meanAcceptedOrReviewRecall: 1,
      },
    };

    const report = buildKtxRelationshipBenchmarkReport({
      fixtures: [fixture()],
      suite,
      modes: ['declared_pks_and_declared_fks_removed', 'validation_disabled', 'profiling_disabled'],
    });

    expect(report.headline).toEqual({
      caseCount: 2,
      headlineCaseCount: 1,
      headlinePkRecall: 0.5,
      headlineFkRecall: 1,
      headlineAcceptedOrReviewRecall: 1,
      acceptedFalsePositiveCount: 0,
      validationBlockedCount: 1,
    });
    expect(report.cases.map((item) => `${item.fixtureId}:${item.mode}:${item.status}`)).toEqual([
      'demo_b2b_no_declared_constraints:declared_pks_and_declared_fks_removed:run',
      'demo_b2b_no_declared_constraints:validation_disabled:validation_blocked',
      'demo_b2b_no_declared_constraints:profiling_disabled:not_run',
    ]);
    expect(report.cases[2]?.reason).toBe('mode not selected by fixture defaultModes');
  });

  it('surfaces validation budget review candidates in the report reason', () => {
    const suite: KtxRelationshipBenchmarkSuiteResult = {
      cases: [
        caseResult({
          fixtureId: 'scale_stress_no_declared_constraints',
          metrics: { fkRecall: 0.5, acceptedOrReviewRecall: 1 },
          predicted: {
            pk: ['dim_entity_00.(entity_00_key)'],
            fk: [
              'fact_activity_000.(entity_00_key)->dim_entity_00.(entity_00_key)',
              'fact_activity_001.(entity_00_key)->dim_entity_00.(entity_00_key)',
            ],
            acceptedFk: ['fact_activity_000.(entity_00_key)->dim_entity_00.(entity_00_key)'],
            reviewFk: ['fact_activity_001.(entity_00_key)->dim_entity_00.(entity_00_key)'],
          },
        }),
      ],
      validationBlockedCases: [],
      aggregate: {
        caseCount: 1,
        headlineCaseCount: 0,
        headlinePkRecall: 1,
        headlineFkRecall: 0.5,
        headlineAcceptedOrReviewRecall: 1,
        meanPkRecall: 1,
        meanFkRecall: 0.5,
        meanAcceptedOrReviewRecall: 1,
      },
    };

    const report = buildKtxRelationshipBenchmarkReport({
      fixtures: [
        fixture({
          id: 'scale_stress_no_declared_constraints',
          name: 'Scale stress fixture',
          tier: 'row_bearing',
          validationBudget: 800,
          defaultModes: ['declared_pks_and_declared_fks_removed'],
        }),
      ],
      suite,
      modes: ['declared_pks_and_declared_fks_removed'],
    });

    expect(report.cases[0]?.reason).toBe('review candidate validation reasons: validation_unattempted (1)');
    expect(formatKtxRelationshipBenchmarkReportMarkdown(report)).toContain('validation_unattempted');
  });

  it('uses benchmark suite eligibility for product and smoke report rows', () => {
    const productCase = caseResult({ fixtureId: 'product_curated' });
    const productBlocked = caseResult({
      fixtureId: 'product_curated',
      mode: 'validation_disabled',
      validationBlocked: true,
      metrics: { fkRecall: 0, acceptedOrReviewRecall: 1, sqlQueries: 0 },
    });
    const smokeCase = caseResult({ fixtureId: 'smoke_even_if_marked' });
    const suite: KtxRelationshipBenchmarkSuiteResult = {
      cases: [productCase, productBlocked, smokeCase],
      validationBlockedCases: ['product_curated:validation_disabled'],
      aggregate: {
        caseCount: 3,
        headlineCaseCount: 1,
        headlinePkRecall: 0.5,
        headlineFkRecall: 1,
        headlineAcceptedOrReviewRecall: 1,
        meanPkRecall: 0.5,
        meanFkRecall: 0.6666666666666666,
        meanAcceptedOrReviewRecall: 1,
      },
    };

    const report = buildKtxRelationshipBenchmarkReport({
      fixtures: [
        fixture({
          id: 'product_curated',
          name: 'Curated product fixture',
          tier: 'product',
          thresholdEligible: true,
          defaultModes: ['declared_pks_and_declared_fks_removed', 'validation_disabled'],
        }),
        fixture({
          id: 'smoke_even_if_marked',
          name: 'Marked smoke fixture',
          tier: 'smoke',
          thresholdEligible: true,
          defaultModes: ['declared_pks_and_declared_fks_removed'],
        }),
      ],
      suite,
      modes: ['declared_pks_and_declared_fks_removed', 'validation_disabled'],
    });

    expect(report.cases.map((item) => `${item.fixtureId}:${item.mode}:${item.tuningEligible}`)).toEqual([
      'product_curated:declared_pks_and_declared_fks_removed:true',
      'product_curated:validation_disabled:false',
      'smoke_even_if_marked:declared_pks_and_declared_fks_removed:false',
      'smoke_even_if_marked:validation_disabled:false',
    ]);
    expect(formatKtxRelationshipBenchmarkReportMarkdown(report)).toContain(
      '| product_curated | product | declared_pks_and_declared_fks_removed | run | yes |',
    );
  });

  it('formats a compact Markdown report with false negatives and blocked modes', () => {
    const suite: KtxRelationshipBenchmarkSuiteResult = {
      cases: [
        caseResult({
          metrics: { fkRecall: 0, acceptedOrReviewRecall: 0 },
          falseNegatives: { pk: ['users.(id)'], fk: ['users.(account_id)->accounts.(id)'] },
        }),
      ],
      validationBlockedCases: [],
      aggregate: {
        caseCount: 1,
        headlineCaseCount: 1,
        headlinePkRecall: 0.5,
        headlineFkRecall: 0,
        headlineAcceptedOrReviewRecall: 0,
        meanPkRecall: 0.5,
        meanFkRecall: 0,
        meanAcceptedOrReviewRecall: 0,
      },
    };

    const markdown = formatKtxRelationshipBenchmarkReportMarkdown(
      buildKtxRelationshipBenchmarkReport({
        fixtures: [fixture()],
        suite,
        modes: ['declared_pks_and_declared_fks_removed'],
      }),
    );

    expect(markdown).toContain('# KTX Relationship Discovery Benchmark Evidence');
    expect(markdown).toContain(
      '| demo_b2b_no_declared_constraints | smoke | declared_pks_and_declared_fks_removed | run | no | 0.500 | 0.000 | 0.000 | 0 |',
    );
    expect(markdown).toContain(
      '- `demo_b2b_no_declared_constraints` / `declared_pks_and_declared_fks_removed` / `run`: users.(id)',
    );
    expect(markdown).toContain(
      '- `demo_b2b_no_declared_constraints` / `declared_pks_and_declared_fks_removed` / `run`: users.(account_id)->accounts.(id)',
    );
  });

  it('keeps headline failures separate from non-headline failure details', () => {
    const suite: KtxRelationshipBenchmarkSuiteResult = {
      cases: [
        caseResult({
          fixtureId: 'product_curated',
          falseNegatives: { pk: [], fk: [] },
          metrics: { pkRecall: 1, fkRecall: 1, acceptedOrReviewRecall: 1 },
        }),
        caseResult({
          fixtureId: 'product_curated',
          mode: 'embeddings_disabled',
          falseNegatives: {
            pk: ['customers.(id)'],
            fk: ['orders.(buyer_ref)->customers.(id)'],
          },
          metrics: { pkRecall: 0.5, fkRecall: 0, acceptedOrReviewRecall: 0 },
        }),
      ],
      validationBlockedCases: [],
      aggregate: {
        caseCount: 2,
        headlineCaseCount: 1,
        headlinePkRecall: 1,
        headlineFkRecall: 1,
        headlineAcceptedOrReviewRecall: 1,
        meanPkRecall: 0.75,
        meanFkRecall: 0.5,
        meanAcceptedOrReviewRecall: 0.5,
      },
    };

    const markdown = formatKtxRelationshipBenchmarkReportMarkdown(
      buildKtxRelationshipBenchmarkReport({
        fixtures: [
          fixture({
            id: 'product_curated',
            name: 'Curated product fixture',
            tier: 'product',
            thresholdEligible: true,
            defaultModes: ['declared_pks_and_declared_fks_removed', 'embeddings_disabled'],
          }),
        ],
        suite,
        modes: ['declared_pks_and_declared_fks_removed', 'embeddings_disabled'],
      }),
    );

    expect(markdown).toContain('## Failure Details');
    expect(markdown).toContain('### Headline False Negative FKs\n\n- none');
    expect(markdown).toContain(
      '- `product_curated` / `embeddings_disabled` / `run`: orders.(buyer_ref)->customers.(id)',
    );
    expect(markdown).toContain('- `product_curated` / `embeddings_disabled` / `run`: customers.(id)');
  });

  it('formats headline failure context from remaining headline false negatives', () => {
    const suite: KtxRelationshipBenchmarkSuiteResult = {
      cases: [
        caseResult({
          fixtureId: 'public_headline_fixture',
          metrics: { pkRecall: 0.5, fkRecall: 0, acceptedOrReviewRecall: 0 },
          falseNegatives: {
            pk: ['parent_table.(opaque_key)'],
            fk: ['child_table.(parent_table_id)->parent_table.(opaque_key)'],
          },
        }),
      ],
      validationBlockedCases: [],
      aggregate: {
        caseCount: 1,
        headlineCaseCount: 1,
        headlinePkRecall: 0.5,
        headlineFkRecall: 0,
        headlineAcceptedOrReviewRecall: 0,
        meanPkRecall: 0.5,
        meanFkRecall: 0,
        meanAcceptedOrReviewRecall: 0,
      },
    };

    const markdown = formatKtxRelationshipBenchmarkReportMarkdown(
      buildKtxRelationshipBenchmarkReport({
        fixtures: [
          fixture({
            id: 'public_headline_fixture',
            name: 'Public headline fixture',
            tier: 'row_bearing',
            thresholdEligible: true,
            defaultModes: ['declared_pks_and_declared_fks_removed'],
          }),
        ],
        suite,
        modes: ['declared_pks_and_declared_fks_removed'],
      }),
    );

    expect(markdown).toContain('## Headline Failure Context');
    expect(markdown).toContain('- Remaining headline false-negative PKs: 1');
    expect(markdown).toContain('- Remaining headline false-negative FKs: 1');
    expect(markdown).toContain(
      '- `public_headline_fixture` / `declared_pks_and_declared_fks_removed` / `run`: parent_table.(opaque_key)',
    );
    expect(markdown).toContain(
      '- `public_headline_fixture` / `declared_pks_and_declared_fks_removed` / `run`: child_table.(parent_table_id)->parent_table.(opaque_key)',
    );
  });

  it('formats skipped composite ground truth separately from false-negative details', () => {
    const compositePk = 'order_lines.(order_id,line_number)';
    const compositeFk = 'order_line_allocations.(order_id,line_number)->order_lines.(order_id,line_number)';
    const suite: KtxRelationshipBenchmarkSuiteResult = {
      cases: [
        caseResult({
          fixtureId: 'composite_keys_no_declared_constraints',
          metrics: { pkRecall: 0, fkRecall: 0, acceptedOrReviewRecall: 0 },
          expected: {
            pk: [compositePk],
            fk: [compositeFk],
          },
          predicted: {
            pk: [],
            fk: [],
            acceptedFk: [],
            reviewFk: [],
          },
          falseNegatives: {
            pk: [compositePk],
            fk: [compositeFk],
          },
          skippedComposite: {
            pk: [compositePk],
            fk: [compositeFk],
          },
        }),
      ],
      validationBlockedCases: [],
      aggregate: {
        caseCount: 1,
        headlineCaseCount: 1,
        headlinePkRecall: 0,
        headlineFkRecall: 0,
        headlineAcceptedOrReviewRecall: 0,
        meanPkRecall: 0,
        meanFkRecall: 0,
        meanAcceptedOrReviewRecall: 0,
      },
    };

    const report = buildKtxRelationshipBenchmarkReport({
      fixtures: [
        fixture({
          id: 'composite_keys_no_declared_constraints',
          name: 'Composite key fixture with no declared constraints',
          tier: 'row_bearing',
          defaultModes: ['declared_pks_and_declared_fks_removed'],
        }),
      ],
      suite,
      modes: ['declared_pks_and_declared_fks_removed'],
    });

    expect(report.cases[0]?.skippedComposite).toEqual({
      pk: [compositePk],
      fk: [compositeFk],
    });

    const markdown = formatKtxRelationshipBenchmarkReportMarkdown(report);
    expect(markdown).toContain('## Composite Ground Truth Skips');
    expect(markdown).toContain(
      '### Skipped Composite PKs\n\n- `composite_keys_no_declared_constraints` / `declared_pks_and_declared_fks_removed` / `run`: order_lines.(order_id,line_number)',
    );
    expect(markdown).toContain(
      '### Skipped Composite FKs\n\n- `composite_keys_no_declared_constraints` / `declared_pks_and_declared_fks_removed` / `run`: order_line_allocations.(order_id,line_number)->order_lines.(order_id,line_number)',
    );
    expect(markdown).toContain(
      '### Headline False Negative FKs\n\n- `composite_keys_no_declared_constraints` / `declared_pks_and_declared_fks_removed` / `run`: order_line_allocations.(order_id,line_number)->order_lines.(order_id,line_number)',
    );
  });
});
