import type { KtxLlmProvider } from '@ktx/llm';
import { describe, expect, it, vi } from 'vitest';
import type { KtxEnrichedColumn, KtxEnrichedSchema, KtxEnrichedTable } from './enrichment-types.js';
import type { KtxRelationshipProfileArtifact } from './relationship-profiling.js';
import { proposeKtxRelationshipCandidatesWithLlm } from './relationship-llm-proposal.js';

function llmProvider(provider = 'anthropic'): KtxLlmProvider {
  const model = { modelId: 'claude-sonnet-4-6', provider };
  return {
    getModel: vi.fn(() => model as ReturnType<KtxLlmProvider['getModel']>),
    getModelByName: vi.fn(() => model as ReturnType<KtxLlmProvider['getModelByName']>),
    cacheMarker: vi.fn(),
    repairToolCallHandler: vi.fn(),
    thinkingProviderOptions: vi.fn(() => ({})),
    telemetryConfig: vi.fn(() => undefined),
    promptCachingConfig: vi.fn(
      () =>
        ({
          enabled: false,
          systemTtl: '1h',
          toolsTtl: '1h',
          historyTtl: '5m',
          cacheSystem: true,
          cacheTools: true,
          cacheHistory: true,
          vertexFallbackTo5m: false,
        }) as ReturnType<KtxLlmProvider['promptCachingConfig']>,
    ),
    activeBackend: vi.fn(() => provider as ReturnType<KtxLlmProvider['activeBackend']>),
  };
}

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

function schema(): KtxEnrichedSchema {
  return {
    connectionId: 'warehouse',
    relationships: [],
    tables: [
      table('customers', [
        column('customers', 'id', { nullable: false }),
        column('customers', 'email', { nativeType: 'TEXT', normalizedType: 'text', dimensionType: 'string' }),
      ]),
      table('orders', [
        column('orders', 'id', { nullable: false }),
        column('orders', 'buyer_ref'),
      ]),
    ],
  };
}

function profile(): KtxRelationshipProfileArtifact {
  return {
    connectionId: 'warehouse',
    driver: 'sqlite',
    sqlAvailable: true,
    queryCount: 4,
    warnings: [],
    tables: [
      { table: { catalog: null, db: null, name: 'customers' }, rowCount: 2 },
      { table: { catalog: null, db: null, name: 'orders' }, rowCount: 2 },
    ],
    columns: {
      'customers.id': {
        table: { catalog: null, db: null, name: 'customers' },
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
      'orders.buyer_ref': {
        table: { catalog: null, db: null, name: 'orders' },
        column: 'buyer_ref',
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
  };
}

describe('relationship LLM proposals', () => {
  it('maps valid structured FK proposals into review candidates with rationale evidence', async () => {
    const generateText = vi.fn(async () => ({
      output: {
        pkCandidates: [{ table: 'customers', column: 'id', confidence: 0.94, rationale: 'Unique customer identifier.' }],
        fkCandidates: [
          {
            fromTable: 'orders',
            fromColumn: 'buyer_ref',
            toTable: 'customers',
            toColumn: 'id',
            confidence: 0.88,
            rationale: 'Buyer reference values match customer identifiers.',
          },
        ],
      },
    }));

    const result = await proposeKtxRelationshipCandidatesWithLlm({
      connectionId: 'warehouse',
      schema: schema(),
      profile: profile(),
      llmProvider: llmProvider(),
      generateText,
    });

    expect(result.summary).toBe('completed');
    expect(result.llmCalls).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      from: { tableId: 'orders', columnIds: ['orders.buyer_ref'], columns: ['buyer_ref'] },
      to: { tableId: 'customers', columnIds: ['customers.id'], columns: ['id'] },
      source: 'llm_proposal',
      status: 'review',
      evidence: {
        llmConfidence: 0.88,
        llmRationale: 'Buyer reference values match customer identifiers.',
        reasons: ['llm_proposal', 'llm_pk_proposal'],
      },
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('You are helping KTX review possible SQL relationships'),
          }),
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('"tables"'),
          }),
        ]),
      }),
    );
    const call = (generateText.mock.calls as unknown as Array<[{ messages: Array<{ role: string; content: string }> }]>)[0]?.[0];
    const userMessage = call?.messages.find((m) => m.role === 'user');
    expect(userMessage?.content).not.toContain('You are helping KTX review possible SQL relationships');
  });

  it('skips deterministic providers without calling generateText', async () => {
    const generateText = vi.fn();

    const result = await proposeKtxRelationshipCandidatesWithLlm({
      connectionId: 'warehouse',
      schema: schema(),
      profile: profile(),
      llmProvider: llmProvider('deterministic'),
      generateText,
    });

    expect(result).toMatchObject({ candidates: [], llmCalls: 0, summary: 'skipped' });
    expect(result.warnings).toEqual([]);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('returns recoverable warnings for invalid references and generation failures', async () => {
    const invalidReference = await proposeKtxRelationshipCandidatesWithLlm({
      connectionId: 'warehouse',
      schema: schema(),
      profile: profile(),
      llmProvider: llmProvider(),
      generateText: vi.fn(async () => ({
        output: {
          pkCandidates: [],
          fkCandidates: [
            {
              fromTable: 'orders',
              fromColumn: 'missing_column',
              toTable: 'customers',
              toColumn: 'id',
              confidence: 0.7,
              rationale: 'Invalid source column.',
            },
          ],
        },
      })),
    });
    expect(invalidReference.candidates).toEqual([]);
    expect(invalidReference.summary).toBe('completed');
    expect(invalidReference.warnings[0]).toMatchObject({
      code: 'relationship_llm_invalid_reference',
      recoverable: true,
    });

    const failed = await proposeKtxRelationshipCandidatesWithLlm({
      connectionId: 'warehouse',
      schema: schema(),
      profile: profile(),
      llmProvider: llmProvider(),
      generateText: vi.fn(async () => {
        throw new Error('model unavailable');
      }),
    });
    expect(failed).toMatchObject({ candidates: [], llmCalls: 1, summary: 'failed' });
    expect(failed.warnings[0]).toMatchObject({
      code: 'relationship_llm_proposal_failed',
      message: 'KTX relationship LLM proposal failed: model unavailable',
      recoverable: true,
    });
  });
});
