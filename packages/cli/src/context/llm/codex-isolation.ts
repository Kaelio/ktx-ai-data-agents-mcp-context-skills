export const CODEX_ISOLATION_WARNING =
  'Codex backend isolation is limited by the public Codex SDK/CLI surface: ktx restricts the runtime MCP server to the current ktx tool set, disables Codex web search, asks for a read-only sandbox, and sets approval_policy=never, but Codex may still load user Codex config and built-in command execution or read-only file capabilities.';

export const CODEX_ISOLATION_WARNING_FIX =
  'Use llm.provider.backend: claude-code when you need stricter Claude-Code-style runtime tool isolation, or remove host Codex MCP/tool config before running untrusted prompts through the codex backend.';

export function formatCodexIsolationWarning(): string {
  return `${CODEX_ISOLATION_WARNING} ${CODEX_ISOLATION_WARNING_FIX}`;
}
