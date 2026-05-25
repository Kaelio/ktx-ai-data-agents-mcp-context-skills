import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectMetricFlowStagedDir } from '../../../../../src/context/ingest/adapters/metricflow/detect.js';

async function touch(stagedDir: string, relPath: string, body = ''): Promise<void> {
  const abs = join(stagedDir, relPath);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body, 'utf-8');
}

describe('detectMetricFlowStagedDir', () => {
  let stagedDir: string;
  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'mf-detect-'));
  });
  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('returns true when any YAML has top-level semantic_models:', async () => {
    await touch(stagedDir, 'models/a.yml', 'semantic_models:\n  - {name: a, model: x, measures: []}\n');
    expect(await detectMetricFlowStagedDir(stagedDir)).toBe(true);
  });

  it('returns true when any YAML has top-level metrics:', async () => {
    await touch(stagedDir, 'metrics/m.yaml', 'metrics:\n  - {name: m, type: simple, type_params: {measure: x}}\n');
    expect(await detectMetricFlowStagedDir(stagedDir)).toBe(true);
  });

  it('returns false for a directory with only dbt_project.yml', async () => {
    await touch(stagedDir, 'dbt_project.yml', 'name: my_proj\nversion: "1.0.0"\n');
    expect(await detectMetricFlowStagedDir(stagedDir)).toBe(false);
  });

  it('returns false for an empty directory', async () => {
    expect(await detectMetricFlowStagedDir(stagedDir)).toBe(false);
  });

  it('returns false for only broken YAML', async () => {
    await touch(stagedDir, 'broken.yml', '{ not: valid :::');
    expect(await detectMetricFlowStagedDir(stagedDir)).toBe(false);
  });

  it('ignores non-YAML files and returns false when no YAML qualifies', async () => {
    await touch(stagedDir, 'readme.md', '# readme');
    await touch(stagedDir, 'script.py', 'print("hi")');
    expect(await detectMetricFlowStagedDir(stagedDir)).toBe(false);
  });
});
