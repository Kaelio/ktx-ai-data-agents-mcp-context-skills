import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCommanderKtxCli } from '../src/cli-program.js';
import type { KtxCliDeps, KtxCliIo, KtxCliPackageInfo } from '../src/cli-runtime.js';
import { TELEMETRY_NOTICE } from '../src/telemetry/identity.js';

const reportExceptionMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../src/telemetry/exception.js', () => ({
  reportException: reportExceptionMock,
}));

function makeIo(
  stdoutIsTTY = true,
  stderrIsTTY = false,
): { io: KtxCliIo; stdout: () => string; stderr: () => string } {
  let stdout = '';
  let stderr = '';
  const stderrStream = stderrIsTTY
    ? {
        isTTY: true,
        columns: 80,
        on: () => undefined,
        write: (chunk: string) => {
          stderr += chunk;
        },
      }
    : {
        write: (chunk: string) => {
          stderr += chunk;
        },
      };

  return {
    io: {
      stdout: {
        isTTY: stdoutIsTTY,
        write: (chunk) => {
          stdout += chunk;
        },
      },
      stderr: stderrStream,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

const info: KtxCliPackageInfo = { name: '@kaelio/ktx', version: '0.4.1' };

describe('runCommanderKtxCli telemetry', () => {
  let tempDir: string;
  const originalEnv = process.env;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-telemetry-'));
    await writeFile(join(tempDir, 'ktx.yaml'), '{}\n', 'utf-8');
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('HOME', tempDir);
    vi.stubEnv('CI', '');
    vi.stubEnv('KTX_TELEMETRY_DISABLED', '');
    vi.stubEnv('DO_NOT_TRACK', '');
    reportExceptionMock.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    process.env = originalEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('emits debug command telemetry for registered actions', async () => {
    const io = makeIo(true);
    await expect(
      runCommanderKtxCli(
        ['--project-dir', tempDir, 'status', '--help'],
        io.io,
        {},
        info,
        { runInit: async () => 0 },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).not.toContain('[telemetry]');

    const statusIo = makeIo(true);
    const deps: KtxCliDeps = { doctor: async () => 0 };

    await expect(
      runCommanderKtxCli(
        ['--project-dir', tempDir, 'status', '--json'],
        statusIo.io,
        deps,
        info,
        { runInit: async () => 0 },
      ),
    ).resolves.toBe(0);

    expect(statusIo.stderr()).toContain('[telemetry]');
    expect(statusIo.stderr()).toContain('"event":"install_first_run"');
    expect(statusIo.stderr()).toContain('"event":"command"');
    expect(statusIo.stderr()).toContain('"commandPath":["ktx","status"]');
    expect(statusIo.stderr()).toContain('"event":"project_stack_snapshot"');
    expect(statusIo.stderr()).toContain('"connectionCount"');
    expect(statusIo.stderr()).not.toContain(tempDir);

    const noticeIndex = statusIo.stderr().indexOf(TELEMETRY_NOTICE);
    const firstTelemetryIndex = statusIo.stderr().indexOf('[telemetry]');
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(firstTelemetryIndex).toBeGreaterThan(noticeIndex);
  });

  it('emits aborted telemetry when project validation aborts after preAction starts', async () => {
    const missingProjectDir = join(tempDir, 'missing');
    await mkdir(missingProjectDir, { recursive: true });
    const io = makeIo(true);

    await expect(
      runCommanderKtxCli(
        ['--project-dir', missingProjectDir, 'connection'],
        io.io,
        {},
        info,
        { runInit: async () => 0 },
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('[telemetry]');
    expect(io.stderr()).toContain('"outcome":"aborted"');
    expect(io.stderr()).toContain('"hasProject":false');
    expect(io.stderr()).toContain('"projectGroupAttached":false');
    expect(io.stderr()).not.toContain(missingProjectDir);
  });

  it('does not import or emit telemetry for help, version, bare non-TTY, or unknown top-level command', async () => {
    const helpIo = makeIo(true);
    await expect(runCommanderKtxCli(['--help'], helpIo.io, {}, info, { runInit: async () => 0 })).resolves.toBe(0);
    expect(helpIo.stderr()).not.toContain('[telemetry]');

    const versionIo = makeIo(true);
    await expect(runCommanderKtxCli(['--version'], versionIo.io, {}, info, { runInit: async () => 0 })).resolves.toBe(0);
    expect(versionIo.stderr()).not.toContain('[telemetry]');

    const bareIo = makeIo(false);
    await expect(runCommanderKtxCli([], bareIo.io, {}, info, { runInit: async () => 0 })).resolves.toBe(0);
    expect(bareIo.stderr()).not.toContain('[telemetry]');

    const unknownIo = makeIo(true);
    await expect(runCommanderKtxCli(['unknown'], unknownIo.io, {}, info, { runInit: async () => 0 })).resolves.toBe(1);
    expect(unknownIo.stderr()).not.toContain('[telemetry]');
  });

  it('reports genuine top-level command catches as handled exceptions', async () => {
    const io = makeIo(true);
    const deps: KtxCliDeps = {
      doctor: async () => {
        throw new Error('status failed');
      },
    };

    await expect(
      runCommanderKtxCli(
        ['--project-dir', tempDir, 'status', '--json'],
        io.io,
        deps,
        info,
        { runInit: async () => 0 },
      ),
    ).resolves.toBe(1);

    expect(reportExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ source: 'ktx status', handled: true, fatal: false }),
        projectDir: tempDir,
      }),
    );
  });

  it('prints the Slack hint for unexpected command errors on TTY stderr only', async () => {
    const ttyIo = makeIo(true, true);
    const deps: KtxCliDeps = {
      doctor: async () => {
        throw new Error('status failed');
      },
    };

    await expect(
      runCommanderKtxCli(
        ['--project-dir', tempDir, 'status', '--json'],
        ttyIo.io,
        deps,
        info,
        { runInit: async () => 0 },
      ),
    ).resolves.toBe(1);

    expect(ttyIo.stderr()).toContain('status failed');
    expect(ttyIo.stderr()).toContain('Stuck? The ktx community can help');
    expect(ttyIo.stderr()).toContain('https://ktx.sh/slack');

    const pipeIo = makeIo(true, false);
    await expect(
      runCommanderKtxCli(
        ['--project-dir', tempDir, 'status', '--json'],
        pipeIo.io,
        deps,
        info,
        { runInit: async () => 0 },
      ),
    ).resolves.toBe(1);

    expect(pipeIo.stderr()).toContain('status failed');
    expect(pipeIo.stderr()).not.toContain('https://ktx.sh/slack');
  });

  it('does not print the Slack hint for Commander usage errors', async () => {
    const io = makeIo(true, true);

    await expect(
      runCommanderKtxCli(['--not-a-real-option'], io.io, {}, info, { runInit: async () => 0 }),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain("unknown option '--not-a-real-option'");
    expect(io.stderr()).not.toContain('Stuck? The ktx community can help');
  });

  it('prints the Slack hint for bare interactive setup failures on TTY stderr', async () => {
    const originalCwd = process.cwd();
    const noProjectDir = await mkdtemp(join(tmpdir(), 'ktx-cli-bare-'));
    const io = makeIo(true, true);
    const deps: KtxCliDeps = {
      setup: async () => {
        throw new Error('setup failed');
      },
    };

    try {
      process.chdir(noProjectDir);
      await expect(runCommanderKtxCli([], io.io, deps, info, { runInit: async () => 0 })).resolves.toBe(1);
    } finally {
      process.chdir(originalCwd);
      await rm(noProjectDir, { recursive: true, force: true });
    }

    expect(io.stderr()).toContain('setup failed');
    expect(io.stderr()).toContain('Stuck? The ktx community can help');
    expect(io.stderr()).toContain('https://ktx.sh/slack');
  });
});
