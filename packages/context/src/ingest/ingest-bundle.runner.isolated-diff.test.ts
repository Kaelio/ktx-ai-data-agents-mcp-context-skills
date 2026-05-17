import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitService, SessionWorktreeService } from '../core/index.js';
import { LocalGitFileStore } from '../project/local-git-file-store.js';
import { addTouchedSlSource } from '../tools/index.js';
import { IngestBundleRunner } from './ingest-bundle.runner.js';
import type { IngestBundleRunnerDeps } from './ports.js';

async function makeRealGitRuntime() {
  const homeDir = await mkdtemp(join(tmpdir(), 'ktx-isolated-runner-'));
  const configDir = join(homeDir, 'config');
  const git = new GitService({
    storage: { configDir, homeDir },
    git: {
      userName: 'System User',
      userEmail: 'system@example.com',
      bootstrapMessage: 'init',
      bootstrapAuthor: 'system',
      bootstrapAuthorEmail: 'system@example.com',
    },
  });
  await git.onModuleInit();
  const configService = new LocalGitFileStore({ rootDir: configDir, git });
  const sessionWorktreeService = new SessionWorktreeService({
    coreConfig: {
      storage: { configDir, homeDir },
      git: {
        userName: 'System User',
        userEmail: 'system@example.com',
        bootstrapMessage: 'init',
        bootstrapAuthor: 'system',
        bootstrapAuthorEmail: 'system@example.com',
      },
    },
    gitService: git,
    configService,
  });
  return { homeDir, configDir, git, configService, sessionWorktreeService };
}

function rootOfConfig(configService: unknown, fallback: string): string {
  const rootDir = (configService as { rootDir?: unknown }).rootDir;
  return typeof rootDir === 'string' ? rootDir : fallback;
}

async function loadSourcesFromRoot(root: string) {
  const raw = await readFile(join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'), 'utf-8').catch(
    () => '',
  );
  const hasCents = raw.includes('total_contract_arr_cents');
  const hasDollars = raw.includes('total_contract_arr');
  return {
    sources:
      hasCents || hasDollars
        ? [
            {
              name: 'mart_account_segments',
              grain: ['account_id'],
              columns: [{ name: 'account_id', type: 'string' }],
              joins: [],
              measures: [{ name: hasCents ? 'total_contract_arr_cents' : 'total_contract_arr', expr: 'sum(contract_arr)' }],
              table: 'analytics.mart_account_segments',
            },
          ]
        : [],
    loadErrors: [],
  };
}

function makeWikiService(root: string) {
  return {
    readPage: vi.fn(async (_scope: string, _scopeId: string | null, key: string) => {
      const path = join(root, 'wiki/global', `${key}.md`);
      const raw = await readFile(path, 'utf-8').catch(() => null);
      if (!raw) {
        return null;
      }
      const [, yaml = '', content = ''] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw) ?? [];
      const slRefs =
        /sl_refs:\n((?:  - .+\n?)*)/
          .exec(yaml)?.[1]
          ?.split('\n')
          .map((line) => line.trim().replace(/^- /, ''))
          .filter(Boolean) ?? [];
      return {
        pageKey: key,
        frontmatter: { summary: key, usage_mode: 'auto', sl_refs: slRefs },
        content: content.trim(),
      };
    }),
    syncFromCommit: vi.fn(),
  };
}

function makeDeps(runtime: Awaited<ReturnType<typeof makeRealGitRuntime>>) {
  const adapter: any = {
    source: 'metabase',
    skillNames: [],
    detect: vi.fn().mockResolvedValue(true),
    chunk: vi.fn().mockResolvedValue({
      workUnits: [
        { unitKey: 'card-wiki', rawFiles: ['cards/wiki.json'], peerFileIndex: [], dependencyPaths: [] },
        { unitKey: 'card-source', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] },
      ],
    }),
  };
  const wikiService = makeWikiService(runtime.configDir);
  const semanticLayerService: any = {
    loadAllSources: vi.fn(async () => loadSourcesFromRoot(runtime.configDir)),
    listFilesForConnection: vi.fn().mockResolvedValue(['mart_account_segments.yaml']),
  };
  semanticLayerService.forWorktree = vi.fn((workdir: string) => ({
    ...semanticLayerService,
    loadAllSources: vi.fn(async () => loadSourcesFromRoot(workdir)),
    listFilesForConnection: vi.fn().mockResolvedValue(['mart_account_segments.yaml']),
  }));

  const deps: IngestBundleRunnerDeps = {
    runs: { create: vi.fn().mockResolvedValue({ id: 'run-1' }), markCompleted: vi.fn(), markFailed: vi.fn() },
    provenance: {
      insertMany: vi.fn(),
      findLatestHashesForCompletedSyncs: vi.fn().mockResolvedValue(new Map()),
      findLatestArtifactsForRawPaths: vi.fn().mockResolvedValue(new Map()),
    },
    reports: { create: vi.fn().mockResolvedValue({ id: 'report-1' }), findByJobId: vi.fn().mockResolvedValue(null), markSuperseded: vi.fn() },
    canonicalPins: { listPins: vi.fn().mockResolvedValue([]) },
    registry: { get: vi.fn().mockReturnValue(adapter), register: vi.fn(), has: vi.fn(), list: vi.fn() },
    diffSetService: {
      compute: vi.fn().mockResolvedValue({ added: ['cards/wiki.json', 'cards/source.json'], modified: [], deleted: [], unchanged: [] }),
    },
    sessionWorktreeService: runtime.sessionWorktreeService,
    agentRunner: { runLoop: vi.fn() },
    gitService: runtime.git,
    lockingService: { withLock: vi.fn(async (_key, fn) => fn()) },
    storage: {
      homeDir: join(runtime.configDir, '.ktx'),
      systemGitAuthor: { name: 'KTX Test', email: 'system@ktx.local' },
      resolveUploadDir: (id) => join(runtime.homeDir, 'upload', id),
      resolvePullDir: (id) => join(runtime.homeDir, 'pull', id),
      resolveTranscriptDir: (id) => join(runtime.configDir, '.ktx/ingest-transcripts', id),
      resolveTracePath: (id) => join(runtime.configDir, '.ktx/ingest-traces', id, 'trace.jsonl'),
    },
    settings: { memoryIngestionModel: 'test', probeRowCount: 1, isolatedDiffSourceKeys: ['metabase'], ingestTraceLevel: 'trace' },
    skillsRegistry: {
      listSkills: vi.fn().mockResolvedValue([]),
      getSkill: vi.fn().mockResolvedValue(null),
      buildSkillsPrompt: vi.fn().mockReturnValue(''),
      stripFrontmatter: vi.fn((body) => body),
    } as never,
    promptService: { loadPrompt: vi.fn().mockResolvedValue('base') } as never,
    wikiService: { ...wikiService, forWorktree: vi.fn((workdir: string) => makeWikiService(workdir)) } as never,
    knowledgeIndex: { listPagesForUser: vi.fn().mockResolvedValue([]) },
    knowledgeSlRefs: { syncFromWiki: vi.fn() },
    semanticLayerService,
    slSearchService: { indexSources: vi.fn() } as never,
    slSourcesRepository: {} as never,
    slValidator: { validateSingleSource: vi.fn().mockResolvedValue({ errors: [], warnings: [] }) },
    connections: { listEnabledConnections: vi.fn().mockResolvedValue([]), getConnectionById: vi.fn() } as never,
    toolsetFactory: { createIngestWuToolset: vi.fn(() => ({ toRuntimeTools: vi.fn(() => ({})) })) },
    commitMessages: { enqueueForExternalCommit: vi.fn() },
    embedding: { maxBatchSize: 64, computeEmbedding: vi.fn(), computeEmbeddingsBulk: vi.fn() },
  };
  return { deps, adapter };
}

async function mockStageRawFiles(runner: IngestBundleRunner, runtime: Awaited<ReturnType<typeof makeRealGitRuntime>>, hashes: [string, string][]) {
  (runner as any).resolveStagedDir = vi.fn().mockResolvedValue(join(runtime.homeDir, 'stage'));
  (runner as any).stageRawFilesStage1 = vi.fn(async ({ worktreeRoot }: any) => {
    const rawDir = join(worktreeRoot, 'raw-sources/warehouse/metabase/s');
    await mkdir(rawDir, { recursive: true });
    for (const [rawPath] of hashes) {
      await mkdir(join(rawDir, rawPath.split('/').slice(0, -1).join('/')), { recursive: true });
      await writeFile(join(rawDir, rawPath), '{}');
    }
    return { currentHashes: new Map(hashes), rawDirInWorktree: 'raw-sources/warehouse/metabase/s' };
  });
}

describe('IngestBundleRunner isolated diff path', () => {
  it('rejects the Metabase stale-measure wiki body regression before squash', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.project = vi.fn(async ({ workdir }) => {
        await mkdir(join(workdir, 'semantic-layer/warehouse'), { recursive: true });
        await writeFile(
          join(workdir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
          'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr_cents\n    expr: sum(contract_arr)\n',
        );
        return {
          warnings: [],
          errors: [],
          touchedSources: [{ connectionId: 'warehouse', sourceName: 'mart_account_segments' }],
          changedWikiPageKeys: [],
        };
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        if (params.telemetryTags.unitKey === 'card-wiki') {
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(
            join(root, 'wiki/global/account-segments.md'),
            '---\nsummary: Account segments\nusage_mode: auto\nsl_refs:\n  - mart_account_segments\n---\n\nARR is `mart_account_segments.total_contract_arr_cents`.\n',
          );
          currentSession.actions.push({ target: 'wiki', type: 'created', key: 'account-segments', detail: 'Account segments' });
          await currentSession.gitService.commitFiles(['wiki/global/account-segments.md'], 'wu wiki', 'KTX Test', 'system@ktx.local');
        }
        if (params.telemetryTags.unitKey === 'card-source') {
          await writeFile(
            join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
            'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
          );
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
          currentSession.actions.push({
            target: 'sl',
            type: 'updated',
            key: 'mart_account_segments',
            detail: 'Dollar measure',
            targetConnectionId: 'warehouse',
          });
          await currentSession.gitService.commitFiles(['semantic-layer/warehouse/mart_account_segments.yaml'], 'wu source', 'KTX Test', 'system@ktx.local');
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['cards/wiki.json', 'h1'],
        ['cards/source.json', 'h2'],
      ]);

      await expect(
        runner.run({ jobId: 'job-1', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/total_contract_arr_cents/);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-1/trace.jsonl'), 'utf-8');
      expect(trace).toContain('input_snapshot');
      expect(trace).toContain('isolated_diff_enabled');
      expect(trace).toContain('work_unit_child_created');
      expect(trace).toContain('work_unit_patch_collected');
      expect(trace).toContain('patch_apply_started');
      expect(trace).toContain('final_artifact_gates_failed');
      expect(trace).toContain('ingest_failed');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('accepts two isolated work units that edit different wiki pages', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'page-a', rawFiles: ['pages/a.json'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'page-b', rawFiles: ['pages/b.json'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const unitKey = params.telemetryTags.unitKey;
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(join(root, `wiki/global/${unitKey}.md`), `---\nsummary: ${unitKey}\nusage_mode: auto\n---\n\n${unitKey}\n`);
        currentSession.actions.push({ target: 'wiki', type: 'created', key: unitKey, detail: unitKey });
        await currentSession.gitService.commitFiles([`wiki/global/${unitKey}.md`], `wu ${unitKey}`, 'KTX Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['pages/a.json', 'h1'],
        ['pages/b.json', 'h2'],
      ]);

      const result = await runner.run({ jobId: 'job-clean', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } });
      expect(result.failedWorkUnits).toEqual([]);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-clean/trace.jsonl'), 'utf-8');
      expect(trace.match(/patch_accepted/g)).toHaveLength(2);
      expect(trace).toContain('ingest_finished');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('classifies same-source patch application failure as a textual conflict', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'orders-a', rawFiles: ['orders/a.json'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'orders-b', rawFiles: ['orders/b.json'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const suffix = params.telemetryTags.unitKey === 'orders-a' ? 'a' : 'b';
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
        await writeFile(
          join(root, 'semantic-layer/warehouse/orders.yaml'),
          `name: orders\ngrain: [id]\ncolumns: [{name: id, type: string}]\njoins: []\nmeasures:\n  - name: order_count_${suffix}\n    expr: count(*)\n`,
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'orders');
        currentSession.actions.push({ target: 'sl', type: 'updated', key: 'orders', detail: suffix, targetConnectionId: 'warehouse' });
        await currentSession.gitService.commitFiles(['semantic-layer/warehouse/orders.yaml'], `wu ${suffix}`, 'KTX Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['orders/a.json', 'h1'],
        ['orders/b.json', 'h2'],
      ]);

      await expect(
        runner.run({ jobId: 'job-text-conflict', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/isolated diff textual conflict/);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-text-conflict/trace.jsonl'), 'utf-8');
      expect(trace).toContain('patch_textual_conflict');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('makes deterministic projection visible to child worktrees before WorkUnit synthesis', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'wiki-projected', rawFiles: ['projected/wiki.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      adapter.project = vi.fn(async ({ workdir }) => {
        await mkdir(join(workdir, 'semantic-layer/warehouse'), { recursive: true });
        await writeFile(
          join(workdir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
          'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
        );
        return {
          warnings: [],
          errors: [],
          touchedSources: [{ connectionId: 'warehouse', sourceName: 'mart_account_segments' }],
          changedWikiPageKeys: [],
        };
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await expect(readFile(join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'), 'utf-8')).resolves.toContain(
          'total_contract_arr',
        );
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(
          join(root, 'wiki/global/projected-orders.md'),
          '---\nsummary: Projected orders\nusage_mode: auto\nsl_refs:\n  - mart_account_segments\n---\n\nARR `mart_account_segments.total_contract_arr`.\n',
        );
        currentSession.actions.push({ target: 'wiki', type: 'created', key: 'projected-orders', detail: 'Projected orders' });
        await currentSession.gitService.commitFiles(['wiki/global/projected-orders.md'], 'wu projected wiki', 'KTX Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['projected/wiki.json', 'h1']]);

      const result = await runner.run({ jobId: 'job-projection', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } });
      expect(result.failedWorkUnits).toEqual([]);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-projection/trace.jsonl'), 'utf-8');
      expect(trace).toContain('deterministic_projection_finished');
      expect(trace).toContain('deterministic_projection_committed');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('rejects Notion-style changed wiki pages with invalid sl_refs', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'notion-page', rawFiles: ['pages/notion.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(join(root, 'wiki/global/notion-page.md'), '---\nsummary: Notion page\nusage_mode: auto\nsl_refs:\n  - missing_source\n---\n\nBody\n');
        currentSession.actions.push({ target: 'wiki', type: 'created', key: 'notion-page', detail: 'Notion page' });
        await currentSession.gitService.commitFiles(['wiki/global/notion-page.md'], 'wu notion', 'KTX Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['pages/notion.json', 'h1']]);

      await expect(
        runner.run({ jobId: 'job-invalid-slrefs', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/unknown sl_refs entry missing_source/);
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('runs final artifact gates after reconciliation mutates the integration tree', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'card-source', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
          await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
          await writeFile(
            join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
            'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
          );
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
          currentSession.actions.push({
            target: 'sl',
            type: 'created',
            key: 'mart_account_segments',
            detail: 'Source with renamed ARR measure',
            targetConnectionId: 'warehouse',
            rawPaths: ['cards/source.json'],
          });
          await currentSession.gitService.commitFiles(
            ['semantic-layer/warehouse/mart_account_segments.yaml'],
            'wu source',
            'KTX Test',
            'system@ktx.local',
          );
        } else {
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(
            join(root, 'wiki/global/account-segments.md'),
            '---\nsummary: Account segments\nusage_mode: auto\nsl_refs:\n  - mart_account_segments\n---\n\nReconcile wrote stale ARR `mart_account_segments.total_contract_arr_cents`.\n',
          );
          currentSession.actions.push({
            target: 'wiki',
            type: 'created',
            key: 'account-segments',
            detail: 'Stale reconcile wiki page',
            rawPaths: ['cards/source.json'],
          });
          await currentSession.gitService.commitFiles(['wiki/global/account-segments.md'], 'reconcile wiki', 'KTX Test', 'system@ktx.local');
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);

      await expect(
        runner.run({
          jobId: 'job-reconcile-stale',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/total_contract_arr_cents/);

      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-reconcile-stale/trace.jsonl'), 'utf-8');
      expect(trace).toContain('reconciliation_finished');
      expect(trace).toContain('final_artifact_gates_failed');
      expect(trace).toContain('ingest_failed');
      expect(await runtime.git.revParseHead()).not.toContain('reconcile wiki');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('stores a failure report and postmortem trace for final gate failures', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      const createdReports: any[] = [];
      deps.reports.create = vi.fn(async (args: any) => {
        createdReports.push(args);
        return { id: `report-${createdReports.length}` };
      });
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'card-wiki', rawFiles: ['cards/wiki.json'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'card-source', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        if (params.telemetryTags.unitKey === 'card-wiki') {
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(
            join(root, 'wiki/global/account-segments.md'),
            '---\nsummary: Account segments\nusage_mode: auto\n---\n\nARR is `mart_account_segments.total_contract_arr_cents`.\n',
          );
          currentSession.actions.push({
            target: 'wiki',
            type: 'created',
            key: 'account-segments',
            detail: 'Account segments',
            rawPaths: ['cards/wiki.json'],
          });
          await currentSession.gitService.commitFiles(['wiki/global/account-segments.md'], 'wu wiki', 'KTX Test', 'system@ktx.local');
        }
        if (params.telemetryTags.unitKey === 'card-source') {
          await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
          await writeFile(
            join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
            'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
          );
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
          currentSession.actions.push({
            target: 'sl',
            type: 'created',
            key: 'mart_account_segments',
            detail: 'Dollar measure',
            targetConnectionId: 'warehouse',
            rawPaths: ['cards/source.json'],
          });
          await currentSession.gitService.commitFiles(
            ['semantic-layer/warehouse/mart_account_segments.yaml'],
            'wu source',
            'KTX Test',
            'system@ktx.local',
          );
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['cards/wiki.json', 'h1'],
        ['cards/source.json', 'h2'],
      ]);

      await expect(
        runner.run({
          jobId: 'job-trace-failure',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/total_contract_arr_cents/);

      const failureReport = createdReports.find((report) => report.body.status === 'failed');
      expect(failureReport.body.tracePath).toContain('job-trace-failure/trace.jsonl');
      expect(failureReport.body.failure).toMatchObject({ phase: 'final_gates' });

      const events = (await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-trace-failure/trace.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining([
          'ingest_started',
          'input_snapshot',
          'work_units_planned',
          'isolated_diff_enabled',
          'work_unit_child_created',
          'work_unit_patch_collected',
          'patch_apply_started',
          'patch_accepted',
          'reconciliation_finished',
          'final_artifact_gates_failed',
          'ingest_failed',
          'failure_report_created',
        ]),
      );
      const failed = events.find((event) => event.event === 'ingest_failed');
      expect(failed).toMatchObject({
        runId: 'run-1',
        syncId: expect.any(String),
        data: { phase: 'final_gates', tracePath: expect.stringContaining('trace.jsonl') },
        error: { message: expect.stringContaining('total_contract_arr_cents') },
      });
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid provenance raw paths before squash reaches main', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      const createdReports: any[] = [];
      deps.reports.create = vi.fn(async (args: any) => {
        createdReports.push(args);
        return { id: `report-${createdReports.length}` };
      });
      adapter.chunk.mockResolvedValue({
        workUnits: [
          {
            unitKey: 'card-valid-artifacts',
            rawFiles: ['cards/source.json'],
            peerFileIndex: [],
            dependencyPaths: [],
          },
        ],
      });

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(
          join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
          'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
        );
        await writeFile(
          join(root, 'wiki/global/account-segments.md'),
          '---\nsummary: Account segments\nusage_mode: auto\nsl_refs:\n  - mart_account_segments\n---\n\nARR is `mart_account_segments.total_contract_arr`.\n',
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
        currentSession.actions.push({
          target: 'sl',
          type: 'created',
          key: 'mart_account_segments',
          detail: 'Valid source',
          targetConnectionId: 'warehouse',
          rawPaths: ['cards/source.json'],
        });
        currentSession.actions.push({
          target: 'wiki',
          type: 'created',
          key: 'account-segments',
          detail: 'Valid wiki with invalid provenance raw path',
          rawPaths: ['cards/missing.json'],
        });
        await currentSession.gitService.commitFiles(
          ['semantic-layer/warehouse/mart_account_segments.yaml', 'wiki/global/account-segments.md'],
          'valid artifacts with invalid provenance',
          'KTX Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);
      const preRunHead = await runtime.git.revParseHead();

      await expect(
        runner.run({
          jobId: 'job-invalid-provenance',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/provenance row references raw path outside this snapshot: cards\/missing\.json/);

      expect(await runtime.git.revParseHead()).toBe(preRunHead);
      expect(deps.provenance.insertMany).not.toHaveBeenCalled();

      const failureReport = createdReports.find((report) => report.body.status === 'failed');
      expect(failureReport.body.tracePath).toContain('job-invalid-provenance/trace.jsonl');
      expect(failureReport.body.failure).toMatchObject({
        phase: 'provenance_validation',
        message: expect.stringContaining('cards/missing.json'),
      });
      expect(failureReport.body.failure.details).toMatchObject({
        invalidRawPaths: ['cards/missing.json'],
        currentRawPaths: ['cards/source.json'],
        invalidRows: expect.arrayContaining([
          expect.objectContaining({
            row: expect.objectContaining({
              rawPath: 'cards/missing.json',
              artifactKind: 'wiki',
              artifactKey: 'account-segments',
              actionType: 'wiki_written',
            }),
            origin: expect.objectContaining({
              source: 'work_unit_action',
              unitKey: 'card-valid-artifacts',
              actionIndex: 1,
              unitRawFiles: ['cards/source.json'],
              action: expect.objectContaining({
                target: 'wiki',
                type: 'created',
                key: 'account-segments',
                rawPaths: ['cards/missing.json'],
              }),
            }),
          }),
        ]),
      });
      expect(failureReport.body.provenanceRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rawPath: 'cards/source.json', artifactKind: 'sl', artifactKey: 'mart_account_segments' }),
          expect.objectContaining({ rawPath: 'cards/missing.json', artifactKind: 'wiki', artifactKey: 'account-segments' }),
        ]),
      );
      expect(failureReport.body.workUnits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            unitKey: 'card-valid-artifacts',
            rawFiles: ['cards/source.json'],
            actions: expect.arrayContaining([
              expect.objectContaining({
                target: 'wiki',
                key: 'account-segments',
                rawPaths: ['cards/missing.json'],
              }),
            ]),
          }),
        ]),
      );

      const events = (await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-invalid-provenance/trace.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining([
          'final_artifact_gates_finished',
          'provenance_rows_validation_failed',
          'ingest_failed',
          'failure_report_created',
        ]),
      );
      expect(events.map((event) => event.event)).not.toContain('squash_finished');
      const validationFailure = events.find((event) => event.event === 'provenance_rows_validation_failed');
      expect(validationFailure).toMatchObject({
        phase: 'provenance',
        data: {
          invalidRawPaths: ['cards/missing.json'],
          currentRawPaths: ['cards/source.json'],
          invalidRows: expect.arrayContaining([
            expect.objectContaining({
              row: expect.objectContaining({ rawPath: 'cards/missing.json' }),
              origin: expect.objectContaining({
                source: 'work_unit_action',
                unitKey: 'card-valid-artifacts',
                actionIndex: 1,
              }),
            }),
          ]),
        },
      });
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('rejects slDisallowed patches that touch semantic-layer files', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [
          {
            unitKey: 'lookml-mismatch',
            rawFiles: ['views/orders.lkml'],
            peerFileIndex: [],
            dependencyPaths: [],
            slDisallowed: true,
            slDisallowedReason: 'lookml_connection_mismatch',
          },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
        await writeFile(
          join(root, 'semantic-layer/warehouse/orders.yaml'),
          'name: orders\ngrain: [id]\ncolumns: [{name: id, type: string}]\njoins: []\nmeasures: []\n',
        );
        currentSession.actions.push({ target: 'sl', type: 'created', key: 'orders', detail: 'forbidden', targetConnectionId: 'warehouse' });
        await currentSession.gitService.commitFiles(['semantic-layer/warehouse/orders.yaml'], 'forbidden sl', 'KTX Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['views/orders.lkml', 'h1']]);

      await expect(
        runner.run({ jobId: 'job-sl-disallowed', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/isolated diff textual conflict/);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-sl-disallowed/trace.jsonl'), 'utf-8');
      expect(trace).toContain('patch_policy_rejected');
      expect(trace).toContain('slDisallowed WorkUnit lookml-mismatch touched semantic-layer/warehouse/orders.yaml');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
});
