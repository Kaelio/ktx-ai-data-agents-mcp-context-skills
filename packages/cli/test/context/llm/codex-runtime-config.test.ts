import { describe, expect, it } from 'vitest';
import { buildCodexRuntimeConfig } from '../../../src/context/llm/codex-runtime-config.js';

describe('buildCodexRuntimeConfig', () => {
  it('builds generic config without SDK thread-option fields', () => {
    expect(buildCodexRuntimeConfig({ model: 'gpt-5.3-codex' })).toEqual({
      configOverrides: {
        history: { persistence: 'none' },
      },
      env: {},
    });
  });

  it('adds only the temporary ktx MCP server and exact enabled tools', () => {
    expect(
      buildCodexRuntimeConfig({
        model: 'gpt-5.3-codex',
        mcp: {
          url: 'http://127.0.0.1:4567/mcp',
          bearerTokenEnvVar: 'KTX_CODEX_RUNTIME_MCP_TOKEN',
          bearerToken: 'secret-token',
          toolNames: ['sl_read_source', 'wiki_search'],
        },
      }),
    ).toEqual({
      configOverrides: {
        history: { persistence: 'none' },
        mcp_servers: {
          ktx: {
            url: 'http://127.0.0.1:4567/mcp',
            bearer_token_env_var: 'KTX_CODEX_RUNTIME_MCP_TOKEN',
            enabled_tools: ['sl_read_source', 'wiki_search'],
            default_tools_approval_mode: 'approve',
            required: true,
          },
        },
      },
      env: {
        KTX_CODEX_RUNTIME_MCP_TOKEN: 'secret-token',
      },
    });
  });
});
