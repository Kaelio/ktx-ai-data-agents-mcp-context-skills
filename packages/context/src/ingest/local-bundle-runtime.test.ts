import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunnerService } from '../agent/index.js';
import { initKtxProject, type KtxLocalProject, loadKtxProject } from '../project/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSourceAdapter } from './adapters/fake/fake.adapter.js';
import { createLocalBundleIngestRuntime } from './local-bundle-runtime.js';

type RuntimeWithConnectionDeps = {
  deps: {
    connections: {
      listEnabledConnections(ids: string[]): Promise<Array<{ id: string; name: string; connectionType: string }>>;
      getConnectionById(connectionId: string): Promise<{ id: string; name: string; connectionType: string } | null>;
      executeQuery(connectionId: string, sql: string): Promise<unknown>;
    };
  };
};

describe('createLocalBundleIngestRuntime', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-bundle-runtime-'));
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        'ingest:',
        '  adapters:',
        '    - fake',
        '  embeddings:',
        '    backend: deterministic',
        '',
      ].join('\n'),
      'utf-8',
    );
    project = await loadKtxProject({ projectDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('requires an agent runner or configured local ingest LLM', () => {
    expect(() =>
      createLocalBundleIngestRuntime({
        project,
        adapters: [new FakeSourceAdapter()],
      }),
    ).toThrow(
      [
        'ktx dev ingest run requires llm.provider.backend: anthropic, vertex, or gateway, or an injected agentRunner.',
        `Configure an Anthropic provider, then rerun ingest:`,
        `  ktx setup --project-dir ${project.projectDir} --anthropic-api-key-env ANTHROPIC_API_KEY --anthropic-model claude-sonnet-4-6 --no-input`,
      ].join('\n'),
    );
  });

  it('builds runner deps with local SQLite stores and context tools enabled', async () => {
    const agentRunner = new AgentRunnerService({ llmProvider: { getModel: () => ({}) as never } as any });

    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      agentRunner,
      jobIdFactory: () => 'job-1',
    });

    expect(runtime.nextJobId()).toBe('job-1');
    expect(runtime.storage.resolvePullDir('job-1')).toBe(join(project.projectDir, '.ktx/cache/local-ingest/job-1/pull'));
    expect(runtime.storage.resolveUploadDir('job-1')).toBe(
      join(project.projectDir, '.ktx/cache/local-ingest/job-1/upload'),
    );
    expect(runtime.storage.resolveTranscriptDir('job-1')).toBe(
      join(project.projectDir, '.ktx/ingest-transcripts/job-1'),
    );

    await mkdir(runtime.storage.resolveUploadDir('job-1'), { recursive: true });
  });

  it('exposes canonical warehouse connection types to local ingest SL tools', async () => {
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'postgresql://readonly@db.example.test/analytics',
    };
    project.config.connections.bq = {
      driver: 'bigquery',
      project_id: 'acme',
      dataset_id: 'warehouse',
    };
    const agentRunner = new AgentRunnerService({ llmProvider: { getModel: () => ({}) as never } as any });

    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      agentRunner,
    });
    const connections = (runtime.runner as unknown as RuntimeWithConnectionDeps).deps.connections;

    await expect(connections.getConnectionById('warehouse')).resolves.toMatchObject({
      id: 'warehouse',
      connectionType: 'POSTGRESQL',
    });
    await expect(connections.listEnabledConnections(['warehouse', 'bq'])).resolves.toEqual([
      { id: 'warehouse', name: 'warehouse', connectionType: 'POSTGRESQL' },
      { id: 'bq', name: 'bq', connectionType: 'BIGQUERY' },
    ]);
  });

  it('passes project connection config to local ingest query executors', async () => {
    const agentRunner = new AgentRunnerService({ llmProvider: { getModel: () => ({}) as never } as any });
    const queryExecutor = {
      execute: vi.fn(async () => ({
        headers: ['answer'],
        rows: [[1]],
        totalRows: 1,
        command: 'SELECT',
        rowCount: 1,
      })),
    };

    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      agentRunner,
      queryExecutor,
    });
    const connections = (runtime.runner as unknown as RuntimeWithConnectionDeps).deps.connections;

    await expect(connections.executeQuery('warehouse', 'select 1')).resolves.toMatchObject({
      headers: ['answer'],
    });
    expect(queryExecutor.execute).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      projectDir: project.projectDir,
      connection: project.config.connections.warehouse,
      sql: 'select 1',
    });
  });

  it('accepts a debug LLM request file when constructing the default agent runner', async () => {
    await writeFile(
      join(project.projectDir, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        'llm:',
        '  provider:',
        '    backend: gateway',
        '    gateway:',
        '      base_url: https://gateway.example/v1',
        '  models:',
        '    default: anthropic/claude-sonnet-4-6',
        'ingest:',
        '  adapters:',
        '    - fake',
        '  embeddings:',
        '    backend: deterministic',
        '',
      ].join('\n'),
      'utf-8',
    );
    project = await loadKtxProject({ projectDir: project.projectDir });

    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      llmDebugRequestFile: join(project.projectDir, '.ktx', 'llm-debug.jsonl'),
    });

    expect(runtime.storage.resolvePullDir('job-1')).toBe(join(project.projectDir, '.ktx/cache/local-ingest/job-1/pull'));
  });
});
