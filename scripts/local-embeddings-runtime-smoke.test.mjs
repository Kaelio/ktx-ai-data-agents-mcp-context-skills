import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  buildLocalEmbeddingsSmokeEnv,
  expectedPublicKtxVersionPattern,
  localEmbeddingsSmokeCommands,
  localEmbeddingsSmokeOptIn,
  parseDaemonBaseUrl,
  publicKtxTarballName,
  validateEmbeddingResponse,
} from './local-embeddings-runtime-smoke.mjs';

describe('localEmbeddingsSmokeOptIn', () => {
  it('skips unless the smoke is explicitly enabled', () => {
    assert.deepEqual(localEmbeddingsSmokeOptIn({}, []), {
      run: false,
      message: 'Set KTX_RUN_LOCAL_EMBEDDINGS_SMOKE=1 or pass --force to run the local embeddings smoke.',
    });
  });

  it('runs when the environment opt-in is set', () => {
    assert.deepEqual(localEmbeddingsSmokeOptIn({ KTX_RUN_LOCAL_EMBEDDINGS_SMOKE: '1' }, []), {
      run: true,
    });
  });

  it('runs when --force is present', () => {
    assert.deepEqual(localEmbeddingsSmokeOptIn({}, ['--force']), {
      run: true,
    });
  });
});

describe('publicKtxTarballName', () => {
  it('selects the public @kaelio/ktx tarball name', () => {
    assert.equal(
      publicKtxTarballName(['kaelio-ktx-0.1.0-rc.0.tgz', 'ignore-me.tgz']),
      'kaelio-ktx-0.1.0-rc.0.tgz',
    );
  });

  it('fails when the public package tarball is missing', () => {
    assert.throws(
      () => publicKtxTarballName(['ktx-cli-0.0.0-private.tgz']),
      /Expected exactly one @kaelio\/ktx tarball/,
    );
  });

  it('fails when multiple public package tarballs are present', () => {
    assert.throws(
      () => publicKtxTarballName(['kaelio-ktx-0.1.0-rc.0.tgz', 'kaelio-ktx-0.2.0.tgz']),
      /Expected exactly one @kaelio\/ktx tarball/,
    );
  });
});

describe('expectedPublicKtxVersionPattern', () => {
  it('matches the public package version and rejects the private workspace version', () => {
    const pattern = expectedPublicKtxVersionPattern();

    assert.match('@kaelio/ktx 0.1.0-rc.0\n', pattern);
    assert.doesNotMatch('@kaelio/ktx 0.0.0-private\n', pattern);
  });
});

describe('buildLocalEmbeddingsSmokeEnv', () => {
  it('isolates the runtime root and model caches inside the smoke root', () => {
    const env = buildLocalEmbeddingsSmokeEnv('/tmp/ktx-local-embedding-smoke', {
      PATH: '/usr/bin',
    });

    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.KTX_RUN_LOCAL_EMBEDDINGS_SMOKE, '1');
    assert.equal(env.KTX_RUNTIME_ROOT, '/tmp/ktx-local-embedding-smoke/managed-runtime');
    assert.equal(env.HF_HOME, '/tmp/ktx-local-embedding-smoke/hf-home');
    assert.equal(env.TRANSFORMERS_CACHE, '/tmp/ktx-local-embedding-smoke/transformers-cache');
    assert.equal(env.SENTENCE_TRANSFORMERS_HOME, '/tmp/ktx-local-embedding-smoke/sentence-transformers-home');
    assert.equal(env.TORCH_HOME, '/tmp/ktx-local-embedding-smoke/torch-home');
  });
});

describe('localEmbeddingsSmokeCommands', () => {
  it('describes the installed-package commands needed for the smoke', () => {
    const commands = localEmbeddingsSmokeCommands({
      projectDir: '/tmp/ktx-local-embedding-smoke/project',
    });

    assert.deepEqual(commands.map((command) => command.label), [
      'ktx public package version',
      'ktx runtime status missing',
      'ktx runtime install local embeddings',
      'ktx runtime status local embeddings ready',
      'ktx runtime start local embeddings',
      'ktx setup local embeddings',
      'ktx runtime stop local embeddings',
    ]);
    assert.deepEqual(commands[2], {
      label: 'ktx runtime install local embeddings',
      command: 'pnpm',
      args: ['exec', 'ktx', 'runtime', 'install', '--feature', 'local-embeddings', '--yes'],
      timeoutMs: 1_200_000,
    });
    assert.deepEqual(commands[4], {
      label: 'ktx runtime start local embeddings',
      command: 'pnpm',
      args: ['exec', 'ktx', 'runtime', 'start', '--feature', 'local-embeddings'],
      timeoutMs: 300_000,
    });
    assert.deepEqual(commands[5].args, [
      'exec',
      'ktx',
      'setup',
      '--project-dir',
      '/tmp/ktx-local-embedding-smoke/project',
      '--new',
      '--no-input',
      '--yes',
      '--skip-llm',
      '--embedding-backend',
      'sentence-transformers',
      '--skip-databases',
      '--skip-sources',
      '--skip-agents',
    ]);
  });
});

describe('parseDaemonBaseUrl', () => {
  it('extracts the daemon URL from runtime start output', () => {
    assert.equal(
      parseDaemonBaseUrl('Started KTX Python daemon\nurl: http://127.0.0.1:61234\nfeatures: local-embeddings\n'),
      'http://127.0.0.1:61234',
    );
  });

  it('rejects output without a daemon URL', () => {
    assert.throws(() => parseDaemonBaseUrl('Started KTX Python daemon\n'), /Daemon URL was not printed/);
  });
});

describe('validateEmbeddingResponse', () => {
  it('accepts a finite embedding vector with the expected dimensions', () => {
    validateEmbeddingResponse({ embedding: [0.1, -0.2, 0.3] }, 3);
  });

  it('rejects a vector with the wrong dimensions', () => {
    assert.throws(
      () => validateEmbeddingResponse({ embedding: [0.1, 0.2] }, 3),
      /Expected embedding dimension 3, got 2/,
    );
  });

  it('rejects non-finite embedding values', () => {
    assert.throws(
      () => validateEmbeddingResponse({ embedding: [0.1, Number.NaN, 0.3] }, 3),
      /Embedding value at index 1 is not a finite number/,
    );
  });
});

describe('package script', () => {
  it('registers the opt-in local embeddings smoke command', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    assert.equal(
      packageJson.scripts['release:local-embeddings-smoke'],
      'node scripts/local-embeddings-runtime-smoke.mjs --require-opt-in',
    );
  });
});
