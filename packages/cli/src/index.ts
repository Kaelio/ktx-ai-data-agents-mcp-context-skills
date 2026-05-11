import { profileMark } from './startup-profile.js';

export {
  getKtxCliPackageInfo,
  packageInfoFromJson,
  runInitForCommander,
  runKtxCli,
  type KtxCliDeps,
  type KtxCliIo,
  type KtxCliPackageInfo,
} from './cli-runtime.js';
export { runKtxAgent, type KtxAgentArgs } from './agent.js';
export {
  KTX_AGENT_MAX_ROWS_CAP,
  createKtxAgentRuntime,
  parseAgentMaxRows,
  readAgentJsonFile,
  writeAgentJson,
  writeAgentJsonError,
  type KtxAgentRuntime,
  type KtxAgentRuntimeDeps,
} from './agent-runtime.js';
export { runKtxSetup, type KtxSetupArgs, type KtxSetupStatus } from './setup.js';
export type {
  KtxSetupDatabaseDriver,
  KtxSetupDatabasesArgs,
  KtxSetupDatabasesDeps,
  KtxSetupDatabasesResult,
} from './setup-databases.js';
export { runKtxSetupDatabasesStep } from './setup-databases.js';
export type {
  KtxSetupEmbeddingBackend,
  KtxSetupEmbeddingsArgs,
  KtxSetupEmbeddingsDeps,
  KtxSetupEmbeddingsResult,
} from './setup-embeddings.js';
export { runKtxSetupEmbeddingsStep } from './setup-embeddings.js';
export type {
  KtxSetupSourcesArgs,
  KtxSetupSourcesDeps,
  KtxSetupSourcesPromptAdapter,
  KtxSetupSourcesResult,
  KtxSetupSourceType,
} from './setup-sources.js';
export { runKtxSetupSourcesStep } from './setup-sources.js';
export { runKtxRuntime, type KtxRuntimeArgs, type KtxRuntimeDeps } from './runtime.js';
export {
  allocateDaemonPort,
  readManagedPythonDaemonStatus,
  startManagedPythonDaemon,
  stopManagedPythonDaemon,
} from './managed-python-daemon.js';
export type {
  ManagedPythonDaemonStartResult,
  ManagedPythonDaemonState,
  ManagedPythonDaemonStatus,
  ManagedPythonDaemonStopResult,
} from './managed-python-daemon.js';
export {
  ensureManagedLocalEmbeddingsDaemon,
  managedLocalEmbeddingHealthConfig,
  managedLocalEmbeddingProjectConfig,
  type ManagedLocalEmbeddingsDaemon,
  type ManagedLocalEmbeddingsOptions,
} from './managed-local-embeddings.js';
export type { KtxMemoryFlowTuiIo, MemoryFlowTuiLiveSession } from './memory-flow-tui.js';
export {
  renderMemoryFlowTui,
  sanitizeMemoryFlowTuiError,
  startLiveMemoryFlowTui,
} from './memory-flow-tui.js';
export { rendererUnavailableVizFallback, resolveVizFallback, warnVizFallbackOnce } from './viz-fallback.js';

profileMark('module:index');
