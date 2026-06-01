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
  env: Record<string, string>;
}

export function buildCodexRuntimeConfig(input: BuildCodexRuntimeConfigInput): CodexRuntimeConfig {
  const configOverrides: Record<string, unknown> = {
    history: { persistence: 'none' },
  };
  const env: Record<string, string> = {};

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
