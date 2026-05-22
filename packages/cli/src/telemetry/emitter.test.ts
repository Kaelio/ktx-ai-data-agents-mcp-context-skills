import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetTelemetryEmitterForTests,
  groupIdentifyProject,
  shutdownTelemetryEmitter,
  trackTelemetryEvent,
} from './emitter.js';
import type { BuiltTelemetryEvent } from './events.js';

const captures: unknown[] = [];
const groupIdentifies: unknown[] = [];
const shutdown = vi.fn(async () => {});

function liveConfigId(): string {
  return 'fixture';
}

vi.mock('posthog-node', () => ({
  PostHog: vi.fn().mockImplementation(function () {
    return {
      capture: (event: unknown) => captures.push(event),
      groupIdentify: (event: unknown) => groupIdentifies.push(event),
      shutdown,
    };
  }),
}));

function commandEvent(): BuiltTelemetryEvent<'command'> {
  return {
    name: 'command',
    properties: {
      cliVersion: '0.4.1',
      nodeVersion: 'v22.0.0',
      osPlatform: 'darwin',
      osRelease: '25.0.0',
      arch: 'arm64',
      runtime: 'node',
      isCi: false,
      commandPath: ['ktx', 'status'],
      durationMs: 1,
      outcome: 'ok',
      flagsPresent: {},
      hasProject: true,
      projectGroupAttached: true,
    },
  };
}

describe('telemetry emitter', () => {
  beforeEach(() => {
    captures.length = 0;
    groupIdentifies.length = 0;
    shutdown.mockClear();
    __resetTelemetryEmitterForTests();
  });

  it('prints debug payloads without importing or sending to PostHog', async () => {
    const stderr: string[] = [];

    await trackTelemetryEvent({
      event: commandEvent(),
      distinctId: 'install-1',
      projectId: 'project-1',
      env: { KTX_TELEMETRY_DEBUG: '1' },
      stderr: { write: (chunk) => stderr.push(chunk) },
    });

    expect(stderr.join('')).toContain('[telemetry]');
    expect(stderr.join('')).toContain('"event":"command"');
    expect(captures).toEqual([]);
  });

  it('does not send when config constants are blank', async () => {
    await trackTelemetryEvent({
      event: commandEvent(),
      distinctId: 'install-1',
      projectId: 'project-1',
      env: {},
      stderr: { write: () => {} },
    });

    expect(captures).toEqual([]);
  });

  it('group-identifies once per project when live config is supplied', async () => {
    await groupIdentifyProject({
      distinctId: 'install-1',
      projectId: 'project-1',
      projectApiKey: liveConfigId(),
      host: 'https://us.i.posthog.com',
    });
    await groupIdentifyProject({
      distinctId: 'install-1',
      projectId: 'project-1',
      projectApiKey: liveConfigId(),
      host: 'https://us.i.posthog.com',
    });

    expect(groupIdentifies).toEqual([
      {
        groupType: 'project',
        groupKey: 'project-1',
        distinctId: 'install-1',
      },
    ]);
  });

  it('captures with distinctId, properties, and groups when live config is supplied', async () => {
    await trackTelemetryEvent({
      event: commandEvent(),
      distinctId: 'install-1',
      projectId: 'project-1',
      projectApiKey: liveConfigId(),
      host: 'https://us.i.posthog.com',
      env: {},
      stderr: { write: () => {} },
    });

    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      distinctId: 'install-1',
      event: 'command',
      groups: { project: 'project-1' },
      properties: {
        cliVersion: '0.4.1',
        commandPath: ['ktx', 'status'],
      },
    });
  });

  it('shuts down the client without throwing', async () => {
    await trackTelemetryEvent({
      event: commandEvent(),
      distinctId: 'install-1',
      projectApiKey: liveConfigId(),
      host: 'https://us.i.posthog.com',
      env: {},
      stderr: { write: () => {} },
    });

    await expect(shutdownTelemetryEmitter()).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
