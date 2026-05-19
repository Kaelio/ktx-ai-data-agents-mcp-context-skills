import {
  MANAGED_SENTENCE_TRANSFORMERS_BASE_URL,
  MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV,
} from '@ktx/context';
import type { KtxProjectEmbeddingConfig } from '@ktx/context/project';
import type { KtxEmbeddingConfig } from '@ktx/llm';
import type { KtxCliIo } from './cli-runtime.js';
import {
  ensureManagedPythonCommandRuntime,
  type KtxManagedPythonInstallPolicy,
  type ManagedPythonCommandRuntime,
} from './managed-python-command.js';
import { startManagedPythonDaemon, type ManagedPythonDaemonStartResult } from './managed-python-daemon.js';

export interface ManagedLocalEmbeddingsDaemon {
  baseUrl: string;
  stdoutLog: string;
  stderrLog: string;
  env: Record<typeof MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV, string>;
}

export interface ManagedLocalEmbeddingsOptions {
  cliVersion: string;
  projectDir: string;
  installPolicy: KtxManagedPythonInstallPolicy;
  io: KtxCliIo;
  ensureRuntime?: (options: {
    cliVersion: string;
    installPolicy: KtxManagedPythonInstallPolicy;
    io: KtxCliIo;
    feature: 'local-embeddings';
  }) => Promise<ManagedPythonCommandRuntime>;
  startDaemon?: (options: {
    cliVersion: string;
    projectDir: string;
    features: ['local-embeddings'];
    force: boolean;
  }) => Promise<ManagedPythonDaemonStartResult>;
}

export function managedLocalEmbeddingProjectConfig(input: {
  model: string;
  dimensions: number;
}): KtxProjectEmbeddingConfig {
  return {
    backend: 'sentence-transformers',
    model: input.model,
    dimensions: input.dimensions,
    sentenceTransformers: {
      base_url: MANAGED_SENTENCE_TRANSFORMERS_BASE_URL,
      pathPrefix: '',
    },
  };
}

export function managedLocalEmbeddingHealthConfig(input: {
  baseUrl: string;
  model: string;
  dimensions: number;
}): KtxEmbeddingConfig {
  return {
    backend: 'sentence-transformers',
    model: input.model,
    dimensions: input.dimensions,
    sentenceTransformers: {
      baseURL: input.baseUrl,
      pathPrefix: '',
    },
  };
}

export async function ensureManagedLocalEmbeddingsDaemon(
  options: ManagedLocalEmbeddingsOptions,
): Promise<ManagedLocalEmbeddingsDaemon> {
  const ensureRuntime = options.ensureRuntime ?? ensureManagedPythonCommandRuntime;
  const startDaemon = options.startDaemon ?? startManagedPythonDaemon;

  await ensureRuntime({
    cliVersion: options.cliVersion,
    installPolicy: options.installPolicy,
    io: options.io,
    feature: 'local-embeddings',
  });
  const daemon = await startDaemon({
    cliVersion: options.cliVersion,
    projectDir: options.projectDir,
    features: ['local-embeddings'],
    force: false,
  });

  const verb = daemon.status === 'started' ? 'Started' : 'Using';
  options.io.stderr.write(`${verb} KTX local embeddings daemon: ${daemon.baseUrl}\n`);

  return {
    baseUrl: daemon.baseUrl,
    stdoutLog: daemon.state.stdoutLog,
    stderrLog: daemon.state.stderrLog,
    env: {
      [MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV]: daemon.baseUrl,
    },
  };
}
