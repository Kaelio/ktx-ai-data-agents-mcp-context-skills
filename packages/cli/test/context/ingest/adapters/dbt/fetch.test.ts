import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchDbtRepo } from '../../../../../src/context/ingest/adapters/dbt/fetch.js';

describe('fetchDbtRepo', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-dbt-fetch-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('copies dbt yaml files from a fetched repo subpath into staged dir', async () => {
    const cacheDir = join(tempDir, 'cache');
    const stagedDir = join(tempDir, 'staged');
    await mkdir(join(cacheDir, 'analytics', 'models'), { recursive: true });
    await writeFile(join(cacheDir, 'analytics', 'dbt_project.yml'), 'name: analytics\n', 'utf-8');
    await writeFile(join(cacheDir, 'analytics', 'models', 'orders.yml'), 'models: []\n', 'utf-8');
    const cloneOrPull = vi.fn(async () => ({ commitHash: 'abc123' }));

    await expect(
      fetchDbtRepo({
        config: { repoUrl: 'https://github.com/acme/dbt.git', path: 'analytics' },
        cacheDir,
        stagedDir,
        deps: { cloneOrPull },
      }),
    ).resolves.toEqual({ commitHash: 'abc123', filesCopied: 2 });

    await expect(readFile(join(stagedDir, 'dbt_project.yml'), 'utf-8')).resolves.toContain('analytics');
    await expect(readFile(join(stagedDir, 'models', 'orders.yml'), 'utf-8')).resolves.toContain('models');
  });
});
