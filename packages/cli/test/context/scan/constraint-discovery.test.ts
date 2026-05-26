import { describe, expect, it } from 'vitest';
import { constraintDiscoveryWarning, tryConstraintQuery } from '../../../src/context/scan/constraint-discovery.js';

describe('tryConstraintQuery', () => {
  it('returns the query value when the query succeeds', async () => {
    await expect(
      tryConstraintQuery(
        {
          schema: 'public',
          kind: 'primary_key',
          isDeniedError: () => false,
        },
        async () => ['id'],
      ),
    ).resolves.toEqual({ ok: true, value: ['id'] });
  });

  it('returns a recoverable warning when the classifier recognizes denial', async () => {
    const error = Object.assign(new Error('permission denied'), { code: '42501' });

    await expect(
      tryConstraintQuery(
        {
          schema: 'analytics',
          kind: 'foreign_key',
          isDeniedError: (candidate) => candidate === error,
        },
        async () => {
          throw error;
        },
      ),
    ).resolves.toEqual({
      ok: false,
      warning: {
        code: 'constraint_discovery_unauthorized',
        message: 'Skipped foreign-key discovery in analytics (insufficient grants on system catalogs)',
        recoverable: true,
        metadata: { schema: 'analytics', kind: 'foreign_key' },
      },
    });
  });

  it('rethrows non-denial errors unchanged', async () => {
    const error = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });

    await expect(
      tryConstraintQuery(
        {
          schema: 'public',
          kind: 'primary_key',
          isDeniedError: () => false,
        },
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
  });
});

describe('constraintDiscoveryWarning', () => {
  it('formats stable primary-key warning text and metadata', () => {
    expect(constraintDiscoveryWarning({ schema: 'public', kind: 'primary_key' })).toEqual({
      code: 'constraint_discovery_unauthorized',
      message: 'Skipped primary-key discovery in public (insufficient grants on system catalogs)',
      recoverable: true,
      metadata: { schema: 'public', kind: 'primary_key' },
    });
  });
});
