const CLAUDE_CODE_MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
  haiku: 'claude-haiku-4-5',
};

const FULL_MODEL_ID = /^claude-(sonnet|opus|haiku)-[0-9]+-[0-9]+$/;

export function resolveClaudeCodeModel(model: string): string {
  const normalized = model.trim();
  const alias = CLAUDE_CODE_MODEL_ALIASES[normalized];
  if (alias) {
    return alias;
  }
  if (FULL_MODEL_ID.test(normalized)) {
    return normalized;
  }
  throw new Error(`Unsupported Claude Code model "${model}". Use sonnet, opus, haiku, or a claude-* model id.`);
}
