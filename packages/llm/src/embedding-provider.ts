import { spawn } from 'node:child_process';
import { join } from 'node:path';
import OpenAI from 'openai';
import type { KtxEmbeddingConfig, KtxEmbeddingProvider } from './types.js';

type FetchFn = typeof fetch;
type SentenceTransformersCommand = 'embedding-compute' | 'embedding-compute-bulk';
type SentenceTransformersJsonRunner = (
  subcommand: SentenceTransformersCommand,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
type SentenceTransformersProcessCommand = { command: string; args: string[] };

export interface KtxEmbeddingProviderDeps {
  createOpenAIClient?: (options: { apiKey?: string; baseURL?: string }) => {
    embeddings: {
      create(input: {
        model: string;
        input: string | string[];
        dimensions: number;
        encoding_format: 'float';
      }): Promise<{ data: Array<{ index?: number; embedding: number[] }>; usage?: { total_tokens?: number } }>;
    };
  };
  fetch?: FetchFn;
  runSentenceTransformersJson?: SentenceTransformersJsonRunner;
  sentenceTransformersCommand?: string;
  sentenceTransformersArgs?: string[];
  sentenceTransformersCwd?: string;
  sentenceTransformersEnv?: NodeJS.ProcessEnv;
}

const DEFAULT_BATCH_SIZE = 100;

function assertNonEmptyText(text: string): void {
  if (!text.trim()) {
    throw new Error('Embedding text must be non-empty');
  }
}

function assertBatchSize(texts: string[], maxBatchSize: number): void {
  if (texts.length === 0) {
    throw new Error('Embedding text batch must not be empty');
  }
  if (texts.length > maxBatchSize) {
    throw new Error(`Embedding batch size ${texts.length} exceeds maximum ${maxBatchSize}`);
  }
  for (const text of texts) {
    assertNonEmptyText(text);
  }
}

function assertVectorDimensions(vector: number[], expected: number, backend: string): number[] {
  if (!Array.isArray(vector) || vector.some((item) => typeof item !== 'number')) {
    throw new Error(`Embedding provider ${backend} returned a malformed vector`);
  }
  if (vector.length !== expected) {
    throw new Error(
      `Embedding provider ${backend} returned vector with ${vector.length} dimensions; expected ${expected}`,
    );
  }
  return vector;
}

function joinUrl(baseURL: string, pathPrefix: string, path: string): string {
  const base = baseURL.replace(/\/+$/, '');
  const prefix = pathPrefix.replace(/^\/+|\/+$/g, '');
  const suffix = path.replace(/^\/+/, '');
  return prefix ? `${base}/${prefix}/${suffix}` : `${base}/${suffix}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.cause
      ? `${error.name}: ${error.message}; cause: ${errorText(error.cause)}`
      : `${error.name}: ${error.message}`;
  }
  return String(error);
}

function parseJsonObject(raw: string, subcommand: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ktx-daemon ${subcommand} returned non-object JSON`);
  }
  return parsed as Record<string, unknown>;
}

function isCommandNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    ('code' in error || 'errno' in error) &&
    ((error as { code?: unknown }).code === 'ENOENT' || (error as { errno?: unknown }).errno === 'ENOENT')
  );
}

function defaultSentenceTransformersProcessCommands(): SentenceTransformersProcessCommand[] {
  const venvBin =
    process.platform === 'win32' ? join('.venv', 'Scripts', 'ktx-daemon.exe') : join('.venv', 'bin', 'ktx-daemon');
  const repoVenvBin =
    process.platform === 'win32'
      ? join('ktx', '.venv', 'Scripts', 'ktx-daemon.exe')
      : join('ktx', '.venv', 'bin', 'ktx-daemon');
  return [
    { command: 'ktx-daemon', args: [] },
    { command: venvBin, args: [] },
    { command: repoVenvBin, args: [] },
  ];
}

function runSentenceTransformersProcessCommand(
  options: SentenceTransformersProcessCommand & {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): SentenceTransformersJsonRunner {
  return async (
    subcommand: SentenceTransformersCommand,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const child = spawn(options.command, [...options.args, subcommand], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        const stdoutText = Buffer.concat(stdout).toString('utf8').trim();
        const stderrText = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) {
          reject(new Error(`ktx-daemon ${subcommand} failed: ${stderrText || `exit code ${code}`}`));
          return;
        }
        try {
          resolve(parseJsonObject(stdoutText, subcommand));
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    });
}

function runSentenceTransformersProcessJson(options: {
  commands: SentenceTransformersProcessCommand[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): SentenceTransformersJsonRunner {
  return async (
    subcommand: SentenceTransformersCommand,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const errors: string[] = [];
    for (const command of options.commands) {
      try {
        return await runSentenceTransformersProcessCommand({
          ...command,
          cwd: options.cwd,
          env: options.env,
        })(subcommand, payload);
      } catch (error) {
        errors.push(`${command.command}: ${errorText(error)}`);
        if (!isCommandNotFound(error)) {
          break;
        }
      }
    }
    throw new Error(`ktx-daemon ${subcommand} failed: ${errors.join('; ')}`);
  };
}

class OpenAIEmbeddingProvider implements KtxEmbeddingProvider {
  readonly dimensions: number;
  readonly maxBatchSize: number;
  private readonly client: ReturnType<NonNullable<KtxEmbeddingProviderDeps['createOpenAIClient']>>;

  constructor(
    private readonly config: KtxEmbeddingConfig,
    deps: KtxEmbeddingProviderDeps,
  ) {
    this.dimensions = config.dimensions;
    this.maxBatchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!config.openai?.apiKey) {
      throw new Error('openai.apiKey is required when KTX embedding backend is openai');
    }
    this.client = deps.createOpenAIClient
      ? deps.createOpenAIClient({ apiKey: config.openai.apiKey, baseURL: config.openai.baseURL })
      : new OpenAI({
          apiKey: config.openai.apiKey,
          ...(config.openai.baseURL ? { baseURL: config.openai.baseURL } : {}),
        });
  }

  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedMany([text]);
    if (!embedding) {
      throw new Error('Embedding provider openai returned no embedding');
    }
    return embedding;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    assertBatchSize(texts, this.maxBatchSize);
    const response = await this.client.embeddings.create({
      model: this.config.model,
      input: texts.length === 1 ? texts[0] : texts,
      dimensions: this.dimensions,
      encoding_format: 'float',
    });
    const sorted = [...response.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const embeddings = sorted.map((item) => item.embedding);
    if (embeddings.length !== texts.length) {
      throw new Error(`Embedding provider openai returned ${embeddings.length} embeddings for ${texts.length} texts`);
    }
    return embeddings.map((embedding) => assertVectorDimensions(embedding, this.dimensions, 'openai'));
  }
}

class SentenceTransformersEmbeddingProvider implements KtxEmbeddingProvider {
  readonly dimensions: number;
  readonly maxBatchSize: number;
  private readonly fetch: FetchFn;
  private readonly baseURL: string;
  private readonly pathPrefix: string;
  private readonly runJson: SentenceTransformersJsonRunner;
  private readonly startupProbe: Promise<void>;
  private useProcessRunner = false;

  constructor(config: KtxEmbeddingConfig, deps: KtxEmbeddingProviderDeps) {
    if (!config.sentenceTransformers?.baseURL) {
      throw new Error('sentenceTransformers.baseURL is required when KTX embedding backend is sentence-transformers');
    }
    this.dimensions = config.dimensions;
    this.maxBatchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.fetch = deps.fetch ?? fetch;
    this.baseURL = config.sentenceTransformers.baseURL;
    this.pathPrefix = config.sentenceTransformers.pathPrefix ?? '/api';
    this.runJson =
      deps.runSentenceTransformersJson ??
      runSentenceTransformersProcessJson({
        commands: deps.sentenceTransformersCommand
          ? [{ command: deps.sentenceTransformersCommand, args: deps.sentenceTransformersArgs ?? [] }]
          : defaultSentenceTransformersProcessCommands(),
        cwd: deps.sentenceTransformersCwd,
        env: deps.sentenceTransformersEnv,
      });
    this.startupProbe = this.requestSingle('__ktx_embedding_probe__').then((embedding) => {
      assertVectorDimensions(embedding, this.dimensions, 'sentence-transformers');
    });
  }

  async embed(text: string): Promise<number[]> {
    assertNonEmptyText(text);
    await this.startupProbe;
    return assertVectorDimensions(await this.requestSingle(text), this.dimensions, 'sentence-transformers');
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    assertBatchSize(texts, this.maxBatchSize);
    await this.startupProbe;
    const response = await this.requestJson('embedding-compute-bulk', '/embeddings/compute-bulk', { texts });
    if (
      !response ||
      typeof response !== 'object' ||
      !('embeddings' in response) ||
      !Array.isArray(response.embeddings)
    ) {
      throw new Error('Embedding provider sentence-transformers returned malformed bulk response');
    }
    if (response.embeddings.length !== texts.length) {
      const count = response.embeddings.length;
      throw new Error(
        `Embedding provider sentence-transformers returned ${count} embeddings for ${texts.length} texts`,
      );
    }
    return response.embeddings.map((embedding: unknown) =>
      assertVectorDimensions(embedding as number[], this.dimensions, 'sentence-transformers'),
    );
  }

  private async requestSingle(text: string): Promise<number[]> {
    const response = await this.requestJson('embedding-compute', '/embeddings/compute', { text });
    if (!response || typeof response !== 'object' || !('embedding' in response) || !Array.isArray(response.embedding)) {
      throw new Error('Embedding provider sentence-transformers returned malformed single response');
    }
    return response.embedding;
  }

  private async requestJson(
    command: SentenceTransformersCommand,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.useProcessRunner) {
      return this.runJson(command, body);
    }

    try {
      return await this.postJson(path, body);
    } catch (httpError) {
      try {
        const response = await this.runJson(command, body);
        this.useProcessRunner = true;
        return response;
      } catch (processError) {
        throw new Error(
          `Embedding provider sentence-transformers local HTTP request failed (${errorText(
            httpError,
          )}) and ktx-daemon fallback failed (${errorText(processError)})`,
        );
      }
    }
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.fetch(joinUrl(this.baseURL, this.pathPrefix, path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Embedding provider sentence-transformers request failed with HTTP ${response.status}`);
    }
    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Embedding provider sentence-transformers returned non-object JSON');
    }
    return parsed as Record<string, unknown>;
  }
}

export function createKtxEmbeddingProvider(
  config: KtxEmbeddingConfig,
  deps: KtxEmbeddingProviderDeps = {},
): KtxEmbeddingProvider {
  switch (config.backend) {
    case 'openai':
      return new OpenAIEmbeddingProvider(config, deps);
    case 'sentence-transformers':
      return new SentenceTransformersEmbeddingProvider(config, deps);
    default:
      throw new Error(`Unsupported KTX embedding backend: ${String((config as { backend?: string }).backend)}`);
  }
}
