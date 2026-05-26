import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KtxCliIo } from '../../src/cli-runtime.js';
import { emitTelemetryEvent } from '../../src/telemetry/index.js';

function makeIo(): { io: KtxCliIo; stderr: () => string } {
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: true,
        write: () => {},
      },
      stderr: {
        write: (chunk) => {
          stderr += chunk;
        },
      },
    },
    stderr: () => stderr,
  };
}

describe('emitTelemetryEvent', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ktx-telemetry-index-'));
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('prints debug telemetry when live telemetry is disabled without creating an identity file', async () => {
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('KTX_TELEMETRY_DISABLED', '1');
    vi.stubEnv('DO_NOT_TRACK', '1');
    const testIo = makeIo();
    const projectDir = join(homeDir, 'private-project');

    await emitTelemetryEvent({
      name: 'connection_added',
      projectDir,
      io: testIo.io,
      packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
      fields: {
        driver: 'sqlite',
        isDemoConnection: false,
      },
    });

    expect(testIo.stderr()).toContain('[telemetry]');
    expect(testIo.stderr()).toContain('"event":"connection_added"');
    expect(testIo.stderr()).not.toContain(projectDir);
    await expect(readFile(join(homeDir, '.ktx', 'telemetry.json'), 'utf-8')).rejects.toThrow();
  });
});
