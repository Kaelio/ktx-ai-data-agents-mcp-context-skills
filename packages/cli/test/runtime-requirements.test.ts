import { buildDefaultKtxProjectConfig, type KtxProjectConfig } from '../src/context/project/config.js';
import { describe, expect, it } from 'vitest';
import {
  resolveProjectRuntimeRequirements,
  resolvePublicIngestRuntimeRequirements,
} from '../src/runtime-requirements.js';

describe('runtime requirement detection', () => {
  it('does not require runtime for agent/MCP setup alone', () => {
    const config = buildDefaultKtxProjectConfig();

    expect(resolveProjectRuntimeRequirements(config).features).toEqual([]);
  });

  it('requires core for Looker source ingest unless an external daemon is configured', () => {
    const config: KtxProjectConfig = {
      ...buildDefaultKtxProjectConfig(),
      connections: {
        looker: { driver: 'looker', base_url: 'https://looker.example.com', client_id: 'client-id' },
      },
    };

    expect(resolveProjectRuntimeRequirements(config).features).toEqual(['core']);
    expect(resolveProjectRuntimeRequirements(config, { env: { KTX_DAEMON_URL: 'http://127.0.0.1:8765' } }).features).toEqual(
      [],
    );
  });

  it('does not treat stale local Looker driver aliases as Looker sources', () => {
    const config: KtxProjectConfig = {
      ...buildDefaultKtxProjectConfig(),
      connections: {
        stale: { driver: 'local_looker' } as never,
      },
    };

    expect(resolveProjectRuntimeRequirements(config).features).toEqual([]);
    expect(
      resolvePublicIngestRuntimeRequirements({
        projectDir: '/tmp/project',
        warnings: [],
        targets: [
          {
            connectionId: 'stale',
            driver: 'local_looker',
            operation: 'source-ingest',
            adapter: 'local_looker',
            debugCommand: 'ktx ingest stale --debug',
            steps: ['source-ingest'],
          },
        ],
      }).features,
    ).toEqual([]);
  });

  it('requires core for query-history ingest unless SQL analysis is externally configured', () => {
    const config: KtxProjectConfig = {
      ...buildDefaultKtxProjectConfig(),
      connections: {
        warehouse: { driver: 'postgres', context: { queryHistory: { enabled: true } } },
      },
    };

    expect(resolveProjectRuntimeRequirements(config).features).toEqual(['core']);
    expect(
      resolveProjectRuntimeRequirements(config, { env: { KTX_SQL_ANALYSIS_URL: 'http://127.0.0.1:8765' } }).features,
    ).toEqual([]);
  });

  it('requires local-embeddings for managed sentence-transformers embeddings', () => {
    const config: KtxProjectConfig = {
      ...buildDefaultKtxProjectConfig(),
      ingest: {
        ...buildDefaultKtxProjectConfig().ingest,
        embeddings: {
          backend: 'sentence-transformers' as const,
          model: 'all-MiniLM-L6-v2',
          dimensions: 384,
          sentenceTransformers: {
            base_url: '',
          },
        },
      },
    };

    expect(resolveProjectRuntimeRequirements(config).features).toEqual(['local-embeddings']);
  });

  it('detects foreground ingest runtime needs from selected query-history targets', () => {
    const config: KtxProjectConfig = {
      ...buildDefaultKtxProjectConfig(),
      ingest: {
        ...buildDefaultKtxProjectConfig().ingest,
        embeddings: {
          backend: 'sentence-transformers' as const,
          model: 'all-MiniLM-L6-v2',
          dimensions: 384,
        },
      },
    };

    expect(
      resolvePublicIngestRuntimeRequirements(
        {
          projectDir: '/tmp/project',
          warnings: [],
          targets: [
            {
              connectionId: 'warehouse',
              driver: 'postgres',
              operation: 'database-ingest',
              debugCommand: 'ktx ingest warehouse --debug',
              steps: ['database-schema', 'query-history'],
              queryHistory: { enabled: true },
            },
          ],
        },
        { config },
      ).features,
    ).toEqual(['core', 'local-embeddings']);
  });
});
