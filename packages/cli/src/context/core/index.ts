export type { KtxCoreConfig, KtxGitConfig, KtxLogger, KtxStorageConfig } from './config.js';
export { noopLogger, resolveConfigDir, resolveWorktreesDir } from './config.js';
export { resolveKtxConfigReference, resolveKtxHomePath } from './config-reference.js';
export type { KtxEmbeddingPort } from './embedding.js';
export {
  REDACTED_KTX_CREDENTIAL_VALUE,
  redactKtxSensitiveMetadata,
  redactKtxSensitiveText,
  redactKtxSensitiveValue,
} from './redaction.js';
export type {
  KtxFileHistoryEntry,
  KtxFileListResult,
  KtxFileReadResult,
  KtxFileStorePort,
  KtxFileWriteResult,
} from './file-store.js';
export type { GitCommitInfo, SquashMergeResult, WorktreeEntry } from './git.service.js';
export { GitService } from './git.service.js';
export type {
  SentinelPayload,
  SessionOutcome,
  SessionWorktree,
  SessionWorktreeServiceDeps,
  WorktreeConfigPort,
} from './session-worktree.service.js';
export { SessionWorktreeService } from './session-worktree.service.js';
