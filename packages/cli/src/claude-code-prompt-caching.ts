import type { KtxProjectLlmConfig } from '@ktx/context/project';

const CLAUDE_CODE_IGNORED_PROMPT_CACHING_FIELDS = [
  'systemTtl',
  'toolsTtl',
  'historyTtl',
  'vertexFallbackTo5m',
] as const;

export function ignoredClaudeCodePromptCachingFields(config: KtxProjectLlmConfig): string[] {
  if (config.provider.backend !== 'claude-code' || !config.promptCaching) {
    return [];
  }
  return CLAUDE_CODE_IGNORED_PROMPT_CACHING_FIELDS.filter((key) => key in config.promptCaching).map(
    (key) => `llm.promptCaching.${key}`,
  );
}

export function formatClaudeCodePromptCachingWarning(fields: string[]): string | null {
  if (fields.length === 0) {
    return null;
  }
  return `claude-code ignores ${fields.join(', ')} because the Claude Agent SDK does not expose KTX prompt-cache TTL, tool, or history markers.`;
}

export function formatClaudeCodePromptCachingFix(): string {
  return 'Remove those promptCaching fields or use anthropic, vertex, or gateway when those cache knobs are required.';
}
