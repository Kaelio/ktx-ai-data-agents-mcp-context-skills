import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeTelemetryProjectId,
  loadTelemetryIdentity,
  readExistingTelemetryProjectId,
  TELEMETRY_NOTICE,
  type TelemetryIdentityEnv,
} from '../../src/telemetry/identity.js';

function makeIo() {
  let stderr = '';
  return {
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
      },
    },
    read: () => stderr,
  };
}

describe('telemetry identity', () => {
  let homeDir: string;
  let env: TelemetryIdentityEnv;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ktx-telemetry-home-'));
    env = {};
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('creates the telemetry file and one-line notice on first enabled load', async () => {
    const testIo = makeIo();

    const identity = await loadTelemetryIdentity({
      homeDir,
      env,
      stderr: testIo.stderr,
      now: () => new Date('2026-05-22T14:33:02.000Z'),
    });

    expect(identity.enabled).toBe(true);
    expect(identity.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.createdFile).toBe(true);
    expect(identity.noticeShown).toBe(true);
    expect(testIo.read()).toBe(`\x1b[2m${TELEMETRY_NOTICE}\x1b[22m\n`);

    const stored = JSON.parse(await readFile(join(homeDir, '.ktx', 'telemetry.json'), 'utf-8')) as {
      enabled: boolean;
      noticeShownVersion: number;
    };
    expect(stored.enabled).toBe(true);
    expect(stored.noticeShownVersion).toBe(1);
  });

  it('mints an identity on a headless first run (no TTY required)', async () => {
    // A fresh install whose first invocation is headless (IDE-launched
    // `ktx mcp stdio`, a scripted run) must still be counted. The one-time
    // notice goes to stderr, which is safe even under the MCP stdio protocol.
    const testIo = makeIo();

    const identity = await loadTelemetryIdentity({
      homeDir,
      env,
      stderr: testIo.stderr,
      now: () => new Date('2026-05-22T14:33:02.000Z'),
    });

    expect(identity).toMatchObject({ enabled: true, createdFile: true, noticeShown: true });
    expect(identity.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(testIo.read()).toBe(`\x1b[2m${TELEMETRY_NOTICE}\x1b[22m\n`);
    const stored = JSON.parse(await readFile(join(homeDir, '.ktx', 'telemetry.json'), 'utf-8')) as {
      enabled: boolean;
    };
    expect(stored.enabled).toBe(true);
  });

  it('emits the notice without ANSI when NO_COLOR is set', async () => {
    const testIo = makeIo();

    await loadTelemetryIdentity({
      homeDir,
      env: { NO_COLOR: '1' },
      stderr: testIo.stderr,
      now: () => new Date('2026-05-22T14:33:02.000Z'),
    });

    expect(testIo.read()).toBe(`${TELEMETRY_NOTICE}\n`);
  });

  it('does not create a file when env disables telemetry', async () => {
    const identity = await loadTelemetryIdentity({
      homeDir,
      env: { KTX_TELEMETRY_DISABLED: '1' },
      stderr: makeIo().stderr,
      now: () => new Date('2026-05-22T14:33:02.000Z'),
    });

    expect(identity.enabled).toBe(false);
    await expect(readFile(join(homeDir, '.ktx', 'telemetry.json'), 'utf-8')).rejects.toThrow();
  });

  it('does not create a file under CI', async () => {
    await expect(
      loadTelemetryIdentity({
        homeDir,
        env: { CI: '1' },
        stderr: makeIo().stderr,
        now: () => new Date('2026-05-22T14:33:02.000Z'),
      }),
    ).resolves.toMatchObject({ enabled: false, createdFile: false });
    await expect(readFile(join(homeDir, '.ktx', 'telemetry.json'), 'utf-8')).rejects.toThrow();
  });

  it('honors persistent enabled false', async () => {
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    await writeFile(
      join(homeDir, '.ktx', 'telemetry.json'),
      JSON.stringify(
        {
          installId: '00000000-0000-4000-8000-000000000000',
          enabled: false,
          noticeShownAt: '2026-05-22T14:33:02.000Z',
          noticeShownVersion: 1,
          createdAt: '2026-05-22T14:33:02.000Z',
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    await expect(
      loadTelemetryIdentity({
        homeDir,
        env,
        stderr: makeIo().stderr,
        now: () => new Date('2026-05-22T15:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      installId: '00000000-0000-4000-8000-000000000000',
      enabled: false,
      createdFile: false,
    });
  });

  it('honors a consented identity without re-showing the notice', async () => {
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    await writeFile(
      join(homeDir, '.ktx', 'telemetry.json'),
      JSON.stringify(
        {
          installId: '00000000-0000-4000-8000-000000000000',
          enabled: true,
          noticeShownAt: '2026-05-22T14:33:02.000Z',
          noticeShownVersion: 1,
          createdAt: '2026-05-22T14:33:02.000Z',
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    const testIo = makeIo();

    await expect(
      loadTelemetryIdentity({
        homeDir,
        env,
        stderr: testIo.stderr,
        now: () => new Date('2026-05-22T15:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      installId: '00000000-0000-4000-8000-000000000000',
      enabled: true,
      createdFile: false,
      noticeShown: false,
    });
    // An already-consented identity must not re-emit the one-time notice.
    expect(testIo.read()).toBe('');
  });

  it('keeps opt-outs suppressing a consented identity', async () => {
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    await writeFile(
      join(homeDir, '.ktx', 'telemetry.json'),
      JSON.stringify(
        {
          installId: '00000000-0000-4000-8000-000000000000',
          enabled: true,
          noticeShownAt: '2026-05-22T14:33:02.000Z',
          noticeShownVersion: 1,
          createdAt: '2026-05-22T14:33:02.000Z',
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    for (const optOut of [{ KTX_TELEMETRY_DISABLED: '1' }, { DO_NOT_TRACK: '1' }, { CI: '1' }]) {
      await expect(
        loadTelemetryIdentity({
          homeDir,
          env: optOut,
          stderr: makeIo().stderr,
          now: () => new Date('2026-05-22T15:00:00.000Z'),
        }),
      ).resolves.toMatchObject({ enabled: false });
    }
  });

  it('recreates a corrupted file instead of surfacing an error to users', async () => {
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    await writeFile(join(homeDir, '.ktx', 'telemetry.json'), '{bad json', 'utf-8');

    const identity = await loadTelemetryIdentity({
      homeDir,
      env,
      stderr: makeIo().stderr,
      now: () => new Date('2026-05-22T14:33:02.000Z'),
    });

    expect(identity.enabled).toBe(true);
    expect(identity.createdFile).toBe(true);
  });

  it('derives a salted project hash without exposing the path', () => {
    const projectDir = resolve('/tmp/acme-private-project');
    const projectId = computeTelemetryProjectId('00000000-0000-4000-8000-000000000000', projectDir);

    expect(projectId).toMatch(/^[a-f0-9]{64}$/);
    expect(projectId).not.toContain('acme');
    expect(computeTelemetryProjectId('00000000-0000-4000-8000-000000000000', projectDir)).toBe(projectId);
    expect(computeTelemetryProjectId('11111111-1111-4111-8111-111111111111', projectDir)).not.toBe(projectId);
  });

  it('reads an existing project id for Python telemetry without creating identity', async () => {
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    await writeFile(
      join(homeDir, '.ktx', 'telemetry.json'),
      JSON.stringify(
        {
          installId: '00000000-0000-4000-8000-000000000000',
          enabled: true,
          noticeShownAt: '2026-05-22T14:33:02.000Z',
          noticeShownVersion: 1,
          createdAt: '2026-05-22T14:33:02.000Z',
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    await expect(
      readExistingTelemetryProjectId({
        homeDir,
        projectDir: '/tmp/acme-private-project',
        env: {},
      }),
    ).resolves.toMatch(/^[a-f0-9]{64}$/);

    await expect(
      readExistingTelemetryProjectId({
        homeDir,
        projectDir: '/tmp/acme-private-project',
        env: { KTX_TELEMETRY_DISABLED: '1' },
      }),
    ).resolves.toBeUndefined();
  });
});
