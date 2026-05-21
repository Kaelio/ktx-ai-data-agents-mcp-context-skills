import { describe, expect, it, vi } from 'vitest';
import type { ToolSession } from '../../../context/tools/tool-session.js';
import { createTouchedSlSources, hasTouchedSlSource } from '../../../context/tools/touched-sl-sources.js';
import type { ToolContext } from '../../../context/tools/base-tool.js';
import { SlRollbackTool } from './sl-rollback.tool.js';

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
  return {
    connectionId: 'conn-1',
    isWorktreeScoped: true,
    preHead: 'base',
    touchedSlSources: createTouchedSlSources([{ connectionId: 'conn-1', sourceName: 'orders' }]),
    actions: [{ target: 'sl', type: 'updated', key: 'orders', detail: 'x' }],
    semanticLayerService: {} as any,
    wikiService: {} as any,
    configService: {
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
    } as any,
    gitService: { getFileAtCommit: vi.fn().mockResolvedValue('pre: content') } as any,
    ...overrides,
  };
}

describe('SlRollbackTool', () => {
  const connections = {
    getConnectionById: vi.fn(),
    listEnabledConnections: vi.fn(),
    executeQuery: vi.fn(),
  };

  it('errors when context.session is absent', async () => {
    const tool = new SlRollbackTool({} as never, connections as never, 1);
    const context: ToolContext = { sourceId: 's', messageId: 'm', userId: 'u' };
    const result = await tool.call({ sourceName: 'orders' } as any, context);
    expect(result.structured.success).toBe(false);
    expect(result.markdown).toMatch(/session/i);
  });

  it('errors when session has no connectionId (wiki-only turn)', async () => {
    const tool = new SlRollbackTool({} as never, connections as never, 1);
    const session = makeSession({ connectionId: null });
    const context: ToolContext = { sourceId: 's', messageId: 'm', userId: 'u', session };
    const result = await tool.call({ sourceName: 'orders' } as any, context);
    expect(result.structured.success).toBe(false);
    expect(result.markdown).toMatch(/connection-scoped session/i);
    // Session state untouched
    expect(hasTouchedSlSource(session.touchedSlSources, 'conn-1', 'orders')).toBe(true);
    expect((session.gitService as any).getFileAtCommit).not.toHaveBeenCalled();
  });

  it('restores the source content from preHead, clears touched set, prunes actions', async () => {
    const slSourcesRepository = { deleteByConnectionAndName: vi.fn().mockResolvedValue(undefined) };
    const tool = new SlRollbackTool(slSourcesRepository as never, connections as never, 1);
    const session = makeSession();
    const context: ToolContext = { sourceId: 's', messageId: 'm', userId: 'u', session };
    const result = await tool.call({ sourceName: 'orders' } as any, context);

    expect(result.structured.success).toBe(true);
    expect((session.gitService as any).getFileAtCommit).toHaveBeenCalledWith(
      expect.stringContaining('orders.yaml'),
      'base',
    );
    expect((session.configService as any).writeFile).toHaveBeenCalled();
    expect(hasTouchedSlSource(session.touchedSlSources, 'conn-1', 'orders')).toBe(false);
    expect(session.actions).toEqual([]);
  });
});
