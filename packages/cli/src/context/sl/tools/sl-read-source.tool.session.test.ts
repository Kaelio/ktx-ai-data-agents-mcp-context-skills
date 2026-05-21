import { describe, expect, it, vi } from 'vitest';
import type { ToolSession } from '../../../context/tools/tool-session.js';
import { createTouchedSlSources } from '../../../context/tools/touched-sl-sources.js';
import type { ToolContext } from '../../../context/tools/base-tool.js';
import { SlReadSourceTool } from './sl-read-source.tool.js';

function makeTool(overrides: Partial<Record<string, any>> = {}) {
  const semanticLayerService = {
    readSourceFile: vi.fn().mockResolvedValue({ content: 'name: foo_default\n', path: 'default' }),
    ...overrides.semanticLayerService,
  };

  const tool = new SlReadSourceTool({
    semanticLayerService: semanticLayerService as never,
    slSearchService: {} as never,
    authorResolver: { resolve: vi.fn() },
  });
  return { tool, semanticLayerService };
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sourceId: 'src',
    messageId: 'msg',
    userId: 'user',
    ...overrides,
  };
}

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
  return {
    connectionId: '11111111-1111-1111-1111-111111111111',
    isWorktreeScoped: true,
    preHead: 'base',
    touchedSlSources: createTouchedSlSources(),
    actions: [],
    semanticLayerService: {
      readSourceFile: vi.fn().mockResolvedValue({ content: 'name: foo_session\n', path: 'session' }),
    } as any,
    wikiService: {} as any,
    configService: {} as any,
    gitService: {} as any,
    ...overrides,
  };
}

describe('SlReadSourceTool - session-scoped reads', () => {
  it('reads through context.session.semanticLayerService when a session is present', async () => {
    const { tool, semanticLayerService } = makeTool();
    const session = makeSession();

    const result = await tool.call(
      { connectionId: '11111111-1111-1111-1111-111111111111', sourceName: 'foo' },
      makeContext({ session }),
    );

    expect((session.semanticLayerService as any).readSourceFile).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      'foo',
    );
    expect(semanticLayerService.readSourceFile).not.toHaveBeenCalled();
    expect(result.structured.yaml).toContain('foo_session');
  });

  it('reads through the default service when no session is present', async () => {
    const { tool, semanticLayerService } = makeTool();

    const result = await tool.call(
      { connectionId: '11111111-1111-1111-1111-111111111111', sourceName: 'foo' },
      makeContext(),
    );

    expect(semanticLayerService.readSourceFile).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', 'foo');
    expect(result.structured.yaml).toContain('foo_default');
  });
});
