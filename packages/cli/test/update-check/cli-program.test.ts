import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildKtxProgram } from '../../src/cli-program.js';
import type { KtxCliDeps, KtxCliIo, KtxCliPackageInfo } from '../../src/cli-runtime.js';
import { updateCheckCachePath } from '../../src/update-check/cache.js';

function makeIo(stdoutIsTTY = true): { io: KtxCliIo; stdout: () => string; stderr: () => string } {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: stdoutIsTTY,
        write: (chunk) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('cli-program update check hooks', () => {
  let projectDir: string;
  let homeDir: string;
  const info: KtxCliPackageInfo = { name: '@kaelio/ktx', version: '0.9.0' };

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'ktx-update-project-'));
    homeDir = await mkdtemp(join(tmpdir(), 'ktx-update-home-'));
    await writeFile(join(projectDir, 'ktx.yaml'), '{}\n', 'utf-8');
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    vi.stubEnv('KTX_TELEMETRY_DISABLED', '1');
    vi.stubEnv('CI', '');
    vi.stubEnv('DO_NOT_TRACK', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('prints a stale-cache notice without awaiting the background refresh', async () => {
    await writeFile(
      updateCheckCachePath(homeDir),
      JSON.stringify(
        {
          checkedAt: '2026-06-05T10:00:00.000Z',
          channel: 'latest',
          installedVersion: '0.9.0',
          latestForChannel: '0.10.0',
        },
        null,
        2,
      ),
      'utf-8',
    );
    const io = makeIo(true);
    const deps: KtxCliDeps = { doctor: async () => 0 };
    const fetchDistTags = vi.fn(
      () =>
        new Promise<Record<string, string>>(() => {
          return;
        }),
    );
    const program = buildKtxProgram({
      io: io.io,
      deps,
      packageInfo: info,
      runInit: async () => 0,
      updateCheck: {
        env: { NO_COLOR: '1' },
        fetchDistTags,
        homeDir,
        now: () => new Date('2026-06-06T12:00:00.000Z'),
      },
    });

    await program.parseAsync(['--project-dir', projectDir, 'status'], { from: 'user' });

    expect(fetchDistTags).toHaveBeenCalledTimes(1);
    expect(io.stderr()).toContain('↑ Update available: ktx 0.9.0 → 0.10.0\n  npm i -g @kaelio/ktx\n');
  });

  it('prints a queued fresh-cache notice after the action', async () => {
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
    const io = makeIo(true);
    const fetchDistTags = vi.fn(async () => ({ latest: '0.10.0' }));
    const program = buildKtxProgram({
      io: io.io,
      deps: { doctor: async () => 0 },
      packageInfo: info,
      runInit: async () => 0,
      updateCheck: {
        env: { NO_COLOR: '1' },
        fetchDistTags,
        homeDir,
        now: () => new Date('2026-06-06T12:00:00.000Z'),
      },
    });

    await program.parseAsync(['--project-dir', projectDir, 'status'], { from: 'user' });

    expect(fetchDistTags).not.toHaveBeenCalled();
    expect(io.stderr()).toContain('↑ Update available: ktx 0.9.0 → 0.10.0\n  npm i -g @kaelio/ktx\n');
  });

  it('does not run update checks for the hidden completion command', async () => {
    const io = makeIo(true);
    const fetchDistTags = vi.fn(async () => ({ latest: '0.10.0' }));
    const program = buildKtxProgram({
      io: io.io,
      deps: {},
      packageInfo: info,
      runInit: async () => 0,
      updateCheck: {
        env: { NO_COLOR: '1' },
        fetchDistTags,
        homeDir,
        now: () => new Date('2026-06-06T12:00:00.000Z'),
      },
    });

    await program.parseAsync(['__complete', '--', 'ktx', 'co'], { from: 'user' });

    expect(fetchDistTags).not.toHaveBeenCalled();
    expect(io.stderr()).not.toContain('Update available');
  });
});
