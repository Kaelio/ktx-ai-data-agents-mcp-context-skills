import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgentTool } from '../../agent/index.js';
import { buildReconcileSystemPrompt, buildReconcileToolSet, buildReconcileUserPrompt } from './build-reconcile-context.js';

const fakeTool = (name: string) =>
  createAgentTool({
    name,
    description: name,
    inputSchema: z.object({}),
    execute: async () => `${name} output`,
  });

describe('buildReconcileSystemPrompt', () => {
  it('appends canonical pins when relevant pins are supplied', () => {
    const prompt = buildReconcileSystemPrompt({
      baseFraming: '<role>reconcile</role>',
      skillsPrompt: '<skills>ingest_triage</skills>',
      syncId: 'sync-1',
      sourceKey: 'lookml',
      canonicalPins: [
        {
          contestedKey: 'churn_risk_score',
          canonicalArtifactKey: 'billing.churn_risk_score',
          pinnedAt: '2026-04-27T12:00:00.000Z',
          pinnedBy: 'user-1',
          reason: 'billing owns the contractual definition',
        },
      ],
    });

    expect(prompt).toContain('<canonical_pins>');
    expect(prompt).toContain('contestedKey: churn_risk_score');
    expect(prompt).toContain('canonicalArtifactKey: billing.churn_risk_score');
    expect(prompt).toContain('<context>');
  });

  it('omits canonical_pins when none are relevant', () => {
    const prompt = buildReconcileSystemPrompt({
      baseFraming: '<role>reconcile</role>',
      skillsPrompt: '',
      syncId: 'sync-1',
      sourceKey: 'lookml',
      canonicalPins: [],
    });

    expect(prompt).not.toContain('<canonical_pins>');
    expect(prompt).toContain('syncId: sync-1');
  });
});

describe('buildReconcileUserPrompt', () => {
  it('includes action details so reconciliation can compare different keys for the same table', () => {
    const prompt = buildReconcileUserPrompt(
      {
        jobId: 'j1',
        connectionId: 'notion',
        workUnits: [
          {
            unitKey: 'notion-a',
            rawFiles: ['pages/a/page.md'],
            status: 'success',
            actions: [
              {
                target: 'wiki',
                type: 'created',
                key: 'orbit-customer-source-reference',
                detail: 'tables: orbit_analytics.customer',
              },
            ],
            touchedSlSources: [],
          },
        ],
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
      },
      undefined,
    );

    expect(prompt).toContain('orbit-customer-source-reference');
    expect(prompt).toContain('tables: orbit_analytics.customer');
  });
});

describe('buildReconcileToolSet', () => {
  it('includes emit_unmapped_fallback with the reconciliation tools', () => {
    const toolSet = buildReconcileToolSet({
      loadSkillTool: { load_skill: fakeTool('load_skill') },
      stageListTool: { stage_list: fakeTool('stage_list') },
      stageDiffTool: { stage_diff: fakeTool('stage_diff') },
      evictionListTool: { eviction_list: fakeTool('eviction_list') },
      emitConflictResolutionTool: { emit_conflict_resolution: fakeTool('emit_conflict_resolution') },
      emitEvictionDecisionTool: { emit_eviction_decision: fakeTool('emit_eviction_decision') },
      emitArtifactResolutionTool: { emit_artifact_resolution: fakeTool('emit_artifact_resolution') },
      emitUnmappedFallbackTool: { emit_unmapped_fallback: fakeTool('emit_unmapped_fallback') },
      readRawSpanTool: { read_raw_span: fakeTool('read_raw_span') },
      toolsetTools: { sl_write_source: fakeTool('sl_write_source'), wiki_write: fakeTool('wiki_write') },
    });

    expect(Object.keys(toolSet).sort()).toEqual(
      [
        'emit_conflict_resolution',
        'emit_eviction_decision',
        'emit_artifact_resolution',
        'emit_unmapped_fallback',
        'eviction_list',
        'load_skill',
        'read_raw_span',
        'record_verification_ledger',
        'sl_write_source',
        'stage_diff',
        'stage_list',
        'wiki_write',
      ].sort(),
    );
    expect(toolSet.record_verification_ledger.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(toolSet.emit_conflict_resolution.name).toBe('emit_conflict_resolution');
  });

  it('requires the verification ledger before reconciliation write tools run', async () => {
    const slWrite = vi.fn().mockResolvedValue({ markdown: 'written', structured: { success: true } });
    const toolSet = buildReconcileToolSet({
      loadSkillTool: { load_skill: fakeTool('load_skill') },
      stageListTool: { stage_list: fakeTool('stage_list') },
      stageDiffTool: { stage_diff: fakeTool('stage_diff') },
      evictionListTool: { eviction_list: fakeTool('eviction_list') },
      emitConflictResolutionTool: { emit_conflict_resolution: fakeTool('emit_conflict_resolution') },
      emitEvictionDecisionTool: { emit_eviction_decision: fakeTool('emit_eviction_decision') },
      emitArtifactResolutionTool: { emit_artifact_resolution: fakeTool('emit_artifact_resolution') },
      emitUnmappedFallbackTool: { emit_unmapped_fallback: fakeTool('emit_unmapped_fallback') },
      readRawSpanTool: { read_raw_span: fakeTool('read_raw_span') },
      toolsetTools: {
        sl_write_source: createAgentTool({
          name: 'sl_write_source',
          description: 'sl write',
          inputSchema: z.object({ connectionId: z.string(), sourceName: z.string() }),
          execute: slWrite,
        }),
      },
    });

    const correction = await toolSet.sl_write_source.execute?.(
      { connectionId: 'warehouse', sourceName: 'accounts' },
      { toolCallId: 't1' } as any,
    );

    expect(slWrite).not.toHaveBeenCalled();
    expect(correction).toMatchObject({ structured: { success: false, reason: 'verification_ledger_required' } });

    await toolSet.record_verification_ledger.execute?.(
      {
        summary: 'Verified warehouse.accounts with entity_details.',
        verifiedIdentifiers: ['warehouse.accounts'],
        unverifiedIdentifiers: [],
      },
      { toolCallId: 't2' } as any,
    );
    const written = await toolSet.sl_write_source.execute?.(
      { connectionId: 'warehouse', sourceName: 'accounts' },
      { toolCallId: 't3' } as any,
    );

    expect(slWrite).toHaveBeenCalledTimes(1);
    expect(written).toMatchObject({ structured: { success: true } });
  });
});
