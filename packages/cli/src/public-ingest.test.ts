import { buildDefaultKtxProjectConfig, type KtxProjectConfig } from '@ktx/context/project';
import { describe, expect, it, vi } from 'vitest';
import { buildPublicIngestPlan, type KtxPublicIngestProject, runKtxPublicIngest } from './public-ingest.js';

function makeIo(options: { isTTY?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: options.isTTY,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function projectWithConnections(connections: KtxProjectConfig['connections']): KtxPublicIngestProject {
  return {
    projectDir: '/tmp/project',
    config: {
      ...buildDefaultKtxProjectConfig('warehouse'),
      connections,
    },
  };
}

describe('buildPublicIngestPlan', () => {
  it('plans warehouse connections as scan targets and source connections as source ingest targets', () => {
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
      prod_metabase: { driver: 'metabase' },
      docs: { driver: 'notion' },
    });

    expect(buildPublicIngestPlan(project, { projectDir: '/tmp/project', all: true })).toEqual({
      projectDir: '/tmp/project',
      targets: [
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          operation: 'scan',
          debugCommand: 'ktx scan warehouse --debug',
          steps: ['scan'],
        },
        {
          connectionId: 'docs',
          driver: 'notion',
          operation: 'source-ingest',
          adapter: 'notion',
          debugCommand: 'ktx dev ingest run --connection-id docs --adapter notion --debug',
          steps: ['source-ingest', 'memory-update'],
        },
        {
          connectionId: 'prod_metabase',
          driver: 'metabase',
          operation: 'source-ingest',
          adapter: 'metabase',
          debugCommand: 'ktx dev ingest run --connection-id prod_metabase --adapter metabase --debug',
          steps: ['source-ingest', 'memory-update'],
        },
      ],
    });
  });

  it('rejects bare non-interactive ingest until the interactive confirmation slice exists', () => {
    const project = projectWithConnections({ warehouse: { driver: 'postgres' } });

    expect(() => buildPublicIngestPlan(project, { projectDir: '/tmp/project', all: false })).toThrow(
      'ktx ingest requires <connectionId> or --all in this release',
    );
  });

});

describe('runKtxPublicIngest', () => {
  it('runs all independent targets and reports partial failures', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
      prod_metabase: { driver: 'metabase' },
    });
    const runScan = vi.fn(async () => 1);
    const runIngest = vi.fn(async () => 0);

    await expect(
      runKtxPublicIngest(
        { command: 'run', projectDir: '/tmp/project', all: true, json: false, inputMode: 'disabled' },
        io.io,
        {
          loadProject: vi.fn(async () => project),
          runScan,
          runIngest,
        },
      ),
    ).resolves.toBe(1);

    expect(runIngest).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: '/tmp/project',
        connectionId: 'prod_metabase',
        adapter: 'metabase',
        outputMode: 'plain',
        inputMode: 'disabled',
      },
      expect.anything(),
    );
    expect(runScan).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: '/tmp/project',
        connectionId: 'warehouse',
        mode: 'structural',
        detectRelationships: false,
        dryRun: false,
      },
      expect.anything(),
    );
    expect(io.stdout()).toContain('Ingest finished with partial failures');
    expect(io.stdout()).toContain('warehouse failed at scan.');
    expect(io.stdout()).toContain('Debug: ktx scan warehouse --debug');
  });

  it('can request enriched relationship scans for setup-managed context builds', async () => {
    const io = makeIo();
    const project = projectWithConnections({ warehouse: { driver: 'postgres' } });
    const runScan = vi.fn(async () => 0);

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          all: true,
          json: false,
          inputMode: 'disabled',
          scanMode: 'enriched',
          detectRelationships: true,
        },
        io.io,
        {
          loadProject: vi.fn(async () => project),
          runScan,
        },
      ),
    ).resolves.toBe(0);

    expect(runScan).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: '/tmp/project',
        connectionId: 'warehouse',
        mode: 'enriched',
        detectRelationships: true,
        dryRun: false,
      },
      io.io,
    );
  });

  it('prints stable JSON results', async () => {
    const io = makeIo();
    const project = projectWithConnections({ warehouse: { driver: 'postgres' } });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: true,
          inputMode: 'disabled',
        },
        io.io,
        {
          loadProject: vi.fn(async () => project),
          runScan: vi.fn(async () => 0),
        },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({
      plan: { projectDir: '/tmp/project' },
      results: [{ connectionId: 'warehouse', driver: 'postgres' }],
    });
  });

  it('passes dbt source_dir from connection config to runKtxIngest', async () => {
    const runIngest = vi.fn(async () => 0);
    const io = makeIo();

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/ktx',
          targetConnectionId: 'analytics_dbt',
          all: false,
          json: false,
          inputMode: 'disabled',
        },
        io.io,
        {
          loadProject: async () =>
            ({
              projectDir: '/tmp/ktx',
              config: {
                connections: {
                  analytics_dbt: {
                    driver: 'dbt',
                    source_dir: '/repo/dbt',
                  },
                },
              },
            }) as never,
          runIngest,
        },
      ),
    ).resolves.toBe(0);

    expect(runIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        connectionId: 'analytics_dbt',
        adapter: 'dbt',
        sourceDir: '/repo/dbt',
      }),
      io.io,
    );
  });

  it('routes public status and watch to the ingest status renderer', async () => {
    const runIngest = vi.fn(async () => 0);
    const statusIo = makeIo();
    const watchIo = makeIo();

    await expect(
      runKtxPublicIngest(
        { command: 'status', projectDir: '/tmp/ktx', json: false, inputMode: 'disabled' },
        statusIo.io,
        { runIngest },
      ),
    ).resolves.toBe(0);
    await expect(
      runKtxPublicIngest(
        { command: 'watch', projectDir: '/tmp/ktx', runId: 'run-1', json: false, inputMode: 'auto' },
        watchIo.io,
        { runIngest },
      ),
    ).resolves.toBe(0);

    expect(runIngest).toHaveBeenNthCalledWith(
      1,
      {
        command: 'status',
        projectDir: '/tmp/ktx',
        outputMode: 'plain',
        inputMode: 'disabled',
      },
      statusIo.io,
    );
    expect(runIngest).toHaveBeenNthCalledWith(
      2,
      {
        command: 'watch',
        projectDir: '/tmp/ktx',
        runId: 'run-1',
        outputMode: 'viz',
        inputMode: 'auto',
      },
      watchIo.io,
    );
  });
});
