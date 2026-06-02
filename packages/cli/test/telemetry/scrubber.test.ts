import { describe, expect, it } from 'vitest';

import { formatErrorDetail, scrubErrorClass } from '../../src/telemetry/scrubber.js';

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

describe('formatErrorDetail', () => {
  it('prefixes a string or numeric .code onto the message', () => {
    const refused = new Error('connect failed');
    (refused as { code?: unknown }).code = 'ECONNREFUSED';
    expect(formatErrorDetail(refused)).toBe('ECONNREFUSED: connect failed');

    const forbidden = new Error('forbidden');
    (forbidden as { code?: unknown }).code = 403;
    expect(formatErrorDetail(forbidden)).toBe('403: forbidden');
  });

  it('uses the bare message when there is no .code', () => {
    expect(formatErrorDetail(new Error('password authentication failed for user "x"'))).toBe(
      'password authentication failed for user "x"',
    );
  });

  it('accepts non-Error values', () => {
    expect(formatErrorDetail('boom')).toBe('boom');
  });

  it('collapses whitespace to a single line', () => {
    expect(formatErrorDetail(new Error('line one\n   line two'))).toBe('line one line two');
  });

  it('caps the length at 1000 characters', () => {
    expect(formatErrorDetail(new Error('x'.repeat(2000)))?.length).toBe(1000);
  });

  it('returns undefined for empty, null, or undefined input', () => {
    expect(formatErrorDetail(new Error('   '))).toBeUndefined();
    expect(formatErrorDetail(null)).toBeUndefined();
    expect(formatErrorDetail(undefined)).toBeUndefined();
  });
});
