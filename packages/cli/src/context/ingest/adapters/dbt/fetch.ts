import { access, copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { cloneOrPull, sanitizeRepoError } from '../../repo-fetch.js';

export interface DbtPullConfig {
  repoUrl: string;
  branch?: string;
  path?: string;
  authToken?: string | null;
}

export interface FetchDbtRepoParams {
  config: DbtPullConfig;
  cacheDir: string;
  stagedDir: string;
  deps?: {
    cloneOrPull?: typeof cloneOrPull;
  };
}

export async function fetchDbtRepo(params: FetchDbtRepoParams): Promise<{ commitHash: string; filesCopied: number }> {
  try {
    const runCloneOrPull = params.deps?.cloneOrPull ?? cloneOrPull;
    const { commitHash } = await runCloneOrPull({
      repoUrl: params.config.repoUrl,
      authToken: params.config.authToken,
      cacheDir: params.cacheDir,
      branch: params.config.branch ?? 'main',
    });
    const sourceRoot = params.config.path ? join(params.cacheDir, params.config.path) : params.cacheDir;
    const filesCopied = await copyYamlFilesRecursive(sourceRoot, params.stagedDir);
    return { commitHash, filesCopied };
  } catch (error) {
    throw new Error(sanitizeRepoError(error, params.config.authToken));
  }
}

async function copyYamlFilesRecursive(sourceRoot: string, destRoot: string): Promise<number> {
  try {
    await access(sourceRoot);
  } catch {
    return 0;
  }

  await mkdir(destRoot, { recursive: true });
  const entries = await readdir(sourceRoot, { withFileTypes: true, recursive: true });
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) {
      continue;
    }
    const absSrc = join(entry.parentPath, entry.name);
    const rel = relative(sourceRoot, absSrc);
    const dest = join(destRoot, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(absSrc, dest);
    copied += 1;
  }
  return copied;
}
