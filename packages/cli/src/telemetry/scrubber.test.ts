import { describe, expect, it } from 'vitest';

import { scrubErrorClass } from './scrubber.js';

class KtxProjectMissingAbortError extends Error {}

describe('scrubErrorClass', () => {
  it('keeps normal JavaScript class names', () => {
    expect(scrubErrorClass(new KtxProjectMissingAbortError('missing'))).toBe('KtxProjectMissingAbortError');
  });

  it('drops path-like, URL-like, email-like, and long values', () => {
    expect(scrubErrorClass({ constructor: { name: '/Users/alice/project' } })).toBeUndefined();
    expect(scrubErrorClass({ constructor: { name: 'https://example.test/error' } })).toBeUndefined();
    expect(scrubErrorClass({ constructor: { name: 'alice@example.test' } })).toBeUndefined();
    expect(scrubErrorClass({ constructor: { name: 'A'.repeat(81) } })).toBeUndefined();
  });

  it('drops lowercase, spaced, and non-error-like values', () => {
    expect(scrubErrorClass({ constructor: { name: 'lowercaseError' } })).toBeUndefined();
    expect(scrubErrorClass({ constructor: { name: 'Bad Error' } })).toBeUndefined();
    expect(scrubErrorClass('plain string')).toBeUndefined();
    expect(scrubErrorClass(null)).toBeUndefined();
  });
});
