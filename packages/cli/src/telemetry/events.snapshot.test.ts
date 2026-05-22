import { describe, expect, it } from 'vitest';

import { buildTelemetryEvent, type TelemetryCommonEnvelope } from './events.js';

const BLACKLIST = [
  '/Users/',
  '/home/',
  'C:\\',
  'localhost',
  '.local',
  'kaelio.com',
  'select ',
  'SELECT ',
  'INSERT',
  'CREATE',
  '@',
  'password',
  'secret',
  'token',
  'key',
];

const envelope: TelemetryCommonEnvelope = {
  cliVersion: '0.4.1',
  nodeVersion: 'v22.0.0',
  osPlatform: 'darwin',
  osRelease: '25.0.0',
  arch: 'arm64',
  runtime: 'node',
  isCi: false,
};

describe('telemetry privacy snapshot', () => {
  it('does not emit known private substrings from phase 1 event payloads', () => {
    const events = [
      buildTelemetryEvent('install_first_run', envelope, {}),
      buildTelemetryEvent('command', envelope, {
        commandPath: ['ktx', 'sql'],
        durationMs: 10,
        outcome: 'error',
        errorClass: 'KtxProjectMissingAbortError',
        flagsPresent: {
          'project-dir': true,
          connection: true,
          c: true,
        },
        hasProject: false,
        projectGroupAttached: false,
      }),
    ];

    const payload = JSON.stringify(events);

    for (const forbidden of BLACKLIST) {
      expect(payload).not.toContain(forbidden);
    }
  });
});
