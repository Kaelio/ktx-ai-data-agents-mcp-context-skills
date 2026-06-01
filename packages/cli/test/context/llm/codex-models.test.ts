import { describe, expect, it } from 'vitest';
import { resolveCodexModel } from '../../../src/context/llm/codex-models.js';

describe('resolveCodexModel', () => {
  it.each([
    ['codex', 'gpt-5.3-codex'],
    ['default', 'gpt-5.3-codex'],
    ['gpt-5.3-codex', 'gpt-5.3-codex'],
    ['gpt-5.4', 'gpt-5.4'],
  ])('maps %s to %s', (input, expected) => {
    expect(resolveCodexModel(input)).toBe(expected);
  });

  it.each(['', '   ', 'sonnet', 'claude-sonnet-4-6'])('rejects %s', (input) => {
    expect(() => resolveCodexModel(input)).toThrow('Unsupported Codex model');
  });
});
