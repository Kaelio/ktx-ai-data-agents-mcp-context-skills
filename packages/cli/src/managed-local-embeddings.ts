import { MANAGED_SENTENCE_TRANSFORMERS_BASE_URL } from '@ktx/context';
import type { KtxProjectEmbeddingConfig } from '@ktx/context/project';
import type { KtxEmbeddingConfig } from '@ktx/llm';
import type { KtxCliIo } from './cli-runtime.js';
import {
  ensureManagedPythonCommandRuntime,
  type KtxManagedPythonInstallPolicy,
  type ManagedPythonCommandRuntime,
} from './managed-python-command.js';
import {
  readManagedPythonDaemonStatus,
  startManagedPythonDaemon,
  type ManagedPythonDaemonStartResult,
  type ManagedPythonDaemonStatus,
} from './managed-python-daemon.js';

export interface ManagedLocalEmbeddingsDaemon {
  baseUrl: string;
  stdoutLog: string;
  stderrLog: string;
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
  options.io.stderr.write(`${verb} KTX daemon: ${daemon.baseUrl}\n`);

  return {
    baseUrl: daemon.baseUrl,
    stdoutLog: daemon.state.stdoutLog,
    stderrLog: daemon.state.stderrLog,
  };
}

export interface TryUseManagedLocalEmbeddingsOptions {
  cliVersion: string;
  projectDir: string;
  readStatus?: typeof readManagedPythonDaemonStatus;
}

export async function tryUseManagedLocalEmbeddingsDaemon(
  options: TryUseManagedLocalEmbeddingsOptions,
): Promise<ManagedLocalEmbeddingsDaemon | null> {
  const readStatus = options.readStatus ?? readManagedPythonDaemonStatus;
  const status: ManagedPythonDaemonStatus = await readStatus({
    cliVersion: options.cliVersion,
    projectDir: options.projectDir,
  });
  if (status.kind !== 'running') {
    return null;
  }
  if (!status.state.features.includes('local-embeddings')) {
    return null;
  }
  return {
    baseUrl: status.baseUrl,
    stdoutLog: status.state.stdoutLog,
    stderrLog: status.state.stderrLog,
  };
}
