import { describe, expect, it } from 'vitest';
import { buildCodexRuntimeConfig } from '../../../src/context/llm/codex-runtime-config.js';

describe('buildCodexRuntimeConfig', () => {
  it('builds deny-by-default config without MCP tools', () => {
    expect(buildCodexRuntimeConfig({ model: 'gpt-5.3-codex' })).toEqual({
      configOverrides: {
        model: 'gpt-5.3-codex',
        approval_policy: 'never',
        sandbox_mode: 'read-only',
        web_search: 'disabled',
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
        model: 'gpt-5.3-codex',
        approval_policy: 'never',
        sandbox_mode: 'read-only',
        web_search: 'disabled',
        history: { persistence: 'none' },
        mcp_servers: {
          ktx: {
            url: 'http://127.0.0.1:4567/mcp',
            bearer_token_env_var: 'KTX_CODEX_RUNTIME_MCP_TOKEN',
            enabled_tools: ['sl_read_source', 'wiki_search'],
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
