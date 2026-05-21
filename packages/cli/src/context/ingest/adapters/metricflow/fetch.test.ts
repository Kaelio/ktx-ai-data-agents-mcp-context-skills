import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeLocalGitRepo } from '../../../test/make-local-git-repo.js';
import { fetchMetricflowRepo } from './fetch.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function makeRepo(tmpRoot: string, files: Record<string, string>) {
  const fixtureDir = join(tmpRoot, 'fixture-src');
  for (const [path, content] of Object.entries(files)) {
    const dest = join(fixtureDir, path);
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, content, 'utf-8');
  }
  return makeLocalGitRepo(fixtureDir, join(tmpRoot, 'origin'));
}

describe('fetchMetricflowRepo', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'metricflow-fetch-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('clones a dbt repo and stages only YAML files', async () => {
    const repo = await makeRepo(tmpRoot, {
      'dbt_project.yml': 'name: analytics\n',
      'models/orders.yml': 'semantic_models:\n  - name: orders\n    model: ref("orders")\n',
      'models/readme.md': '# not staged\n',
      'macros/util.sql': 'select 1\n',
    });

    const result = await fetchMetricflowRepo({
      config: {
        repoUrl: repo.repoUrl,
        branch: 'main',
        path: null,
        authToken: null,
        parsedTargetTables: {},
      },
      cacheDir: join(tmpRoot, 'cache'),
      stagedDir: join(tmpRoot, 'stage'),
    });

    expect(result.filesCopied).toBe(2);
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
    await expect(readFile(join(tmpRoot, 'stage/dbt_project.yml'), 'utf-8')).resolves.toContain('analytics');
    await expect(readFile(join(tmpRoot, 'stage/models/orders.yml'), 'utf-8')).resolves.toContain('semantic_models');
    expect(await exists(join(tmpRoot, 'stage/models/readme.md'))).toBe(false);
    expect(await exists(join(tmpRoot, 'stage/macros/util.sql'))).toBe(false);
  });

  it('honors a configured repo subdirectory', async () => {
    const repo = await makeRepo(tmpRoot, {
      'warehouse/dbt_project.yml': 'name: warehouse\n',
      'warehouse/models/orders.yaml': 'semantic_models:\n  - name: orders\n    model: ref("orders")\n',
      'outside/ignored.yml': 'semantic_models:\n  - name: ignored\n    model: ref("ignored")\n',
    });

    const result = await fetchMetricflowRepo({
      config: {
        repoUrl: repo.repoUrl,
        branch: 'main',
        path: 'warehouse',
        authToken: null,
        parsedTargetTables: {},
      },
      cacheDir: join(tmpRoot, 'cache'),
      stagedDir: join(tmpRoot, 'stage'),
    });

    expect(result.filesCopied).toBe(2);
    await expect(readFile(join(tmpRoot, 'stage/models/orders.yaml'), 'utf-8')).resolves.toContain('orders');
    expect(await exists(join(tmpRoot, 'stage/outside/ignored.yml'))).toBe(false);
  });

  it('returns zero files when the configured subdirectory is absent', async () => {
    const repo = await makeRepo(tmpRoot, {
      'dbt_project.yml': 'name: analytics\n',
    });
    await mkdir(join(tmpRoot, 'stage'), { recursive: true });

    const result = await fetchMetricflowRepo({
      config: {
        repoUrl: repo.repoUrl,
        branch: 'main',
        path: 'missing',
        authToken: null,
        parsedTargetTables: {},
      },
      cacheDir: join(tmpRoot, 'cache'),
      stagedDir: join(tmpRoot, 'stage'),
    });

    expect(result.filesCopied).toBe(0);
  });
});
