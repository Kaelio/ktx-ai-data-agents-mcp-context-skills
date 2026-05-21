import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ktxLocalStateDbPath } from '../../context/project/local-state-db.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import { LocalLookerRuntimeStore } from './adapters/looker/local-runtime-store.js';
import { seedLocalMappingStateFromKtxYaml } from './local-mapping-reconcile.js';

describe('local mapping yaml reconciliation bridge', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  function projectWithConnections(connections: KtxLocalProject['config']['connections']): KtxLocalProject {
    return {
      projectDir: tempDir,
      config: { connections },
    } as KtxLocalProject;
  }

  it('does not copy Metabase mapping intent into local SQLite state', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-metabase-yaml-seed-'));
    const project = projectWithConnections({
      'prod-metabase': {
        driver: 'metabase',
        api_url: 'https://metabase.example.com',
        mappings: {
          databaseMappings: { '1': 'prod-warehouse' },
          syncEnabled: { '1': true },
          syncMode: 'ONLY',
          selections: { collections: [12], items: [] },
          defaultTagNames: ['ktx'],
        },
      },
      'prod-warehouse': { driver: 'postgres', url: 'postgresql://readonly@db.test/analytics' },
    });

    await expect(seedLocalMappingStateFromKtxYaml(project, 'prod-metabase')).resolves.toBeUndefined();
  });

  it('seeds Looker local mappings from ktx.yaml mapping intent', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-looker-yaml-seed-'));
    const project = projectWithConnections({
      'prod-looker': {
        driver: 'looker',
        base_url: 'https://looker.example.com',
        client_id: 'client',
        mappings: { connectionMappings: { analytics: 'prod-warehouse' } },
      },
      'prod-warehouse': { driver: 'postgres', url: 'postgresql://readonly@db.test/analytics' },
    });

    await seedLocalMappingStateFromKtxYaml(project, 'prod-looker');

    const store = new LocalLookerRuntimeStore({ dbPath: ktxLocalStateDbPath(project) });
    await expect(store.listConnectionMappings('prod-looker')).resolves.toMatchObject([
      { lookerConnectionName: 'analytics', ktxConnectionId: 'prod-warehouse', source: 'ktx.yaml' },
    ]);
  });

  it('does nothing for connections without mapping bootstrap intent', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-no-yaml-seed-'));
    const project = projectWithConnections({ warehouse: { driver: 'postgres', url: 'env:DATABASE_URL' } });

    await expect(seedLocalMappingStateFromKtxYaml(project, 'warehouse')).resolves.toBeUndefined();
  });
});
