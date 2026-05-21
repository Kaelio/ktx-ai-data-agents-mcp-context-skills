import { access, copyFile, mkdir, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { cloneOrPull, sanitizeRepoError } from '../../repo-fetch.js';
import type { LookmlPullConfig } from './pull-config.js';

export interface FetchLookmlRepoParams {
  config: LookmlPullConfig;
  /** Persistent cache directory (typically per-connection). Cloned here once, pulled on subsequent calls. */
  cacheDir: string;
  /** Per-job staged directory that the adapter writes `.lkml`/`.lookml` files into. */
  stagedDir: string;
}

export interface FetchLookmlRepoResult {
  /** SHA of the repo HEAD after the pull. */
  commitHash: string;
  /** Number of LookML files copied into `stagedDir`. */
  filesCopied: number;
}

const LKML_EXT_RE = /\.(lkml|lookml)$/i;

export async function fetchLookmlRepo(params: FetchLookmlRepoParams): Promise<FetchLookmlRepoResult> {
  const { config, cacheDir, stagedDir } = params;
  const branch = config.branch || 'main';

  try {
    const { commitHash } = await cloneOrPull({
      repoUrl: config.repoUrl,
      authToken: config.authToken,
      cacheDir,
      branch,
    });

    const sourceRoot = config.path ? join(cacheDir, config.path) : cacheDir;
    const filesCopied = await copyLkmlFilesRecursive(sourceRoot, stagedDir);

    return { commitHash, filesCopied };
  } catch (err) {
    throw new Error(sanitizeRepoError(err, config.authToken));
  }
}

async function copyLkmlFilesRecursive(sourceRoot: string, destRoot: string): Promise<number> {
  if (!(await dirExists(sourceRoot))) {
    return 0;
  }
  await mkdir(destRoot, { recursive: true });
  const entries = await readdir(sourceRoot, { withFileTypes: true, recursive: true });
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!LKML_EXT_RE.test(entry.name)) {
      continue;
    }
    const absSrc = join(entry.parentPath, entry.name);
    const rel = relative(sourceRoot, absSrc);
    const dest = join(destRoot, rel);
    await mkdir(join(dest, '..'), { recursive: true });
    await copyFile(absSrc, dest);
    copied++;
  }
  return copied;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
