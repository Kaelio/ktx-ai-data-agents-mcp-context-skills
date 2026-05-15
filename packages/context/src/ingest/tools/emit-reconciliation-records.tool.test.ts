import { describe, expect, it } from 'vitest';
import type { AgentToolDefinition } from '../../agent/index.js';
import type { StageIndex } from '../stages/stage-index.types.js';
import { createEmitArtifactResolutionTool } from './emit-artifact-resolution.tool.js';
import { createEmitConflictResolutionTool } from './emit-conflict-resolution.tool.js';
import { createEmitEvictionDecisionTool } from './emit-eviction-decision.tool.js';
import { createEmitUnmappedFallbackTool } from './emit-unmapped-fallback.tool.js';

function makeStageIndex(): StageIndex {
  return {
    jobId: 'job-1',
    connectionId: 'c1',
    workUnits: [],
    conflictsResolved: [],
    evictionsApplied: [],
    unmappedFallbacks: [],
  };
}

async function executeTool<Input>(tool: AgentToolDefinition<any>, input: NoInfer<Input>) {
  return (await tool.execute(input, { toolCallId: 'tool-call-1' })) as string;
}

describe('reconciliation emit tools', () => {
  it('records conflict resolutions on the shared stage index', async () => {
    const stageIndex = makeStageIndex();
    const tool = createEmitConflictResolutionTool({ stageIndex });

    const output = await executeTool(tool, {
      unitKey: 'wu-orders',
      kind: 'near_duplicate',
      contestedKey: 'gross_revenue',
      artifactKey: 'sl:orders.gross_revenue',
      detail: 'orders and order_facts compute the same revenue metric; retained orders as canonical',
      flaggedForHuman: true,
    });

    expect(stageIndex.conflictsResolved).toEqual([
      {
        unitKey: 'wu-orders',
        kind: 'near_duplicate',
        contestedKey: 'gross_revenue',
        artifactKey: 'sl:orders.gross_revenue',
        detail: 'orders and order_facts compute the same revenue metric; retained orders as canonical',
        flaggedForHuman: true,
      },
    ]);
    expect(output).toBe('recorded conflict resolution for sl:orders.gross_revenue');
  });

  it('records eviction decisions only for deleted raw paths in the current eviction set', async () => {
    const stageIndex = makeStageIndex();
    const tool = createEmitEvictionDecisionTool({
      stageIndex,
      deletedRawPaths: ['views/old_orders.view.lkml'],
    });

    const output = await executeTool(tool, {
      rawPath: 'views/old_orders.view.lkml',
      artifactKind: 'sl',
      artifactKey: 'old_orders',
      action: 'removed',
      reason: 'source raw file was deleted and no retained artifacts are required',
    });

    expect(output).toContain('recorded eviction decision for views/old_orders.view.lkml');
    expect(stageIndex.evictionsApplied).toEqual([
      {
        rawPath: 'views/old_orders.view.lkml',
        artifactKind: 'sl',
        artifactKey: 'old_orders',
        action: 'removed',
        reason: 'source raw file was deleted and no retained artifacts are required',
      },
    ]);
  });

  it('updates an existing eviction decision for the same raw path and artifact', async () => {
    const stageIndex = makeStageIndex();
    const tool = createEmitEvictionDecisionTool({
      stageIndex,
      deletedRawPaths: ['views/old_orders.view.lkml'],
    });

    await executeTool(tool, {
      rawPath: 'views/old_orders.view.lkml',
      artifactKind: 'wiki',
      artifactKey: 'orders/old',
      action: 'removed',
      reason: 'first pass',
    });
    await executeTool(tool, {
      rawPath: 'views/old_orders.view.lkml',
      artifactKind: 'wiki',
      artifactKey: 'orders/old',
      action: 'removed',
      reason: 'second pass after checking references',
    });

    expect(stageIndex.evictionsApplied).toEqual([
      {
        rawPath: 'views/old_orders.view.lkml',
        artifactKind: 'wiki',
        artifactKey: 'orders/old',
        action: 'removed',
        reason: 'second pass after checking references',
      },
    ]);
  });

  it('rejects eviction decisions for raw paths outside the current eviction set', async () => {
    const stageIndex = makeStageIndex();
    const tool = createEmitEvictionDecisionTool({
      stageIndex,
      deletedRawPaths: ['views/old_orders.view.lkml'],
    });

    const output = await executeTool(tool, {
      rawPath: 'views/not_deleted.view.lkml',
      artifactKind: 'sl',
      artifactKey: 'not_deleted',
      action: 'removed',
      reason: 'bad input',
    });

    expect(output).toContain('Error: rawPath "views/not_deleted.view.lkml" is not in the current eviction set');
    expect(stageIndex.evictionsApplied).toEqual([]);
  });

  it('records unmapped fallback decisions for allowed raw paths', async () => {
    const stageIndex = makeStageIndex();
    const tool = createEmitUnmappedFallbackTool({
      stageIndex,
      allowedPaths: new Set(['metrics/conversion.yml']),
    });

    const output = await executeTool(tool, {
      rawPath: 'metrics/conversion.yml',
      reason: 'no_physical_table',
      fallback: 'flagged',
    });

    expect(output).toContain('recorded unmapped fallback for metrics/conversion.yml');
    expect(stageIndex.unmappedFallbacks).toEqual([
      {
        rawPath: 'metrics/conversion.yml',
        reason: 'no_physical_table',
        detail: expect.stringContaining('not present as a source'),
        fallback: 'flagged',
      },
    ]);
  });

  it('deduplicates identical unmapped fallback decisions', async () => {
    const stageIndex = makeStageIndex();
    const tool = createEmitUnmappedFallbackTool({
      stageIndex,
      allowedPaths: new Set(['metrics/conversion.yml']),
    });

    await executeTool(tool, {
      rawPath: 'metrics/conversion.yml',
      reason: 'no_physical_table',
      fallback: 'flagged',
    });
    await executeTool(tool, {
      rawPath: 'metrics/conversion.yml',
      reason: 'no_physical_table',
      fallback: 'flagged',
    });

    expect(stageIndex.unmappedFallbacks).toEqual([
      {
        rawPath: 'metrics/conversion.yml',
        reason: 'no_physical_table',
        detail: expect.stringContaining('not present as a source'),
        fallback: 'flagged',
      },
    ]);
  });

  it('records MetricFlow-specific unsupported fallback reasons', async () => {
    const stageIndex = makeStageIndex();
    const tool = createEmitUnmappedFallbackTool({
      stageIndex,
      allowedPaths: new Set(['metrics/conversion.yml']),
    });

    const output = await executeTool(tool, {
      rawPath: 'metrics/conversion.yml',
      reason: 'conversion_metric_unsupported',
      fallback: 'flagged',
    });

    expect(output).toContain('conversion metric');
    expect(stageIndex.unmappedFallbacks).toEqual([
      {
        rawPath: 'metrics/conversion.yml',
        reason: 'conversion_metric_unsupported',
        detail: expect.stringContaining('conversion metric'),
        fallback: 'flagged',
      },
    ]);
  });

  it('rejects unmapped fallback decisions for raw paths outside the allowed set', async () => {
    const stageIndex = makeStageIndex();
    const tool = createEmitUnmappedFallbackTool({
      stageIndex,
      allowedPaths: new Set(['metrics/conversion.yml']),
    });

    const output = await executeTool(tool, {
      rawPath: 'metrics/not-in-this-work-unit.yml',
      reason: 'no_physical_table',
      fallback: 'flagged',
    });

    expect(output).toContain(
      'Error: rawPath "metrics/not-in-this-work-unit.yml" is not available to this ingest stage',
    );
    expect(stageIndex.unmappedFallbacks).toEqual([]);
  });

  it('rejects missing-table fallback decisions when the table resolves to an existing semantic source', async () => {
    const stageIndex = makeStageIndex();
    const tool = createEmitUnmappedFallbackTool({
      stageIndex,
      allowedPaths: new Set(['cards/revenue.json']),
      tableRefExists: async (tableRef) => tableRef === 'orbit_analytics.mart_revenue_daily',
    });

    const output = await executeTool(tool, {
      rawPath: 'cards/revenue.json',
      reason: 'no_physical_table',
      tableRef: 'orbit_analytics.mart_revenue_daily',
      fallback: 'wiki_only',
    });

    expect(output).toContain(
      'Error: tableRef "orbit_analytics.mart_revenue_daily" already resolves to a semantic source',
    );
    expect(stageIndex.unmappedFallbacks).toEqual([]);
  });

  it('records explicit artifact resolutions for provenance rows', async () => {
    const stageIndex = makeStageIndex();
    const tool = createEmitArtifactResolutionTool({
      stageIndex,
      allowedPaths: new Set(['explores/b2b/sales_pipeline.json']),
    });

    const output = await executeTool(tool, {
      rawPath: 'explores/b2b/sales_pipeline.json',
      artifactKind: 'sl',
      artifactKey: 'looker__b2b__sales_pipeline',
      actionType: 'subsumed',
      reason: 'File-adapter source b2b__sales_pipeline is canonical for this explore.',
    });

    expect(output).toBe('recorded artifact resolution for sl:looker__b2b__sales_pipeline');
    expect(stageIndex.artifactResolutions).toEqual([
      {
        rawPath: 'explores/b2b/sales_pipeline.json',
        artifactKind: 'sl',
        artifactKey: 'looker__b2b__sales_pipeline',
        actionType: 'subsumed',
        reason: 'File-adapter source b2b__sales_pipeline is canonical for this explore.',
      },
    ]);
  });
});
