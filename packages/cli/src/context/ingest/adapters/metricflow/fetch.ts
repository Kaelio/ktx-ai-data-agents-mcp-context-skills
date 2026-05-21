import { access, copyFile, mkdir, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { cloneOrPull, sanitizeRepoError } from '../../repo-fetch.js';
import type { MetricflowPullConfig } from './pull-config.js';

export interface FetchMetricflowRepoParams {
  config: MetricflowPullConfig;
  cacheDir: string;
  stagedDir: string;
}

export interface FetchMetricflowRepoResult {
  commitHash: string;
  filesCopied: number;
}

const YAML_EXT_RE = /\.ya?ml$/i;

export async function fetchMetricflowRepo(params: FetchMetricflowRepoParams): Promise<FetchMetricflowRepoResult> {
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
    const filesCopied = await copyYamlFilesRecursive(sourceRoot, stagedDir);
    return { commitHash, filesCopied };
  } catch (err) {
    throw new Error(sanitizeRepoError(err, config.authToken));
  }
}

async function copyYamlFilesRecursive(sourceRoot: string, destRoot: string): Promise<number> {
  if (!(await dirExists(sourceRoot))) {
    return 0;
  }
  await mkdir(destRoot, { recursive: true });
  const entries = await readdir(sourceRoot, { withFileTypes: true, recursive: true });
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !YAML_EXT_RE.test(entry.name)) {
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
