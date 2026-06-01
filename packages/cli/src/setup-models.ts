import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { runClaudeCodeAuthProbe } from './context/llm/claude-code-runtime.js';
import { runCodexAuthProbe } from './context/llm/codex-runtime.js';
import { resolveLocalKtxLlmConfig } from './context/llm/local-config.js';
import { resolveKtxConfigReference } from './context/core/config-reference.js';
import { type KtxProjectConfig, type KtxProjectLlmConfig, serializeKtxProjectConfig } from './context/project/config.js';
import { loadKtxProject } from './context/project/project.js';
import { markKtxSetupStateStepComplete } from './context/project/setup-config.js';
import type { KtxLlmConfig } from './llm/types.js';
import { type KtxLlmHealthCheckResult, runKtxLlmHealthCheck } from './llm/model-health.js';
import {
  formatClaudeCodePromptCachingWarning,
  ignoredClaudeCodePromptCachingFields,
} from './claude-code-prompt-caching.js';
import { createClackSpinner, type KtxCliSpinner } from './clack.js';
import type { KtxCliIo } from './cli-runtime.js';
import { withTextInputNavigation } from './prompt-navigation.js';
import { envCredentialReference, writeProjectLocalSecretReference } from './setup-secrets.js';
import {
  createKtxSetupPromptAdapter,
  type KtxSetupPromptOption,
} from './setup-prompts.js';

const ESC = String.fromCharCode(0x1b);

function yellow(text: string): string {
  return `${ESC}[33m${text}${ESC}[39m`;
}

export interface KtxSetupModelArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  llmBackend?: KtxSetupLlmBackend;
  anthropicApiKeyEnv?: string;
  anthropicApiKeyFile?: string;
  llmModel?: string;
  vertexProject?: string;
  vertexLocation?: string;
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

/** @internal */
export interface AnthropicModelChoice {
  id: string;
  label: string;
  recommended: boolean;
}

export type KtxSetupLlmBackend = 'anthropic' | 'vertex' | 'claude-code' | 'codex';

/** @internal */
export interface KtxSetupModelPromptAdapter {
  select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
  autocomplete(options: {
    message: string;
    placeholder?: string;
    options: KtxSetupPromptOption[];
  }): Promise<string>;
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
  claudeCodeAuthProbe?: (input: {
    projectDir: string;
    model: string;
    env?: NodeJS.ProcessEnv;
  }) => Promise<{ ok: true } | { ok: false; message: string }>;
  codexAuthProbe?: (input: {
    projectDir: string;
    model: string;
  }) => Promise<{ ok: true } | { ok: false; message: string }>;
  readGcloudProject?: () => Promise<string | undefined>;
  listGcloudProjects?: () => Promise<GcloudProjectChoice[]>;
  spinner?: () => KtxCliSpinner;
}

/** @internal */
export const BUNDLED_ANTHROPIC_MODELS: AnthropicModelChoice[] = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', recommended: false },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', recommended: false },
];

const VERTEX_ANTHROPIC_MODELS: AnthropicModelChoice[] = [
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', recommended: false },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: false },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', recommended: false },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', recommended: false },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', recommended: false },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', recommended: false },
  { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', recommended: false },
];

const CLAUDE_CODE_MODELS: AnthropicModelChoice[] = [
  { id: 'sonnet', label: 'Claude Sonnet', recommended: true },
  { id: 'opus', label: 'Claude Opus', recommended: false },
  { id: 'haiku', label: 'Claude Haiku', recommended: false },
];

const CODEX_MODELS: AnthropicModelChoice[] = [
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', recommended: true },
  { id: 'gpt-5.4', label: 'GPT-5.4', recommended: false },
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

const VERTEX_PROJECT_PROMPT_CONTEXT =
  'KTX stores the selected Google Cloud project ID in ktx.yaml and uses Application Default Credentials for ' +
  'access. Project visibility depends on the signed-in Google account and organization permissions.';
const DEFAULT_VERTEX_LOCATION = 'us-east5';

const execFileAsync = promisify(execFile);

type AnthropicModelDiscoveryErrorReason = 'authentication' | 'http' | 'empty-response';

class AnthropicModelDiscoveryError extends Error {
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

type ChooseBackendResult =
  | { status: 'ready'; backend: KtxSetupLlmBackend; prompted: boolean }
  | { status: 'back' };

type VertexConfigChoice =
  | {
      status: 'ready';
      refs: { project?: string; location: string };
      values: { project?: string; location: string };
    }
  | { status: 'back' | 'missing-input' };

interface GcloudProjectChoice {
  projectId: string;
  name?: string;
}

function createPromptAdapter(): KtxSetupModelPromptAdapter {
  return createKtxSetupPromptAdapter({ selectCancelValue: 'back' });
}

async function defaultReadGcloudProject(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('gcloud', ['config', 'get-value', 'project'], { encoding: 'utf8' });
    const value = stdout.trim();
    return value && value !== '(unset)' ? value : undefined;
  } catch {
    return undefined;
  }
}

async function defaultListGcloudProjects(): Promise<GcloudProjectChoice[]> {
  const { stdout } = await execFileAsync('gcloud', ['projects', 'list', '--format=json(projectId,name)'], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(stdout.trim() || '[]') as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((item): GcloudProjectChoice | undefined => {
      if (!item || typeof item !== 'object') {
        return undefined;
      }
      const record = item as { projectId?: unknown; name?: unknown };
      if (typeof record.projectId !== 'string' || !record.projectId.trim()) {
        return undefined;
      }
      const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : undefined;
      return {
        projectId: record.projectId.trim(),
        ...(name ? { name } : {}),
      };
    })
    .filter((project): project is GcloudProjectChoice => Boolean(project));
}

/** @internal */
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

  return (
    resolved.backend === 'anthropic' ||
    resolved.backend === 'gateway' ||
    resolved.backend === 'claude-code' ||
    resolved.backend === 'codex'
  );
}

function hasUsableConfiguredLlm(config: KtxProjectConfig): boolean {
  return isKtxSetupLlmConfigReady(config.llm);
}

function buildProjectLlmConfig(
  existing: KtxProjectLlmConfig,
  provider:
    | { backend: 'anthropic'; credentialRef: string }
    | { backend: 'vertex'; vertex: { project?: string; location: string } }
    | { backend: 'claude-code' }
    | { backend: 'codex' },
  model: string,
): KtxProjectLlmConfig {
  if (provider.backend === 'claude-code') {
    return {
      provider: { backend: 'claude-code' },
      models: { ...existing.models, default: model },
      promptCaching: existing.promptCaching,
    };
  }

  if (provider.backend === 'codex') {
    return {
      provider: { backend: 'codex' },
      models: { ...existing.models, default: model },
      promptCaching: existing.promptCaching,
    };
  }

  if (provider.backend === 'vertex') {
    return {
      provider: {
        backend: 'vertex',
        vertex: provider.vertex,
      },
      models: { ...existing.models, default: model },
      promptCaching: { ...(existing.promptCaching ?? {}), enabled: true, vertexFallbackTo5m: true },
    };
  }

  return {
    provider: {
      backend: 'anthropic',
      anthropic: { api_key: provider.credentialRef },
    },
    models: { ...existing.models, default: model },
    promptCaching: { ...(existing.promptCaching ?? {}), enabled: true },
  };
}

function buildAnthropicHealthConfig(credentialValue: string, model: string): KtxLlmConfig {
  return {
    backend: 'anthropic',
    anthropic: { apiKey: credentialValue },
    modelSlots: { default: model },
    promptCaching: { enabled: true },
  };
}

function buildVertexHealthConfig(vertex: { project?: string; location: string }, model: string): KtxLlmConfig {
  return {
    backend: 'vertex',
    vertex,
    modelSlots: { default: model },
    promptCaching: { enabled: true, vertexFallbackTo5m: true },
  };
}

type LlmHealthProvider = 'Anthropic API' | 'Vertex AI';

function llmHealthCheckStartText(provider: LlmHealthProvider, model: string): string {
  return `Checking ${provider} LLM (${model}).`;
}

function startLlmHealthCheckProgress(
  spinner: KtxCliSpinner,
  message: string,
): { succeed(msg: string): void; fail(msg: string): void } {
  spinner.start(message);
  return {
    succeed(msg: string) {
      spinner.stop(msg);
    },
    fail(msg: string) {
      spinner.error(msg);
    },
  };
}

async function runLlmHealthCheckWithProgress(
  config: KtxLlmConfig,
  provider: LlmHealthProvider,
  model: string,
  healthCheck: (config: KtxLlmConfig) => Promise<KtxLlmHealthCheckResult>,
  deps: KtxSetupModelDeps,
): Promise<KtxLlmHealthCheckResult> {
  const progress = startLlmHealthCheckProgress(
    (deps.spinner ?? createClackSpinner)(),
    llmHealthCheckStartText(provider, model),
  );
  let health: KtxLlmHealthCheckResult;
  try {
    health = await healthCheck(config);
  } catch (error) {
    progress.fail('LLM test failed');
    throw error;
  }
  if (health.ok) {
    progress.succeed(`LLM test passed (${provider}, ${model})`);
  } else {
    progress.fail('LLM test failed');
  }
  return health;
}

function formatVertexHealthFailure(message: string, vertex: { project?: string; location: string }): string {
  const trimmed = message.trim() || 'unknown error';
  if (!/(forbidden|permission|permission_denied|403)/i.test(trimmed)) {
    return trimmed;
  }

  return (
    `${trimmed}. Check that Vertex AI API is enabled for project ${vertex.project ?? '(unknown)'}, ` +
    `Anthropic Claude model access is enabled for location ${vertex.location}, and that your Application Default ` +
    'Credentials principal has Vertex AI User (roles/aiplatform.user) or equivalent permissions.'
  );
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
      '│  Use Up/Down to move, Enter to confirm the current selection, choose Back to return to the previous step, Ctrl+C to exit.\n',
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
        '│  KTX will save the key in .ktx/secrets/anthropic-api-key with local file permissions, then write a file: reference in ktx.yaml.\n',
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

function requestedBackend(args: KtxSetupModelArgs): KtxSetupLlmBackend | undefined {
  if (args.llmBackend) {
    return args.llmBackend;
  }
  if (args.vertexProject || args.vertexLocation) {
    return 'vertex';
  }
  if (args.anthropicApiKeyEnv || args.anthropicApiKeyFile || args.llmModel) {
    return 'anthropic';
  }
  return undefined;
}

function requestedModel(args: KtxSetupModelArgs): string | undefined {
  return args.llmModel;
}

async function chooseBackend(
  args: KtxSetupModelArgs,
  io: KtxCliIo,
  deps: KtxSetupModelDeps,
): Promise<ChooseBackendResult> {
  const explicit = requestedBackend(args);
  if (explicit) {
    return { status: 'ready', backend: explicit, prompted: false };
  }
  if (args.inputMode === 'disabled') {
    return { status: 'ready', backend: 'anthropic', prompted: false };
  }

  const prompts = deps.prompts ?? createPromptAdapter();
  if (args.showPromptInstructions !== false) {
    io.stdout.write(
      '│  Use Up/Down to move, Enter to confirm the current selection, choose Back to return to the previous step, Ctrl+C to exit.\n',
    );
  }
  const choice = await prompts.select({
    message: 'Which LLM provider should KTX use?',
    options: [
      { value: 'claude-code', label: 'Claude subscription (Pro/Max)' },
      { value: 'codex', label: 'Codex subscription' },
      { value: 'anthropic', label: 'Anthropic API key' },
      { value: 'vertex', label: 'Google Vertex AI for Anthropic Claude' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (choice === 'back') {
    return { status: 'back' };
  }
  return {
    status: 'ready',
    backend: choice === 'vertex' || choice === 'claude-code' || choice === 'codex' ? choice : 'anthropic',
    prompted: true,
  };
}

function resolveProvidedVertexRef(
  label: 'project' | 'location',
  ref: string,
  env: NodeJS.ProcessEnv,
  io: KtxCliIo,
): { status: 'ready'; ref: string; value: string } | { status: 'missing-input' } {
  let value: string | undefined;
  try {
    value = resolveKtxConfigReference(ref, env);
  } catch {
    value = undefined;
  }
  if (!value) {
    io.stderr.write(`Missing Vertex AI ${label}: ${ref} could not be resolved.\n`);
    return { status: 'missing-input' };
  }
  return { status: 'ready', ref, value };
}

function normalizeGcloudProjectId(projectId: string | undefined): string | undefined {
  const trimmed = projectId?.trim();
  return trimmed ? trimmed : undefined;
}

function orderGcloudProjects(projects: GcloudProjectChoice[], currentProject: string | undefined): GcloudProjectChoice[] {
  const ordered: GcloudProjectChoice[] = [];
  const seen = new Set<string>();
  const addProject = (project: GcloudProjectChoice) => {
    const projectId = normalizeGcloudProjectId(project.projectId);
    if (!projectId || seen.has(projectId)) {
      return;
    }
    seen.add(projectId);
    const name = normalizeGcloudProjectId(project.name);
    ordered.push({
      projectId,
      ...(name ? { name } : {}),
    });
  };

  if (currentProject) {
    addProject(projects.find((project) => project.projectId.trim() === currentProject) ?? { projectId: currentProject });
  }
  for (const project of projects) {
    addProject(project);
  }
  return ordered;
}

function formatGcloudProjectLabel(project: GcloudProjectChoice, currentProject: string | undefined): string {
  const name = project.name && project.name !== project.projectId ? ` - ${project.name}` : '';
  const current = project.projectId === currentProject ? ' (current gcloud project)' : '';
  return `${project.projectId}${name}${current}`;
}

function formatGcloudProjectListFailure(error: unknown): string {
  const stderr = typeof (error as { stderr?: unknown })?.stderr === 'string' ? (error as { stderr: string }).stderr : '';
  const message = error instanceof Error ? error.message : '';
  const details = `${stderr}\n${message}`;
  const reason = /reauthentication failed|cannot prompt/i.test(details)
    ? 'gcloud needs reauthentication before it can list projects.'
    : 'gcloud returned an error while listing projects.';
  return [
    `Could not list Google Cloud projects with gcloud: ${reason}`,
    'Run `gcloud auth login --update-adc` in another terminal, then choose Retry loading Google Cloud projects.',
  ]
    .map((line) => yellow(line))
    .join('\n');
}

async function chooseInteractiveVertexProject(
  currentProject: string | undefined,
  io: KtxCliIo,
  deps: KtxSetupModelDeps,
): Promise<{ status: 'ready'; ref: string; value: string } | { status: 'back' | 'missing-input' }> {
  const prompts = deps.prompts ?? createPromptAdapter();
  while (true) {
    let projects: GcloudProjectChoice[] = [];
    let listFailed = false;
    let listFailureMessage: string | undefined;
    try {
      projects = await (deps.listGcloudProjects ?? defaultListGcloudProjects)();
    } catch (error) {
      listFailed = true;
      listFailureMessage = formatGcloudProjectListFailure(error);
    }

    const orderedProjects = orderGcloudProjects(projects, currentProject);
    if (orderedProjects.length === 0 && !listFailed) {
      io.stdout.write('│  gcloud did not return any visible Google Cloud projects. Enter a project ID manually or choose Back.\n');
    }

    const choice = await prompts.autocomplete({
      message: `Which Google Cloud project should KTX use for Vertex AI?\n\n${[
        VERTEX_PROJECT_PROMPT_CONTEXT,
        listFailureMessage,
      ]
        .filter((value): value is string => Boolean(value))
        .join('\n\n')}`,
      placeholder: 'Type to search projects',
      options: [
        ...orderedProjects.map((project) => ({
          value: project.projectId,
          label: formatGcloudProjectLabel(project, currentProject),
        })),
        ...(listFailed ? [{ value: 'retry', label: 'Retry loading Google Cloud projects' }] : []),
        { value: 'manual', label: 'Enter a project ID manually' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') {
      return { status: 'back' };
    }
    if (choice === 'retry') {
      continue;
    }
    if (choice === 'manual') {
      const manual = await prompts.text({
        message: withTextInputNavigation('Google Cloud project ID'),
        placeholder: currentProject ?? orderedProjects[0]?.projectId,
      });
      if (manual === undefined) {
        return { status: 'back' };
      }
      const project = normalizeGcloudProjectId(manual);
      return project ? { status: 'ready', ref: project, value: project } : { status: 'missing-input' };
    }

    return { status: 'ready', ref: choice, value: choice };
  }
}

async function chooseVertexConfig(
  args: KtxSetupModelArgs,
  io: KtxCliIo,
  deps: KtxSetupModelDeps,
): Promise<VertexConfigChoice> {
  const env = deps.env ?? process.env;
  let projectRef: string | undefined;
  let projectValue: string | undefined;
  let gcloudProject: string | undefined;

  if (args.vertexProject) {
    const project = resolveProvidedVertexRef('project', args.vertexProject, env, io);
    if (project.status !== 'ready') {
      return { status: project.status };
    }
    projectRef = project.ref;
    projectValue = project.value;
  } else if (env.GOOGLE_VERTEX_PROJECT?.trim()) {
    projectRef = envCredentialReference('GOOGLE_VERTEX_PROJECT');
    projectValue = env.GOOGLE_VERTEX_PROJECT.trim();
  } else {
    gcloudProject = normalizeGcloudProjectId(await (deps.readGcloudProject ?? defaultReadGcloudProject)());
    if (args.inputMode === 'disabled') {
      if (gcloudProject) {
        projectRef = gcloudProject;
        projectValue = gcloudProject;
      }
    } else {
      const project = await chooseInteractiveVertexProject(gcloudProject, io, deps);
      if (project.status !== 'ready') {
        return { status: project.status };
      }
      projectRef = project.ref;
      projectValue = project.value;
    }
  }

  let locationRef: string | undefined;
  let locationValue: string | undefined;
  if (args.vertexLocation) {
    const location = resolveProvidedVertexRef('location', args.vertexLocation, env, io);
    if (location.status !== 'ready') {
      return { status: location.status };
    }
    locationRef = location.ref;
    locationValue = location.value;
  } else if (env.GOOGLE_VERTEX_LOCATION?.trim()) {
    locationRef = envCredentialReference('GOOGLE_VERTEX_LOCATION');
    locationValue = env.GOOGLE_VERTEX_LOCATION.trim();
  } else {
    locationRef = DEFAULT_VERTEX_LOCATION;
    locationValue = DEFAULT_VERTEX_LOCATION;
  }

  if (!projectRef || !projectValue) {
    io.stderr.write(
      'Missing Vertex AI project: run `gcloud config set project PROJECT_ID`, pass --vertex-project, or set GOOGLE_VERTEX_PROJECT.\n',
    );
    return { status: 'missing-input' };
  }

  if (!locationRef || !locationValue) {
    io.stderr.write('Missing Vertex AI location: pass --vertex-location.\n');
    return { status: 'missing-input' };
  }

  return {
    status: 'ready',
    refs: {
      ...(projectRef ? { project: projectRef } : {}),
      location: locationRef,
    },
    values: {
      ...(projectValue ? { project: projectValue } : {}),
      location: locationValue,
    },
  };
}

async function chooseModel(
  args: KtxSetupModelArgs,
  credentialValue: string,
  io: KtxCliIo,
  deps: KtxSetupModelDeps,
): Promise<ChooseModelResult> {
  const providedModel = requestedModel(args);
  if (providedModel) {
    return { status: 'ready', model: providedModel };
  }
  if (args.inputMode === 'disabled') {
    io.stderr.write('Missing LLM model: pass --llm-model.\n');
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
      label: model.label || model.id,
      ...(model.recommended ? { hint: 'recommended' } : {}),
    })),
    { value: 'manual', label: 'Enter a model ID manually' },
    { value: 'back', label: 'Back' },
  ];
  const choice = await prompts.autocomplete({
    message: `Which Anthropic model should KTX use?\n\n${ANTHROPIC_MODEL_PROMPT_CONTEXT}`,
    placeholder: 'Type to search models',
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

async function chooseVertexModel(args: KtxSetupModelArgs, io: KtxCliIo, deps: KtxSetupModelDeps): Promise<ChooseModelResult> {
  const providedModel = requestedModel(args);
  if (providedModel) {
    return { status: 'ready', model: providedModel };
  }
  if (args.inputMode === 'disabled') {
    io.stderr.write('Missing LLM model: pass --llm-model.\n');
    return { status: 'missing-input' };
  }

  const selectableModels = VERTEX_ANTHROPIC_MODELS.filter(isSelectableAnthropicModel);
  const prompts = deps.prompts ?? createPromptAdapter();
  const choice = await prompts.autocomplete({
    message: `Which Anthropic model should KTX use?\n\n${ANTHROPIC_MODEL_PROMPT_CONTEXT}`,
    placeholder: 'Type to search models',
    options: [
      ...selectableModels.map((model) => ({
        value: model.id,
        label: model.label || model.id,
        ...(model.recommended ? { hint: 'recommended' } : {}),
      })),
      { value: 'manual', label: 'Enter a model ID manually' },
      { value: 'back', label: 'Back' },
    ],
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

async function chooseClaudeCodeModel(args: KtxSetupModelArgs, deps: KtxSetupModelDeps): Promise<ChooseModelResult> {
  const providedModel = requestedModel(args);
  if (providedModel) {
    return { status: 'ready', model: providedModel };
  }
  if (args.inputMode === 'disabled') {
    return { status: 'ready', model: 'sonnet' };
  }

  const prompts = deps.prompts ?? createPromptAdapter();
  const choice = await prompts.select({
    message: `Which Claude Code model should KTX use?\n\n${ANTHROPIC_MODEL_PROMPT_CONTEXT}`,
    options: [
      ...CLAUDE_CODE_MODELS.map((model) => ({
        value: model.id,
        label: model.label,
        ...(model.recommended ? { hint: 'recommended' } : {}),
      })),
      { value: 'manual', label: 'Enter a Claude Code model ID manually' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (choice === 'back') {
    return { status: 'back' };
  }
  if (choice === 'manual') {
    const manual = await prompts.text({
      message: withTextInputNavigation('Claude Code model ID'),
      placeholder: CLAUDE_CODE_MODELS.find((model) => model.recommended)?.id ?? CLAUDE_CODE_MODELS[0]?.id,
    });
    if (manual === undefined) {
      return { status: 'back' };
    }
    return manual.trim() ? { status: 'ready', model: manual.trim() } : { status: 'missing-input' };
  }
  return { status: 'ready', model: choice };
}

async function chooseCodexModel(args: KtxSetupModelArgs, deps: KtxSetupModelDeps): Promise<ChooseModelResult> {
  const providedModel = requestedModel(args);
  if (providedModel) {
    return { status: 'ready', model: providedModel };
  }
  if (args.inputMode === 'disabled') {
    return { status: 'ready', model: 'gpt-5.3-codex' };
  }

  const prompts = deps.prompts ?? createPromptAdapter();
  const choice = await prompts.select({
    message: `Which Codex model should KTX use?\n\n${ANTHROPIC_MODEL_PROMPT_CONTEXT}`,
    options: [
      ...CODEX_MODELS.map((model) => ({
        value: model.id,
        label: model.label,
        ...(model.recommended ? { hint: 'recommended' } : {}),
      })),
      { value: 'manual', label: 'Enter a Codex model ID manually' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (choice === 'back') {
    return { status: 'back' };
  }
  if (choice === 'manual') {
    const manual = await prompts.text({
      message: withTextInputNavigation('Codex model ID'),
      placeholder: CODEX_MODELS.find((model) => model.recommended)?.id ?? CODEX_MODELS[0]?.id,
    });
    if (manual === undefined) {
      return { status: 'back' };
    }
    return manual.trim() ? { status: 'ready', model: manual.trim() } : { status: 'missing-input' };
  }
  return { status: 'ready', model: choice };
}

async function persistLlmConfig(
  projectDir: string,
  provider:
    | { backend: 'anthropic'; credentialRef: string }
    | { backend: 'vertex'; vertex: { project?: string; location: string } }
    | { backend: 'claude-code' }
    | { backend: 'codex' },
  model: string,
): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  const config = {
    ...project.config,
    llm: buildProjectLlmConfig(project.config.llm, provider, model),
    scan: {
      ...project.config.scan,
      enrichment: {
        ...project.config.scan.enrichment,
        mode: 'llm' as const,
      },
    },
  };
  await writeFile(project.configPath, serializeKtxProjectConfig(config), 'utf-8');
  await markKtxSetupStateStepComplete(projectDir, 'llm');
}

function buildInteractiveRetryArgs(args: KtxSetupModelArgs, backend?: KtxSetupLlmBackend): KtxSetupModelArgs {
  return {
    projectDir: args.projectDir,
    inputMode: args.inputMode,
    ...(backend ?? args.llmBackend ? { llmBackend: backend ?? args.llmBackend } : {}),
    showPromptInstructions: false,
    skipLlm: args.skipLlm,
  };
}

export async function runKtxSetupAnthropicModelStep(
  args: KtxSetupModelArgs,
  io: KtxCliIo,
  deps: KtxSetupModelDeps = {},
): Promise<KtxSetupModelResult> {
  if (args.skipLlm) {
    io.stdout.write('│  LLM setup skipped.\n');
    return { status: 'skipped', projectDir: args.projectDir };
  }

  const project = await loadKtxProject({ projectDir: args.projectDir });
  if (
    args.forcePrompt !== true &&
    hasUsableConfiguredLlm(project.config) &&
    !args.llmBackend &&
    !args.anthropicApiKeyEnv &&
    !args.anthropicApiKeyFile &&
    !args.llmModel &&
    !args.vertexProject &&
    !args.vertexLocation
  ) {
    io.stdout.write(`│  LLM ready: yes (${project.config.llm.models.default})\n`);
    return { status: 'ready', projectDir: args.projectDir };
  }

  const healthCheck = deps.healthCheck ?? ((config: KtxLlmConfig) => runKtxLlmHealthCheck(config));
  let attemptArgs = args;

  while (true) {
    const backendChoice = await chooseBackend(attemptArgs, io, deps);
    if (backendChoice.status !== 'ready') {
      return { status: backendChoice.status, projectDir: args.projectDir };
    }

    const backendArgs = backendChoice.prompted
      ? ({ ...attemptArgs, llmBackend: backendChoice.backend, showPromptInstructions: false } satisfies KtxSetupModelArgs)
      : attemptArgs;

    if (backendChoice.backend === 'vertex') {
      const vertex = await chooseVertexConfig(backendArgs, io, deps);
      if (vertex.status === 'back' && backendChoice.prompted) {
        attemptArgs = buildInteractiveRetryArgs(args);
        continue;
      }
      if (vertex.status !== 'ready') {
        return { status: vertex.status, projectDir: args.projectDir };
      }

      const model = await chooseVertexModel(backendArgs, io, deps);
      if (model.status === 'back' && !backendArgs.vertexLocation) {
        attemptArgs = buildInteractiveRetryArgs(args, backendChoice.backend);
        continue;
      }
      if (model.status === 'invalid-credential') {
        return { status: 'failed', projectDir: args.projectDir };
      }
      if (model.status !== 'ready') {
        return { status: model.status, projectDir: args.projectDir };
      }

      const health = await runLlmHealthCheckWithProgress(
        buildVertexHealthConfig(vertex.values, model.model),
        'Vertex AI',
        model.model,
        healthCheck,
        deps,
      );
      if (health.ok) {
        await persistLlmConfig(args.projectDir, { backend: 'vertex', vertex: vertex.refs }, model.model);
        io.stdout.write(`│  LLM ready: yes (${model.model})\n`);
        return { status: 'ready', projectDir: args.projectDir };
      }

      io.stderr.write(`Vertex AI Anthropic model health check failed: ${formatVertexHealthFailure(health.message, vertex.values)}\n`);
      if (args.inputMode === 'disabled') {
        return { status: 'failed', projectDir: args.projectDir };
      }
      io.stderr.write('Choose a different Vertex AI project, location, or model, or Back.\n');
      attemptArgs = buildInteractiveRetryArgs(args, backendChoice.backend);
      continue;
    }

    if (backendChoice.backend === 'claude-code') {
      const model = await chooseClaudeCodeModel(backendArgs, deps);
      if (model.status === 'back' && backendChoice.prompted) {
        attemptArgs = buildInteractiveRetryArgs(args);
        continue;
      }
      if (model.status === 'invalid-credential') {
        return { status: 'failed', projectDir: args.projectDir };
      }
      if (model.status !== 'ready') {
        return { status: model.status, projectDir: args.projectDir };
      }
      const probe = deps.claudeCodeAuthProbe ?? runClaudeCodeAuthProbe;
      const health = await probe({ projectDir: args.projectDir, model: model.model, env: deps.env ?? process.env });
      if (!health.ok) {
        io.stderr.write(`${health.message}\n`);
        return { status: 'failed', projectDir: args.projectDir };
      }
      const warning = formatClaudeCodePromptCachingWarning(
        ignoredClaudeCodePromptCachingFields(
          buildProjectLlmConfig(project.config.llm, { backend: 'claude-code' }, model.model),
        ),
      );
      if (warning) {
        io.stderr.write(`${warning}\n`);
      }
      await persistLlmConfig(args.projectDir, { backend: 'claude-code' }, model.model);
      io.stdout.write(`│  LLM ready: yes (${model.model})\n`);
      return { status: 'ready', projectDir: args.projectDir };
    }

    if (backendChoice.backend === 'codex') {
      const model = await chooseCodexModel(backendArgs, deps);
      if (model.status === 'back' && backendChoice.prompted) {
        attemptArgs = buildInteractiveRetryArgs(args);
        continue;
      }
      if (model.status === 'invalid-credential') {
        return { status: 'failed', projectDir: args.projectDir };
      }
      if (model.status !== 'ready') {
        return { status: model.status, projectDir: args.projectDir };
      }
      const probe = deps.codexAuthProbe ?? runCodexAuthProbe;
      const health = await probe({ projectDir: args.projectDir, model: model.model });
      if (!health.ok) {
        io.stderr.write(`${health.message}\n`);
        return { status: 'failed', projectDir: args.projectDir };
      }
      await persistLlmConfig(args.projectDir, { backend: 'codex' }, model.model);
      io.stdout.write(`│  LLM ready: yes (codex, ${model.model})\n`);
      return { status: 'ready', projectDir: args.projectDir };
    }

    const credential = await chooseCredentialRef(backendArgs, io, deps);
    if (credential.status === 'back' && backendChoice.prompted) {
      attemptArgs = buildInteractiveRetryArgs(args);
      continue;
    }
    if (credential.status !== 'ready') {
      return { status: credential.status, projectDir: args.projectDir };
    }

    const model = await chooseModel(backendArgs, credential.value, io, deps);
    if (model.status === 'invalid-credential') {
      if (args.inputMode === 'disabled') {
        return { status: 'failed', projectDir: args.projectDir };
      }
      io.stderr.write('Choose a different credential source or Back.\n');
      attemptArgs = buildInteractiveRetryArgs(args, backendChoice.backend);
      continue;
    }
    if (model.status === 'back' && !backendArgs.anthropicApiKeyEnv && !backendArgs.anthropicApiKeyFile) {
      attemptArgs = buildInteractiveRetryArgs(args, backendChoice.backend);
      continue;
    }
    if (model.status !== 'ready') {
      return { status: model.status, projectDir: args.projectDir };
    }

    const health = await runLlmHealthCheckWithProgress(
      buildAnthropicHealthConfig(credential.value, model.model),
      'Anthropic API',
      model.model,
      healthCheck,
      deps,
    );
    if (health.ok) {
      await persistLlmConfig(args.projectDir, { backend: 'anthropic', credentialRef: credential.ref }, model.model);
      io.stdout.write(`│  LLM ready: yes (${model.model})\n`);
      return { status: 'ready', projectDir: args.projectDir };
    }

    io.stderr.write(`Anthropic model health check failed: ${health.message}\n`);
    if (args.inputMode === 'disabled') {
      return { status: 'failed', projectDir: args.projectDir };
    }
    io.stderr.write('Choose a different credential source or model, or Back.\n');
    attemptArgs = buildInteractiveRetryArgs(args, backendChoice.backend);
  }
}
