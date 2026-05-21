import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeLookerScope, hashLookerScope, isPathInLookerScope } from './scope.js';

async function writeJson(stagedDir: string, relPath: string, value: unknown): Promise<void> {
  const abs = join(stagedDir, relPath);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('Looker runtime fetch scope', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'looker-scope-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('keeps omitted known-current entity files out of the deletion baseline', () => {
    const scope = {
      mode: 'incremental' as const,
      knownCurrentRawPaths: ['dashboards/10.json', 'dashboards/11.json', 'looks/20.json'],
      fetchedRawPaths: ['dashboards/11.json'],
    };

    expect(isPathInLookerScope('dashboards/10.json', scope)).toBe(false);
    expect(isPathInLookerScope('looks/20.json', scope)).toBe(false);
    expect(isPathInLookerScope('dashboards/11.json', scope)).toBe(true);
    expect(isPathInLookerScope('looks/21.json', scope)).toBe(true);
    expect(isPathInLookerScope('signals/dashboard_usage.json', scope)).toBe(true);
    expect(isPathInLookerScope('explores/b2b/sales_pipeline.json', scope)).toBe(true);
  });

  it('keeps omitted unchanged evidence documents out of incremental delete scope', () => {
    const scope = {
      mode: 'incremental' as const,
      knownCurrentRawPaths: ['dashboards/10.json', 'looks/20.json'],
      fetchedRawPaths: ['dashboards/10.json'],
    };

    expect(isPathInLookerScope('evidence/dashboards/10/page.md', scope)).toBe(true);
    expect(isPathInLookerScope('evidence/dashboards/10/metadata.json', scope)).toBe(true);
    expect(isPathInLookerScope('evidence/looks/20/page.md', scope)).toBe(false);
    expect(isPathInLookerScope('evidence/looks/20/metadata.json', scope)).toBe(false);
  });

  it('treats full scope as all raw paths in scope', () => {
    const scope = {
      mode: 'full' as const,
      knownCurrentRawPaths: ['dashboards/10.json'],
      fetchedRawPaths: ['dashboards/10.json'],
    };

    expect(isPathInLookerScope('dashboards/10.json', scope)).toBe(true);
    expect(isPathInLookerScope('dashboards/99.json', scope)).toBe(true);
    expect(isPathInLookerScope('looks/20.json', scope)).toBe(true);
  });

  it('hashes scope order-insensitively', () => {
    const a = hashLookerScope({
      mode: 'incremental',
      knownCurrentRawPaths: ['looks/20.json', 'dashboards/10.json'],
      fetchedRawPaths: ['dashboards/10.json'],
    });
    const b = hashLookerScope({
      mode: 'incremental',
      knownCurrentRawPaths: ['dashboards/10.json', 'looks/20.json'],
      fetchedRawPaths: ['dashboards/10.json'],
    });

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads staged scope and returns a SourceAdapter ScopeDescriptor', async () => {
    await writeJson(stagedDir, 'looker-scope.json', {
      mode: 'incremental',
      knownCurrentRawPaths: ['dashboards/10.json', 'looks/20.json'],
      fetchedRawPaths: ['dashboards/10.json'],
    });

    const descriptor = await describeLookerScope(stagedDir);

    expect(descriptor.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(descriptor.isPathInScope('dashboards/10.json')).toBe(true);
    expect(descriptor.isPathInScope('looks/20.json')).toBe(false);
    expect(descriptor.isPathInScope('looks/99.json')).toBe(true);
  });

  it('falls back to full scope when old fixtures do not have a scope file', async () => {
    const descriptor = await describeLookerScope(stagedDir);

    expect(descriptor.isPathInScope('dashboards/10.json')).toBe(true);
    expect(descriptor.isPathInScope('looks/20.json')).toBe(true);
  });
});
