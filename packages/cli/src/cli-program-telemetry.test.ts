import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCommanderKtxCli } from './cli-program.js';
import type { KtxCliDeps, KtxCliIo, KtxCliPackageInfo } from './cli-runtime.js';

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

const info: KtxCliPackageInfo = { name: '@kaelio/ktx', version: '0.4.1' };

describe('runCommanderKtxCli telemetry', () => {
  let tempDir: string;
  const originalEnv = process.env;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-telemetry-'));
    await writeFile(join(tempDir, 'ktx.yaml'), '{}\n', 'utf-8');
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('HOME', tempDir);
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
    expect(statusIo.stderr()).toContain('"event":"command"');
    expect(statusIo.stderr()).toContain('"commandPath":["ktx","status"]');
    expect(statusIo.stderr()).toContain('"event":"project_stack_snapshot"');
    expect(statusIo.stderr()).toContain('"connectionCount"');
    expect(statusIo.stderr()).not.toContain(tempDir);
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
});
