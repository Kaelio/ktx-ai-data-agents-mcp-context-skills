import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KtxCliIo } from '../../src/cli-runtime.js';
import { __resetTelemetryEmitterForTests } from '../../src/telemetry/emitter.js';
import {
  __resetTelemetryExceptionStateForTests,
  reportException,
} from '../../src/telemetry/exception.js';

const captures: unknown[] = [];
const immediateCaptures: unknown[] = [];
const shutdown = vi.fn(async () => {});

vi.mock('posthog-node', () => ({
  PostHog: vi.fn(function PostHog() {
    return {
      captureException: (
        error: unknown,
        distinctId?: string,
        properties?: Record<string, unknown>,
      ) => {
        captures.push({ error, distinctId, properties });
      },
      captureExceptionImmediate: async (
        error: unknown,
        distinctId?: string,
        properties?: Record<string, unknown>,
      ) => {
        immediateCaptures.push({ error, distinctId, properties });
      },
      capture: vi.fn(),
      shutdown,
    };
  }),
}));

function makeIo(): { io: KtxCliIo; stderr: () => string } {
  let stderr = '';
  return {
    io: {
      stdout: { write: () => {} },
      stderr: {
        write: (chunk) => {
          stderr += chunk;
        },
      },
    },
    stderr: () => stderr,
  };
}

async function writeIdentity(homeDir: string, enabled = true): Promise<void> {
  const path = join(homeDir, '.ktx', 'telemetry.json');
  await mkdir(join(homeDir, '.ktx'), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      installId: '00000000-0000-4000-8000-000000000000',
      enabled,
      createdAt: '2026-06-05T00:00:00.000Z',
    })}\n`,
    'utf-8',
  );
}

describe('reportException', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ktx-exception-'));
    await writeIdentity(homeDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('CI', '');
    vi.stubEnv('KTX_TELEMETRY_DISABLED', '');
    vi.stubEnv('DO_NOT_TRACK', '');
    captures.length = 0;
    immediateCaptures.length = 0;
    shutdown.mockClear();
    __resetTelemetryEmitterForTests();
    __resetTelemetryExceptionStateForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('honors telemetry kill switches', async () => {
    vi.stubEnv('KTX_TELEMETRY_DISABLED', '1');
    const { io } = makeIo();

    await reportException({
      error: new Error('boom'),
      context: { source: 'scan run', handled: true, fatal: false },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
      projectDir: join(homeDir, 'project'),
    });

    expect(captures).toEqual([]);
    expect(immediateCaptures).toEqual([]);
  });

  it('prints debug payloads without sending', async () => {
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('KTX_TELEMETRY_DISABLED', '1');
    const { io, stderr } = makeIo();

    await reportException({
      error: new Error('debug boom'),
      context: { source: 'scan run', handled: true, fatal: false },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
      projectDir: join(homeDir, 'project'),
    });

    expect(stderr()).toContain('[telemetry-exception]');
    expect(stderr()).toContain('"source":"scan run"');
    expect(captures).toEqual([]);
  });

  it('sends projectId as a property and omits $groups for Node exceptions', async () => {
    const { io } = makeIo();

    await reportException({
      error: new Error('project boom'),
      context: { source: 'sql run', handled: true, fatal: false },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
      projectDir: join(homeDir, 'project'),
    });

    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      distinctId: '00000000-0000-4000-8000-000000000000',
      properties: {
        source: 'sql run',
        handled: true,
        fatal: false,
        cliVersion: '0.0.0-test',
        runtime: 'node',
      },
    });
    expect(
      (captures[0] as { properties: Record<string, unknown> }).properties.projectId,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect((captures[0] as { properties: Record<string, unknown> }).properties.$groups).toBeUndefined();
  });

  it('uses captureExceptionImmediate for fatal reports', async () => {
    const { io } = makeIo();

    await reportException({
      error: new Error('fatal boom'),
      context: { source: 'uncaughtException', handled: false, fatal: true },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
      immediate: true,
    });

    expect(immediateCaptures).toHaveLength(1);
    expect(captures).toEqual([]);
  });

  it('redacts snapshot secrets and static credential patterns from message and cause', async () => {
    const { io } = makeIo();
    const cause = new Error('cause has sk-live-fixture-value and Authorization: Bearer token-123');
    const error = new Error('message has sk-live-fixture-value and password=hunter2', { cause });

    await reportException({
      error,
      context: { source: 'connection test', handled: true, fatal: false },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
      redactionSecrets: ['sk-live-fixture-value'],
    });

    const sent = captures[0] as { error: Error & { cause?: Error } };
    expect(sent.error.message).toContain('[redacted]');
    expect(sent.error.message).not.toContain('sk-live-fixture-value');
    expect(sent.error.message).not.toContain('hunter2');
    expect(sent.error.cause?.message).not.toContain('token-123');
  });

  it('does not use process-global secret discovery when no snapshot is supplied', async () => {
    vi.stubEnv('KTX_FAKE_SECRET', 'plain-secret-without-pattern');
    const { io } = makeIo();

    await reportException({
      error: new Error('plain-secret-without-pattern'),
      context: { source: 'uncaughtException', handled: false, fatal: true },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
    });

    const sent = captures[0] as { error: Error };
    expect(sent.error.message).toContain('plain-secret-without-pattern');
  });

  it('dedupes the same Error instance between operation and global tiers', async () => {
    const { io } = makeIo();
    const error = new Error('same object');

    await reportException({
      error,
      context: { source: 'scan run', handled: true, fatal: false },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
    });
    await reportException({
      error,
      context: { source: 'uncaughtException', handled: false, fatal: true },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
      immediate: true,
    });

    expect(captures).toHaveLength(1);
    expect(immediateCaptures).toHaveLength(0);
  });

  it('captures wrapped Error causes as distinct logical occurrences', async () => {
    const { io } = makeIo();
    const inner = new Error('inner');
    const wrapper = new Error('outer', { cause: inner });

    await reportException({
      error: inner,
      context: { source: 'sl query', handled: true, fatal: false },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
    });
    await reportException({
      error: wrapper,
      context: { source: 'uncaughtException', handled: false, fatal: true },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
      immediate: true,
    });

    expect(captures).toHaveLength(1);
    expect(immediateCaptures).toHaveLength(1);
  });

  it('dedupes primitive and plain-object throwables propagated to the global tier', async () => {
    const { io } = makeIo();
    const objectThrowable = { message: 'plain object' };

    await reportException({
      error: 'primitive boom',
      context: { source: 'mcp:sql_execution', handled: true, fatal: false },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
    });
    await reportException({
      error: 'primitive boom',
      context: { source: 'unhandledRejection', handled: false, fatal: true },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
      immediate: true,
    });
    await reportException({
      error: objectThrowable,
      context: { source: 'mcp:discover_data', handled: true, fatal: false },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
    });
    await reportException({
      error: objectThrowable,
      context: { source: 'unhandledRejection', handled: false, fatal: true },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
      immediate: true,
    });

    expect(captures).toHaveLength(2);
    expect(immediateCaptures).toHaveLength(0);
  });

  it('does not collapse independent primitive throw events with the same value', async () => {
    const { io } = makeIo();

    await reportException({
      error: 'oops',
      context: { source: 'scan run', handled: true, fatal: false },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
    });
    await reportException({
      error: 'oops',
      context: { source: 'sql run', handled: true, fatal: false },
      io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
    });

    expect(captures).toHaveLength(2);
  });
});
