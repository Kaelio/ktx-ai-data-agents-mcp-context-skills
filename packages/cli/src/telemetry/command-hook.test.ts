import { describe, expect, it } from 'vitest';

import {
  beginCommandSpan,
  completeCommandSpan,
  extractFlagsPresent,
  resetCommandSpan,
} from './command-hook.js';

describe('telemetry command hook', () => {
  it('extracts only flag names, never flag values', () => {
    expect(
      extractFlagsPresent(['--project-dir', '/Users/alice/private', '--json', '--limit=5', '-v', 'status']),
    ).toEqual({
      'project-dir': true,
      json: true,
      limit: true,
      v: true,
    });
  });

  it('builds a completed command event from a span', () => {
    resetCommandSpan();
    beginCommandSpan({
      commandPath: ['ktx', 'status'],
      argv: ['--project-dir', '/tmp/private', 'status', '--json'],
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
      flagsPresent: {
        'project-dir': true,
        json: true,
      },
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
