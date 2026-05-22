import { describe, expect, it } from 'vitest';

import { beginCommandSpan, completeCommandSpan, resetCommandSpan } from './command-hook.js';

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
});
