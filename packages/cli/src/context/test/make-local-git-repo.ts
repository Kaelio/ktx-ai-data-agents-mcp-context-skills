import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SimpleGit } from 'simple-git';
import { createSimpleGit } from '../ingest/git-env.js';

export interface LocalGitRepo {
  repoDir: string;
  repoUrl: string;
  git: SimpleGit;
  commit: (message: string) => Promise<string>;
  writeFile: (relPath: string, content: string) => Promise<void>;
  deleteFile: (relPath: string) => Promise<void>;
}

export async function makeLocalGitRepo(fixtureDir: string, destRoot: string): Promise<LocalGitRepo> {
  const repoDir = join(destRoot, 'repo');
  await mkdir(repoDir, { recursive: true });
  await cp(fixtureDir, repoDir, { recursive: true });
  const git = createSimpleGit(repoDir);
  await git.init();
  await git.raw(['checkout', '-B', 'main']);
  await git.addConfig('user.email', 'test@ktx.local');
  await git.addConfig('user.name', 'KTX Test');
  await git.add('.');
  await git.commit('initial');
  const commit = async (message: string): Promise<string> => {
    await git.add('.');
    await git.commit(message);
    return (await git.log({ maxCount: 1 })).latest?.hash ?? '';
  };
  return {
    repoDir,
    repoUrl: `file://${repoDir}`,
    git,
    commit,
    writeFile: async (relPath: string, content: string) => {
      const dest = join(repoDir, relPath);
      await mkdir(join(dest, '..'), { recursive: true });
      await writeFile(dest, content, 'utf-8');
    },
    deleteFile: async (relPath: string) => {
      await rm(join(repoDir, relPath), { force: true });
    },
  };
}
