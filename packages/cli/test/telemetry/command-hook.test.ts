import { describe, expect, it } from 'vitest';

import {
  annotateCommandOutcome,
  beginCommandSpan,
  completeCommandSpan,
  resetCommandSpan,
} from '../../src/telemetry/command-hook.js';

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

  it('applies an annotated outcome when no error is thrown', () => {
    resetCommandSpan();
    beginCommandSpan({
      commandPath: ['ktx', 'setup'],
      flagsPresent: {},
      hasProject: false,
      attachProjectGroup: true,
      startedAt: 0,
    });

    annotateCommandOutcome({ outcome: 'aborted' });

    // The wrapper derives 'error' from a non-zero exit code, but the action
    // knows the user aborted — the annotation must win on the non-throwing path.
    const completed = completeCommandSpan({ completedAt: 5, outcome: 'error' });
    expect(completed?.outcome).toBe('aborted');
    expect(completed?.errorClass).toBeUndefined();
    expect(completed?.errorDetail).toBeUndefined();
  });

  it('applies an annotated reason so a non-throwing failure is self-diagnosing', () => {
    resetCommandSpan();
    beginCommandSpan({
      commandPath: ['ktx', 'setup'],
      flagsPresent: {},
      hasProject: false,
      attachProjectGroup: true,
      startedAt: 0,
    });

    annotateCommandOutcome({
      outcome: 'error',
      errorClass: 'KtxSetupStepFailed',
      errorDetail: 'runtime setup step failed',
    });

    const completed = completeCommandSpan({ completedAt: 5, outcome: 'error' });
    expect(completed?.outcome).toBe('error');
    expect(completed?.errorClass).toBe('KtxSetupStepFailed');
    expect(completed?.errorDetail).toBe('runtime setup step failed');
  });

  it('lets a thrown error take precedence over an annotation', () => {
    resetCommandSpan();
    beginCommandSpan({
      commandPath: ['ktx', 'setup'],
      flagsPresent: {},
      hasProject: false,
      attachProjectGroup: true,
      startedAt: 0,
    });

    annotateCommandOutcome({ outcome: 'aborted', errorDetail: 'user aborted' });

    class KtxSetupBoomError extends Error {}
    const completed = completeCommandSpan({
      completedAt: 5,
      outcome: 'error',
      error: new KtxSetupBoomError('boom'),
    });
    expect(completed?.outcome).toBe('error');
    expect(completed?.errorClass).toBe('KtxSetupBoomError');
    expect(completed?.errorDetail).toBe('boom');
  });

  it('ignores annotation when no span is active', () => {
    resetCommandSpan();
    expect(() => annotateCommandOutcome({ outcome: 'aborted' })).not.toThrow();
    expect(completeCommandSpan({ completedAt: 1, outcome: 'ok' })).toBeUndefined();
  });
});
