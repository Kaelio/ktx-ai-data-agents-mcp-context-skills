# Isolated Diff Ingestion V1 Connector Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Notion, LookML, Looker, dbt, and MetricFlow direct durable-write
ingest through the isolated-diff runner path.

**Architecture:** Keep isolated-diff routing private and runner-owned by
centralizing the default source-key list outside adapters and public
configuration. The shared runner continues to own per-work-unit child
worktrees, patch integration, gates, repair, traces, and reports. MetricFlow
also gets its deterministic semantic-model import moved into the adapter
projector hook so those authoritative writes land in the integration worktree
before child worktrees are created.

**Tech Stack:** TypeScript ESM/NodeNext, Vitest, simple-git, existing
`IngestBundleRunner`, `SessionWorktreeService`, `MetricflowSourceAdapter`,
`importMetricflowSemanticModels()`, and local ingest runtime wiring.

---

## Audit summary

This audit read
`docs/superpowers/specs/2026-05-17-isolated-diff-ingestion-design.md`, all
implemented isolated-diff plans from May 17 and May 18, and the current runner
and adapter code under `packages/context/src/ingest/`.

Implemented v1 safety plans:

- `2026-05-17-isolated-diff-ingestion-v1-core.md`: core isolated worktrees,
  patch proposals, integration, trace storage, body-reference parsing, and the
  Metabase stale-measure regression exist in code.
- `2026-05-17-isolated-diff-ingestion-v1-gates-and-trace-closure.md`: final
  gates run after reconciliation and later mutating stages, child worktrees are
  cleaned up, failed reports are stored, and traces cover postmortem phases.
- `2026-05-17-isolated-diff-ingestion-v1-provenance-gate-closure.md`:
  provenance validation runs before squash.
- `2026-05-17-isolated-diff-ingestion-v1-reference-and-target-gate-closure.md`:
  final wiki reference gates, semantic-layer target policy, and patch target
  checks exist.
- `2026-05-17-isolated-diff-ingestion-v1-global-wiki-reference-gate-closure.md`:
  global wiki reference scope expands when semantic-layer sources change or
  wiki pages are removed.
- `2026-05-18-isolated-diff-ingestion-v1-textual-conflict-resolver.md`:
  bounded textual conflict repair exists and is wired into patch integration.
- `2026-05-18-isolated-diff-ingestion-v1-gate-repair.md`: bounded repair for
  cleanly applied patch and final artifact gate failures exists.

Current v1-blocking gaps:

- `packages/context/src/ingest/local-bundle-runtime.ts` still sets
  `isolatedDiffSourceKeys: ['metabase']`, so Notion, LookML, Looker, dbt, and
  MetricFlow still use the old shared-worktree WorkUnit path by default.
- `packages/context/src/ingest/ingest-bundle.runner.ts` still contains the
  shared-worktree fallback branch. That branch must remain until connector
  migration and default promotion finish, but the other direct durable-write
  connectors must stop taking it.
- There is no regression matrix proving the five non-Metabase connector source
  keys route through child worktrees and produce `isolatedDiff` report data.
- MetricFlow has `importMetricflowSemanticModels()` but
  `MetricflowSourceAdapter` does not expose it as `project()`. The spec says
  MetricFlow's deterministic semantic-model import becomes an ingestion
  projector, not a post-WorkUnit shared-worktree write.

Later v1-blocking gaps after this plan:

- Promote isolated diffs to the default once the Metabase regression and at
  least one non-Metabase connector pass are green.
- Remove the old shared-worktree WorkUnit execution path after the default path
  is promoted.

Non-blocking gaps:

- Deterministic semantic merge helpers from rollout step 9.
- Transitive SQL-projection dependency expansion beyond direct declared joins.
- Moving provenance rows into worktree files.
- Public connector knobs such as `executionMode`, `planningStrategy`, or
  `conflictPolicy`.
- Resolver context expansion to include richer transcript excerpts and every
  previously applied overlapping patch.

## File structure

- Create `packages/context/src/ingest/isolated-diff/source-routing.ts`.
  Owns the private runner default source-key list for direct durable-write
  connectors.
- Create `packages/context/src/ingest/isolated-diff/source-routing.test.ts`.
  Locks the internal list to Metabase plus the five migrated connectors.
- Modify `packages/context/src/ingest/local-bundle-runtime.ts`.
  Uses the centralized isolated-diff source-key list instead of the Metabase-only
  inline array.
- Modify `packages/context/src/ingest/local-bundle-runtime.test.ts`.
  Verifies local ingest runtime deps enable isolated routing for the migrated
  connector list.
- Modify `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`.
  Adds a non-Metabase source-key routing matrix that proves direct writes run in
  isolated child worktrees and report `isolatedDiff` metadata.
- Modify `packages/context/src/ingest/types.ts`.
  Adds the semantic-layer service to `DeterministicProjectionContext` so
  adapter projectors can write to the integration worktree.
- Modify `packages/context/src/ingest/ingest-bundle.runner.ts`.
  Passes the semantic-layer service into adapter projectors.
- Create `packages/context/src/ingest/adapters/metricflow/projection-config.ts`.
  Persists and reads MetricFlow projection metadata from the staged snapshot and
  converts parsed target-table mappings into importer host-table inputs.
- Modify `packages/context/src/ingest/adapters/metricflow/metricflow.adapter.ts`.
  Writes projection metadata during fetch and implements `project()` via
  `importMetricflowSemanticModels()`.
- Modify `packages/context/src/ingest/adapters/metricflow/metricflow.adapter.test.ts`.
  Covers projection metadata persistence and the adapter projector.
- Modify `packages/context/src/ingest/local-bundle-ingest.test.ts`.
  Verifies local MetricFlow ingest takes the isolated path and records a
  projection commit.

---

### Task 1: Centralize runner-owned connector routing

**Files:**
- Create: `packages/context/src/ingest/isolated-diff/source-routing.ts`
- Create: `packages/context/src/ingest/isolated-diff/source-routing.test.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.test.ts`

- [ ] **Step 1: Write the failing routing tests**

Create `packages/context/src/ingest/isolated-diff/source-routing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  defaultIsolatedDiffSourceKeys,
  isIsolatedDiffDirectWriteSourceKey,
  ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEYS,
} from './source-routing.js';

describe('isolated-diff source routing', () => {
  it('keeps the runner-owned direct-write connector list explicit', () => {
    expect(ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEYS).toEqual([
      'metabase',
      'notion',
      'lookml',
      'looker',
      'dbt',
      'metricflow',
    ]);
  });

  it('returns a mutable copy for runtime settings', () => {
    const keys = defaultIsolatedDiffSourceKeys();
    keys.push('fake');

    expect(defaultIsolatedDiffSourceKeys()).toEqual([
      'metabase',
      'notion',
      'lookml',
      'looker',
      'dbt',
      'metricflow',
    ]);
  });

  it('recognizes migrated connector source keys only', () => {
    expect(isIsolatedDiffDirectWriteSourceKey('notion')).toBe(true);
    expect(isIsolatedDiffDirectWriteSourceKey('metricflow')).toBe(true);
    expect(isIsolatedDiffDirectWriteSourceKey('historic-sql')).toBe(false);
    expect(isIsolatedDiffDirectWriteSourceKey('live-database')).toBe(false);
  });
});
```

In `packages/context/src/ingest/local-bundle-runtime.test.ts`, add this helper
type near the existing runtime helper types:

```ts
type RuntimeWithSettingsDeps = {
  deps: {
    settings: {
      isolatedDiffSourceKeys?: string[];
    };
  };
};
```

Then append this test inside `describe('createLocalBundleIngestRuntime', ...)`:

```ts
  it('enables isolated-diff routing for direct durable-write connectors', () => {
    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      agentRunner: testAgentRunner(),
    });

    const settings = (runtime.runner as unknown as RuntimeWithSettingsDeps).deps.settings;

    expect(settings.isolatedDiffSourceKeys).toEqual([
      'metabase',
      'notion',
      'lookml',
      'looker',
      'dbt',
      'metricflow',
    ]);
  });
```

- [ ] **Step 2: Run the failing routing tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/source-routing.test.ts src/ingest/local-bundle-runtime.test.ts -t "isolated-diff source routing|direct durable-write connectors"
```

Expected: FAIL because `source-routing.ts` does not exist and local runtime
still uses only `['metabase']`.

- [ ] **Step 3: Add centralized routing code**

Create `packages/context/src/ingest/isolated-diff/source-routing.ts`:

```ts
export const ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEYS = [
  'metabase',
  'notion',
  'lookml',
  'looker',
  'dbt',
  'metricflow',
] as const;

export type IsolatedDiffDirectWriteSourceKey = (typeof ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEYS)[number];

const ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEY_SET = new Set<string>(ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEYS);

export function defaultIsolatedDiffSourceKeys(): string[] {
  return [...ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEYS];
}

export function isIsolatedDiffDirectWriteSourceKey(
  sourceKey: string,
): sourceKey is IsolatedDiffDirectWriteSourceKey {
  return ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEY_SET.has(sourceKey);
}
```

In `packages/context/src/ingest/local-bundle-runtime.ts`, add this import:

```ts
import { defaultIsolatedDiffSourceKeys } from './isolated-diff/source-routing.js';
```

Then replace the settings value:

```ts
      isolatedDiffSourceKeys: ['metabase'],
```

with:

```ts
      isolatedDiffSourceKeys: defaultIsolatedDiffSourceKeys(),
```

- [ ] **Step 4: Run the routing tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/source-routing.test.ts src/ingest/local-bundle-runtime.test.ts -t "isolated-diff source routing|direct durable-write connectors"
```

Expected: PASS.

- [ ] **Step 5: Commit routing changes**

Run:

```bash
git add packages/context/src/ingest/isolated-diff/source-routing.ts \
  packages/context/src/ingest/isolated-diff/source-routing.test.ts \
  packages/context/src/ingest/local-bundle-runtime.ts \
  packages/context/src/ingest/local-bundle-runtime.test.ts
git commit -m "feat(ingest): route direct-write connectors through isolated diffs"
```

Expected: commit is created with only the routing files.

---

### Task 2: Add non-Metabase isolated routing regressions

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`

- [ ] **Step 1: Write the failing non-Metabase routing matrix**

In `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`,
add this import:

```ts
import { defaultIsolatedDiffSourceKeys } from './isolated-diff/source-routing.js';
```

Change `makeDeps()` to accept a source key:

```ts
function makeDeps(runtime: Awaited<ReturnType<typeof makeRealGitRuntime>>, sourceKey = 'metabase') {
  const adapter: any = {
    source: sourceKey,
    skillNames: [],
    detect: vi.fn().mockResolvedValue(true),
    chunk: vi.fn().mockResolvedValue({
      workUnits: [
        { unitKey: 'card-wiki', rawFiles: ['cards/wiki.json'], peerFileIndex: [], dependencyPaths: [] },
        { unitKey: 'card-source', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] },
      ],
    }),
  };
```

In the same helper, replace the settings block with:

```ts
    settings: {
      memoryIngestionModel: 'test',
      probeRowCount: 1,
      isolatedDiffSourceKeys: defaultIsolatedDiffSourceKeys(),
      ingestTraceLevel: 'trace',
    },
```

Change `mockStageRawFiles()` to accept the source key:

```ts
async function mockStageRawFiles(
  runner: IngestBundleRunner,
  runtime: Awaited<ReturnType<typeof makeRealGitRuntime>>,
  hashes: [string, string][],
  sourceKey = 'metabase',
) {
  (runner as any).resolveStagedDir = vi.fn().mockResolvedValue(join(runtime.homeDir, 'stage'));
  (runner as any).stageRawFilesStage1 = vi.fn(async ({ worktreeRoot }: any) => {
    const rawDir = join(worktreeRoot, 'raw-sources/warehouse', sourceKey, 's');
    await mkdir(rawDir, { recursive: true });
    for (const [rawPath] of hashes) {
      await mkdir(join(rawDir, rawPath.split('/').slice(0, -1).join('/')), { recursive: true });
      await writeFile(join(rawDir, rawPath), '{}');
    }
    return { currentHashes: new Map(hashes), rawDirInWorktree: `raw-sources/warehouse/${sourceKey}/s` };
  });
}
```

Append this test inside `describe('IngestBundleRunner isolated diff path', ...)`:

```ts
  it.each(['notion', 'lookml', 'looker', 'dbt', 'metricflow'] as const)(
    'routes %s direct writes through isolated child worktrees',
    async (sourceKey) => {
      const runtime = await makeRealGitRuntime();
      try {
        const { deps, adapter } = makeDeps(runtime, sourceKey);
        adapter.chunk.mockResolvedValue({
          workUnits: [
            {
              unitKey: `${sourceKey}-wiki`,
              rawFiles: [`${sourceKey}/page.json`],
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
        deps.agentRunner.runLoop = vi.fn(async (params: any) => {
          const root = rootOfConfig(currentSession.configService, runtime.configDir);
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(
            join(root, 'wiki/global', `${sourceKey}-isolated.md`),
            `---\nsummary: ${sourceKey} isolated write\nusage_mode: auto\n---\n\nIsolated ${sourceKey} write.\n`,
            'utf-8',
          );
          currentSession.actions.push({
            target: 'wiki',
            type: 'created',
            key: `${sourceKey}-isolated`,
            detail: `${sourceKey} isolated write`,
            rawPaths: [`${sourceKey}/page.json`],
          });
          await currentSession.gitService.commitFiles(
            [`wiki/global/${sourceKey}-isolated.md`],
            `${sourceKey} wiki`,
            'KTX Test',
            'system@ktx.local',
          );

          expect(params.telemetryTags).toMatchObject({
            operationName: 'ingest-bundle-wu',
            source: sourceKey,
            unitKey: `${sourceKey}-wiki`,
          });
          return { stopReason: 'natural' };
        }) as never;

        const runner = new IngestBundleRunner(deps);
        await mockStageRawFiles(runner, runtime, [[`${sourceKey}/page.json`, 'h1']], sourceKey);

        await expect(
          runner.run({
            jobId: `job-${sourceKey}`,
            connectionId: 'warehouse',
            sourceKey,
            trigger: 'upload',
            bundleRef: { kind: 'upload', uploadId: 'upload' },
          }),
        ).resolves.toMatchObject({
          jobId: `job-${sourceKey}`,
          failedWorkUnits: [],
          workUnitCount: 1,
        });

        const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces', `job-${sourceKey}`, 'trace.jsonl'), 'utf-8');
        expect(trace).toContain('isolated_diff_enabled');
        expect(trace).toContain('work_unit_child_created');
        expect(trace).toContain('work_unit_patch_collected');
        expect(trace).toContain('patch_apply_started');
        expect(trace).not.toContain('shared_worktree_path_enabled');

        const reportCreate = vi.mocked(deps.reports.create).mock.calls.at(-1)?.[0];
        expect(reportCreate?.body.isolatedDiff).toMatchObject({
          enabled: true,
          acceptedPatches: 1,
        });
      } finally {
        await rm(runtime.homeDir, { recursive: true, force: true });
      }
    },
  );
```

- [ ] **Step 2: Run the non-Metabase routing matrix**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts -t "routes .* direct writes"
```

Expected: PASS after Task 1. If it fails, the failure must point to one of
these concrete problems: settings do not include the source key, the shared path
still runs, or the final report lacks `isolatedDiff`.

- [ ] **Step 3: Commit runner regression coverage**

Run:

```bash
git add packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts
git commit -m "test(ingest): cover non-metabase isolated diff routing"
```

Expected: commit contains only the isolated runner regression file.

---

### Task 3: Move MetricFlow deterministic import into projection

**Files:**
- Modify: `packages/context/src/ingest/types.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Create: `packages/context/src/ingest/adapters/metricflow/projection-config.ts`
- Modify: `packages/context/src/ingest/adapters/metricflow/metricflow.adapter.ts`
- Modify: `packages/context/src/ingest/adapters/metricflow/metricflow.adapter.test.ts`

- [ ] **Step 1: Write failing MetricFlow projector tests**

In `packages/context/src/ingest/adapters/metricflow/metricflow.adapter.test.ts`,
add these imports:

```ts
import type { MetricFlowParseResult } from './deep-parse.js';
import { readMetricflowProjectionConfig, writeMetricflowProjectionConfig } from './projection-config.js';
```

Add this helper near the top of the file:

```ts
function metricflowParseResult(): MetricFlowParseResult {
  return {
    semanticModels: [
      {
        name: 'orders',
        description: 'Orders',
        modelRef: 'orders',
        dimensions: [{ name: 'status', column: 'status', type: 'string', label: 'Status' }],
        measures: [{ type: 'simple', name: 'order_count', column: 'id', aggregation: 'count' }],
        entities: [{ name: 'customer', type: 'foreign', expr: 'customer_id' }],
        defaultTimeDimension: null,
      },
    ],
    crossModelMetrics: [],
    relationships: [],
    warnings: ['parser warning'],
  };
}
```

Append these tests inside `describe('MetricflowSourceAdapter', ...)`:

```ts
  it('persists parsed target tables for deterministic projection during fetch', async () => {
    const repo = await makeRepo(tmpRoot, {
      'dbt_project.yml': 'name: analytics\n',
      'models/orders.yml': 'semantic_models:\n  - name: orders\n    model: ref("orders")\n',
    });

    await adapter.fetch?.(
      {
        repoUrl: repo.repoUrl,
        branch: 'main',
        path: null,
        authToken: null,
        parsedTargetTables: {
          orders: {
            ok: true,
            catalog: null,
            schema: 'analytics',
            name: 'orders',
            canonicalTable: 'analytics.orders',
          },
        },
      },
      stagedDir,
      { connectionId: 'warehouse-1', sourceKey: 'metricflow' },
    );

    await expect(readMetricflowProjectionConfig(stagedDir)).resolves.toMatchObject({
      parsedTargetTables: {
        orders: {
          ok: true,
          schema: 'analytics',
          name: 'orders',
        },
      },
    });
  });

  it('projects parsed MetricFlow semantic models in the integration worktree', async () => {
    await writeMetricflowProjectionConfig(stagedDir, {
      parsedTargetTables: {
        orders: {
          ok: true,
          catalog: null,
          schema: 'analytics',
          name: 'orders',
          canonicalTable: 'analytics.orders',
        },
      },
    });
    const scoped = {
      getManifestEntry: vi.fn().mockResolvedValue(null),
      isManifestBacked: vi.fn().mockResolvedValue(false),
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
      loadSource: vi.fn().mockResolvedValue(null),
      writeSource: vi.fn().mockResolvedValue({ warnings: [] }),
    };
    const semanticLayerService = {
      forWorktree: vi.fn().mockReturnValue(scoped),
      getManifestEntry: vi.fn(),
      isManifestBacked: vi.fn(),
      loadAllSources: vi.fn(),
      loadSource: vi.fn(),
      writeSource: vi.fn(),
    };

    const result = await adapter.project?.({
      connectionId: 'warehouse-1',
      sourceKey: 'metricflow',
      syncId: 'sync-1',
      jobId: 'job-1',
      runId: 'run-1',
      stagedDir,
      workdir: '/tmp/metricflow-integration',
      parseArtifacts: metricflowParseResult(),
      semanticLayerService: semanticLayerService as never,
    });

    expect(semanticLayerService.forWorktree).toHaveBeenCalledWith('/tmp/metricflow-integration');
    expect(scoped.writeSource).toHaveBeenCalledWith(
      'warehouse-1',
      expect.objectContaining({ name: 'orders' }),
      'dbt MetricFlow',
      expect.any(String),
      'dbt MetricFlow sync: create source orders',
      { skipValidation: true },
    );
    expect(result).toMatchObject({
      warnings: ['parser warning'],
      errors: [],
      touchedSources: [{ connectionId: 'warehouse-1', sourceName: 'orders' }],
      changedWikiPageKeys: [],
    });
  });

  it('returns a projection error when parse artifacts are missing', async () => {
    const result = await adapter.project?.({
      connectionId: 'warehouse-1',
      sourceKey: 'metricflow',
      syncId: 'sync-1',
      jobId: 'job-1',
      runId: 'run-1',
      stagedDir,
      workdir: '/tmp/metricflow-integration',
      parseArtifacts: undefined,
      semanticLayerService: {} as never,
    });

    expect(result).toMatchObject({
      warnings: [],
      errors: ['MetricFlow deterministic projection requires parseArtifacts from chunk()'],
      touchedSources: [],
      changedWikiPageKeys: [],
    });
  });
```

- [ ] **Step 2: Run the failing MetricFlow projector tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/metricflow/metricflow.adapter.test.ts -t "deterministic projection|projects parsed|parse artifacts"
```

Expected: FAIL because `projection-config.ts` and `adapter.project()` do not
exist.

- [ ] **Step 3: Add projector service context**

In `packages/context/src/ingest/types.ts`, add this import:

```ts
import type { SemanticLayerService } from '../sl/index.js';
```

Then extend `DeterministicProjectionContext`:

```ts
export interface DeterministicProjectionContext {
  connectionId: string;
  sourceKey: string;
  syncId: string;
  jobId: string;
  runId: string;
  stagedDir: string;
  workdir: string;
  parseArtifacts?: unknown;
  semanticLayerService: SemanticLayerService;
}
```

In `packages/context/src/ingest/ingest-bundle.runner.ts`, add this property to
the `adapter.project!({ ... })` call:

```ts
                semanticLayerService: this.deps.semanticLayerService,
```

- [ ] **Step 4: Add MetricFlow projection config helpers**

Create `packages/context/src/ingest/adapters/metricflow/projection-config.ts`:

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parsedTargetTableSchema, type ParsedTargetTable } from '../../parsed-target-table.js';
import type { MetricflowHostTable } from './semantic-models.js';

export const METRICFLOW_PROJECTION_CONFIG_FILE = 'sync-config.json';

export const metricflowProjectionConfigSchema = z.object({
  parsedTargetTables: z.record(z.string(), parsedTargetTableSchema).default({}),
});

export type MetricflowProjectionConfig = z.infer<typeof metricflowProjectionConfigSchema>;

export async function writeMetricflowProjectionConfig(
  stagedDir: string,
  config: MetricflowProjectionConfig,
): Promise<void> {
  const parsed = metricflowProjectionConfigSchema.parse(config);
  await writeFile(join(stagedDir, METRICFLOW_PROJECTION_CONFIG_FILE), `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
}

export async function readMetricflowProjectionConfig(stagedDir: string): Promise<MetricflowProjectionConfig> {
  const path = join(stagedDir, METRICFLOW_PROJECTION_CONFIG_FILE);
  try {
    return metricflowProjectionConfigSchema.parse(JSON.parse(await readFile(path, 'utf-8')));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { parsedTargetTables: {} };
    }
    throw error;
  }
}

export function metricflowHostTablesFromParsedTargets(
  parsedTargetTables: Record<string, ParsedTargetTable>,
): MetricflowHostTable[] {
  return Object.entries(parsedTargetTables)
    .flatMap(([id, table]) =>
      table.ok
        ? [
            {
              id,
              name: table.name,
              catalog: table.catalog,
              db: table.schema,
              columns: [],
            },
          ]
        : [],
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}
```

- [ ] **Step 5: Implement MetricFlow adapter projection**

In `packages/context/src/ingest/adapters/metricflow/metricflow.adapter.ts`,
replace the type import with:

```ts
import type {
  ChunkResult,
  DeterministicProjectionContext,
  DiffSet,
  FetchContext,
  ProjectionResult,
  SourceAdapter,
} from '../../types.js';
```

Add these imports:

```ts
import { importMetricflowSemanticModels } from './import-semantic-models.js';
import {
  metricflowHostTablesFromParsedTargets,
  readMetricflowProjectionConfig,
  writeMetricflowProjectionConfig,
} from './projection-config.js';
```

After `await fetchMetricflowRepo({ ... })` in `fetch()`, persist projection
metadata:

```ts
    await writeMetricflowProjectionConfig(stagedDir, {
      parsedTargetTables: config.parsedTargetTables,
    });
```

Add this method to `MetricflowSourceAdapter`:

```ts
  async project(ctx: DeterministicProjectionContext): Promise<ProjectionResult> {
    if (!isMetricFlowParseResult(ctx.parseArtifacts)) {
      return {
        warnings: [],
        errors: ['MetricFlow deterministic projection requires parseArtifacts from chunk()'],
        touchedSources: [],
        changedWikiPageKeys: [],
      };
    }

    const projectionConfig = await readMetricflowProjectionConfig(ctx.stagedDir);
    const result = await importMetricflowSemanticModels(
      { semanticLayerService: ctx.semanticLayerService },
      {
        connectionId: ctx.connectionId,
        parseResult: ctx.parseArtifacts,
        targetSchema: null,
        hostTables: metricflowHostTablesFromParsedTargets(projectionConfig.parsedTargetTables),
        workdir: ctx.workdir,
      },
    );

    return {
      result,
      warnings: result.warnings,
      errors: result.errors,
      touchedSources: result.touchedSources,
      changedWikiPageKeys: [],
    };
  }
```

Add this helper below `parseMetricflowStagedDirForImport()`:

```ts
function isMetricFlowParseResult(value: unknown): value is MetricFlowParseResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<MetricFlowParseResult>;
  return (
    Array.isArray(candidate.semanticModels) &&
    Array.isArray(candidate.crossModelMetrics) &&
    Array.isArray(candidate.relationships) &&
    Array.isArray(candidate.warnings)
  );
}
```

- [ ] **Step 6: Run the MetricFlow projector tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/metricflow/metricflow.adapter.test.ts -t "deterministic projection|projects parsed|parse artifacts"
```

Expected: PASS.

- [ ] **Step 7: Commit MetricFlow projection changes**

Run:

```bash
git add packages/context/src/ingest/types.ts \
  packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/adapters/metricflow/projection-config.ts \
  packages/context/src/ingest/adapters/metricflow/metricflow.adapter.ts \
  packages/context/src/ingest/adapters/metricflow/metricflow.adapter.test.ts
git commit -m "feat(ingest): project metricflow semantic models before work units"
```

Expected: commit contains only MetricFlow projector and projector context files.

---

### Task 4: Verify MetricFlow takes the isolated path locally

**Files:**
- Modify: `packages/context/src/ingest/local-bundle-ingest.test.ts`

- [ ] **Step 1: Add local MetricFlow isolated projection assertions**

In
`packages/context/src/ingest/local-bundle-ingest.test.ts`, update the existing
`runs full MetricFlow local ingest from a dbt repo fixture through the canonical
runner` test after the report assertions:

```ts
    expect(result.report.body.isolatedDiff).toMatchObject({
      enabled: true,
      acceptedPatches: 0,
      projectionSha: expect.any(String),
    });

    const projectedSourcePath = join(metricflowProject.projectDir, 'semantic-layer/warehouse/orders.yaml');
    await expect(readFile(projectedSourcePath, 'utf-8')).resolves.toContain('name: orders');
```

Keep the existing `expect(agentRunner.runLoop).toHaveBeenCalledTimes(1);`
assertion. It proves the connector remains hybrid: deterministic projection
runs first, then the MetricFlow WorkUnit still runs for agent-authored wiki or
enrichment work.

- [ ] **Step 2: Run the local MetricFlow acceptance test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-bundle-ingest.test.ts -t "runs full MetricFlow local ingest"
```

Expected: PASS. The report body must include `isolatedDiff.enabled: true`, and
the final project must contain `semantic-layer/warehouse/orders.yaml`.

- [ ] **Step 3: Commit local acceptance coverage**

Run:

```bash
git add packages/context/src/ingest/local-bundle-ingest.test.ts
git commit -m "test(ingest): verify metricflow isolated projection path"
```

Expected: commit contains only the local bundle ingest acceptance test.

---

### Task 5: Final verification

**Files:**
- Verify: `packages/context/src/ingest/isolated-diff/source-routing.ts`
- Verify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Verify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Verify: `packages/context/src/ingest/types.ts`
- Verify: `packages/context/src/ingest/adapters/metricflow/*`
- Verify: `packages/context/src/ingest/*.test.ts`

- [ ] **Step 1: Run focused connector migration tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/isolated-diff/source-routing.test.ts \
  src/ingest/local-bundle-runtime.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  src/ingest/adapters/metricflow/metricflow.adapter.test.ts \
  src/ingest/local-bundle-ingest.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the isolated-diff safety suite**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/ingest-trace.test.ts \
  src/ingest/wiki-body-refs.test.ts \
  src/ingest/artifact-gates.test.ts \
  src/ingest/semantic-layer-target-policy.test.ts \
  src/ingest/isolated-diff/git-patch.test.ts \
  src/ingest/isolated-diff/work-unit-executor.test.ts \
  src/ingest/isolated-diff/patch-integrator.test.ts \
  src/ingest/isolated-diff/textual-conflict-resolver.test.ts \
  src/ingest/isolated-diff/source-routing.test.ts \
  src/ingest/final-gate-repair.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  src/ingest/report-snapshot.test.ts \
  src/sl/tools/sl-write-source.tool.test.ts \
  src/sl/tools/sl-edit-source.tool.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run package type checks**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 4: Run dead-code checks**

Run:

```bash
pnpm run dead-code
```

Expected: PASS, or only pre-existing findings unrelated to this connector
migration.

- [ ] **Step 5: Run formatting and diff checks**

Run:

```bash
pnpm exec biome check \
  packages/context/src/ingest/isolated-diff/source-routing.ts \
  packages/context/src/ingest/isolated-diff/source-routing.test.ts \
  packages/context/src/ingest/local-bundle-runtime.ts \
  packages/context/src/ingest/local-bundle-runtime.test.ts \
  packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  packages/context/src/ingest/types.ts \
  packages/context/src/ingest/adapters/metricflow/projection-config.ts \
  packages/context/src/ingest/adapters/metricflow/metricflow.adapter.ts \
  packages/context/src/ingest/adapters/metricflow/metricflow.adapter.test.ts \
  packages/context/src/ingest/local-bundle-ingest.test.ts
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Decide docs-site impact**

No `docs-site/content/docs/` update is required for this plan because it
changes an internal ingest correctness route and does not add, remove, or rename
public CLI commands, flags, config fields, or connector setup instructions.

- [ ] **Step 7: Commit verification fixes only when files changed**

If verification required formatting or type-only edits, run:

```bash
git add packages/context/src/ingest docs/superpowers/plans/2026-05-18-isolated-diff-ingestion-v1-connector-migration.md
git commit -m "chore(ingest): verify isolated diff connector migration"
```

Expected: no empty commit. If no files changed during verification, leave the
branch at the previous task commit.

## Self-review

Spec coverage:

- Rollout step 8 is covered for Notion, LookML, Looker, dbt, and MetricFlow by
  the centralized source-key routing and the non-Metabase isolated runner
  regression matrix.
- The connector migration notes remain source-shaped: adapters keep fetch,
  chunk, clustering, target resolution, and domain rules; the runner owns
  execution isolation and gates.
- MetricFlow's existing deterministic semantic-model import moves into
  `project()`, so its authoritative writes happen in the integration worktree
  before child worktrees are created.
- Notion clustering remains adapter logic; the routing change only changes where
  WorkUnits execute.
- LookML `slDisallowed` remains adapter-scoped and continues to be enforced by
  existing scoped tools and integration patch policy.
- Default promotion and old shared-worktree path removal remain later rollout
  steps and are not implemented by this plan.

Placeholder scan:

- No deferred implementation markers remain.
- Every code-changing step includes exact paths, commands, expected outcomes,
  and concrete code or insertion snippets.

Type consistency:

- The routing helper names are `ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEYS`,
  `defaultIsolatedDiffSourceKeys()`, and
  `isIsolatedDiffDirectWriteSourceKey()` across code and tests.
- The MetricFlow projection config helper names are
  `writeMetricflowProjectionConfig()`, `readMetricflowProjectionConfig()`, and
  `metricflowHostTablesFromParsedTargets()`.
- `DeterministicProjectionContext.semanticLayerService` is passed by
  `IngestBundleRunner` and consumed by `MetricflowSourceAdapter.project()`.
