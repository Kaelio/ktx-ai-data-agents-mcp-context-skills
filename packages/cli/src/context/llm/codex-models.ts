const DEFAULT_CODEX_MODEL = 'gpt-5.3-codex';

const CODEX_MODEL_ALIASES: Record<string, string> = {
  codex: DEFAULT_CODEX_MODEL,
  default: DEFAULT_CODEX_MODEL,
};

const EXPLICIT_CODEX_MODEL_ID = /^(?:gpt|codex)-[a-z0-9][a-z0-9._-]*$/i;

export function resolveCodexModel(model: string): string {
  const normalized = model.trim();
  const alias = CODEX_MODEL_ALIASES[normalized];
  if (alias) {
    return alias;
  }
  if (EXPLICIT_CODEX_MODEL_ID.test(normalized)) {
    return normalized;
  }
  throw new Error(`Unsupported Codex model "${model}". Use codex, default, or a gpt-* / codex-* model id.`);
}
