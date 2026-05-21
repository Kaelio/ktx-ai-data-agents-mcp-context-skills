import { describe, expect, it, vi } from 'vitest';
import { buildReconcileSystemPrompt, buildReconcileToolSet, buildReconcileUserPrompt } from './build-reconcile-context.js';

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
      loadSkillTool: { load_skill: { description: 'load', inputSchema: {} as any, execute: vi.fn() } } as any,
      stageListTool: { stage_list: { description: 'stage list', inputSchema: {} as any, execute: vi.fn() } } as any,
      stageDiffTool: { stage_diff: { description: 'stage diff', inputSchema: {} as any, execute: vi.fn() } } as any,
      evictionListTool: {
        eviction_list: { description: 'eviction list', inputSchema: {} as any, execute: vi.fn() },
      } as any,
      emitConflictResolutionTool: {
        emit_conflict_resolution: { description: 'conflict', inputSchema: {} as any, execute: vi.fn() },
      } as any,
      emitEvictionDecisionTool: {
        emit_eviction_decision: { description: 'eviction', inputSchema: {} as any, execute: vi.fn() },
      } as any,
      emitArtifactResolutionTool: {
        emit_artifact_resolution: { description: 'resolution', inputSchema: {} as any, execute: vi.fn() },
      } as any,
      emitUnmappedFallbackTool: {
        emit_unmapped_fallback: { description: 'fallback', inputSchema: {} as any, execute: vi.fn() },
      } as any,
      readRawSpanTool: { read_raw_span: { description: 'raw span', inputSchema: {} as any, execute: vi.fn() } } as any,
      toolsetTools: { sl_write_source: {} as any, wiki_write: {} as any },
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
  });

  it('requires the verification ledger before reconciliation write tools run', async () => {
    const slWrite = vi.fn().mockResolvedValue({ markdown: 'written', structured: { success: true } });
    const toolSet = buildReconcileToolSet({
      loadSkillTool: { load_skill: { description: 'load', inputSchema: {} as any, execute: vi.fn() } } as any,
      stageListTool: { stage_list: { description: 'stage list', inputSchema: {} as any, execute: vi.fn() } } as any,
      stageDiffTool: { stage_diff: { description: 'stage diff', inputSchema: {} as any, execute: vi.fn() } } as any,
      evictionListTool: {
        eviction_list: { description: 'eviction list', inputSchema: {} as any, execute: vi.fn() },
      } as any,
      emitConflictResolutionTool: {
        emit_conflict_resolution: { description: 'conflict', inputSchema: {} as any, execute: vi.fn() },
      } as any,
      emitEvictionDecisionTool: {
        emit_eviction_decision: { description: 'eviction', inputSchema: {} as any, execute: vi.fn() },
      } as any,
      emitArtifactResolutionTool: {
        emit_artifact_resolution: { description: 'resolution', inputSchema: {} as any, execute: vi.fn() },
      } as any,
      emitUnmappedFallbackTool: {
        emit_unmapped_fallback: { description: 'fallback', inputSchema: {} as any, execute: vi.fn() },
      } as any,
      readRawSpanTool: { read_raw_span: { description: 'raw span', inputSchema: {} as any, execute: vi.fn() } } as any,
      toolsetTools: { sl_write_source: { description: 'sl write', inputSchema: {} as any, execute: slWrite } as any },
    });

    const correction = await toolSet.sl_write_source.execute?.({ connectionId: 'warehouse', sourceName: 'accounts' });

    expect(slWrite).not.toHaveBeenCalled();
    expect(correction).toMatchObject({ structured: { success: false, reason: 'verification_ledger_required' } });

    await toolSet.record_verification_ledger.execute?.({
      summary: 'Verified warehouse.accounts with entity_details.',
      verifiedIdentifiers: ['warehouse.accounts'],
      unverifiedIdentifiers: [],
    });
    const written = await toolSet.sl_write_source.execute?.({ connectionId: 'warehouse', sourceName: 'accounts' });

    expect(slWrite).toHaveBeenCalledTimes(1);
    expect(written).toMatchObject({ structured: { success: true } });
  });
});
