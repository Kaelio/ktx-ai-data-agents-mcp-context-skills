import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { KtxCoreConfig } from '../../../src/context/core/config.js';
import { classifyKtxRepoOwnership, GitService } from '../../../src/context/core/git.service.js';

function coreConfig(configDir: string): KtxCoreConfig {
  return {
    storage: { configDir, homeDir: configDir },
    git: {
      userName: 'Test User',
      userEmail: 'test@example.com',
      bootstrapMessage: 'Initialize test config repo',
      bootstrapAuthor: 'test-system',
      bootstrapAuthorEmail: 'system@example.com',
    },
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Parent User',
      GIT_AUTHOR_EMAIL: 'parent@example.com',
      GIT_COMMITTER_NAME: 'Parent User',
      GIT_COMMITTER_EMAIL: 'parent@example.com',
    },
  }).trim();
}

describe('GitService repository ownership', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'git-service-isolation-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates and commits inside its own repo when nested in an enclosing repo', async () => {
    const parentDir = join(tempDir, 'parent');
    const projectDir = join(parentDir, '.ktx-project');
    await mkdir(projectDir, { recursive: true });

    git(parentDir, ['init']);
    await writeFile(join(parentDir, 'README.md'), '# Parent\n', 'utf-8');
    git(parentDir, ['add', 'README.md']);
    git(parentDir, ['commit', '-m', 'parent baseline']);
    const parentHeadBefore = git(parentDir, ['rev-parse', 'HEAD']);

    const service = new GitService(coreConfig(projectDir));
    await service.onModuleInit();

    expect(git(projectDir, ['config', '--local', '--get', 'ktx.managed'])).toBe('true');
    expect(git(parentDir, ['rev-parse', 'HEAD'])).toBe(parentHeadBefore);
    expect(await realpath(git(projectDir, ['rev-parse', '--show-toplevel']))).toBe(await realpath(projectDir));

    await writeFile(join(projectDir, 'wiki.md'), '# Wiki\n', 'utf-8');
    await service.commitFile('wiki.md', 'Add wiki page', 'Test User', 'test@example.com');

    expect(git(parentDir, ['rev-parse', 'HEAD'])).toBe(parentHeadBefore);
    expect(git(projectDir, ['log', '--oneline', '--max-count=1'])).toContain('Add wiki page');
    expect(git(parentDir, ['status', '--short'])).toContain('?? .ktx-project/');
  });

  it('rejects a foreign repo rooted at the project dir', async () => {
    const projectDir = join(tempDir, 'foreign');
    await mkdir(projectDir, { recursive: true });
    git(projectDir, ['init']);
    const configBefore = await readFile(join(projectDir, '.git', 'config'), 'utf-8');

    const service = new GitService(coreConfig(projectDir));

    await expect(service.onModuleInit()).rejects.toThrow(/already a git repository that ktx did not create/);
    expect(await readFile(join(projectDir, '.git', 'config'), 'utf-8')).toBe(configBefore);
  });

  it('rejects a gitfile at the project dir as foreign', async () => {
    const projectDir = join(tempDir, 'linked-worktree');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, '.git'), 'gitdir: ../actual.git\n', 'utf-8');

    const service = new GitService(coreConfig(projectDir));

    await expect(service.onModuleInit()).rejects.toThrow(/already a git repository that ktx did not create/);
  });

  it('accepts a marked ktx repo and does not create a second bootstrap commit', async () => {
    const projectDir = join(tempDir, 'owned');
    const service = new GitService(coreConfig(projectDir));
    await service.onModuleInit();
    const before = await service.revParseHead();

    const second = new GitService(coreConfig(projectDir));
    await second.onModuleInit();

    expect(await second.revParseHead()).toBe(before);
    expect(git(projectDir, ['config', '--local', '--get', 'ktx.managed'])).toBe('true');
  });
});

describe('classifyKtxRepoOwnership', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'git-ownership-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reports unowned when no .git exists at the directory', async () => {
    const dir = join(tempDir, 'fresh');
    await mkdir(dir, { recursive: true });
    expect(await classifyKtxRepoOwnership(dir)).toBe('unowned');
  });

  it('reports unowned for a fresh directory nested inside an enclosing repo', async () => {
    const parentDir = join(tempDir, 'parent');
    const nestedDir = join(parentDir, 'nested');
    await mkdir(nestedDir, { recursive: true });
    git(parentDir, ['init']);
    expect(await classifyKtxRepoOwnership(nestedDir)).toBe('unowned');
  });

  it('reports ktx-managed for a repo ktx initialized', async () => {
    const dir = join(tempDir, 'owned');
    await new GitService(coreConfig(dir)).onModuleInit();
    expect(await classifyKtxRepoOwnership(dir)).toBe('ktx-managed');
  });

  it('reports foreign for a repo ktx did not create', async () => {
    const dir = join(tempDir, 'foreign');
    await mkdir(dir, { recursive: true });
    git(dir, ['init']);
    expect(await classifyKtxRepoOwnership(dir)).toBe('foreign');
  });

  it('reports foreign for a .git file (linked worktree)', async () => {
    const dir = join(tempDir, 'linked');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.git'), 'gitdir: ../actual.git\n', 'utf-8');
    expect(await classifyKtxRepoOwnership(dir)).toBe('foreign');
  });

  it('reports unowned when the path is itself a file', async () => {
    const filePath = join(tempDir, 'notes.txt');
    await writeFile(filePath, 'a file, not a folder\n', 'utf-8');
    expect(await classifyKtxRepoOwnership(filePath)).toBe('unowned');
  });
});
