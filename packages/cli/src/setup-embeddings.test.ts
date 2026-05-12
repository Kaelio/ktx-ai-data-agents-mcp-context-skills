import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject, parseKtxProjectConfig, readKtxSetupState } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type KtxSetupEmbeddingsPromptAdapter, runKtxSetupEmbeddingsStep } from './setup-embeddings.js';

const EMBEDDING_OPTION_PROMPT_MESSAGE = [
  'Which embedding option should KTX use?',
  '',
  'KTX uses embeddings for semantic search over semantic-layer sources, wiki context, schema metadata, ' +
    'and relationship evidence.',
].join('\n');

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: true,
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

function makePromptAdapter(options: {
  selectValues?: string[];
  passwordValue?: string;
}): KtxSetupEmbeddingsPromptAdapter {
  const selectValues = [...(options.selectValues ?? [])];
  return {
    select: vi.fn(async () => selectValues.shift() ?? 'retry'),
    password: vi.fn(async () => options.passwordValue ?? 'embedding-secret'),
    cancel: vi.fn(),
  };
}

function managedDaemon(baseUrl = 'http://127.0.0.1:61234') {
  return {
    baseUrl,
    env: {
      KTX_MANAGED_SENTENCE_TRANSFORMERS_BASE_URL: baseUrl,
    },
  };
}

describe('setup embeddings step', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-embeddings-'));
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('explains why interactive users choose an embedding option before validating embeddings', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const prompts = makePromptAdapter({ selectValues: ['back'] });

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      { prompts, env: {}, healthCheck },
    );

    expect(result.status).toBe('back');
    expect(healthCheck).not.toHaveBeenCalled();
    expect(prompts.select).toHaveBeenCalledWith({
      message: EMBEDDING_OPTION_PROMPT_MESSAGE,
      options: [
        { value: 'sentence-transformers', label: 'Local sentence-transformers embeddings' },
        { value: 'openai', label: 'OpenAI embeddings (recommended)' },
        { value: 'back', label: 'Back' },
      ],
    });
  });

  it('returns from the OpenAI credential prompt to embedding option selection when Back is selected', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const prompts = makePromptAdapter({ selectValues: ['openai', 'back', 'sentence-transformers'] });

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      { prompts, env: {}, healthCheck, ensureLocalEmbeddings: vi.fn(async () => managedDaemon()) },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledTimes(1);
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://127.0.0.1:61234', pathPrefix: '' },
    });
    expect(vi.mocked(prompts.select).mock.calls.map((call) => call[0].message)).toEqual([
      EMBEDDING_OPTION_PROMPT_MESSAGE,
      'How should KTX find your OpenAI embedding API key?',
      EMBEDDING_OPTION_PROMPT_MESSAGE,
    ]);
  });

  it('configures local sentence-transformers embeddings after interactive selection', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const prompts = makePromptAdapter({ selectValues: ['sentence-transformers'] });
    const ensureLocalEmbeddings = vi.fn(async () => managedDaemon());

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      { prompts, env: {}, healthCheck, ensureLocalEmbeddings },
    );

    expect(result.status).toBe('ready');
    expect(ensureLocalEmbeddings).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: io.io,
    });
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://127.0.0.1:61234', pathPrefix: '' },
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.ingest.embeddings).toMatchObject({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { base_url: 'managed:local-embeddings', pathPrefix: '' },
    });
    expect(config.scan.enrichment.embeddings).toMatchObject(config.ingest.embeddings);
    expect(config.setup?.completed_steps).toEqual(undefined);
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('embeddings');
    expect(io.stdout()).toContain(
      'Testing local sentence-transformers embeddings (all-MiniLM-L6-v2, 384 dimensions). First run may take up to 60 seconds.',
    );
    expect(io.stdout()).toContain('Embeddings ready: yes');
  });

  it('shows live progress while local sentence-transformers embeddings are being tested', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['sentence-transformers'] });
    let resolveHealthCheck: ((result: { ok: true }) => void) | undefined;
    const healthCheck = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveHealthCheck = resolve;
        }),
    );

    const result = runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      { prompts, env: {}, healthCheck, ensureLocalEmbeddings: vi.fn(async () => managedDaemon()) },
    );

    await vi.waitFor(() => {
      expect(io.stdout()).toContain(
        '\r- Testing local sentence-transformers embeddings (all-MiniLM-L6-v2, 384 dimensions). First run may take up to 60 seconds.',
      );
    });

    expect(resolveHealthCheck).toBeDefined();
    resolveHealthCheck?.({ ok: true });
    await expect(result).resolves.toMatchObject({ status: 'ready' });
  });

  it('uses default local sentence-transformers embeddings in non-interactive setup', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      { env: {}, healthCheck, ensureLocalEmbeddings: vi.fn(async () => managedDaemon()) },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://127.0.0.1:61234', pathPrefix: '' },
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.ingest.embeddings).toMatchObject({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { base_url: 'managed:local-embeddings', pathPrefix: '' },
    });
    expect(config.scan.enrichment.embeddings).toMatchObject(config.ingest.embeddings);
    expect(config.setup?.completed_steps).toEqual(undefined);
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('embeddings');
  });

  it('fails non-interactive local setup when the managed local embeddings runtime is missing', async () => {
    const io = makeIo();
    const ensureLocalEmbeddings = vi.fn(async () => {
      throw new Error(
        'KTX Python runtime is required for this command. Run: ktx dev runtime install --feature local-embeddings --yes',
      );
    });

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'never',
        skipEmbeddings: false,
      },
      io.io,
      { env: {}, ensureLocalEmbeddings },
    );

    expect(result.status).toBe('failed');
    expect(io.stderr()).toContain(
      'KTX Python runtime is required for this command. Run: ktx dev runtime install --feature local-embeddings --yes',
    );
  });

  it('does not persist embedding completion when the health check fails', async () => {
    const io = makeIo();
    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      {
        env: {},
        ensureLocalEmbeddings: vi.fn(async () => managedDaemon()),
        healthCheck: vi.fn(async () => ({ ok: false as const, message: '401 invalid api key [redacted]' })),
      },
    );

    expect(result.status).toBe('failed');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.setup?.completed_steps ?? []).not.toContain('embeddings');
    expect(config.ingest.embeddings.backend).toBe('deterministic');
    expect(io.stderr()).toContain('Local embedding health check failed: 401 invalid api key [redacted]');
    expect(io.stderr()).toContain('Prepare the runtime with: ktx dev runtime start --feature local-embeddings');
    expect(io.stderr()).not.toContain('skip for now');
  });

  it('uses fixed OpenAI defaults and only asks for credentials when OpenAI is selected', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        embeddingBackend: 'openai',
        embeddingApiKeyEnv: 'OPENAI_API_KEY',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      {
        env: { OPENAI_API_KEY: 'sk-openai-test' },
        healthCheck,
      },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      openai: { apiKey: 'sk-openai-test' },
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.ingest.embeddings).toMatchObject({
      backend: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      openai: { api_key: 'env:OPENAI_API_KEY' },
    });
    expect(io.stdout()).not.toContain('sk-openai-test');
  });

  it('can fall back to OpenAI after the default local daemon is unavailable', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['sentence-transformers', 'openai', 'env'] });
    const healthCheck = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, message: 'fetch failed' })
      .mockResolvedValueOnce({ ok: true as const });

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      {
        prompts,
        env: { OPENAI_API_KEY: 'sk-openai-test' },
        healthCheck,
        ensureLocalEmbeddings: vi.fn(async () => managedDaemon()),
      },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenNthCalledWith(1, {
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://127.0.0.1:61234', pathPrefix: '' },
    });
    expect(healthCheck).toHaveBeenNthCalledWith(2, {
      backend: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      openai: { apiKey: 'sk-openai-test' },
    });
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Local embeddings are not reachable. Start the local KTX daemon, then retry.',
        options: expect.arrayContaining([expect.objectContaining({ value: 'openai' })]),
      }),
    );
    expect(vi.mocked(prompts.select).mock.calls[1]?.[0].options).toEqual([
      { value: 'retry', label: 'Retry' },
      { value: 'openai', label: 'Use OpenAI embeddings' },
      { value: 'back', label: 'Back' },
    ]);
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.ingest.embeddings.backend).toBe('openai');
  });

  it('leaves setup incomplete when skipped', async () => {
    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: true,
      },
      makeIo().io,
    );

    expect(result.status).toBe('skipped');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.setup?.completed_steps ?? []).not.toContain('embeddings');
    expect(config.ingest.embeddings.backend).toBe('deterministic');
  });

  it('returns back without writing config when the local health check fails and Back is selected', async () => {
    const prompts = makePromptAdapter({ selectValues: ['sentence-transformers', 'back'] });
    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      makeIo().io,
      {
        prompts,
        env: {},
        ensureLocalEmbeddings: vi.fn(async () => managedDaemon()),
        healthCheck: vi.fn(async () => ({ ok: false as const, message: 'daemon unavailable' })),
      },
    );

    expect(result.status).toBe('back');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.ingest.embeddings.backend).toBe('deterministic');
  });

  it('preserves already completed embeddings setup when no embedding args request changes', async () => {
    await mkdir(join(tempDir, '.ktx'), { recursive: true });
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse', force: true });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: warehouse',
        'setup:',
        '  database_connection_ids: []',
        '  completed_steps:',
        '    - project',
        '    - llm',
        '    - embeddings',
        'connections: {}',
        'ingest:',
        '  embeddings:',
        '    backend: sentence-transformers',
        '    model: all-MiniLM-L6-v2',
        '    dimensions: 384',
        '    sentenceTransformers:',
        '      base_url: http://127.0.0.1:8765',
        "      pathPrefix: ''",
      ].join('\n'),
      'utf-8',
    );

    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    await expect(
      runKtxSetupEmbeddingsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
          skipEmbeddings: false,
        },
        makeIo().io,
        {
          env: { OPENAI_API_KEY: 'sk-openai-test' },
          healthCheck,
        },
      ),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(healthCheck).not.toHaveBeenCalled();
  });
});
