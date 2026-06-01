interface CodexRuntimeMcpConfig {
  url: string;
  bearerTokenEnvVar: string;
  bearerToken: string;
  toolNames: string[];
}

export interface BuildCodexRuntimeConfigInput {
  model: string;
  mcp?: CodexRuntimeMcpConfig;
}

export interface CodexRuntimeConfig {
  configOverrides: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
}

export function buildCodexRuntimeConfig(input: BuildCodexRuntimeConfigInput): CodexRuntimeConfig {
  const configOverrides: Record<string, unknown> = {
    model: input.model,
    approval_policy: 'never',
    sandbox_mode: 'read-only',
    web_search: 'disabled',
    history: { persistence: 'none' },
  };
  const env: NodeJS.ProcessEnv = {};

  if (input.mcp) {
    configOverrides.mcp_servers = {
      ktx: {
        url: input.mcp.url,
        bearer_token_env_var: input.mcp.bearerTokenEnvVar,
        enabled_tools: input.mcp.toolNames,
        required: true,
      },
    };
    env[input.mcp.bearerTokenEnvVar] = input.mcp.bearerToken;
  }

  return { configOverrides, env };
}
