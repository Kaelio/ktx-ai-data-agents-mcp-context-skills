import { describe, expect, it, vi } from 'vitest';
import type { ToolSession } from '../../../../src/context/tools/tool-session.js';
import { createTouchedSlSources, hasTouchedSlSource } from '../../../../src/context/tools/touched-sl-sources.js';
import type { ToolContext } from '../../../../src/context/tools/base-tool.js';
import { SlRollbackTool } from '../../../../src/context/sl/tools/sl-rollback.tool.js';

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
      // No live file for `orders` — revert recovers the preHead path from history.
      listFiles: vi.fn().mockResolvedValue({ files: [] }),
      readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    } as any,
    gitService: {
      // The source lived at its derived filename at preHead.
      listFilesAtCommit: vi.fn().mockResolvedValue(['semantic-layer/conn-1/orders.yaml']),
      getFileAtCommit: vi.fn().mockResolvedValue('name: orders\nmeasures: []\n'),
    } as any,
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

  it('restores a deleted human-renamed source at the path it occupied at preHead', async () => {
    // The source lived at a custom filename (≠ the writer-derived `orders.yaml`)
    // and the session deleted it. Revert must recover the custom path from the
    // preHead commit and restore there, not write/no-op against the derived path.
    const slSourcesRepository = { deleteByConnectionAndName: vi.fn().mockResolvedValue(undefined) };
    const tool = new SlRollbackTool(slSourcesRepository as never, connections as never, 1);
    const renamedContent = 'name: orders\ntable: public.orders\nmeasures: []\n';
    const session = makeSession({
      gitService: {
        listFilesAtCommit: vi.fn().mockResolvedValue(['semantic-layer/conn-1/custom.yaml']),
        getFileAtCommit: vi.fn().mockResolvedValue(renamedContent),
      } as any,
    });
    const context: ToolContext = { sourceId: 's', messageId: 'm', userId: 'u', session };

    const result = await tool.call({ sourceName: 'orders' } as any, context);

    expect(result.structured.success).toBe(true);
    expect((session.configService as any).writeFile).toHaveBeenCalledWith(
      'semantic-layer/conn-1/custom.yaml',
      renamedContent,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect((session.configService as any).deleteFile).not.toHaveBeenCalled();
  });
});
