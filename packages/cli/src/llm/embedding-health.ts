import { describeError } from '../error-message.js';
import { createKtxEmbeddingProvider, type KtxEmbeddingProviderDeps } from './embedding-provider.js';
import type { KtxEmbeddingConfig } from './types.js';

export type KtxEmbeddingHealthCheckResult = { ok: true } | { ok: false; message: string };

export interface KtxEmbeddingHealthCheckOptions {
  text?: string;
  timeoutMs?: number;
  deps?: KtxEmbeddingProviderDeps;
}

function redactHealthCheckMessage(message: string, config: KtxEmbeddingConfig): string {
  const secrets = [config.openai?.apiKey].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return secrets.reduce((current, secret) => current.split(secret).join('[redacted]'), message);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Embedding health check timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function runKtxEmbeddingHealthCheck(
  config: KtxEmbeddingConfig,
  options: KtxEmbeddingHealthCheckOptions = {},
): Promise<KtxEmbeddingHealthCheckResult> {
  try {
    const provider = createKtxEmbeddingProvider(config, options.deps);
    const embedding = await withTimeout(
      provider.embed(options.text ?? 'ktx embedding health check'),
      options.timeoutMs ?? 15_000,
    );
    if (embedding.length !== config.dimensions) {
      return {
        ok: false,
        message: `Embedding provider ${config.backend} returned vector with ${embedding.length} dimensions; expected ${config.dimensions}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: redactHealthCheckMessage(describeError(error), config) };
  }
}
