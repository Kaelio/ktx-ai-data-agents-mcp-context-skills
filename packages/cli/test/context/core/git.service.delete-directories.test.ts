import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimpleGit } from 'simple-git';
import type { KtxCoreConfig } from '../../../src/context/core/config.js';
import { createSimpleGit } from '../../../src/context/core/git-env.js';
import { GitService } from '../../../src/context/core/git.service.js';

describe('GitService.deleteDirectories', () => {
  let workdir: string;
  let git: SimpleGit;
  let gitService: GitService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'gitsvc-dd-'));
    git = createSimpleGit(workdir);
    await git.init();
    await git.addConfig('user.email', 't@test');
    await git.addConfig('user.name', 'Test');
    await writeFile(join(workdir, 'keep'), 'k');
    await git.add('.');
    await git.commit('init');

    const coreConfig: KtxCoreConfig = {
      storage: { configDir: workdir, homeDir: workdir },
      git: { userName: 'Test', userEmail: 't@test' },
    };
    gitService = new GitService(coreConfig);
    (gitService as any).git = git;
    (gitService as any).configDir = workdir;
  });

  afterEach(async () => rm(workdir, { recursive: true, force: true }));

  it('removes multiple directories in a single commit', async () => {
    for (const name of ['a', 'b', 'c']) {
      await mkdir(join(workdir, name), { recursive: true });
      await writeFile(join(workdir, name, 'f.txt'), name);
    }
    await git.add('.');
    await git.commit('seed 3 dirs');
    const beforeCommits = (await git.log()).total;

    const result = await gitService.deleteDirectories(['a', 'b'], 'gc: drop a+b', 'System User', 'system@example.com');
    expect(result.commitHash).toBeTruthy();

    const entries = await readdir(workdir);
    expect(entries).not.toContain('a');
    expect(entries).not.toContain('b');
    expect(entries).toContain('c');

    const afterCommits = (await git.log()).total;
    expect(afterCommits).toBe(beforeCommits + 1);
  });

  it('no-ops and returns a null hash when the input list is empty', async () => {
    const result = await gitService.deleteDirectories([], 'empty', 'X', 'x@example.com');
    expect(result.commitHash).toBe('');
    expect(result.created).toBe(false);
  });

  it('ignores paths that have already been deleted — commits only the remaining ones', async () => {
    await mkdir(join(workdir, 'stale'), { recursive: true });
    await writeFile(join(workdir, 'stale', 'x'), 'x');
    await git.add('.');
    await git.commit('seed stale');
    const result = await gitService.deleteDirectories(
      ['stale', 'missing'],
      'gc: drop stale + missing',
      'System User',
      'system@example.com',
    );
    expect(result.commitHash).toBeTruthy();
    const entries = await readdir(workdir);
    expect(entries).not.toContain('stale');
  });
});
