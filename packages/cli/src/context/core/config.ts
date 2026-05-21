export interface KtxStorageConfig {
  configDir?: string;
  homeDir?: string;
  worktreesDir?: string;
}

export interface KtxGitConfig {
  userName: string;
  userEmail: string;
  bootstrapMessage?: string;
  bootstrapAuthor?: string;
  bootstrapAuthorEmail?: string;
}

export interface KtxCoreConfig {
  storage: KtxStorageConfig;
  git: KtxGitConfig;
}

export interface KtxLogger {
  debug(message: string): void;
  log(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export const noopLogger: KtxLogger = {
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function resolveConfigDir(config: KtxCoreConfig): string {
  const homeDir = config.storage.homeDir ?? '/tmp';
  return config.storage.configDir ?? `${homeDir}/ktx/config`;
}

export function resolveWorktreesDir(config: KtxCoreConfig): string {
  const homeDir = config.storage.homeDir ?? '/tmp';
  return config.storage.worktreesDir ?? `${homeDir}/.worktrees`;
}
