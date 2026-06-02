import { describe, expect, it } from 'vitest';

import { beginCommandSpan, completeCommandSpan, resetCommandSpan } from '../../src/telemetry/command-hook.js';

describe('telemetry command hook', () => {
  it('builds a completed command event from a span', () => {
    resetCommandSpan();
    beginCommandSpan({
      commandPath: ['ktx', 'status'],
      flagsPresent: { projectDir: true, json: true },
      projectDir: '/tmp/private',
      hasProject: true,
      attachProjectGroup: true,
      startedAt: 100,
    });

    expect(
      completeCommandSpan({
        completedAt: 125,
        outcome: 'ok',
      }),
    ).toEqual({
      commandPath: ['ktx', 'status'],
      durationMs: 25,
      outcome: 'ok',
      flagsPresent: { projectDir: true, json: true },
      hasProject: true,
      projectDir: '/tmp/private',
      projectGroupAttached: true,
    });
  });

  it('returns undefined when no preAction span exists', () => {
    resetCommandSpan();
    expect(completeCommandSpan({ completedAt: 200, outcome: 'ok' })).toBeUndefined();
  });

  it('captures errorClass and raw errorDetail on a failed command', () => {
    resetCommandSpan();
    beginCommandSpan({
      commandPath: ['ktx', 'ingest'],
      flagsPresent: {},
      hasProject: true,
      attachProjectGroup: false,
      startedAt: 0,
    });

    class KtxConnectionError extends Error {}
    const error = new KtxConnectionError('connect ECONNREFUSED 127.0.0.1:5432');

    const completed = completeCommandSpan({ completedAt: 10, outcome: 'error', error });
    expect(completed?.outcome).toBe('error');
    expect(completed?.errorClass).toBe('KtxConnectionError');
    expect(completed?.errorDetail).toBe('connect ECONNREFUSED 127.0.0.1:5432');
  });
});
