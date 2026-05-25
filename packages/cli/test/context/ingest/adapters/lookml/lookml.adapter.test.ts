import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeLocalGitRepo } from '../../../test/make-local-git-repo.js';
import { LOOKML_FETCH_REPORT_FILE } from '../../../../../src/context/ingest/adapters/lookml/fetch-report.js';
import { LookmlSourceAdapter } from '../../../../../src/context/ingest/adapters/lookml/lookml.adapter.js';

describe('LookmlSourceAdapter validation sidecars', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'lookml-adapter-'));
  });

  afterEach(async () => rm(tmpRoot, { recursive: true, force: true }));

  it('returns configured target warehouse connection ids', async () => {
    const adapter = new LookmlSourceAdapter({
      homeDir: join(tmpRoot, 'home'),
      targetConnectionIds: ['warehouse', 'analytics', 'warehouse'],
    });

    await expect(adapter.listTargetConnectionIds?.(join(tmpRoot, 'staged'))).resolves.toEqual([
      'analytics',
      'warehouse',
    ]);
  });

  it('writes a partial fetch report and marks mismatched chunks as SL-disallowed', async () => {
    const originRoot = join(tmpRoot, 'origin-src');
    await mkdir(join(originRoot, 'views'), { recursive: true });
    await writeFile(
      join(originRoot, 'b2b.model.lkml'),
      'connection: "wrong_connection"\ninclude: "views/*.view.lkml"\nexplore: orders {}\n',
      'utf-8',
    );
    await writeFile(
      join(originRoot, 'views', 'orders.view.lkml'),
      'view: orders { sql_table_name: public.orders ;; }\n',
      'utf-8',
    );
    const repo = await makeLocalGitRepo(originRoot, join(tmpRoot, 'origin'));
    const stagedDir = join(tmpRoot, 'staged');
    await mkdir(stagedDir, { recursive: true });

    const adapter = new LookmlSourceAdapter({ homeDir: join(tmpRoot, 'home') });
    await adapter.fetch(
      {
        repoUrl: repo.repoUrl,
        branch: 'main',
        path: null,
        authToken: null,
        expectedLookerConnectionName: 'expected_connection',
      },
      stagedDir,
      { connectionId: '11111111-1111-4111-8111-111111111111', sourceKey: 'lookml' },
    );

    await expect(readFile(join(stagedDir, LOOKML_FETCH_REPORT_FILE), 'utf-8')).resolves.toContain(
      'lookml_connection_mismatch',
    );
    await expect(adapter.readFetchReport(stagedDir)).resolves.toMatchObject({ status: 'partial' });

    const chunks = await adapter.chunk(stagedDir);
    expect(chunks.workUnits[0]).toMatchObject({
      unitKey: 'lookml-b2b',
      slDisallowed: true,
      slDisallowedReason: 'lookml_connection_mismatch',
    });
  });
});
