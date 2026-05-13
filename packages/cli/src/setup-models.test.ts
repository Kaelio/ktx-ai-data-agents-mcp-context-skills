import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject, parseKtxProjectConfig, readKtxSetupState } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUNDLED_ANTHROPIC_MODELS,
  fetchAnthropicModels,
  type KtxSetupModelPromptAdapter,
  runKtxSetupGcloudApplicationDefaultAuth,
  runKtxSetupAnthropicModelStep,
} from './setup-models.js';
import type { KtxCliIo } from './cli-runtime.js';

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
  providerChoice?: string;
  selectValues?: string[];
  credentialChoice?: string;
  modelChoice?: string;
  textValues?: string[];
  passwordValue?: string;
  passwordValues?: Array<string | undefined>;
}): KtxSetupModelPromptAdapter {
  const selectValues = [...(options.selectValues ?? [])];
  const textValues = [...(options.textValues ?? [])];
  const passwordValues = [...(options.passwordValues ?? [])];
  let providerPromptCount = 0;
  return {
    select: vi.fn(async ({ message }) => {
      if (message.includes('LLM provider')) {
        providerPromptCount += 1;
        const nextProviderChoice = selectValues[0];
        if (nextProviderChoice === 'anthropic' || nextProviderChoice === 'vertex' || nextProviderChoice === 'back') {
          return selectValues.shift() ?? nextProviderChoice;
        }
        if (options.credentialChoice === 'back' && providerPromptCount > 1) {
          return 'back';
        }
        return options.providerChoice ?? 'anthropic';
      }
      const nextValue = selectValues.shift();
      if (nextValue) {
        return nextValue;
      }
      if (message.includes('Anthropic API key')) {
        return options.credentialChoice ?? 'env';
      }
      return options.modelChoice ?? 'claude-sonnet-4-6';
    }),
    text: vi.fn(async () => textValues.shift() ?? ''),
    password: vi.fn(
      async () =>
        passwordValues.length > 0 ? passwordValues.shift() : options.passwordValue ?? 'sk-ant-pasted', // pragma: allowlist secret
    ),
    cancel: vi.fn(),
  };
}

describe('setup Anthropic model step', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-models-'));
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('does not expose Claude Sonnet 4 or Claude Opus 4 as selectable Anthropic models', async () => {
    const fetchModels = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4' },
              { id: 'claude-opus-4', display_name: 'Claude Opus 4' },
              { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
              { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
              { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
            ],
          }),
          { status: 200 },
        ),
    );

    await expect(fetchAnthropicModels('sk-ant-test', fetchModels)).resolves.toEqual([ // pragma: allowlist secret
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', recommended: false },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', recommended: false },
    ]);
    expect(BUNDLED_ANTHROPIC_MODELS.map((model) => model.id)).not.toEqual(
      expect.arrayContaining(['claude-sonnet-4', 'claude-opus-4']),
    );
  });

  it('filters Claude Sonnet 4 and Claude Opus 4 from Anthropic model prompt choices', async () => {
    const prompts = makePromptAdapter({ selectValues: ['env', 'back', 'back'] });

    await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      {
        prompts,
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        listModels: vi.fn(async () => [
          { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', recommended: true },
          { id: 'claude-opus-4', label: 'Claude Opus 4', recommended: false },
          { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true },
          { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', recommended: false },
          { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', recommended: false },
        ]),
      },
    );

    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Which Anthropic model should KTX use?'),
        options: [
          { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (recommended)' },
          { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
          { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
          { value: 'manual', label: 'Enter a model ID manually' },
          { value: 'back', label: 'Back' },
        ],
      }),
    );
  });

  it('offers Vertex AI as an Anthropic model provider option', async () => {
    const prompts = makePromptAdapter({ providerChoice: 'back' });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      { prompts, env: {} },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Which LLM provider should KTX use?'),
        options: expect.arrayContaining([
          { value: 'vertex', label: 'Google Vertex AI for Anthropic Claude' },
          { value: 'back', label: 'Back' },
        ]),
      }),
    );
  });

  it('returns from Anthropic credential Back to provider selection', async () => {
    const prompts = makePromptAdapter({ selectValues: ['anthropic', 'back', 'back'] });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      { prompts, env: {} },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        message: expect.stringContaining('Which LLM provider should KTX use?'),
      }),
    );
  });

  it('configures env credentials, selected model, prompt caching, and llm completion state', async () => {
    const io = makeIo();
    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
        anthropicModel: 'claude-sonnet-4-6',
        skipLlm: false,
      },
      io.io,
      {
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        healthCheck: vi.fn(async () => ({ ok: true as const })),
      },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm).toMatchObject({
      provider: {
        backend: 'anthropic',
        anthropic: { api_key: 'env:ANTHROPIC_API_KEY' }, // pragma: allowlist secret
      },
      models: { default: 'claude-sonnet-4-6' },
      promptCaching: { enabled: true },
    });
    expect(config.scan.enrichment.mode).toBe('llm');
    expect(config.setup?.completed_steps).toEqual(undefined);
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('llm');
    expect(io.stdout()).toContain('LLM ready: yes');
    expect(io.stdout()).not.toContain('sk-ant-test');
  });

  it('configures Vertex AI provider, selected model, prompt caching, and llm completion state', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'vertex',
        vertexProject: 'local-gcp-project',
        vertexLocation: 'us-east5',
        anthropicModel: 'claude-sonnet-4-6',
        skipLlm: false,
      },
      io.io,
      { env: {}, healthCheck },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'vertex',
      vertex: { project: 'local-gcp-project', location: 'us-east5' },
      modelSlots: { default: 'claude-sonnet-4-6' },
      promptCaching: { enabled: true, vertexFallbackTo5m: true },
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm).toMatchObject({
      provider: {
        backend: 'vertex',
        vertex: { project: 'local-gcp-project', location: 'us-east5' },
      },
      models: { default: 'claude-sonnet-4-6' },
      promptCaching: { enabled: true, vertexFallbackTo5m: true },
    });
    expect(config.scan.enrichment.mode).toBe('llm');
    expect(config.setup?.completed_steps).toEqual(undefined);
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('llm');
    expect(io.stdout()).toContain('LLM ready: yes (claude-sonnet-4-6)');
  });

  it('can run gcloud auth for Vertex AI and infer project and default location', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['vertex', 'gcloud', 'local-gcp-project', 'claude-sonnet-4-6'] });
    const runGcloudAuth = vi.fn(async () => ({ ok: true as const }));
    const readGcloudProject = vi.fn(async () => 'local-gcp-project');
    const listGcloudProjects = vi.fn(async () => [
      { projectId: 'local-gcp-project', name: 'Local project' },
      { projectId: 'other-gcp-project', name: 'Other project' },
    ]);
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: {},
        runGcloudAuth,
        readGcloudProject,
        listGcloudProjects,
        healthCheck,
      },
    );

    expect(result.status).toBe('ready');
    expect(runGcloudAuth).toHaveBeenCalledWith(io.io);
    expect(readGcloudProject).toHaveBeenCalled();
    expect(listGcloudProjects).toHaveBeenCalled();
    expect(prompts.text).not.toHaveBeenCalled();
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Which Google Cloud project should KTX use for Vertex AI?'),
        options: [
          { value: 'local-gcp-project', label: 'local-gcp-project - Local project (current gcloud project)' },
          { value: 'other-gcp-project', label: 'other-gcp-project - Other project' },
          { value: 'manual', label: 'Enter a project ID manually' },
          { value: 'back', label: 'Back' },
        ],
      }),
    );
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'vertex',
      vertex: { project: 'local-gcp-project', location: 'us-east5' },
      modelSlots: { default: 'claude-sonnet-4-6' },
      promptCaching: { enabled: true, vertexFallbackTo5m: true },
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.provider).toMatchObject({
      backend: 'vertex',
      vertex: { project: 'local-gcp-project', location: 'us-east5' },
    });
  });

  it('lets users choose a different visible gcloud project for Vertex AI', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['vertex', 'existing', 'other-gcp-project', 'claude-sonnet-4-6'] });
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: {},
        readGcloudProject: vi.fn(async () => 'current-gcp-project'),
        listGcloudProjects: vi.fn(async () => [
          { projectId: 'current-gcp-project', name: 'Current project' },
          { projectId: 'other-gcp-project', name: 'Other project' },
        ]),
        healthCheck,
      },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'vertex',
      vertex: { project: 'other-gcp-project', location: 'us-east5' },
      modelSlots: { default: 'claude-sonnet-4-6' },
      promptCaching: { enabled: true, vertexFallbackTo5m: true },
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.provider).toMatchObject({
      backend: 'vertex',
      vertex: { project: 'other-gcp-project', location: 'us-east5' },
    });
  });

  it('allows manual Vertex AI project entry when gcloud project listing is empty', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['vertex', 'existing', 'manual', 'claude-sonnet-4-6'],
      textValues: ['manual-gcp-project'],
    });
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: {},
        readGcloudProject: vi.fn(async () => undefined),
        listGcloudProjects: vi.fn(async () => []),
        healthCheck,
      },
    );

    expect(result.status).toBe('ready');
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Which Google Cloud project should KTX use for Vertex AI?'),
        options: [
          { value: 'manual', label: 'Enter a project ID manually' },
          { value: 'back', label: 'Back' },
        ],
      }),
    );
    expect(prompts.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Google Cloud project ID\n│  Press Escape to go back.\n│',
      }),
    );
    expect(healthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        vertex: { project: 'manual-gcp-project', location: 'us-east5' },
      }),
    );
  });

  it('returns from Vertex AI project selection Back to provider selection', async () => {
    const prompts = makePromptAdapter({ selectValues: ['vertex', 'existing', 'back', 'back'] });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      {
        prompts,
        env: {},
        readGcloudProject: vi.fn(async () => 'current-gcp-project'),
        listGcloudProjects: vi.fn(async () => [{ projectId: 'current-gcp-project', name: 'Current project' }]),
      },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        message: expect.stringContaining('Which LLM provider should KTX use?'),
      }),
    );
  });

  it('runs only gcloud application-default login for Vertex AI auth', async () => {
    const io = makeIo();
    const runGcloud = vi.fn(async () => ({ ok: true as const }));

    await expect(runKtxSetupGcloudApplicationDefaultAuth(io.io, runGcloud)).resolves.toEqual({ ok: true });

    expect(runGcloud).toHaveBeenCalledTimes(1);
    expect(runGcloud).toHaveBeenCalledWith(['auth', 'application-default', 'login'], expect.anything());
    expect(runGcloud).not.toHaveBeenCalledWith(['auth', 'login'], expect.anything());
    expect(io.stdout()).toContain('gcloud auth application-default login');
    expect(io.stdout()).not.toContain('gcloud auth login');
  });

  it('indents gcloud auth output inside the setup gutter', async () => {
    const io = makeIo();
    const runGcloud = vi.fn(async (_args: string[], commandIo: KtxCliIo) => {
      commandIo.stdout.write('Your browser has been opened to visit:\n\n    https://accounts.example/auth\n');
      commandIo.stderr.write('Credentials saved to file: [/tmp/application_default_credentials.json]\n');
      return { ok: true as const };
    });

    await expect(runKtxSetupGcloudApplicationDefaultAuth(io.io, runGcloud)).resolves.toEqual({ ok: true });

    expect(io.stdout()).toContain('│  Your browser has been opened to visit:');
    expect(io.stdout()).toContain('│      https://accounts.example/auth');
    expect(io.stderr()).toContain('│  Credentials saved to file: [/tmp/application_default_credentials.json]');
    expect(io.stdout()).not.toContain('\nYour browser has been opened');
  });

  it('explains common Vertex AI Forbidden health-check causes', async () => {
    const io = makeIo();

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'vertex',
        vertexProject: 'kaelio-orbit-looker-20260430',
        vertexLocation: 'us-east5',
        anthropicModel: 'claude-sonnet-4-6',
        skipLlm: false,
      },
      io.io,
      {
        env: {},
        healthCheck: vi.fn(async () => ({ ok: false as const, message: 'Forbidden' })),
      },
    );

    expect(result.status).toBe('failed');
    expect(io.stderr()).toContain('project kaelio-orbit-looker-20260430');
    expect(io.stderr()).toContain('Vertex AI API is enabled');
    expect(io.stderr()).toContain('Anthropic Claude model access');
    expect(io.stderr()).toContain('roles/aiplatform.user');
  });

  it('resolves --anthropic-api-key-file for health checks and stores a file reference', async () => {
    const io = makeIo();
    const secretPath = join(tempDir, 'anthropic-api-key');
    await writeFile(secretPath, 'sk-ant-file', 'utf-8'); // pragma: allowlist secret
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        anthropicApiKeyFile: secretPath,
        anthropicModel: 'claude-sonnet-4-6',
        skipLlm: false,
      },
      io.io,
      { env: {}, healthCheck },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        anthropic: { apiKey: 'sk-ant-file' }, // pragma: allowlist secret
        modelSlots: { default: 'claude-sonnet-4-6' },
      }),
    );
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm).toMatchObject({
      provider: {
        backend: 'anthropic',
        anthropic: { api_key: `file:${secretPath}` }, // pragma: allowlist secret
      },
      models: { default: 'claude-sonnet-4-6' },
    });
    expect(config.setup?.completed_steps).toEqual(undefined);
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('llm');
    expect(io.stdout()).not.toContain('sk-ant-file');
  });

  it('returns missing-input when --anthropic-api-key-file points to a missing file', async () => {
    const io = makeIo();
    const missingSecretPath = join(tempDir, 'missing-anthropic-api-key');
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        anthropicApiKeyFile: missingSecretPath,
        anthropicModel: 'claude-sonnet-4-6',
        skipLlm: false,
      },
      io.io,
      { env: {}, healthCheck },
    );

    expect(result.status).toBe('missing-input');
    expect(healthCheck).not.toHaveBeenCalled();
    expect(io.stderr()).toContain(`Missing Anthropic API key file: ${missingSecretPath}`);
  });

  it('does not recommend skipping when non-interactive setup is missing an Anthropic credential source', async () => {
    const io = makeIo();

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'disabled', skipLlm: false },
      io.io,
    );

    expect(result.status).toBe('missing-input');
    expect(io.stderr()).toContain(
      'Missing Anthropic API key: pass --anthropic-api-key-env or --anthropic-api-key-file.',
    );
    expect(io.stderr()).not.toContain('--skip-llm');
  });

  it('does not recommend skipping when non-interactive setup is missing an Anthropic model', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
        skipLlm: false,
      },
      io.io,
      { env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, healthCheck }, // pragma: allowlist secret
    );

    expect(result.status).toBe('missing-input');
    expect(healthCheck).not.toHaveBeenCalled();
    expect(io.stderr()).toContain('Missing Anthropic model: pass --anthropic-model.');
    expect(io.stderr()).not.toContain('--skip-llm');
  });

  it('writes pasted keys to .ktx/secrets and never prints the key', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      credentialChoice: 'paste',
      modelChoice: 'claude-sonnet-4-6',
      passwordValue: 'sk-ant-pasted', // pragma: allowlist secret
    });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: {},
        listModels: vi.fn(async () => [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true }]),
        healthCheck: vi.fn(async () => ({ ok: true as const })),
      },
    );

    expect(result.status).toBe('ready');
    await expect(readFile(join(tempDir, '.ktx/secrets/anthropic-api-key'), 'utf-8')).resolves.toBe('sk-ant-pasted\n'); // pragma: allowlist secret
    if (process.platform !== 'win32') {
      expect((await stat(join(tempDir, '.ktx/secrets/anthropic-api-key'))).mode & 0o777).toBe(0o600);
    }
    const yaml = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    expect(yaml).toContain('api_key: file:');
    expect(yaml).not.toContain('sk-ant-pasted');
    expect(io.stdout()).not.toContain('sk-ant-pasted');
  });

  it('opens pasted key entry directly and tells users Escape goes back', async () => {
    const prompts = makePromptAdapter({
      selectValues: ['paste', 'claude-sonnet-4-6'],
      passwordValue: 'sk-ant-pasted', // pragma: allowlist secret
    });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      {
        prompts,
        env: {},
        listModels: vi.fn(async () => [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true }]),
        healthCheck: vi.fn(async () => ({ ok: true as const })),
      },
    );

    expect(result.status).toBe('ready');
    expect(prompts.select).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Paste Anthropic API key now?' }));
    expect(prompts.password).toHaveBeenCalledWith({
      message: 'Anthropic API key\n│  Press Escape to go back.\n│',
    });
  });

  it('does not offer skipping while choosing an Anthropic credential source', async () => {
    const prompts = makePromptAdapter({ credentialChoice: 'back' });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      { prompts, env: {} },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('How should KTX find your Anthropic API key?'),
        options: expect.not.arrayContaining([expect.objectContaining({ value: 'skip' })]),
      }),
    );
  });

  it('explains why KTX asks for an Anthropic API key', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ credentialChoice: 'back' });
    const expectedPromptMessage = [
      'How should KTX find your Anthropic API key?',
      '',
      [
        'KTX uses the key to verify Anthropic model access now and to run ingest agents that turn schemas, SQL,',
        'BI metadata, and docs into semantic-layer sources and wiki context. ktx.yaml stores an env: or file:',
        'reference, not the raw key.',
      ].join(' '),
    ].join('\n');

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      { prompts, env: {} },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expectedPromptMessage,
      }),
    );
    expect(io.stdout()).not.toContain('KTX uses the key');
  });

  it('does not offer skipping while choosing an Anthropic model', async () => {
    const prompts = makePromptAdapter({ selectValues: ['env', 'back', 'back'] });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      {
        prompts,
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        listModels: vi.fn(async () => [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true }]),
      },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Which Anthropic model should KTX use?'),
        options: expect.not.arrayContaining([expect.objectContaining({ value: 'skip' })]),
      }),
    );
  });

  it('explains why KTX asks for an Anthropic model', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ credentialChoice: 'env', modelChoice: 'claude-sonnet-4-6' });
    const expectedPromptMessage = [
      'Which Anthropic model should KTX use?',
      '',
      [
        'KTX uses this as the default model for ingest agents that turn schemas, SQL, BI metadata, and docs',
        'into semantic-layer sources and wiki context.',
      ].join(' '),
    ].join('\n');

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        listModels: vi.fn(async () => [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true }]),
        healthCheck: vi.fn(async () => ({ ok: true as const })),
      },
    );

    expect(result.status).toBe('ready');
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expectedPromptMessage,
      }),
    );
    expect(io.stdout()).not.toContain('KTX uses this as the default model');
    expect(io.stdout()).not.toContain('Setup verifies the selected model now');
  });

  it('uses the bundled fallback registry when live discovery fails', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ credentialChoice: 'env', modelChoice: 'claude-sonnet-4-6' });

    await expect(
      runKtxSetupAnthropicModelStep({ projectDir: tempDir, inputMode: 'auto', skipLlm: false }, io.io, {
        prompts,
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        listModels: vi.fn(async () => {
          throw new Error('network unavailable');
        }),
        healthCheck: vi.fn(async () => ({ ok: true as const })),
      }),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(io.stderr()).toContain('Could not fetch live Anthropic models. Showing bundled defaults.');
  });

  it('shows bundled model choices when live discovery fails', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['env', 'manual'], textValues: [''] });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        listModels: vi.fn(async () => {
          throw new Error('network unavailable');
        }),
        healthCheck: vi.fn(async () => ({ ok: true as const })),
      },
    );

    expect(result.status).toBe('missing-input');
    expect(BUNDLED_ANTHROPIC_MODELS.length).toBeGreaterThan(0);
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Which Anthropic model should KTX use?'),
        options: expect.arrayContaining([
          { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (recommended)' },
        ]),
      }),
    );
    expect(prompts.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Anthropic model ID\n│  Press Escape to go back.\n│',
        placeholder: 'claude-sonnet-4-6',
      }),
    );
  });

  it('reports invalid Anthropic API keys during live discovery instead of showing bundled defaults', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['env', 'back'] });
    const fetchModels = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }),
    );
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: { ANTHROPIC_API_KEY: 'sk-ant-invalid' }, // pragma: allowlist secret
        fetch: fetchModels,
        healthCheck,
      },
    );

    expect(result.status).toBe('back');
    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(healthCheck).not.toHaveBeenCalled();
    expect(io.stderr()).toContain('Anthropic API key is invalid or unauthorized');
    expect(io.stderr()).toContain('Choose a different credential source or Back.');
    expect(io.stderr()).not.toContain('Could not fetch live Anthropic models. Showing bundled defaults.');
    expect(io.stderr()).not.toContain('sk-ant-invalid');
  });

  it('does not persist llm completion when the health check fails', async () => {
    const io = makeIo();
    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
        anthropicModel: 'claude-sonnet-4-6',
        skipLlm: false,
      },
      io.io,
      {
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        healthCheck: vi.fn(async () => ({ ok: false as const, message: '401 invalid x-api-key [redacted]' })),
      },
    );

    expect(result.status).toBe('failed');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.setup?.completed_steps ?? []).not.toContain('llm');
    expect(io.stderr()).toContain('Anthropic model health check failed: 401 invalid x-api-key [redacted]');
    expect(io.stderr()).not.toContain('sk-ant-test');
  });

  it('re-prompts after an interactive health-check failure and saves after retry success', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['env', 'claude-haiku-3-5', 'env', 'claude-sonnet-4-6'],
    });
    const healthCheck = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, message: 'model not found' })
      .mockResolvedValueOnce({ ok: true as const });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        listModels: vi.fn(async () => [
          { id: 'claude-haiku-3-5', label: 'Claude Haiku 3.5', recommended: false },
          { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true },
        ]),
        healthCheck,
      },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledTimes(2);
    expect(prompts.select).toHaveBeenCalledTimes(5);
    expect(io.stderr()).toContain('Anthropic model health check failed: model not found');
    expect(io.stderr()).toContain('Choose a different credential source or model, or Back.');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.models.default).toBe('claude-sonnet-4-6');
    expect(config.setup?.completed_steps).toEqual(undefined);
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('llm');
    expect(io.stderr()).not.toContain('sk-ant-test');
  });

  it('leaves setup incomplete when skipped', async () => {
    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'disabled', skipLlm: true },
      makeIo().io,
    );

    expect(result.status).toBe('skipped');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.setup?.completed_steps ?? []).not.toContain('llm');
  });

  it('returns back without writing config when Back is selected', async () => {
    const prompts = makePromptAdapter({ credentialChoice: 'back' });
    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      { prompts, env: {} },
    );

    expect(result.status).toBe('back');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.provider.backend).toBe('none');
  });

  it('returns from model selection Back to credential selection instead of exiting setup', async () => {
    const prompts = makePromptAdapter({
      selectValues: ['paste', 'back', 'back'],
      passwordValue: 'sk-ant-pasted', // pragma: allowlist secret
    });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      {
        prompts,
        env: {},
        listModels: vi.fn(async () => [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true }]),
        healthCheck: vi.fn(async () => ({ ok: true as const })),
      },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        message: expect.stringContaining('How should KTX find your Anthropic API key?'),
      }),
    );
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.provider.backend).toBe('none');
  });

  it('returns from pasted key entry Escape to credential selection and can use env credentials', async () => {
    const prompts = makePromptAdapter({
      selectValues: ['paste', 'env', 'claude-sonnet-4-6'],
      passwordValues: [undefined],
    });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      {
        prompts,
        env: { ANTHROPIC_API_KEY: 'sk-ant-env' }, // pragma: allowlist secret
        listModels: vi.fn(async () => [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true }]),
        healthCheck: vi.fn(async () => ({ ok: true as const })),
      },
    );

    expect(result.status).toBe('ready');
    expect(prompts.password).toHaveBeenCalledWith({
      message: 'Anthropic API key\n│  Press Escape to go back.\n│',
    });
    await expect(readFile(join(tempDir, '.ktx/secrets/anthropic-api-key'), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.provider).toMatchObject({
      backend: 'anthropic',
      anthropic: { api_key: 'env:ANTHROPIC_API_KEY' }, // pragma: allowlist secret
    });
  });

  it('preserves already completed llm setup when no model args request changes', async () => {
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
        'connections: {}',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '    anthropic:',
        '      api_key: env:ANTHROPIC_API_KEY', // pragma: allowlist secret
        '  models:',
        '    default: claude-sonnet-4-6',
        'ingest:',
        '  embeddings:',
        '    backend: deterministic',
        '    model: deterministic',
        '    dimensions: 8',
      ].join('\n'),
      'utf-8',
    );

    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    await expect(
      runKtxSetupAnthropicModelStep({ projectDir: tempDir, inputMode: 'disabled', skipLlm: false }, makeIo().io, {
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        healthCheck,
      }),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it.each([
    {
      backend: 'vertex',
      providerLines: ['    backend: vertex', '    vertex:', '      project: kaelio-dev', '      location: us-east5'],
      model: 'claude-sonnet-4-6',
    },
    {
      backend: 'gateway',
      providerLines: ['    backend: gateway', '    gateway:', '      api_key: env:AI_GATEWAY_API_KEY'],
      model: 'anthropic/claude-sonnet-4-6',
    },
  ])('preserves already configured $backend llm setup without asking for Anthropic credentials', async (fixture) => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: warehouse',
        'setup:',
        '  database_connection_ids: []',
        '  completed_steps:',
        '    - project',
        '    - llm',
        'connections: {}',
        'llm:',
        '  provider:',
        ...fixture.providerLines,
        '  models:',
        `    default: ${fixture.model}`,
        'ingest:',
        '  embeddings:',
        '    backend: deterministic',
        '    model: deterministic',
        '    dimensions: 8',
      ].join('\n'),
      'utf-8',
    );

    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const io = makeIo();
    await expect(
      runKtxSetupAnthropicModelStep({ projectDir: tempDir, inputMode: 'disabled', skipLlm: false }, io.io, {
        healthCheck,
      }),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(healthCheck).not.toHaveBeenCalled();
    expect(io.stdout()).toContain(`LLM ready: yes (${fixture.model})`);
    expect(io.stderr()).not.toContain('Anthropic');
  });
});
