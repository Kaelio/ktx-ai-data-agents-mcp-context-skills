import { describe, expect, it, vi } from 'vitest';
import type { ToolSession } from '../../../../src/context/tools/tool-session.js';
import { createTouchedSlSources, hasTouchedSlSource } from '../../../../src/context/tools/touched-sl-sources.js';
import type { ToolContext } from '../../../../src/context/tools/base-tool.js';
import { SlEditSourceTool } from '../../../../src/context/sl/tools/sl-edit-source.tool.js';

function makeTool(overrides: any = {}) {
  const semanticLayerService = {
    readSourceFile: vi.fn().mockResolvedValue({
      content:
        'name: orders\ntable: public.orders\ngrain: [id]\ncolumns:\n  - name: id\n    type: string\nmeasures: []\njoins: []\n',
    }),
    validateWithProposedSource: vi.fn().mockResolvedValue({ errors: [], warnings: [] }),
    writeSource: vi.fn().mockResolvedValue({ commitHash: 'c1' }),
    loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
    deleteSource: vi.fn().mockResolvedValue(undefined),
    isManifestBacked: vi.fn().mockResolvedValue(false),
    ...overrides.semanticLayerService,
  };
  const slSearchService = {
    indexSources: vi.fn().mockResolvedValue(undefined),
    ...overrides.slSearchService,
  };
  const tool = new SlEditSourceTool({
    semanticLayerService: semanticLayerService as never,
    slSearchService: slSearchService as never,
    authorResolver: { resolve: vi.fn().mockResolvedValue({ name: 'T U', email: 't@u.com' }) },
  });
  return { tool, semanticLayerService, slSearchService };
}

const baseContext: ToolContext = { sourceId: 's', messageId: 'm', userId: 'u' };

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
  return {
    connectionId: '11111111-1111-1111-1111-111111111111',
    isWorktreeScoped: true,
    preHead: 'base',
    touchedSlSources: createTouchedSlSources(),
    actions: [],
    semanticLayerService: {
      readSourceFile: vi.fn().mockResolvedValue({
        content:
          'name: orders\ntable: public.orders\ngrain: [id]\ncolumns:\n  - name: id\n    type: string\nmeasures: []\njoins: []\n',
      }),
      validateWithProposedSource: vi.fn().mockResolvedValue({ errors: [], warnings: [] }),
      writeSource: vi.fn().mockResolvedValue({ commitHash: 'c1' }),
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
    } as any,
    wikiService: {} as any,
    configService: {} as any,
    gitService: {} as any,
    ...overrides,
  };
}

describe('SlEditSourceTool — session gating', () => {
  it('skips slSearchService.indexSources when session is worktree-scoped', async () => {
    const { tool, slSearchService } = makeTool();
    const session = makeSession();
    const context: ToolContext = { ...baseContext, session };
    const result = await tool.call(
      {
        connectionId: session.connectionId,
        sourceName: 'orders',
        yaml_edits: [{ oldText: 'measures: []', newText: 'measures: []' }],
      } as any,
      context,
    );
    expect(result.structured.success).toBe(true);
    expect(slSearchService.indexSources).not.toHaveBeenCalled();
    expect(hasTouchedSlSource(session.touchedSlSources, session.connectionId!, 'orders')).toBe(true);
    expect(session.actions).toContainEqual(expect.objectContaining({ target: 'sl', key: 'orders' }));
  });

  it('records cross-connection SL edits with targetConnectionId', async () => {
    const { tool } = makeTool();
    const session = makeSession({ connectionId: '11111111-1111-4111-8111-111111111111' });
    const warehouseConnectionId = '22222222-2222-4222-8222-222222222222';
    const context: ToolContext = { ...baseContext, session };

    const result = await tool.call(
      {
        connectionId: warehouseConnectionId,
        sourceName: 'orders',
        yaml_edits: [{ oldText: 'measures: []', newText: 'measures: []' }],
      } as any,
      context,
    );

    expect(result.structured.success).toBe(true);
    expect(hasTouchedSlSource(session.touchedSlSources, warehouseConnectionId, 'orders')).toBe(true);
    expect(session.actions).toContainEqual(
      expect.objectContaining({
        target: 'sl',
        type: 'updated',
        key: 'orders',
        targetConnectionId: warehouseConnectionId,
      }),
    );
  });

  it('rejects session-scoped edits outside allowed target connections', async () => {
    const { tool } = makeTool();
    const session = makeSession({
      allowedConnectionNames: new Set(['warehouse']),
    });
    const context: ToolContext = { ...baseContext, session };

    const result = await tool.call(
      {
        connectionId: 'finance',
        sourceName: 'orders',
        yaml_edits: [{ oldText: 'measures: []', newText: 'measures: []' }],
      } as any,
      context,
    );

    expect(result.structured.success).toBe(false);
    expect(result.markdown).toContain('connectionId "finance" is outside this ingest session');
    expect(session.actions).toEqual([]);
  });

  it('indexes normally when no session is present', async () => {
    const { tool, slSearchService } = makeTool();
    const result = await tool.call(
      {
        connectionId: '11111111-1111-1111-1111-111111111111',
        sourceName: 'orders',
        yaml_edits: [{ oldText: 'measures: []', newText: 'measures: []' }],
      } as any,
      baseContext,
    );
    expect(result.structured.success).toBe(true);
    expect(slSearchService.indexSources).toHaveBeenCalledTimes(1);
  });

  it('uses session.semanticLayerService when session is present', async () => {
    const { tool } = makeTool();
    const session = makeSession();
    const context: ToolContext = { ...baseContext, session };
    await tool.call(
      {
        connectionId: session.connectionId,
        sourceName: 'orders',
        yaml_edits: [{ oldText: 'measures: []', newText: 'measures: []' }],
      } as any,
      context,
    );
    expect((session.semanticLayerService as any).writeSource).toHaveBeenCalled();
  });

  it('fills missing descriptions when an ingest session edits a source', async () => {
    const { tool } = makeTool();
    const session = makeSession({
      ingest: { runId: 'run-1', jobId: 'job-1', syncId: 'sync-1', sourceKey: 'dbt' },
    });
    const context: ToolContext = { ...baseContext, session };

    const result = await tool.call(
      {
        connectionId: session.connectionId,
        sourceName: 'orders',
        yaml_edits: [{ oldText: 'measures: []', newText: 'measures: []' }],
      } as any,
      context,
    );

    expect(result.structured.success).toBe(true);
    expect((session.semanticLayerService as any).writeSource).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        descriptions: { ktx: expect.stringContaining('orders') },
        columns: [
          expect.objectContaining({
            descriptions: { ktx: expect.stringContaining('Identifier') },
          }),
        ],
      }),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });
});

describe('SlEditSourceTool — manifest-backed source without overlay', () => {
  it('returns a directed hint pointing at sl_write_source + overlay shape', async () => {
    const { tool, semanticLayerService } = makeTool({
      semanticLayerService: {
        readSourceFile: vi.fn().mockResolvedValue(null),
        isManifestBacked: vi.fn().mockResolvedValue(true),
      },
    });
    const result = await tool.call(
      {
        connectionId: '11111111-1111-1111-1111-111111111111',
        sourceName: 'CONSIGNMENTS',
        yaml_edits: [{ oldText: 'measures: []', newText: 'measures:\n  - name: aav_count\n    expr: count(*)' }],
      } as any,
      baseContext,
    );

    expect(result.structured.success).toBe(false);
    expect(semanticLayerService.isManifestBacked).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      'CONSIGNMENTS',
    );
    expect(semanticLayerService.writeSource).not.toHaveBeenCalled();

    const joinedErrors = (result.structured.errors ?? []).join('\n');
    expect(joinedErrors).toContain('CONSIGNMENTS');
    expect(joinedErrors).toContain('manifest');
    expect(joinedErrors).toContain('sl_write_source');
    expect(joinedErrors).toContain('overlay');
    // Overlay shape: name plus overlay-only fields.
    expect(joinedErrors).toContain('measures');
    expect(joinedErrors).toContain('segments');
    expect(joinedErrors).toContain('column_overrides');
  });

  it('still returns the plain "Source not found" error for truly-missing names', async () => {
    const { tool, semanticLayerService } = makeTool({
      semanticLayerService: {
        readSourceFile: vi.fn().mockResolvedValue(null),
        isManifestBacked: vi.fn().mockResolvedValue(false),
      },
    });
    const result = await tool.call(
      {
        connectionId: '11111111-1111-1111-1111-111111111111',
        sourceName: 'does_not_exist',
        yaml_edits: [{ oldText: 'x', newText: 'y' }],
      } as any,
      baseContext,
    );

    expect(result.structured.success).toBe(false);
    expect(result.structured.errors).toEqual(['Source not found. Use sl_write_source to create it.']);
    expect(semanticLayerService.isManifestBacked).toHaveBeenCalledTimes(1);
    expect(semanticLayerService.writeSource).not.toHaveBeenCalled();
  });
});

describe('SlEditSourceTool — name edits', () => {
  it('rejects edits that change the in-file name', async () => {
    const { tool, semanticLayerService } = makeTool();
    const result = await tool.call(
      {
        connectionId: '11111111-1111-1111-1111-111111111111',
        sourceName: 'orders',
        yaml_edits: [{ oldText: 'name: orders', newText: 'name: renamed_orders' }],
      } as any,
      baseContext,
    );
    expect(result.structured.success).toBe(false);
    expect(result.markdown).toMatch(/renaming is not supported/i);
    expect(semanticLayerService.writeSource).not.toHaveBeenCalled();
  });
});
