import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgentTool } from '../../agent/index.js';
import { buildWuSystemPrompt, buildWuToolSet, buildWuUserPrompt } from './build-wu-context.js';

const fakeTool = (name: string) =>
  createAgentTool({
    name,
    description: name,
    inputSchema: z.object({}),
    execute: async () => `${name} output`,
  });

describe('buildWuUserPrompt', () => {
  it('includes rawFiles, dependencyPaths, peerFileIndex, and priorProvenance when present', () => {
    const prompt = buildWuUserPrompt({
      wu: { unitKey: 'u1', rawFiles: ['a.yml'], peerFileIndex: ['p.yml'], dependencyPaths: ['dep.yml'] },
      wikiIndex: '(empty)',
      slIndex: '(empty)',
      priorProvenance: new Map([
        [
          'a.yml',
          [{ artifact_kind: 'sl', artifact_key: 'src_a', action_type: 'source_created', sync_id: 'prev' } as any],
        ],
      ]),
    });
    expect(prompt).toContain('## WorkUnit: u1');
    expect(prompt).toContain('### rawFiles\n- a.yml');
    expect(prompt).toContain('### dependencyPaths\n- dep.yml');
    expect(prompt).toContain('### peerFileIndex\n- p.yml');
    expect(prompt).toContain('a.yml');
    expect(prompt).toContain('src_a');
  });

  it('omits priorProvenance block when every rawFile is new', () => {
    const prompt = buildWuUserPrompt({
      wu: { unitKey: 'u1', rawFiles: ['new.yml'], peerFileIndex: [], dependencyPaths: [] },
      wikiIndex: '',
      slIndex: '',
      priorProvenance: new Map([['new.yml', []]]),
    });
    expect(prompt).not.toContain('priorProvenance');
  });

  it('caps very large peer file indexes in the prompt', () => {
    const prompt = buildWuUserPrompt({
      wu: {
        unitKey: 'u1',
        rawFiles: ['current.yml'],
        peerFileIndex: Array.from({ length: 140 }, (_, i) => `peer-${i + 1}.yml`),
        dependencyPaths: [],
      },
      wikiIndex: '',
      slIndex: '',
      priorProvenance: new Map(),
    });

    expect(prompt).toContain('- peer-100.yml');
    expect(prompt).not.toContain('- peer-101.yml');
    expect(prompt).toContain('40 more peer files omitted');
  });
});

describe('buildWuToolSet', () => {
  it('includes load_skill, emit_unmapped_fallback, read_raw_file, read_raw_span, and provided toolset tools', () => {
    const toolSet = buildWuToolSet({
      stagedDir: '/tmp/staged',
      wu: { unitKey: 'u1', rawFiles: ['a.yml'], peerFileIndex: [], dependencyPaths: ['dep.yml'] },
      loadSkillTool: { load_skill: fakeTool('load_skill') },
      emitUnmappedFallbackTool: { emit_unmapped_fallback: fakeTool('emit_unmapped_fallback') },
      toolsetTools: { wiki_write: fakeTool('wiki_write') },
    });
    expect(Object.keys(toolSet).sort()).toEqual(
      [
        'emit_unmapped_fallback',
        'load_skill',
        'read_raw_file',
        'read_raw_span',
        'record_verification_ledger',
        'wiki_write',
      ].sort(),
    );
    expect(toolSet.record_verification_ledger.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(toolSet.wiki_write.name).toBe('wiki_write');
  });

  it('requires the verification ledger before write-capable tools run', async () => {
    const wikiWrite = vi.fn().mockResolvedValue({ markdown: 'written', structured: { success: true } });
    const toolSet = buildWuToolSet({
      stagedDir: '/tmp/staged',
      wu: { unitKey: 'u1', rawFiles: ['a.yml'], peerFileIndex: [], dependencyPaths: [] },
      loadSkillTool: { load_skill: fakeTool('load_skill') },
      emitUnmappedFallbackTool: { emit_unmapped_fallback: fakeTool('emit_unmapped_fallback') },
      toolsetTools: {
        wiki_write: createAgentTool({
          name: 'wiki_write',
          description: 'write',
          inputSchema: z.object({ key: z.string() }),
          execute: wikiWrite,
        }),
      },
    });

    const correction = await toolSet.wiki_write.execute?.({ key: 'customer-rules' }, { toolCallId: 't1' } as any);

    expect(wikiWrite).not.toHaveBeenCalled();
    expect(correction).toMatchObject({ structured: { success: false, reason: 'verification_ledger_required' } });
    expect(String((correction as any).markdown)).toContain('record_verification_ledger');

    await toolSet.record_verification_ledger.execute?.(
      {
        summary: 'No warehouse identifiers will be emitted in this wiki write.',
        verifiedIdentifiers: [],
        unverifiedIdentifiers: [],
      },
      { toolCallId: 't2' } as any,
    );
    const written = await toolSet.wiki_write.execute?.({ key: 'customer-rules' }, { toolCallId: 't3' } as any);

    expect(wikiWrite).toHaveBeenCalledTimes(1);
    expect(written).toMatchObject({ structured: { success: true } });
  });

  it('includes looker_query_to_sl only for Looker WorkUnits', () => {
    const toolSet = buildWuToolSet({
      sourceKey: 'looker',
      stagedDir: '/tmp/staged',
      wu: { unitKey: 'looker-look-20', rawFiles: ['looks/20.json'], peerFileIndex: [], dependencyPaths: [] },
      loadSkillTool: { load_skill: fakeTool('load_skill') },
      emitUnmappedFallbackTool: { emit_unmapped_fallback: fakeTool('emit_unmapped_fallback') },
      toolsetTools: { wiki_search: fakeTool('wiki_search'), sl_write_source: fakeTool('sl_write_source') },
    });

    expect(Object.keys(toolSet).sort()).toEqual(
      [
        'emit_unmapped_fallback',
        'load_skill',
        'looker_query_to_sl',
        'read_raw_file',
        'read_raw_span',
        'record_verification_ledger',
        'sl_write_source',
        'wiki_search',
      ].sort(),
    );
  });

  it('does not expose looker_query_to_sl to non-Looker WorkUnits', () => {
    const toolSet = buildWuToolSet({
      sourceKey: 'metabase',
      stagedDir: '/tmp/staged',
      wu: { unitKey: 'metabase-col-1', rawFiles: ['cards/1.json'], peerFileIndex: [], dependencyPaths: [] },
      loadSkillTool: { load_skill: fakeTool('load_skill') },
      emitUnmappedFallbackTool: { emit_unmapped_fallback: fakeTool('emit_unmapped_fallback') },
      toolsetTools: { wiki_search: fakeTool('wiki_search'), sl_write_source: fakeTool('sl_write_source') },
    });

    expect(Object.keys(toolSet)).not.toContain('looker_query_to_sl');
  });

  it('removes write/edit SL tools for SL-disallowed WorkUnits', () => {
    const toolSet = buildWuToolSet({
      sourceKey: 'lookml',
      stagedDir: '/tmp/staged',
      wu: {
        unitKey: 'lookml-b2b',
        rawFiles: ['b2b.model.lkml'],
        peerFileIndex: [],
        dependencyPaths: [],
        slDisallowed: true,
        slDisallowedReason: 'lookml_connection_mismatch',
      },
      loadSkillTool: { load_skill: fakeTool('load_skill') },
      emitUnmappedFallbackTool: { emit_unmapped_fallback: fakeTool('emit_unmapped_fallback') },
      toolsetTools: {
        sl_write_source: fakeTool('sl_write_source'),
        sl_edit_source: fakeTool('sl_edit_source'),
        sl_read_source: fakeTool('sl_read_source'),
        wiki_search: fakeTool('wiki_search'),
      },
    });

    expect(Object.keys(toolSet)).not.toContain('sl_write_source');
    expect(Object.keys(toolSet)).not.toContain('sl_edit_source');
    expect(Object.keys(toolSet)).toContain('sl_read_source');
    expect(Object.keys(toolSet)).toContain('wiki_search');
  });
});

describe('buildWuSystemPrompt', () => {
  it('emits a context block with syncId and source, but NOT rawDirInWorktree', () => {
    const prompt = buildWuSystemPrompt({
      baseFraming: 'BASE',
      skillsPrompt: 'SKILLS',
      syncId: 'sync-abc',
      sourceKey: 'metabase',
      canonicalPins: [],
    });
    expect(prompt).toContain('BASE');
    expect(prompt).toContain('SKILLS');
    expect(prompt).toContain('<context>');
    expect(prompt).toContain('syncId: sync-abc');
    expect(prompt).toContain('source: metabase');
    expect(prompt).not.toMatch(/rawDirInWorktree/i);
    expect(prompt).not.toContain('<canonical_pins>');
  });

  it('appends canonical pins before the WorkUnit context block', () => {
    const prompt = buildWuSystemPrompt({
      baseFraming: '<role>work unit</role>',
      skillsPrompt: '<skills>ingest_triage</skills>',
      syncId: 'sync-abc',
      sourceKey: 'metabase',
      canonicalPins: [
        {
          contestedKey: 'gross_revenue',
          canonicalArtifactKey: 'finance.gross_revenue',
          pinnedAt: '2026-04-27T12:00:00.000Z',
          pinnedBy: 'user-1',
          reason: 'finance owns revenue definitions',
        },
      ],
    });

    expect(prompt).toContain('<canonical_pins>');
    expect(prompt).toContain('contestedKey: gross_revenue');
    expect(prompt).toContain('canonicalArtifactKey: finance.gross_revenue');
    expect(prompt.indexOf('<canonical_pins>')).toBeLessThan(prompt.indexOf('<context>'));
  });
});
