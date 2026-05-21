import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeLocalGitRepo } from '../../../test/make-local-git-repo.js';
import { fetchLookmlRepo } from './fetch.js';
import type { LookmlPullConfig } from './pull-config.js';

const FIXTURE_ROOT = join(__dirname, '../../../../test/fixtures/lookml');

function pullConfig(overrides: Partial<LookmlPullConfig> & Pick<LookmlPullConfig, 'repoUrl'>): LookmlPullConfig {
  return {
    branch: 'main',
    path: null,
    authToken: null,
    expectedLookerConnectionName: null,
    parsedTargetTables: {},
    ...overrides,
  };
}

describe('fetchLookmlRepo', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'fetch-lookml-'));
  });

  afterEach(async () => rm(tmpRoot, { recursive: true, force: true }));

  it('clones a local file:// repo and materializes only .lkml/.lookml files into stagedDir', async () => {
    const repo = await makeLocalGitRepo(join(FIXTURE_ROOT, 'single-model'), join(tmpRoot, 'origin'));
    // Add a non-LookML file to prove we filter it out.
    await repo.writeFile('README.md', '# readme\n');
    await repo.commit('add readme');

    const stagedDir = join(tmpRoot, 'staged');
    const cacheDir = join(tmpRoot, 'cache', 'conn-1');
    await mkdir(stagedDir, { recursive: true });

    const result = await fetchLookmlRepo({
      config: pullConfig({ repoUrl: repo.repoUrl }),
      cacheDir,
      stagedDir,
    });

    expect(result.filesCopied).toBe(3); // orders.model.lkml + 2 views
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
    await expect(readFile(join(stagedDir, 'orders.model.lkml'), 'utf-8')).resolves.toMatch(/connection:/);
    await expect(readFile(join(stagedDir, 'views', 'orders.view.lkml'), 'utf-8')).resolves.toMatch(/view: orders/);
    // README.md is present in the cache but NOT in stagedDir.
    await expect(readFile(join(stagedDir, 'README.md'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(cacheDir, 'README.md'), 'utf-8')).resolves.toMatch(/readme/);
  });

  it('pulls an existing cache dir (second call) and surfaces the new commit', async () => {
    const repo = await makeLocalGitRepo(join(FIXTURE_ROOT, 'single-model'), join(tmpRoot, 'origin'));
    const stagedDir1 = join(tmpRoot, 'staged-1');
    const stagedDir2 = join(tmpRoot, 'staged-2');
    const cacheDir = join(tmpRoot, 'cache', 'conn-1');
    await mkdir(stagedDir1, { recursive: true });
    await mkdir(stagedDir2, { recursive: true });

    const r1 = await fetchLookmlRepo({
      config: pullConfig({ repoUrl: repo.repoUrl }),
      cacheDir,
      stagedDir: stagedDir1,
    });

    // Commit a new revision in the origin — a modified view.
    await repo.writeFile('views/orders.view.lkml', 'view: orders { sql_table_name: public.orders_v2 ;; }\n');
    await repo.commit('bump');

    const r2 = await fetchLookmlRepo({
      config: pullConfig({ repoUrl: repo.repoUrl }),
      cacheDir,
      stagedDir: stagedDir2,
    });
    expect(r2.commitHash).not.toBe(r1.commitHash);
    await expect(readFile(join(stagedDir2, 'views', 'orders.view.lkml'), 'utf-8')).resolves.toMatch(/orders_v2/);
  });

  it('respects config.path — only files under that subtree land in stagedDir', async () => {
    // Build a multi-subdir repo: models/... + views/...
    const originRoot = join(tmpRoot, 'origin');
    await mkdir(originRoot, { recursive: true });
    await mkdir(join(originRoot, 'fixture-src', 'models'), { recursive: true });
    await mkdir(join(originRoot, 'fixture-src', 'views'), { recursive: true });
    await writeFile(join(originRoot, 'fixture-src', 'models', 'orders.model.lkml'), 'connection: "c"\n', 'utf-8');
    await writeFile(join(originRoot, 'fixture-src', 'views', 'orders.view.lkml'), 'view: orders {}\n', 'utf-8');
    const repo = await makeLocalGitRepo(join(originRoot, 'fixture-src'), join(originRoot, 'git'));

    const stagedDir = join(tmpRoot, 'staged');
    const cacheDir = join(tmpRoot, 'cache', 'conn-path');
    await mkdir(stagedDir, { recursive: true });

    const result = await fetchLookmlRepo({
      config: pullConfig({ repoUrl: repo.repoUrl, path: 'views' }),
      cacheDir,
      stagedDir,
    });
    expect(result.filesCopied).toBe(1);
    await expect(readFile(join(stagedDir, 'orders.view.lkml'), 'utf-8')).resolves.toMatch(/view: orders/);
    // The model under `models/` is NOT copied because we scoped to `views/`.
    await expect(readFile(join(stagedDir, 'orders.model.lkml'), 'utf-8')).rejects.toThrow();
  });

  it('falls back to fresh clone when the cache dir is corrupt', async () => {
    const repo = await makeLocalGitRepo(join(FIXTURE_ROOT, 'single-model'), join(tmpRoot, 'origin'));
    const stagedDir = join(tmpRoot, 'staged');
    const cacheDir = join(tmpRoot, 'cache', 'conn-bad');
    await mkdir(stagedDir, { recursive: true });

    // Pre-create a cacheDir that looks like a git repo but is corrupt.
    await mkdir(join(cacheDir, '.git'), { recursive: true });
    await writeFile(join(cacheDir, '.git', 'HEAD'), 'garbage\n', 'utf-8');

    const result = await fetchLookmlRepo({
      config: pullConfig({ repoUrl: repo.repoUrl }),
      cacheDir,
      stagedDir,
    });
    expect(result.filesCopied).toBeGreaterThan(0);
  });

  it('sanitizes auth tokens out of error messages when clone fails', async () => {
    const stagedDir = join(tmpRoot, 'staged');
    const cacheDir = join(tmpRoot, 'cache', 'conn-bad-url');
    await mkdir(stagedDir, { recursive: true });

    await expect(
      fetchLookmlRepo({
        config: pullConfig({
          repoUrl: 'http://definitely-not-a-real-host.test/r.git',
          authToken: 'supersecret-token',
        }),
        cacheDir,
        stagedDir,
      }),
    ).rejects.toThrow(
      // Error is thrown with sanitized message — the token is replaced by '***'.
      // The exact message depends on simple-git's failure mode; we assert the token does NOT appear.
      expect.objectContaining({ message: expect.not.stringContaining('supersecret-token') }),
    );
  });
});
