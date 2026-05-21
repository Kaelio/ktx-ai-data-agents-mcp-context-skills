/** @internal */
export const CLAUDE_CODE_PROVIDER_ENV_DENYLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_PROFILE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

const DENYLIST = new Set<string>(CLAUDE_CODE_PROVIDER_ENV_DENYLIST);

export function createKtxClaudeCodeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !DENYLIST.has(key)));
}
