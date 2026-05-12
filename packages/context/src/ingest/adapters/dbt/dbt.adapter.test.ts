import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SourceAdapter } from '../../types.js';
import { DbtSourceAdapter } from './dbt.adapter.js';

describe('DbtSourceAdapter', () => {
  let stagedDir: string;
  let adapter: SourceAdapter;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'dbt-adapter-'));
    adapter = new DbtSourceAdapter();
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('declares the expected source key and skill list', () => {
    expect(adapter.source).toBe('dbt');
    expect(adapter.skillNames).toEqual(['dbt_ingest']);
  });

  it('detects a staged dbt project root (dbt_project.yml)', async () => {
    await writeFile(join(stagedDir, 'dbt_project.yml'), "name: 'jaffle'\nversion: '1.0.0'\n", 'utf-8');
    expect(await adapter.detect(stagedDir)).toBe(true);
  });

  it('chunk: dbt_project.yml + models/a.yml yields one WU (≤25 files)', async () => {
    await writeFile(join(stagedDir, 'dbt_project.yml'), "name: 'jaffle'\n", 'utf-8');
    await mkdir(join(stagedDir, 'models'), { recursive: true });
    await writeFile(
      join(stagedDir, 'models/a.yml'),
      'version: 2\nmodels:\n  - name: orders\n    description: Orders\n',
      'utf-8',
    );
    const result = await adapter.chunk(stagedDir);
    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0].unitKey).toBe('dbt-all');
    expect(result.parseArtifacts).toMatchObject({
      projectName: 'jaffle',
      tables: [{ name: 'orders', description: 'Orders' }],
    });
  });

  it('implements fetch() for git-backed dbt source setup', () => {
    expect(adapter.fetch).toBeTypeOf('function');
  });

  it('reports mapped warehouse targets for bundle SL discovery', async () => {
    adapter = new DbtSourceAdapter({ targetConnectionIds: ['postgres-warehouse', 'postgres-warehouse'] });

    await expect(adapter.listTargetConnectionIds?.(stagedDir)).resolves.toEqual(['postgres-warehouse']);
  });
});
