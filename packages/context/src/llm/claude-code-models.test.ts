import { describe, expect, it } from 'vitest';
import { resolveClaudeCodeModel } from './claude-code-models.js';

describe('resolveClaudeCodeModel', () => {
  it.each([
    ['sonnet', 'claude-sonnet-4-6'],
    ['opus', 'claude-opus-4-7'],
    ['haiku', 'claude-haiku-4-5'],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
  ])('maps %s to %s', (input, expected) => {
    expect(resolveClaudeCodeModel(input)).toBe(expected);
  });

  it('rejects unsupported aliases', () => {
    expect(() => resolveClaudeCodeModel('gpt-5')).toThrow('Unsupported Claude Code model');
  });
});
