export interface KtxFileWriteResult {
  commitHash?: string | null;
  [key: string]: unknown;
}

export interface KtxFileReadResult {
  content: string;
  [key: string]: unknown;
}

export interface KtxFileListResult {
  files: string[];
}

export interface KtxFileHistoryEntry {
  sha?: string;
  message?: string;
  author?: string;
  date?: string | Date;
  [key: string]: unknown;
}

export interface KtxFileStorePort<TSelf = unknown> {
  writeFile(
    path: string,
    content: string,
    author: string,
    authorEmail: string,
    commitMessage: string,
    options?: { skipLock?: boolean },
  ): Promise<KtxFileWriteResult>;
  readFile(path: string): Promise<KtxFileReadResult>;
  deleteFile(
    path: string,
    author: string,
    authorEmail: string,
    commitMessage: string,
    options?: { skipLock?: boolean },
  ): Promise<KtxFileWriteResult | null>;
  listFiles(path: string, recursive?: boolean): Promise<KtxFileListResult>;
  getFileHistory(path: string): Promise<KtxFileHistoryEntry[] | unknown>;
  forWorktree(workdir: string): TSelf;
}
