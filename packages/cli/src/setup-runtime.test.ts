import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDefaultKtxProjectConfig, readKtxSetupState, type KtxProjectConfig } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKtxSetupRuntimeStep } from './setup-runtime.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function projectConfig(config: KtxProjectConfig) {
  return vi.fn(async () => ({ config }));
}

describe('runKtxSetupRuntimeStep', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-runtime-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('skips runtime setup when the project has no direct runtime requirements', async () => {
    const io = makeIo();
    const ensureRuntime = vi.fn();

    await expect(
      runKtxSetupRuntimeStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'prompt',
        },
        io.io,
        {
          loadProject: projectConfig(buildDefaultKtxProjectConfig()),
          ensureRuntime,
          env: {},
        },
      ),
    ).resolves.toMatchObject({ status: 'skipped' });

    expect(ensureRuntime).not.toHaveBeenCalled();
    expect((await readKtxSetupState(tempDir)).completed_steps).not.toContain('runtime');
    expect(io.stdout()).toContain('Runtime setup skipped.');
  });

  it('fails fast when required runtime features cannot be installed in no-input mode', async () => {
    const io = makeIo();
    const ensureRuntime = vi.fn(async () => {
      throw new Error('KTX Python runtime is required for this command. Run: ktx admin runtime install --yes');
    });

    await expect(
      runKtxSetupRuntimeStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'never',
          databaseIntrospectionFallback: true,
        },
        io.io,
        {
          loadProject: projectConfig(buildDefaultKtxProjectConfig()),
          ensureRuntime,
          env: {},
        },
      ),
    ).resolves.toMatchObject({ status: 'failed' });

    expect(ensureRuntime).toHaveBeenCalledWith(expect.objectContaining({ installPolicy: 'never' }));
    expect((await readKtxSetupState(tempDir)).completed_steps).not.toContain('runtime');
    expect(io.stderr()).toContain('ktx admin runtime install --yes');
  });

  it('starts the KTX daemon for configured sentence-transformers embeddings', async () => {
    const io = makeIo();
    const ensureLocalEmbeddings = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:61234',
      stdoutLog: join(tempDir, '.ktx', 'runtime', 'daemon.stdout.log'),
      stderrLog: join(tempDir, '.ktx', 'runtime', 'daemon.stderr.log'),
      env: { KTX_MANAGED_SENTENCE_TRANSFORMERS_BASE_URL: 'http://127.0.0.1:61234' },
    }));
    const config: KtxProjectConfig = {
      ...buildDefaultKtxProjectConfig(),
      ingest: {
        ...buildDefaultKtxProjectConfig().ingest,
        embeddings: {
          backend: 'sentence-transformers',
          model: 'all-MiniLM-L6-v2',
          dimensions: 384,
          sentenceTransformers: { base_url: '' },
        },
      },
    };

    await expect(
      runKtxSetupRuntimeStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        io.io,
        {
          loadProject: projectConfig(config),
          ensureLocalEmbeddings,
          env: {},
        },
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(ensureLocalEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        installPolicy: 'auto',
      }),
    );
    expect(io.stdout()).toContain('Runtime ready: yes (local embeddings)');
  });
});
