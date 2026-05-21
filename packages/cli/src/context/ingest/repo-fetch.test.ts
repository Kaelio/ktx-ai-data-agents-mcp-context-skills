import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalGitRepo } from '../test/make-local-git-repo.js';

const FIXTURE_ROOT = join(__dirname, '../../test/fixtures/lookml/single-model');

async function loadRepoFetch() {
  return await import('./repo-fetch.js');
}

describe('repo-fetch', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'repo-fetch-'));
    vi.resetModules();
    vi.doUnmock('./git-env.js');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('./git-env.js');
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('builds authenticated URLs for GitHub, GitLab, generic hosts, empty tokens, and file URLs', async () => {
    const { buildAuthenticatedUrl } = await loadRepoFetch();

    expect(buildAuthenticatedUrl('https://github.com/acme/repo.git', null)).toBe(
      'https://github.com/acme/repo.git',
    );
    expect(buildAuthenticatedUrl('file:///tmp/repo', 'tok')).toBe('file:///tmp/repo');
    expect(buildAuthenticatedUrl('https://github.com/acme/repo.git', 'tok')).toBe(
      'https://x-token-auth:tok@github.com/acme/repo.git', // pragma: allowlist secret
    );
    expect(buildAuthenticatedUrl('https://gitlab.com/acme/repo.git', 'tok')).toBe(
      'https://oauth2:tok@gitlab.com/acme/repo.git', // pragma: allowlist secret
    );
    expect(buildAuthenticatedUrl('https://git.example.com/acme/repo.git', 'tok')).toBe(
      'https://token:tok@git.example.com/acme/repo.git', // pragma: allowlist secret
    );
  });

  it('sanitizes both URL password patterns and literal token text', async () => {
    const { sanitizeRepoError } = await loadRepoFetch();

    const message = sanitizeRepoError(
      new Error('failed https://token:supersecret@git.example.com/acme/repo.git because supersecret expired'), // pragma: allowlist secret
      'supersecret',
    );

    expect(message).toContain('https://token:***@git.example.com/acme/repo.git');
    expect(message).not.toContain('supersecret');
  });

  it('validates required and URL-shaped repository configuration', async () => {
    const { RepoConfigError, validateRepoConfig } = await loadRepoFetch();

    expect(() => validateRepoConfig({ repoUrl: '' })).toThrow(RepoConfigError);
    expect(() => validateRepoConfig({ repoUrl: 'not a url' })).toThrow(RepoConfigError);
    expect(() => validateRepoConfig({ repoUrl: 'file:///tmp/repo' })).not.toThrow();
  });

  it('clones a local repo and returns the full 40-character commit hash', async () => {
    const { cloneOrPull } = await loadRepoFetch();
    const repo = await makeLocalGitRepo(FIXTURE_ROOT, join(tmpRoot, 'origin'));
    const cacheDir = join(tmpRoot, 'cache', 'conn-1');

    const result = await cloneOrPull({
      repoUrl: repo.repoUrl,
      cacheDir,
      branch: 'main',
    });

    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
    await expect(readFile(join(cacheDir, 'orders.model.lkml'), 'utf-8')).resolves.toMatch(/connection:/);
  });

  it('pulls an existing cache and returns the new origin commit hash', async () => {
    const { cloneOrPull } = await loadRepoFetch();
    const repo = await makeLocalGitRepo(FIXTURE_ROOT, join(tmpRoot, 'origin'));
    const cacheDir = join(tmpRoot, 'cache', 'conn-pull');

    const first = await cloneOrPull({ repoUrl: repo.repoUrl, cacheDir, branch: 'main' });

    await repo.writeFile('views/orders.view.lkml', 'view: orders { sql_table_name: public.orders_v2 ;; }\n');
    const secondCommit = await repo.commit('bump lookml view');

    const second = await cloneOrPull({ repoUrl: repo.repoUrl, cacheDir, branch: 'main' });

    expect(second.commitHash).toBe(secondCommit);
    expect(second.commitHash).not.toBe(first.commitHash);
    await expect(readFile(join(cacheDir, 'views', 'orders.view.lkml'), 'utf-8')).resolves.toMatch(/orders_v2/);
  });

  it('falls back to a fresh clone when the existing cache diverges locally', async () => {
    const { cloneOrPull } = await loadRepoFetch();
    const { createSimpleGit } = await import('./git-env.js');
    const repo = await makeLocalGitRepo(FIXTURE_ROOT, join(tmpRoot, 'origin'));
    const cacheDir = join(tmpRoot, 'cache', 'conn-diverged');

    await cloneOrPull({ repoUrl: repo.repoUrl, cacheDir, branch: 'main' });

    const cacheGit = createSimpleGit(cacheDir);
    await cacheGit.addConfig('user.email', 'test@ktx.local');
    await cacheGit.addConfig('user.name', 'KTX Test');
    await writeFile(join(cacheDir, 'local-only.txt'), 'local commit\n', 'utf-8');
    await cacheGit.add('.');
    await cacheGit.commit('local-only divergent commit');

    await repo.writeFile('views/orders.view.lkml', 'view: orders { sql_table_name: public.orders_remote ;; }\n');
    const originCommit = await repo.commit('remote commit');

    const result = await cloneOrPull({ repoUrl: repo.repoUrl, cacheDir, branch: 'main' });

    expect(result.commitHash).toBe(originCommit);
    await expect(access(join(cacheDir, 'local-only.txt'))).rejects.toThrow();
    await expect(readFile(join(cacheDir, 'views', 'orders.view.lkml'), 'utf-8')).resolves.toMatch(/orders_remote/);
  });

  it('falls back to a fresh clone when the cache has a corrupt .git directory', async () => {
    const { cloneOrPull } = await loadRepoFetch();
    const repo = await makeLocalGitRepo(FIXTURE_ROOT, join(tmpRoot, 'origin'));
    const cacheDir = join(tmpRoot, 'cache', 'conn-corrupt');

    await mkdir(join(cacheDir, '.git'), { recursive: true });
    await writeFile(join(cacheDir, '.git', 'HEAD'), 'garbage\n', 'utf-8');

    const result = await cloneOrPull({ repoUrl: repo.repoUrl, cacheDir, branch: 'main' });

    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
    await expect(readFile(join(cacheDir, 'orders.model.lkml'), 'utf-8')).resolves.toMatch(/connection:/);
  });

  it('returns a sanitized RepoFetchError when fresh clone fails', async () => {
    const { RepoFetchError, cloneOrPull } = await loadRepoFetch();
    const repo = await makeLocalGitRepo(FIXTURE_ROOT, join(tmpRoot, 'origin'));

    await expect(
      cloneOrPull({
        repoUrl: repo.repoUrl,
        cacheDir: join(tmpRoot, 'cache', 'missing-branch'),
        branch: 'missing',
        authToken: 'supersecret-token',
      }),
    ).rejects.toThrow(RepoFetchError);

    await expect(
      cloneOrPull({
        repoUrl: repo.repoUrl,
        cacheDir: join(tmpRoot, 'cache', 'missing-branch-2'),
        branch: 'missing',
        authToken: 'supersecret-token',
      }),
    ).rejects.toThrow(expect.objectContaining({ message: expect.not.stringContaining('supersecret-token') }));
  });

  it('testRepoConnection returns ok true for a local repo and ok false for a missing local repo', async () => {
    const { testRepoConnection } = await loadRepoFetch();
    const repo = await makeLocalGitRepo(FIXTURE_ROOT, join(tmpRoot, 'origin'));

    await expect(testRepoConnection({ repoUrl: repo.repoUrl })).resolves.toEqual({ ok: true });

    const failed = await testRepoConnection({ repoUrl: `file://${join(tmpRoot, 'does-not-exist')}` });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toEqual(expect.any(String));
    }
  });

  it('cleans up non-existent and existing repository directories idempotently', async () => {
    const { cleanupRepoDir } = await loadRepoFetch();
    const existing = join(tmpRoot, 'cache', 'to-clean');

    await mkdir(join(existing, '.git'), { recursive: true });
    await cleanupRepoDir(existing);
    await cleanupRepoDir(existing);

    await expect(access(existing)).rejects.toThrow();
  });

  it('sets the remote URL on every pull so token rotation and token removal update cached .git/config', async () => {
    const cacheDir = join(tmpRoot, 'cache', 'auth-refresh');
    await mkdir(join(cacheDir, '.git'), { recursive: true });

    const worktreeGit = {
      remote: vi.fn(async () => undefined),
      fetch: vi.fn(async () => undefined),
      checkout: vi.fn(async () => undefined),
      pull: vi.fn(async () => undefined),
      log: vi.fn(async () => ({ latest: { hash: 'a'.repeat(40) } })),
    };
    const rootGit = {
      clone: vi.fn(async () => undefined),
    };

    vi.doMock('./git-env.js', () => ({
      createSimpleGit: vi.fn((baseDir?: string) => (baseDir ? worktreeGit : rootGit)),
    }));

    const { cloneOrPull } = await loadRepoFetch();

    await cloneOrPull({
      repoUrl: 'https://github.com/acme/repo.git',
      authToken: 'new-token',
      cacheDir,
      branch: 'main',
    });
    await cloneOrPull({
      repoUrl: 'https://github.com/acme/repo.git',
      authToken: null,
      cacheDir,
      branch: 'main',
    });

    expect(worktreeGit.remote).toHaveBeenCalledWith([
      'set-url',
      'origin',
      'https://x-token-auth:new-token@github.com/acme/repo.git', // pragma: allowlist secret
    ]);
    expect(worktreeGit.remote).toHaveBeenCalledWith(['set-url', 'origin', 'https://github.com/acme/repo.git']);
    expect(rootGit.clone).not.toHaveBeenCalled();
  });
});
