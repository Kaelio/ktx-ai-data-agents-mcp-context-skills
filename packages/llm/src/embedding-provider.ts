import OpenAI from 'openai';
import type { KtxEmbeddingConfig, KtxEmbeddingProvider } from './types.js';

type FetchFn = typeof fetch;

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
}

const DEFAULT_BATCH_SIZE = 100;
const HTTP_ERROR_BODY_MAX_LENGTH = 2_000;

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

function boundedHttpBody(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= HTTP_ERROR_BODY_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, HTTP_ERROR_BODY_MAX_LENGTH)}...`;
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
  private readonly startupProbe: Promise<void>;

  constructor(config: KtxEmbeddingConfig, deps: KtxEmbeddingProviderDeps) {
    if (!config.sentenceTransformers?.baseURL) {
      throw new Error('sentenceTransformers.baseURL is required when KTX embedding backend is sentence-transformers');
    }
    this.dimensions = config.dimensions;
    this.maxBatchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.fetch = deps.fetch ?? fetch;
    this.baseURL = config.sentenceTransformers.baseURL;
    this.pathPrefix = config.sentenceTransformers.pathPrefix ?? '/api';
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
    const response = await this.requestJson('/embeddings/compute-bulk', { texts });
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
    const response = await this.requestJson('/embeddings/compute', { text });
    if (!response || typeof response !== 'object' || !('embedding' in response) || !Array.isArray(response.embedding)) {
      throw new Error('Embedding provider sentence-transformers returned malformed single response');
    }
    return response.embedding;
  }

  private async requestJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.postJson(path, body);
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.fetch(joinUrl(this.baseURL, this.pathPrefix, path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const bodyText = boundedHttpBody(await response.text());
      throw new Error(
        `Embedding provider sentence-transformers request failed with HTTP ${response.status}${
          bodyText ? `: ${bodyText}` : ''
        }`,
      );
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
