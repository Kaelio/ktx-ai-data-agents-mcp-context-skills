import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createCodexRuntimeMcpServer,
  startCodexRuntimeMcpServer,
} from '../../../src/context/llm/codex-mcp-runtime-server.js';

describe('Codex runtime MCP server', () => {
  it('registers runtime tools with markdown output', async () => {
    const registered = new Map<
      string,
      {
        config: { description?: string; inputSchema: unknown };
        handler: (input: Record<string, unknown>) => Promise<unknown>;
      }
    >();
    const server = createCodexRuntimeMcpServer({
      server: {
        registerTool(name, config, handler) {
          registered.set(name, { config, handler });
        },
      },
      toolSet: {
        wiki_search: {
          name: 'wiki_search',
          description: 'Search the wiki',
          inputSchema: z.object({ query: z.string() }),
          execute: vi.fn(async () => ({ markdown: 'result markdown', structured: { matches: 1 } })),
        },
      },
    });

    expect(server).toBeDefined();
    expect([...registered.keys()]).toEqual(['wiki_search']);
    expect(registered.get('wiki_search')?.config).toMatchObject({
      description: 'Search the wiki',
    });
    await expect(registered.get('wiki_search')?.handler({ query: 'revenue' })).resolves.toEqual({
      content: [{ type: 'text', text: 'result markdown' }],
      structuredContent: { matches: 1 },
    });
  });

  it('starts loopback HTTP MCP with a bearer token and reports the runtime URL', async () => {
    const close = vi.fn(async () => undefined);
    const runServer = vi.fn(async () => ({
      server: { address: () => ({ port: 4321 }) },
      close,
    }));

    const handle = await startCodexRuntimeMcpServer({
      projectDir: '/tmp/ktx-project',
      toolSet: {},
      runServer: runServer as never,
    });

    expect(handle.url).toBe('http://127.0.0.1:4321/mcp');
    expect(handle.bearerTokenEnvVar).toBe('KTX_CODEX_RUNTIME_MCP_TOKEN');
    expect(handle.bearerToken).toMatch(/^[a-f0-9]{64}$/);
    expect(runServer).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: '/tmp/ktx-project',
        host: '127.0.0.1',
        port: 0,
        token: handle.bearerToken,
        allowedHosts: ['127.0.0.1', 'localhost'],
        allowedOrigins: [],
      }),
    );
    await handle.close();
    expect(close).toHaveBeenCalled();
  });
});
