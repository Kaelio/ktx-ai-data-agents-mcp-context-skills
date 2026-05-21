import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GitCommitInfo, GitService } from '../../context/core/git.service.js';
import type { KtxFileHistoryEntry, KtxFileListResult, KtxFileReadResult, KtxFileStorePort, KtxFileWriteResult } from '../../context/core/file-store.js';

export interface LocalGitFileStoreDeps {
  rootDir: string;
  git: GitService;
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function gitInfoToWriteResult(info: GitCommitInfo): KtxFileWriteResult {
  return {
    success: true,
    commitHash: info.commitHash,
    commitMessage: info.message,
    author: info.author,
    authorEmail: info.authorEmail,
    timestamp: info.timestamp,
    created: info.created,
  };
}

export class LocalGitFileStore implements KtxFileStorePort<LocalGitFileStore> {
  private readonly rootDir: string;
  private readonly git: GitService;

  constructor(deps: LocalGitFileStoreDeps) {
    this.rootDir = resolve(deps.rootDir);
    this.git = deps.git;
  }

  forWorktree(workdir: string): LocalGitFileStore {
    return new LocalGitFileStore({ rootDir: workdir, git: this.git.forWorktree(workdir) });
  }

  async writeFile(
    path: string,
    content: string,
    author: string,
    authorEmail: string,
    commitMessage: string,
    options?: { skipLock?: boolean },
  ): Promise<KtxFileWriteResult> {
    const relativePath = this.safeRelativePath(path);
    const absolutePath = this.absolutePath(relativePath);
    await fs.mkdir(dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf-8');

    if (options?.skipLock) {
      return { success: true, commitHash: null, path: relativePath, operation: 'write' };
    }

    const info = await this.git.commitFile(relativePath, commitMessage, author, authorEmail);
    return { ...gitInfoToWriteResult(info), path: relativePath, operation: 'write' };
  }

  async readFile(path: string): Promise<KtxFileReadResult> {
    const relativePath = this.safeRelativePath(path);
    const absolutePath = this.absolutePath(relativePath);
    const content = await fs.readFile(absolutePath, 'utf-8');
    const stats = await fs.stat(absolutePath);
    return {
      path: relativePath,
      content,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  }

  async deleteFile(
    path: string,
    author: string,
    authorEmail: string,
    commitMessage: string,
    options?: { skipLock?: boolean },
  ): Promise<KtxFileWriteResult | null> {
    const relativePath = this.safeRelativePath(path);
    const absolutePath = this.absolutePath(relativePath);
    try {
      await fs.access(absolutePath);
    } catch {
      return null;
    }

    await fs.unlink(absolutePath);

    if (options?.skipLock) {
      return { success: true, commitHash: null, path: relativePath, operation: 'delete' };
    }

    const info = await this.git.deleteFile(relativePath, commitMessage, author, authorEmail);
    return { ...gitInfoToWriteResult(info), path: relativePath, operation: 'delete' };
  }

  async listFiles(path = '', stripPrefix = false): Promise<KtxFileListResult> {
    const relativePath = path ? this.safeRelativePath(path) : '';
    const searchRoot = relativePath ? this.absolutePath(relativePath) : this.rootDir;
    let files: string[];

    try {
      files = await this.walk(searchRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { files: [] };
      }
      throw error;
    }

    const prefix = relativePath ? `${relativePath}/` : '';
    const relativeFiles = files
      .map((file) => normalizeRelativePath(relative(this.rootDir, file)))
      .filter((file) => !file.startsWith('.git/') && !file.includes('/.git/'))
      .filter((file) => !file.startsWith('.ktx/cache/'))
      .map((file) => (stripPrefix && prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file))
      .sort();

    return { files: relativeFiles };
  }

  async getFileHistory(path: string): Promise<KtxFileHistoryEntry[]> {
    const relativePath = this.safeRelativePath(path);
    const history = await this.git.getFileHistory(relativePath);
    return history.map((entry) => ({
      sha: entry.commitHash,
      commitHash: entry.commitHash,
      shortHash: entry.shortHash,
      message: entry.message,
      author: entry.author,
      authorEmail: entry.authorEmail,
      timestamp: entry.timestamp,
      committedDate: entry.committedDate,
      created: entry.created,
      enhancedMessage: entry.enhancedMessage,
    }));
  }

  private safeRelativePath(path: string): string {
    if (path.length === 0) {
      return '';
    }
    if (isAbsolute(path)) {
      throw new Error('Path must be relative');
    }

    const normalized = normalizeRelativePath(path);
    if (normalized === '.git' || normalized.startsWith('.git/')) {
      throw new Error('Path cannot access .git');
    }

    const absolute = resolve(this.rootDir, normalized);
    if (absolute !== this.rootDir && !absolute.startsWith(`${this.rootDir}${sep}`)) {
      throw new Error('Path escapes the project directory');
    }

    return normalized;
  }

  private absolutePath(path: string): string {
    return path ? join(this.rootDir, path) : this.rootDir;
  }

  private async walk(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git') {
          files.push(...(await this.walk(absolute)));
        }
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }

    return files;
  }
}
