import { Codex, type CodexOptions, type ThreadOptions, type TurnOptions } from '@openai/codex-sdk';

export interface CodexSdkRunnerInput {
  projectDir: string;
  model: string;
  prompt: string;
  configOverrides?: Record<string, unknown>;
  env?: Record<string, string>;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface CodexSdkRunner {
  runStreamed(input: CodexSdkRunnerInput): Promise<AsyncIterable<unknown>>;
}

export interface CodexSdkCliRunnerOptions {
  envBase?: NodeJS.ProcessEnv;
  codexPathOverride?: string;
}

type CodexThread = {
  runStreamed(input: string, turnOptions?: TurnOptions): Promise<{ events: AsyncIterable<unknown> }>;
};

type CodexClient = {
  startThread(options: ThreadOptions): CodexThread;
};

type CodexConstructor = new (options?: CodexOptions) => CodexClient;

const CODEX_ENV_ALLOWLIST = new Set([
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'CODEX_HOME',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'PATH',
  'Path',
  'SYSTEMROOT',
  'COMSPEC',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
]);

function buildCodexSdkEnv(baseEnv: NodeJS.ProcessEnv, overrides: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = baseEnv[key];
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return { ...env, ...(overrides ?? {}) };
}

export class CodexSdkCliRunner implements CodexSdkRunner {
  constructor(private readonly options: CodexSdkCliRunnerOptions = {}) {}

  async runStreamed(input: CodexSdkRunnerInput): Promise<AsyncIterable<unknown>> {
    const CodexClass = Codex as CodexConstructor;
    const codex = new CodexClass({
      ...(input.configOverrides ? { config: input.configOverrides as CodexOptions['config'] } : {}),
      env: buildCodexSdkEnv(this.options.envBase ?? process.env, input.env),
      ...(this.options.codexPathOverride ? { codexPathOverride: this.options.codexPathOverride } : {}),
    });
    const thread = codex.startThread({
      workingDirectory: input.projectDir,
      skipGitRepoCheck: true,
      model: input.model,
      sandboxMode: 'read-only',
      webSearchMode: 'disabled',
      approvalPolicy: 'never',
    });
    const turnOptions: TurnOptions = {
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    };
    const streamed = await thread.runStreamed(
      input.prompt,
      Object.keys(turnOptions).length > 0 ? turnOptions : undefined,
    );
    return streamed.events;
  }
}
