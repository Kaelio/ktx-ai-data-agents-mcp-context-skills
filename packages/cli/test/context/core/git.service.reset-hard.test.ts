import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimpleGit } from 'simple-git';
import type { KtxCoreConfig } from '../../../src/context/core/config.js';
import { createSimpleGit } from '../../../src/context/core/git-env.js';
import { GitService } from '../../../src/context/core/git.service.js';

describe('GitService.resetHardTo', () => {
  let workdir: string;
  let git: SimpleGit;
  let gitService: GitService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'gitsvc-reset-'));
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

  it('rewinds HEAD to the target SHA, removing later commits and their files', async () => {
    const baseSha = (await git.revparse(['HEAD'])).trim();
    await writeFile(join(workdir, 'a'), 'a1');
    await git.add('.');
    await git.commit('a');
    await writeFile(join(workdir, 'b'), 'b1');
    await git.add('.');
    await git.commit('b');

    await gitService.resetHardTo(baseSha);

    expect((await git.revparse(['HEAD'])).trim()).toBe(baseSha);
    expect(await readFile(join(workdir, 'a'), 'utf-8').catch(() => null)).toBeNull();
    expect(await readFile(join(workdir, 'b'), 'utf-8').catch(() => null)).toBeNull();
  });

  it('is a no-op when target SHA equals current HEAD', async () => {
    const sha = (await git.revparse(['HEAD'])).trim();
    await gitService.resetHardTo(sha);
    expect((await git.revparse(['HEAD'])).trim()).toBe(sha);
  });
});
