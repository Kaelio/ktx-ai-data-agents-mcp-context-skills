import { writeFile } from 'node:fs/promises';
import { cancel, isCancel, password, select, text } from '@clack/prompts';
import { resolveLocalKtxLlmConfig } from '@ktx/context';
import { resolveKtxConfigReference } from '@ktx/context/core';
import {
  type KtxProjectConfig,
  type KtxProjectLlmConfig,
  loadKtxProject,
  markKtxSetupStepComplete,
  serializeKtxProjectConfig,
} from '@ktx/context/project';
import { type KtxLlmConfig, type KtxLlmHealthCheckResult, runKtxLlmHealthCheck } from '@ktx/llm';
import type { KtxCliIo } from './cli-runtime.js';
import { withMenuOptionsSpacing, withTextInputNavigation } from './prompt-navigation.js';
import { withSetupInterruptConfirmation } from './setup-interrupt.js';
import { envCredentialReference, writeProjectLocalSecretReference } from './setup-secrets.js';

export interface KtxSetupModelArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  anthropicApiKeyEnv?: string;
  anthropicApiKeyFile?: string;
  anthropicModel?: string;
  forcePrompt?: boolean;
  showPromptInstructions?: boolean;
  skipLlm: boolean;
}

export type KtxSetupModelResult =
  | { status: 'ready'; projectDir: string }
  | { status: 'skipped'; projectDir: string }
  | { status: 'back'; projectDir: string }
  | { status: 'missing-input'; projectDir: string }
  | { status: 'failed'; projectDir: string };

export interface AnthropicModelChoice {
  id: string;
  label: string;
  recommended: boolean;
}

export interface KtxSetupModelPromptAdapter {
  select(options: { message: string; options: Array<{ value: string; label: string }> }): Promise<string>;
  text(options: { message: string; placeholder?: string }): Promise<string | undefined>;
  password(options: { message: string }): Promise<string | undefined>;
  cancel(message: string): void;
}

export interface KtxSetupModelDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  prompts?: KtxSetupModelPromptAdapter;
  listModels?: (apiKey: string) => Promise<AnthropicModelChoice[]>;
  healthCheck?: (config: KtxLlmConfig) => Promise<KtxLlmHealthCheckResult>;
}

export const BUNDLED_ANTHROPIC_MODEL_REGISTRY_VERSION = '2026-05-07';

export const BUNDLED_ANTHROPIC_MODELS: AnthropicModelChoice[] = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', recommended: false },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', recommended: false },
];

const HIDDEN_ANTHROPIC_MODEL_PATTERNS = [
  /^claude-sonnet-4$/i,
  /^claude-opus-4$/i,
  /^Claude Sonnet 4$/i,
  /^Claude Opus 4$/i,
];

const ANTHROPIC_CREDENTIAL_PROMPT_CONTEXT =
  'KTX uses the key to verify Anthropic model access now and to run ingest agents that turn schemas, SQL, ' +
  'BI metadata, and docs into semantic-layer sources and wiki context. ktx.yaml stores an env: or file: ' +
  'reference, not the raw key.';

const ANTHROPIC_MODEL_PROMPT_CONTEXT =
  'KTX uses this as the default model for ingest agents that turn schemas, SQL, BI metadata, and docs ' +
  'into semantic-layer sources and wiki context.';

type AnthropicModelDiscoveryErrorReason = 'authentication' | 'http' | 'empty-response';

export class AnthropicModelDiscoveryError extends Error {
  constructor(
    message: string,
    public readonly reason: AnthropicModelDiscoveryErrorReason,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AnthropicModelDiscoveryError';
  }
}

function isAnthropicModelAuthenticationError(error: unknown): error is AnthropicModelDiscoveryError {
  return error instanceof AnthropicModelDiscoveryError && error.reason === 'authentication';
}

function isSelectableAnthropicModel(model: AnthropicModelChoice): boolean {
  return !HIDDEN_ANTHROPIC_MODEL_PATTERNS.some((pattern) => pattern.test(model.id) || pattern.test(model.label));
}

type ChooseModelResult =
  | { status: 'ready'; model: string }
  | { status: 'back' | 'missing-input' | 'invalid-credential' };

function createPromptAdapter(): KtxSetupModelPromptAdapter {
  return {
    async select(options) {
      const value = await withSetupInterruptConfirmation(() => select(withMenuOptionsSpacing(options)));
      if (isCancel(value)) {
        cancel('Setup cancelled.');
        return 'back';
      }
      return value;
    },
    async text(options) {
      const value = await withSetupInterruptConfirmation(() =>
        text({ ...options, message: withTextInputNavigation(options.message) }),
      );
      return isCancel(value) ? undefined : value;
    },
    async password(options) {
      const value = await withSetupInterruptConfirmation(() =>
        password({ ...options, message: withTextInputNavigation(options.message) }),
      );
      return isCancel(value) ? undefined : value;
    },
    cancel(message) {
      cancel(message);
    },
  };
}

export async function fetchAnthropicModels(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<AnthropicModelChoice[]> {
  const response = await fetchFn('https://api.anthropic.com/v1/models?limit=1000', {
    headers: {
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new AnthropicModelDiscoveryError(
        `Anthropic model discovery failed with HTTP ${response.status}`,
        'authentication',
        response.status,
      );
    }
    throw new AnthropicModelDiscoveryError(
      `Anthropic model discovery failed with HTTP ${response.status}`,
      'http',
      response.status,
    );
  }
  const body = (await response.json()) as { data?: Array<{ id?: unknown; display_name?: unknown; type?: unknown }> };
  const models = (body.data ?? [])
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : '',
      label: typeof item.display_name === 'string' ? item.display_name : typeof item.id === 'string' ? item.id : '',
      recommended: false,
    }))
    .filter((item) => item.id.startsWith('claude-'))
    .filter(isSelectableAnthropicModel);
  if (models.length === 0) {
    throw new AnthropicModelDiscoveryError('Anthropic model discovery returned no Claude models', 'empty-response');
  }
  const recommendedIndex = models.findIndex((item) => item.id.includes('sonnet'));
  return models.map((item, index) => ({ ...item, recommended: index === Math.max(recommendedIndex, 0) }));
}

export function isKtxSetupLlmConfigReady(config: KtxProjectLlmConfig): boolean {
  let resolved: KtxLlmConfig | null;
  try {
    resolved = resolveLocalKtxLlmConfig(config, process.env);
  } catch {
    return false;
  }
  if (!resolved) {
    return false;
  }

  if (resolved.backend === 'vertex') {
    return typeof resolved.vertex?.location === 'string' && resolved.vertex.location.trim().length > 0;
  }

  return resolved.backend === 'anthropic' || resolved.backend === 'gateway';
}

function hasUsableConfiguredLlm(config: KtxProjectConfig): boolean {
  return isKtxSetupLlmConfigReady(config.llm);
}

function buildProjectLlmConfig(
  existing: KtxProjectLlmConfig,
  credentialRef: string,
  model: string,
): KtxProjectLlmConfig {
  return {
    provider: {
      backend: 'anthropic',
      anthropic: { api_key: credentialRef },
    },
    models: { ...existing.models, default: model },
    promptCaching: { ...(existing.promptCaching ?? {}), enabled: true },
  };
}

function buildHealthConfig(credentialValue: string, model: string): KtxLlmConfig {
  return {
    backend: 'anthropic',
    anthropic: { apiKey: credentialValue },
    modelSlots: { default: model },
    promptCaching: { enabled: true },
  };
}

async function chooseCredentialRef(
  args: KtxSetupModelArgs,
  io: KtxCliIo,
  deps: KtxSetupModelDeps,
): Promise<{ status: 'ready'; ref: string; value: string } | { status: 'back' | 'missing-input' }> {
  const env = deps.env ?? process.env;
  if (args.anthropicApiKeyEnv) {
    const ref = envCredentialReference(args.anthropicApiKeyEnv);
    const value = resolveKtxConfigReference(ref, env);
    if (!value) {
      io.stderr.write(`Missing Anthropic API key: ${args.anthropicApiKeyEnv} is not set.\n`);
      return { status: 'missing-input' };
    }
    return { status: 'ready', ref, value };
  }
  if (args.anthropicApiKeyFile) {
    const ref = `file:${args.anthropicApiKeyFile}`;
    let value: string | undefined;
    try {
      value = resolveKtxConfigReference(ref, env);
    } catch {
      value = undefined;
    }
    if (!value) {
      io.stderr.write(`Missing Anthropic API key file: ${args.anthropicApiKeyFile}\n`);
      return { status: 'missing-input' };
    }
    return { status: 'ready', ref, value };
  }
  if (args.inputMode === 'disabled') {
    io.stderr.write('Missing Anthropic API key: pass --anthropic-api-key-env or --anthropic-api-key-file.\n');
    return { status: 'missing-input' };
  }

  const prompts = deps.prompts ?? createPromptAdapter();
  if (args.showPromptInstructions !== false) {
    io.stdout.write(
      'Use Up/Down to move, Enter to confirm the current selection, choose Back to return to the previous step, Ctrl+C to exit.\n',
    );
  }
  while (true) {
    const choice = await prompts.select({
      message: `How should KTX find your Anthropic API key?\n\n${ANTHROPIC_CREDENTIAL_PROMPT_CONTEXT}`,
      options: [
        { value: 'env', label: 'Use ANTHROPIC_API_KEY from the environment' },
        { value: 'paste', label: 'Paste a key and save it as a local secret file' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') {
      return { status: 'back' };
    }
    if (choice === 'paste') {
      io.stdout.write(
        'KTX will save the key in .ktx/secrets/anthropic-api-key with local file permissions, then write a file: reference in ktx.yaml.\n',
      );
      const value = await prompts.password({ message: withTextInputNavigation('Anthropic API key') });
      if (value === undefined) {
        continue;
      }
      if (!value.trim()) {
        return { status: 'missing-input' };
      }
      const ref = await writeProjectLocalSecretReference({
        projectDir: args.projectDir,
        fileName: 'anthropic-api-key',
        value,
      });
      return { status: 'ready', ref, value: value.trim() };
    }

    const ref = envCredentialReference('ANTHROPIC_API_KEY');
    const value = resolveKtxConfigReference(ref, env);
    if (!value) {
      io.stderr.write('Missing Anthropic API key: ANTHROPIC_API_KEY is not set.\n');
      return { status: 'missing-input' };
    }
    return { status: 'ready', ref, value };
  }
}

async function chooseModel(
  args: KtxSetupModelArgs,
  credentialValue: string,
  io: KtxCliIo,
  deps: KtxSetupModelDeps,
): Promise<ChooseModelResult> {
  if (args.anthropicModel) {
    return { status: 'ready', model: args.anthropicModel };
  }
  if (args.inputMode === 'disabled') {
    io.stderr.write('Missing Anthropic model: pass --anthropic-model.\n');
    return { status: 'missing-input' };
  }

  let models: AnthropicModelChoice[];
  try {
    models = deps.listModels
      ? await deps.listModels(credentialValue)
      : await fetchAnthropicModels(credentialValue, deps.fetch);
  } catch (error) {
    if (isAnthropicModelAuthenticationError(error)) {
      const statusSuffix = error.status ? ` (HTTP ${error.status})` : '';
      io.stderr.write(`Anthropic API key is invalid or unauthorized${statusSuffix}. Check the key and try again.\n`);
      return { status: 'invalid-credential' };
    }
    io.stderr.write(
      'Could not fetch live Anthropic models. Showing bundled defaults. Setup will still test the selected model before saving it.\n',
    );
    models = BUNDLED_ANTHROPIC_MODELS;
  }

  const selectableModels = models.filter(isSelectableAnthropicModel);
  const prompts = deps.prompts ?? createPromptAdapter();
  const modelOptions = [
    ...selectableModels.map((model) => ({
      value: model.id,
      label: `${model.label || model.id}${model.recommended ? ' (recommended)' : ''}`,
    })),
    { value: 'manual', label: 'Enter a model ID manually' },
    { value: 'back', label: 'Back' },
  ];
  const choice = await prompts.select({
    message: `Which Anthropic model should KTX use?\n\n${ANTHROPIC_MODEL_PROMPT_CONTEXT}`,
    options: modelOptions,
  });
  if (choice === 'back') {
    return { status: 'back' };
  }
  if (choice === 'manual') {
    const manual = await prompts.text({
      message: withTextInputNavigation('Anthropic model ID'),
      placeholder: selectableModels.find((model) => model.recommended)?.id ?? selectableModels[0]?.id,
    });
    if (manual === undefined) {
      return { status: 'back' };
    }
    return manual.trim() ? { status: 'ready', model: manual.trim() } : { status: 'missing-input' };
  }
  return { status: 'ready', model: choice };
}

async function persistLlmConfig(projectDir: string, credentialRef: string, model: string): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  const config = markKtxSetupStepComplete(
    {
      ...project.config,
      llm: buildProjectLlmConfig(project.config.llm, credentialRef, model),
      scan: {
        ...project.config.scan,
        enrichment: {
          ...project.config.scan.enrichment,
          mode: 'llm',
        },
      },
    },
    'llm',
  );
  await writeFile(project.configPath, serializeKtxProjectConfig(config), 'utf-8');
}

function buildInteractiveRetryArgs(args: KtxSetupModelArgs): KtxSetupModelArgs {
  return {
    projectDir: args.projectDir,
    inputMode: args.inputMode,
    ...(args.showPromptInstructions !== undefined ? { showPromptInstructions: args.showPromptInstructions } : {}),
    skipLlm: args.skipLlm,
  };
}

export async function runKtxSetupAnthropicModelStep(
  args: KtxSetupModelArgs,
  io: KtxCliIo,
  deps: KtxSetupModelDeps = {},
): Promise<KtxSetupModelResult> {
  if (args.skipLlm) {
    io.stdout.write('LLM setup skipped.\n');
    return { status: 'skipped', projectDir: args.projectDir };
  }

  const project = await loadKtxProject({ projectDir: args.projectDir });
  if (
    args.forcePrompt !== true &&
    hasUsableConfiguredLlm(project.config) &&
    !args.anthropicApiKeyEnv &&
    !args.anthropicApiKeyFile &&
    !args.anthropicModel
  ) {
    io.stdout.write(`LLM ready: yes (${project.config.llm.models.default})\n`);
    return { status: 'ready', projectDir: args.projectDir };
  }

  const healthCheck = deps.healthCheck ?? ((config: KtxLlmConfig) => runKtxLlmHealthCheck(config));
  let attemptArgs = args;

  while (true) {
    const credential = await chooseCredentialRef(attemptArgs, io, deps);
    if (credential.status !== 'ready') {
      return { status: credential.status, projectDir: args.projectDir };
    }

    const model = await chooseModel(attemptArgs, credential.value, io, deps);
    if (model.status === 'invalid-credential') {
      if (args.inputMode === 'disabled') {
        return { status: 'failed', projectDir: args.projectDir };
      }
      io.stderr.write('Choose a different credential source or Back.\n');
      attemptArgs = buildInteractiveRetryArgs(args);
      continue;
    }
    if (model.status === 'back' && !attemptArgs.anthropicApiKeyEnv && !attemptArgs.anthropicApiKeyFile) {
      attemptArgs = buildInteractiveRetryArgs(args);
      continue;
    }
    if (model.status !== 'ready') {
      return { status: model.status, projectDir: args.projectDir };
    }

    const health = await healthCheck(buildHealthConfig(credential.value, model.model));
    if (health.ok) {
      await persistLlmConfig(args.projectDir, credential.ref, model.model);
      io.stdout.write(`LLM ready: yes (${model.model})\n`);
      return { status: 'ready', projectDir: args.projectDir };
    }

    io.stderr.write(`Anthropic model health check failed: ${health.message}\n`);
    if (args.inputMode === 'disabled') {
      return { status: 'failed', projectDir: args.projectDir };
    }
    io.stderr.write('Choose a different credential source or model, or Back.\n');
    attemptArgs = buildInteractiveRetryArgs(args);
  }
}
