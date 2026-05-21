import { describe, expect, it } from 'vitest';
import { normalizeDbtPath } from './parse.js';

describe('normalizeDbtPath', () => {
  it('normalizes Windows separators to POSIX separators', () => {
    expect(normalizeDbtPath('models\\marts\\orders.yml')).toBe('models/marts/orders.yml');
  });
});
