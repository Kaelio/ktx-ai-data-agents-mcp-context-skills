import { describe, expect, it } from 'vitest';

import {
  buildTelemetryEvent,
  telemetryEventCatalog,
  telemetryEventSchemas,
  type TelemetryCommonEnvelope,
} from './events.js';

const envelope: TelemetryCommonEnvelope = {
  cliVersion: '0.4.1',
  nodeVersion: 'v22.0.0',
  osPlatform: 'darwin',
  osRelease: '25.0.0',
  arch: 'arm64',
  runtime: 'node',
  isCi: false,
};

describe('telemetry event schemas', () => {
  it('catalogs only phase 1 events', () => {
    expect(telemetryEventCatalog.map((event) => event.name)).toEqual(['install_first_run', 'command']);
  });

  it('builds a strict install_first_run event', () => {
    expect(buildTelemetryEvent('install_first_run', envelope, {})).toEqual({
      name: 'install_first_run',
      properties: envelope,
    });
  });

  it('builds a strict command event with project grouping fields', () => {
    expect(
      buildTelemetryEvent('command', envelope, {
        commandPath: ['ktx', 'status'],
        durationMs: 12,
        outcome: 'ok',
        flagsPresent: { json: true },
        hasProject: true,
        projectGroupAttached: true,
      }),
    ).toEqual({
      name: 'command',
      properties: {
        ...envelope,
        commandPath: ['ktx', 'status'],
        durationMs: 12,
        outcome: 'ok',
        flagsPresent: { json: true },
        hasProject: true,
        projectGroupAttached: true,
      },
    });
  });

  it('rejects unmodeled event properties', () => {
    expect(() =>
      telemetryEventSchemas.command.parse({
        ...envelope,
        commandPath: ['ktx', 'status'],
        durationMs: 12,
        outcome: 'ok',
        flagsPresent: {},
        hasProject: true,
        projectGroupAttached: true,
        tableName: 'private_table',
      }),
    ).toThrow();
  });

  it('rejects raw string fields that are not in the phase 1 schema', () => {
    expect(JSON.stringify(telemetryEventSchemas)).not.toContain('tableName');
    expect(JSON.stringify(telemetryEventSchemas)).not.toContain('sql');
    expect(JSON.stringify(telemetryEventSchemas)).not.toContain('path');
  });
});
