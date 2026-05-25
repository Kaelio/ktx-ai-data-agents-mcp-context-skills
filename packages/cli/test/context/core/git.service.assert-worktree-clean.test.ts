import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimpleGit } from 'simple-git';
import type { KtxCoreConfig } from '../../../src/context/core/config.js';
import { createSimpleGit } from '../../../src/context/core/git-env.js';
import { GitService } from '../../../src/context/core/git.service.js';

describe('GitService.assertWorktreeClean', () => {
  let workdir: string;
  let git: SimpleGit;
  let gitService: GitService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'gitsvc-clean-'));
    git = createSimpleGit(workdir);
    await git.init();
    await git.addConfig('user.email', 't@test');
    await git.addConfig('user.name', 'Test');
    await writeFile(join(workdir, 'init'), 'init');
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

  it('does not throw on a clean worktree', async () => {
    await expect(gitService.assertWorktreeClean()).resolves.toBeUndefined();
  });

  it('throws when MERGE_HEAD exists', async () => {
    await writeFile(join(workdir, '.git', 'MERGE_HEAD'), 'deadbeef\n');
    await expect(gitService.assertWorktreeClean()).rejects.toThrow(/MERGE_HEAD/);
  });

  it('throws when CHERRY_PICK_HEAD exists', async () => {
    await writeFile(join(workdir, '.git', 'CHERRY_PICK_HEAD'), 'deadbeef\n');
    await expect(gitService.assertWorktreeClean()).rejects.toThrow(/CHERRY_PICK_HEAD/);
  });

  it('throws when REVERT_HEAD exists', async () => {
    await writeFile(join(workdir, '.git', 'REVERT_HEAD'), 'deadbeef\n');
    await expect(gitService.assertWorktreeClean()).rejects.toThrow(/REVERT_HEAD/);
  });

  it('throws when sequencer/todo exists (interrupted multi-commit revert/cherry-pick)', async () => {
    await mkdir(join(workdir, '.git', 'sequencer'), { recursive: true });
    await writeFile(join(workdir, '.git', 'sequencer', 'todo'), 'pick deadbeef foo\n');
    await expect(gitService.assertWorktreeClean()).rejects.toThrow(/sequencer/);
  });

  it('throws when the index has unmerged paths', async () => {
    await git.checkoutLocalBranch('a');
    await writeFile(join(workdir, 'shared'), 'A version');
    await git.add('.');
    await git.commit('a');
    await git.checkout('master').catch(() => git.checkout('main'));
    await git.checkoutLocalBranch('b');
    await writeFile(join(workdir, 'shared'), 'B version');
    await git.add('.');
    await git.commit('b');

    await git.raw(['merge', 'a']).catch(() => undefined);

    await expect(gitService.assertWorktreeClean()).rejects.toThrow();
  });
});
