import { describe, expect, it } from 'vitest';
import {
  CODEX_ISOLATION_WARNING,
  CODEX_ISOLATION_WARNING_FIX,
  formatCodexIsolationWarning,
} from '../../../src/context/llm/codex-isolation.js';

describe('Codex isolation warning', () => {
  it('documents the enforced and unenforced Codex isolation boundaries', () => {
    expect(CODEX_ISOLATION_WARNING).toContain('runtime MCP server to the current ktx tool set');
    expect(CODEX_ISOLATION_WARNING).toContain('disables Codex web search');
    expect(CODEX_ISOLATION_WARNING).toContain('may still load user Codex config');
    expect(CODEX_ISOLATION_WARNING).toContain('built-in command execution');
    expect(CODEX_ISOLATION_WARNING_FIX).toContain('claude-code');
    expect(formatCodexIsolationWarning()).toBe(
      `${CODEX_ISOLATION_WARNING} ${CODEX_ISOLATION_WARNING_FIX}`,
    );
  });
});
