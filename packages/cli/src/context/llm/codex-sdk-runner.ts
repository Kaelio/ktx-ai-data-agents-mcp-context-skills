import { Codex } from '@openai/codex-sdk';

export interface CodexSdkRunnerInput {
  projectDir: string;
  model: string;
  prompt: string;
  configOverrides?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  outputSchema?: Record<string, unknown>;
}

export interface CodexSdkRunner {
  runStreamed(input: CodexSdkRunnerInput): Promise<AsyncIterable<unknown>>;
}

type CodexThread = {
  runStreamed(input: string, turnOptions?: { outputSchema?: Record<string, unknown> }): Promise<{ events: AsyncIterable<unknown> }>;
};

type CodexClient = {
  startThread(options: { workingDirectory: string; skipGitRepoCheck: true }): CodexThread;
};

type CodexConstructor = new (options?: { config?: Record<string, unknown> }) => CodexClient;

function applyRunnerEnv(env: NodeJS.ProcessEnv | undefined): () => void {
  if (!env) {
    return () => undefined;
  }
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export class CodexSdkCliRunner implements CodexSdkRunner {
  async runStreamed(input: CodexSdkRunnerInput): Promise<AsyncIterable<unknown>> {
    const restoreEnv = applyRunnerEnv(input.env);
    try {
      const CodexClass = Codex as CodexConstructor;
      const codex = new CodexClass({
        config: {
          ...(input.configOverrides ?? {}),
          model: input.model,
        },
      });
      const thread = codex.startThread({
        workingDirectory: input.projectDir,
        skipGitRepoCheck: true,
      });
      const streamed = await thread.runStreamed(
        input.prompt,
        input.outputSchema ? { outputSchema: input.outputSchema } : undefined,
      );
      return streamed.events;
    } finally {
      restoreEnv();
    }
  }
}
