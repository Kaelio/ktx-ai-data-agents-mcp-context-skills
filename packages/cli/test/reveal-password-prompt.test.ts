import { describe, expect, it } from 'vitest';
import { maskRevealingTail } from '../src/reveal-password-prompt.js';

const MASK = '▪';

describe('maskRevealingTail', () => {
  it('reveals the last `tail` characters of a long value', () => {
    const value = 'example-token-value-abcd';
    const masked = maskRevealingTail(value, MASK, 4);
    expect(masked).toBe(`${MASK.repeat(value.length - 4)}abcd`);
    expect(masked.endsWith('abcd')).toBe(true);
  });

  it('keeps the same length as the input so cursor slicing stays aligned', () => {
    for (const secret of ['', 'a', 'abcdefgh', 'abcdefghijklmnop']) {
      expect(maskRevealingTail(secret, MASK, 4)).toHaveLength(secret.length);
    }
  });

  it('fully masks secrets that are not longer than tail * 2', () => {
    expect(maskRevealingTail('abcdefgh', MASK, 4)).toBe(MASK.repeat(8));
    expect(maskRevealingTail('abcd', MASK, 4)).toBe(MASK.repeat(4));
    expect(maskRevealingTail('ab', MASK, 4)).toBe(MASK.repeat(2));
  });

  it('reveals the tail once the secret crosses the tail * 2 boundary', () => {
    // length 9 > 8 → reveal last 4, hide the first 5
    expect(maskRevealingTail('abcdefghi', MASK, 4)).toBe(`${MASK.repeat(5)}fghi`);
  });

  it('fully masks an empty value', () => {
    expect(maskRevealingTail('', MASK, 4)).toBe('');
  });

  it('honors a custom tail count', () => {
    // tail 2 reveals only when length > 4
    expect(maskRevealingTail('abcde', MASK, 2)).toBe(`${MASK.repeat(3)}de`);
    expect(maskRevealingTail('abcd', MASK, 2)).toBe(MASK.repeat(4));
  });
});
