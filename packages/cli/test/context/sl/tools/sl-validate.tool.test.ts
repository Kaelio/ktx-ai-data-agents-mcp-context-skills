import { describe, expect, it, vi } from 'vitest';
import type { ToolSession } from '../../../../src/context/tools/tool-session.js';
import { createTouchedSlSources } from '../../../../src/context/tools/touched-sl-sources.js';
import type { ToolContext } from '../../../../src/context/tools/base-tool.js';
import type { SemanticLayerService } from '../../../../src/context/sl/semantic-layer.service.js';
import type { SemanticLayerSource } from '../../../../src/context/sl/types.js';
import { SlValidateTool, validateSemanticLayerEndpoint } from '../../../../src/context/sl/tools/sl-validate.tool.js';

describe('validateSemanticLayerEndpoint', () => {
  it('uses the connection warehouse dialect, not hardcoded postgres', async () => {
    const serviceMock = {
      validateSourcesForConnection: vi.fn().mockResolvedValue({ errors: [], warnings: [] }),
    };

    await validateSemanticLayerEndpoint('conn-1', serviceMock as unknown as SemanticLayerService);

    expect(serviceMock.validateSourcesForConnection).toHaveBeenCalledWith('conn-1');
  });

  it('short-circuits when there are no validatable sources', async () => {
    const serviceMock = {
      validateSourcesForConnection: vi.fn().mockResolvedValue({ errors: [], warnings: [] }),
    };

    const result = await validateSemanticLayerEndpoint('conn-1', serviceMock as unknown as SemanticLayerService);

    expect(result).toEqual({ errors: [], warnings: [] });
  });
});

describe('SlValidateTool — session-aware touched-set filtering', () => {
  it('when session present, only returns errors/warnings that mention touched sources', async () => {
    const sources: SemanticLayerSource[] = [
      { name: 'orders', table: 'x.orders', grain: ['id'], columns: [], joins: [], measures: [] },
      { name: 'customers', table: 'x.customers', grain: ['id'], columns: [], joins: [], measures: [] },
    ];
    const serviceMock = {
      loadAllSources: vi.fn().mockResolvedValue({ sources, loadErrors: [] }),
      validateSourcesForConnection: vi.fn().mockResolvedValue({
        errors: ['orders: missing join target', 'customers: invalid grain'],
        warnings: ['orders: disconnected-components warning'],
      }),
    };

    const tool = new SlValidateTool({
      semanticLayerService: serviceMock as never,
      slSearchService: {} as never,
      authorResolver: { resolve: vi.fn() },
    });

    const session: ToolSession = {
      connectionId: 'conn-1',
      isWorktreeScoped: true,
      preHead: null,
      touchedSlSources: createTouchedSlSources([{ connectionId: 'conn-1', sourceName: 'orders' }]),
      actions: [],
      semanticLayerService: serviceMock as any,
      wikiService: {} as any,
      configService: {} as any,
      gitService: {} as any,
    };
    const context: ToolContext = { sourceId: 's', messageId: 'm', userId: 'u', session };
    const result = await tool.call({ connectionId: 'conn-1' } as any, context);
    expect(result.structured.validationErrors).toEqual(['orders: missing join target']);
    expect(result.structured.validationWarnings).toEqual(['orders: disconnected-components warning']);
  });
});
