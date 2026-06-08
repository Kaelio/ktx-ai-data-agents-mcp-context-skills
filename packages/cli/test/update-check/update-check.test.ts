import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updateCheckCachePath } from '../../src/update-check/cache.js';
import {
  prepareUpdateCheckNotice,
  renderUpdateNotice,
  shouldSuppressUpdateCheck,
} from '../../src/update-check/update-check.js';

function makeIo(stdoutIsTTY = true) {
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: stdoutIsTTY,
        write: () => {},
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stderr: () => stderr,
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('update-check orchestration', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ktx-update-check-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it.each([
    ['json option', true, {}, { json: true }],
    ['json output option', true, {}, { output: 'json' }],
    ['json format option', true, {}, { format: 'json' }],
    ['CI', true, { CI: '1' }, {}],
    ['non-TTY stdout', false, {}, {}],
    ['KTX_NO_UPDATE_CHECK', true, { KTX_NO_UPDATE_CHECK: '1' }, {}],
    ['NO_UPDATE_NOTIFIER', true, { NO_UPDATE_NOTIFIER: '1' }, {}],
    ['DO_NOT_TRACK', true, { DO_NOT_TRACK: '1' }, {}],
  ])('suppresses cache and network work for %s', async (_name, stdoutIsTTY, env, commandOptions) => {
    const fetchDistTags = vi.fn(async () => ({ latest: '0.10.0' }));

    const result = await prepareUpdateCheckNotice({
      io: makeIo(stdoutIsTTY).io,
      env,
      homeDir,
      installedVersion: '0.9.0',
      commandOptions,
      now: () => new Date('2026-06-06T12:00:00.000Z'),
      fetchDistTags,
    });

    expect(result.notice).toBeNull();
    expect(fetchDistTags).not.toHaveBeenCalled();
    await expect(readFile(updateCheckCachePath(homeDir), 'utf-8')).rejects.toThrow();
  });

  it.each([
    ['CI', true, { CI: '1', KTX_OUTPUT: 'pretty' }],
    ['non-TTY stdout', false, { KTX_OUTPUT: 'pretty' }],
  ])('suppresses cache and network work for %s even when pretty output is forced', async (_name, stdoutIsTTY, env) => {
    const fetchDistTags = vi.fn(async () => ({ latest: '0.10.0' }));

    const result = await prepareUpdateCheckNotice({
      io: makeIo(stdoutIsTTY).io,
      env,
      homeDir,
      installedVersion: '0.9.0',
      commandOptions: {},
      now: () => new Date('2026-06-06T12:00:00.000Z'),
      fetchDistTags,
    });

    expect(result.notice).toBeNull();
    expect(fetchDistTags).not.toHaveBeenCalled();
    await expect(readFile(updateCheckCachePath(homeDir), 'utf-8')).rejects.toThrow();
  });

  it('does not suppress when only KTX_TELEMETRY_DISABLED is set', () => {
    expect(
      shouldSuppressUpdateCheck({
        io: makeIo(true).io,
        env: { KTX_TELEMETRY_DISABLED: '1' } as NodeJS.ProcessEnv,
        commandOptions: {},
      }),
    ).toBe(false);
  });

  it('renders a compact no-color stable notice', () => {
    expect(
      renderUpdateNotice({
        installedVersion: '0.9.0',
        targetVersion: '0.10.0',
        channel: 'latest',
        env: { NO_COLOR: '1' },
      }),
    ).toBe('↑ Update available: ktx 0.9.0 → 0.10.0\n  npm i -g @kaelio/ktx\n');
  });

  it('renders the next-channel install command', () => {
    expect(
      renderUpdateNotice({
        installedVersion: '0.10.0-rc.1',
        targetVersion: '0.10.0-rc.2',
        channel: 'next',
        env: { NO_COLOR: '1' },
      }),
    ).toBe('↑ Update available: ktx 0.10.0-rc.1 → 0.10.0-rc.2\n  npm i -g @kaelio/ktx@next\n');
  });

  it('queues a cached notice and stamps lastNoticeAt', async () => {
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    await writeFile(
      updateCheckCachePath(homeDir),
      JSON.stringify(
        {
          checkedAt: '2026-06-06T11:00:00.000Z',
          channel: 'latest',
          installedVersion: '0.9.0',
          latestForChannel: '0.10.0',
        },
        null,
        2,
      ),
      'utf-8',
    );
    const fetchDistTags = vi.fn(async () => ({ latest: '0.10.0' }));

    const result = await prepareUpdateCheckNotice({
      io: makeIo(true).io,
      env: { NO_COLOR: '1' },
      homeDir,
      installedVersion: '0.9.0',
      now: () => new Date('2026-06-06T12:00:00.000Z'),
      fetchDistTags,
    });

    expect(result.notice).toBe('↑ Update available: ktx 0.9.0 → 0.10.0\n  npm i -g @kaelio/ktx\n');
    expect(fetchDistTags).not.toHaveBeenCalled();
    const stored = JSON.parse(await readFile(updateCheckCachePath(homeDir), 'utf-8')) as { lastNoticeAt?: string };
    expect(stored.lastNoticeAt).toBe('2026-06-06T12:00:00.000Z');
  });

  it('queues a stale cached notice and still refreshes in the background', async () => {
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    await writeFile(
      updateCheckCachePath(homeDir),
      JSON.stringify(
        {
          checkedAt: '2026-06-05T10:00:00.000Z',
          channel: 'latest',
          installedVersion: '0.9.0',
          latestForChannel: '0.10.0',
          lastNoticeAt: '2026-06-05T11:00:00.000Z',
        },
        null,
        2,
      ),
      'utf-8',
    );
    const fetchDistTags = vi.fn(async () => ({ latest: '0.11.0' }));

    const result = await prepareUpdateCheckNotice({
      io: makeIo(true).io,
      env: { NO_COLOR: '1' },
      homeDir,
      installedVersion: '0.9.0',
      now: () => new Date('2026-06-06T12:00:00.000Z'),
      fetchDistTags,
    });

    expect(result.notice).toBe('↑ Update available: ktx 0.9.0 → 0.10.0\n  npm i -g @kaelio/ktx\n');
    expect(fetchDistTags).toHaveBeenCalledTimes(1);

    await flushAsyncWork();
    await vi.waitFor(async () => {
      const stored = JSON.parse(await readFile(updateCheckCachePath(homeDir), 'utf-8')) as {
        latestForChannel: string;
        lastNoticeAt?: string;
      };
      expect(stored.latestForChannel).toBe('0.11.0');
      expect(stored.lastNoticeAt).toBe('2026-06-06T12:00:00.000Z');
    });
  });

  it('throttles a cached notice for 24 hours', async () => {
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    await writeFile(
      updateCheckCachePath(homeDir),
      JSON.stringify(
        {
          checkedAt: '2026-06-06T11:00:00.000Z',
          channel: 'latest',
          installedVersion: '0.9.0',
          latestForChannel: '0.10.0',
          lastNoticeAt: '2026-06-06T11:30:00.000Z',
        },
        null,
        2,
      ),
      'utf-8',
    );

    await expect(
      prepareUpdateCheckNotice({
        io: makeIo(true).io,
        env: { NO_COLOR: '1' },
        homeDir,
        installedVersion: '0.9.0',
        now: () => new Date('2026-06-06T12:00:00.000Z'),
        fetchDistTags: vi.fn(async () => ({ latest: '0.10.0' })),
      }),
    ).resolves.toEqual({ notice: null });
  });

  it('does not show stale cache after the installed version changes and schedules a refresh', async () => {
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    await writeFile(
      updateCheckCachePath(homeDir),
      JSON.stringify(
        {
          checkedAt: '2026-06-06T11:00:00.000Z',
          channel: 'latest',
          installedVersion: '0.9.0',
          latestForChannel: '0.10.0',
        },
        null,
        2,
      ),
      'utf-8',
    );
    const fetchDistTags = vi.fn(async () => ({ latest: '0.10.0' }));

    const result = await prepareUpdateCheckNotice({
      io: makeIo(true).io,
      env: { NO_COLOR: '1' },
      homeDir,
      installedVersion: '0.10.0',
      now: () => new Date('2026-06-06T12:00:00.000Z'),
      fetchDistTags,
    });

    expect(result.notice).toBeNull();
    expect(fetchDistTags).toHaveBeenCalledTimes(1);
  });

  it('refreshes stale cache in the background and preserves lastNoticeAt for the same install', async () => {
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    await writeFile(
      updateCheckCachePath(homeDir),
      JSON.stringify(
        {
          checkedAt: '2026-06-05T10:00:00.000Z',
          channel: 'latest',
          installedVersion: '0.9.0',
          latestForChannel: '0.10.0',
          lastNoticeAt: '2026-06-06T09:00:00.000Z',
        },
        null,
        2,
      ),
      'utf-8',
    );

    await prepareUpdateCheckNotice({
      io: makeIo(true).io,
      env: { NO_COLOR: '1' },
      homeDir,
      installedVersion: '0.9.0',
      now: () => new Date('2026-06-06T12:00:00.000Z'),
      fetchDistTags: vi.fn(async () => ({ latest: '0.11.0' })),
    });
    await flushAsyncWork();

    await vi.waitFor(async () => {
      const stored = JSON.parse(await readFile(updateCheckCachePath(homeDir), 'utf-8')) as {
        checkedAt: string;
        latestForChannel: string;
        lastNoticeAt?: string;
      };
      expect(stored.checkedAt).toBe('2026-06-06T12:00:00.000Z');
      expect(stored.latestForChannel).toBe('0.11.0');
      expect(stored.lastNoticeAt).toBe('2026-06-06T09:00:00.000Z');
    });
  });

  it('swallows refresh failures and leaves existing cache untouched', async () => {
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    const originalCache = {
      checkedAt: '2026-06-05T10:00:00.000Z',
      channel: 'latest',
      installedVersion: '0.9.0',
      latestForChannel: '0.10.0',
      lastNoticeAt: '2026-06-06T09:00:00.000Z',
    };
    await writeFile(updateCheckCachePath(homeDir), JSON.stringify(originalCache, null, 2), 'utf-8');

    await prepareUpdateCheckNotice({
      io: makeIo(true).io,
      env: { NO_COLOR: '1' },
      homeDir,
      installedVersion: '0.9.0',
      now: () => new Date('2026-06-06T12:00:00.000Z'),
      fetchDistTags: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    await flushAsyncWork();

    await expect(readFile(updateCheckCachePath(homeDir), 'utf-8')).resolves.toBe(JSON.stringify(originalCache, null, 2));
  });
});
