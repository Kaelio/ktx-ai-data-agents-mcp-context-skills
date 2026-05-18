# Adapter-Owned Finalization V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace runner-level ingest post-processors with a typed
`SourceAdapter.finalize()` phase that runs after reconciliation and before all
final gates.

**Architecture:** Keep the runner responsible for execution mechanics:
worktree scope, diff capture, commits, declaration checks, wiki semantic-layer
reference repair, target policy, final artifact gates, provenance planning,
reports, traces, and squash. Move source-specific deterministic maintenance
into adapter-owned `finalize()` implementations, starting with historic SQL.

**Tech Stack:** TypeScript ESM/NodeNext, Vitest, simple-git through
`GitService`, existing `IngestBundleRunner`, `SourceAdapter`,
`SemanticLayerService`, `KnowledgeWikiService`, `StageIndex`, memory actions,
and isolated-diff trace/report infrastructure.

---

## Audit summary

This audit read
`docs/superpowers/specs/2026-05-18-adapter-owned-ingest-finalization-design.md`,
searched `docs/superpowers/plans/`, and inspected the current ingest runner,
adapter contract, reports, local runtime wiring, and historic-SQL projection
code.

No existing implementation plan targets this spec directly. Existing
isolated-diff plans implemented prerequisites that this work can reuse:
projection before child worktrees, reconciliation before final gates, target
policy, final artifact gates, wiki semantic-layer reference repair, provenance
raw-path validation, persistent traces, failure reports, and gate repair.

Current implementation evidence:

- `SourceAdapter.project()` exists, but `SourceAdapter.finalize()` does not.
- `IngestBundleRunnerDeps.postProcessors` and
  `IngestBundlePostProcessorPort` still exist in
  `packages/context/src/ingest/ports.ts`.
- `IngestBundleRunner` still runs a `post_processor` phase after
  reconciliation.
- `HistoricSqlProjectionPostProcessor` is still exported and wired in
  `local-bundle-runtime.ts`.
- Reports still expose `postProcessor`, and saved-memory counts special-case
  historic SQL post-processor result fields.
- Historic SQL projection still commits its own changes from the
  post-processor, outside runner-owned finalization commit/report/provenance
  mechanics.

## V1-blocking gaps

These gaps block the adapter-owned finalization spec:

- Add typed `DeterministicFinalizationContext`,
  `FinalizationOverrideReplay`, and `FinalizationResult` objects, and add
  optional `SourceAdapter.finalize()`.
- Invoke `adapter.finalize()` after reconciliation and before
  `wiki_sl_ref_repair`, target-policy checks, final artifact gates, provenance
  validation, and squash.
- Make the runner derive finalization changed paths, wiki page keys, and
  semantic-layer touched sources from the integration-worktree diff.
- Resolve aggregate `_schema/*.yaml` semantic-layer changes by comparing
  pre-finalization and post-finalization loaded semantic-layer sources.
- Cross-check adapter-declared touched sources and wiki page keys against the
  runner-derived diff and fail on under-reporting, over-reporting, or
  unresolvable changed semantic-layer paths.
- Commit finalization changes in the integration worktree with a runner-owned
  commit and include the commit SHA and touched paths in reports and traces.
- Fail if finalization effectively changes a path already changed by accepted
  work-unit, projection, or reconciliation writes in the same run.
- Include finalization paths in target policy and final artifact gates.
- Include finalization actions in saved-memory counts and report details, but
  do not re-apply them as writes.
- Add finalization provenance rows only for actions with defensible raw paths:
  current raw snapshot paths, current-run `stageIndex.evictionsApplied` raw
  paths, or `overrideReplay.evictionRawPaths`.
- Report finalization actions excluded from provenance, including the reason.
- Pass explicit override replay metadata to finalization and keep
  `workUnitOutcomes` empty when override replay skips source work units.
- Migrate historic-SQL whole-run projection maintenance into
  `HistoricSqlSourceAdapter.finalize()`.
- Remove `IngestBundlePostProcessorPort`, `deps.postProcessors`,
  `HistoricSqlProjectionPostProcessor`, `post_processor` trace/report phases,
  and `postProcessor` report fields.
- Cover successful finalization, finalization errors, unauthorized target
  rejection, declaration mismatch rejection, override replay behavior,
  wiki-SL-ref repair placement, finalization provenance exclusion, path
  overlap failure, and historic-SQL projection without runner post-processors.

## Non-blocking gaps

These are not required for v1 of this spec:

- Moving historic-SQL per-unit table usage or pattern writes out of typed
  evidence into direct work-unit tools. Evidence can remain an internal
  adapter input as long as it is not exposed as a runner post-processor
  contract.
- Adding deterministic `finalize()` implementations for adapters other than
  historic SQL.
- Re-parsing materialized override raw snapshots as a future override-safe
  input. This plan treats override replay without current-run evidence as a
  no-op for historic-SQL stale/archive cleanup.
- Designing public execution knobs such as `executionMode`,
  `planningStrategy`, `conflictPolicy`, or source-key allowlists.
- Reworking wiki page frontmatter, semantic-layer YAML formats, or historic-SQL
  chunking.

## File structure

- Modify `packages/context/src/ingest/types.ts`.
  Owns the new adapter finalization context/result types and
  `SourceAdapter.finalize()`.
- Modify `packages/context/src/ingest/reports.ts`.
  Replaces post-processor report/count fields with finalization report/count
  fields.
- Modify `packages/context/src/ingest/report-snapshot.ts`.
  Parses stored finalization report metadata.
- Create `packages/context/src/ingest/finalization-scope.ts`.
  Derives finalization wiki keys and semantic-layer source scope from changed
  paths and pre/post semantic-layer snapshots, and validates adapter
  declarations.
- Create `packages/context/src/ingest/finalization-scope.test.ts`.
  Covers standalone SL files, aggregate `_schema` files, wiki pages, mismatch
  detection, and unresolvable aggregate changes.
- Modify `packages/context/src/ingest/ingest-bundle.runner.ts`.
  Calls `adapter.finalize()`, commits finalization changes, records trace and
  report metadata, enforces path overlap and target policy, feeds finalization
  into gates, memory counts, provenance, reindexing, and wiki-SL-ref repair.
- Modify `packages/context/src/ingest/ingest-bundle.runner.test.ts`.
  Covers unit-level finalization context, reports, failures, and provenance
  partitioning.
- Modify `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`.
  Covers real-git finalization ordering, path overlap, target policy, and
  wiki-SL-ref repair placement.
- Modify `packages/context/src/ingest/adapters/historic-sql/projection.ts`.
  Makes projection callable from adapter finalization, returns changed wiki
  page keys and descriptive actions, and no-ops stale/archive cleanup when no
  current-run evidence exists.
- Modify `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.ts`.
  Implements `finalize()`.
- Modify `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`.
  Covers finalization projection result metadata and override-safe no-op
  behavior.
- Delete `packages/context/src/ingest/adapters/historic-sql/post-processor.ts`.
- Delete `packages/context/src/ingest/adapters/historic-sql/post-processor.test.ts`.
- Modify `packages/context/src/ingest/local-bundle-runtime.ts`.
  Removes post-processor import and dependency wiring.
- Modify `packages/context/src/ingest/ports.ts`.
  Removes post-processor port types and dependency injection.
- Modify `packages/context/src/ingest/index.ts`.
  Removes post-processor exports and exports finalization helper types only as
  needed.
- Modify `packages/context/src/package-exports.test.ts`.
  Removes the historic-SQL post-processor export assertion.
- Modify `packages/cli/src/ingest.test.ts` and
  `packages/cli/src/setup.ts` only if saved-memory count assertions still
  refer to post-processor report fields.

---

### Task 1: Add adapter finalization and report contracts

**Files:**
- Modify: `packages/context/src/ingest/types.ts`
- Modify: `packages/context/src/ingest/reports.ts`
- Modify: `packages/context/src/ingest/report-snapshot.ts`

- [ ] **Step 1: Add finalization adapter types**

In `packages/context/src/ingest/types.ts`, add these imports near the top:

```ts
import type { MemoryAction } from '../memory/index.js';
import type { TouchedSlSource } from '../tools/index.js';
import type { StageIndex } from './stages/stage-index.types.js';
import type { WorkUnitOutcome } from './stages/stage-3-work-units.js';
```

In the same file, insert this block after `ProjectionResult`:

```ts
export interface FinalizationOverrideReplay {
  priorJobId: string;
  priorRunId: string;
  priorSyncId: string;
  evictionRawPaths: string[];
}

export interface DeterministicFinalizationContext {
  connectionId: string;
  sourceKey: string;
  syncId: string;
  jobId: string;
  runId: string;
  stagedDir: string;
  workdir: string;
  parseArtifacts?: unknown;
  stageIndex: StageIndex;
  workUnitOutcomes: WorkUnitOutcome[];
  reconciliationActions: MemoryAction[];
  overrideReplay?: FinalizationOverrideReplay;
}

export interface FinalizationResult {
  warnings: string[];
  errors: string[];
  touchedSources: TouchedSlSource[];
  changedWikiPageKeys: string[];
  actions?: MemoryAction[];
  result?: unknown;
}
```

Then add the optional method to `SourceAdapter` immediately after `project?`:

```ts
  finalize?(ctx: DeterministicFinalizationContext): Promise<FinalizationResult>;
```

- [ ] **Step 2: Add finalization report types**

In `packages/context/src/ingest/reports.ts`, replace
`IngestReportPostProcessorOutcome` with:

```ts
export interface IngestReportFinalizationMismatch {
  artifactKind: 'sl' | 'wiki';
  key: string;
  direction: 'missing_from_adapter_declaration' | 'extra_in_adapter_declaration';
}

export interface IngestReportFinalizationProvenanceExclusion {
  action: MemoryAction;
  reason: 'missing_raw_paths' | 'raw_path_not_defensible';
  invalidRawPaths?: string[];
}

export interface IngestReportFinalizationOutcome {
  sourceKey: string;
  status: 'success' | 'failed' | 'skipped';
  commitSha: string | null;
  touchedPaths: string[];
  declaredTouchedSources: TouchedSlSource[];
  derivedTouchedSources: TouchedSlSource[];
  declaredChangedWikiPageKeys: string[];
  derivedChangedWikiPageKeys: string[];
  mismatches: IngestReportFinalizationMismatch[];
  result?: unknown;
  errors: string[];
  warnings: string[];
  actions: MemoryAction[];
  provenanceExclusions: IngestReportFinalizationProvenanceExclusion[];
}
```

Replace the `postProcessor?: IngestReportPostProcessorOutcome;` field in
`IngestReportBody` with:

```ts
  finalization?: IngestReportFinalizationOutcome;
```

Replace `postProcessorSavedMemoryCounts()` with:

```ts
export function finalizationSavedMemoryCounts(
  finalization: IngestReportFinalizationOutcome | undefined,
): IngestSavedMemoryCounts {
  const actions = finalization?.actions ?? [];
  return {
    wikiCount: actions.filter((action) => action.target === 'wiki').length,
    slCount: actions.filter((action) => action.target === 'sl').length,
  };
}
```

Then update `savedMemoryCountsForReport()` so it includes finalization
actions:

```ts
export function savedMemoryCountsForReport(report: IngestReportSnapshot): IngestSavedMemoryCounts {
  const workUnitActions = report.body.workUnits.flatMap((workUnit) => workUnit.actions);
  const reconciliationActions = report.body.reconciliationActions ?? [];
  const finalizationActions = report.body.finalization?.actions ?? [];
  const actions = [...workUnitActions, ...reconciliationActions, ...finalizationActions];
  return {
    wikiCount: actions.filter((action) => action.target === 'wiki').length,
    slCount: actions.filter((action) => action.target === 'sl').length,
  };
}
```

- [ ] **Step 3: Parse stored finalization report snapshots**

In `packages/context/src/ingest/report-snapshot.ts`, add this schema near the
other report schemas:

```ts
const finalizationMismatchSchema = z.object({
  artifactKind: z.enum(['sl', 'wiki']),
  key: z.string().min(1),
  direction: z.enum(['missing_from_adapter_declaration', 'extra_in_adapter_declaration']),
});

const finalizationProvenanceExclusionSchema = z.object({
  action: ingestActionSchema,
  reason: z.enum(['missing_raw_paths', 'raw_path_not_defensible']),
  invalidRawPaths: z.array(z.string()).optional(),
});

const finalizationOutcomeSchema = z.object({
  sourceKey: z.string().min(1),
  status: z.enum(['success', 'failed', 'skipped']),
  commitSha: z.string().nullable(),
  touchedPaths: z.array(z.string()),
  declaredTouchedSources: z.array(touchedSlSourceSchema),
  derivedTouchedSources: z.array(touchedSlSourceSchema),
  declaredChangedWikiPageKeys: z.array(z.string()),
  derivedChangedWikiPageKeys: z.array(z.string()),
  mismatches: z.array(finalizationMismatchSchema).default([]),
  result: z.unknown().optional(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  actions: z.array(ingestActionSchema).default([]),
  provenanceExclusions: z.array(finalizationProvenanceExclusionSchema).default([]),
});
```

Then add this field inside the report body schema:

```ts
        finalization: finalizationOutcomeSchema.optional(),
```

- [ ] **Step 4: Run the contract checks**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/report-snapshot.test.ts src/package-exports.test.ts
```

Expected: PASS after the implementation compiles. Before downstream code is
updated, TypeScript references to removed post-processor names may still fail
in later tasks.

### Task 2: Add finalization scope derivation helpers

**Files:**
- Create: `packages/context/src/ingest/finalization-scope.ts`
- Create: `packages/context/src/ingest/finalization-scope.test.ts`

- [ ] **Step 1: Write finalization scope tests**

Create `packages/context/src/ingest/finalization-scope.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  deriveFinalizationWikiPageKeys,
  compareFinalizationDeclarations,
  deriveFinalizationTouchedSources,
} from './finalization-scope.js';

describe('deriveFinalizationWikiPageKeys', () => {
  it('maps changed global wiki markdown paths to page keys', () => {
    expect(
      deriveFinalizationWikiPageKeys([
        'wiki/global/historic-sql-orders.md',
        'wiki/global/nested/page.md',
        'README.md',
      ]),
    ).toEqual(['historic-sql-orders']);
  });
});

describe('deriveFinalizationTouchedSources', () => {
  it('maps standalone semantic-layer files directly', async () => {
    const result = await deriveFinalizationTouchedSources({
      changedPaths: ['semantic-layer/warehouse/orders.yaml'],
      beforeSourcesByConnection: new Map(),
      afterSourcesByConnection: new Map(),
    });
    expect(result).toEqual({
      touchedSources: [{ connectionId: 'warehouse', sourceName: 'orders' }],
      unresolvedPaths: [],
    });
  });

  it('resolves aggregate _schema changes by comparing loaded source snapshots', async () => {
    const beforeSourcesByConnection = new Map([
      [
        'warehouse',
        [
          {
            name: 'orders',
            grain: ['order_id'],
            columns: [{ name: 'order_id', type: 'string' }],
            joins: [],
            measures: [],
            usage: { narrative: 'old' },
          },
        ],
      ],
    ]);
    const afterSourcesByConnection = new Map([
      [
        'warehouse',
        [
          {
            name: 'orders',
            grain: ['order_id'],
            columns: [{ name: 'order_id', type: 'string' }],
            joins: [],
            measures: [],
            usage: { narrative: 'new' },
          },
        ],
      ],
    ]);

    const result = await deriveFinalizationTouchedSources({
      changedPaths: ['semantic-layer/warehouse/_schema/public.yaml'],
      beforeSourcesByConnection,
      afterSourcesByConnection,
    });

    expect(result).toEqual({
      touchedSources: [{ connectionId: 'warehouse', sourceName: 'orders' }],
      unresolvedPaths: [],
    });
  });

  it('flags aggregate _schema changes that cannot be resolved to logical sources', async () => {
    const beforeSourcesByConnection = new Map([['warehouse', []]]);
    const afterSourcesByConnection = new Map([['warehouse', []]]);

    const result = await deriveFinalizationTouchedSources({
      changedPaths: ['semantic-layer/warehouse/_schema/public.yaml'],
      beforeSourcesByConnection,
      afterSourcesByConnection,
    });

    expect(result).toEqual({
      touchedSources: [],
      unresolvedPaths: ['semantic-layer/warehouse/_schema/public.yaml'],
    });
  });
});

describe('compareFinalizationDeclarations', () => {
  it('reports missing and extra adapter declarations', () => {
    expect(
      compareFinalizationDeclarations({
        declaredTouchedSources: [{ connectionId: 'warehouse', sourceName: 'orders' }],
        derivedTouchedSources: [{ connectionId: 'warehouse', sourceName: 'customers' }],
        declaredChangedWikiPageKeys: ['orders'],
        derivedChangedWikiPageKeys: ['orders', 'patterns'],
      }),
    ).toEqual([
      {
        artifactKind: 'sl',
        key: 'warehouse:customers',
        direction: 'missing_from_adapter_declaration',
      },
      {
        artifactKind: 'sl',
        key: 'warehouse:orders',
        direction: 'extra_in_adapter_declaration',
      },
      {
        artifactKind: 'wiki',
        key: 'patterns',
        direction: 'missing_from_adapter_declaration',
      },
    ]);
  });
});
```

- [ ] **Step 2: Implement finalization scope helpers**

Create `packages/context/src/ingest/finalization-scope.ts`:

```ts
import type { SemanticLayerSource } from '../sl/index.js';
import type { TouchedSlSource } from '../tools/index.js';
import type { IngestReportFinalizationMismatch } from './reports.js';

interface DeriveTouchedSourcesInput {
  changedPaths: string[];
  beforeSourcesByConnection: Map<string, SemanticLayerSource[]>;
  afterSourcesByConnection: Map<string, SemanticLayerSource[]>;
}

interface DeriveTouchedSourcesResult {
  touchedSources: TouchedSlSource[];
  unresolvedPaths: string[];
}

interface CompareFinalizationDeclarationsInput {
  declaredTouchedSources: TouchedSlSource[];
  derivedTouchedSources: TouchedSlSource[];
  declaredChangedWikiPageKeys: string[];
  derivedChangedWikiPageKeys: string[];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function touchedKey(source: TouchedSlSource): string {
  return `${source.connectionId}:${source.sourceName}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function changedSourceNames(
  beforeSources: SemanticLayerSource[],
  afterSources: SemanticLayerSource[],
): string[] {
  const before = new Map(beforeSources.map((source) => [source.name, stableJson(source)]));
  const after = new Map(afterSources.map((source) => [source.name, stableJson(source)]));
  return uniqueSorted(
    uniqueSorted([...before.keys(), ...after.keys()]).filter((sourceName) => before.get(sourceName) !== after.get(sourceName)),
  );
}

export function deriveFinalizationWikiPageKeys(paths: string[]): string[] {
  return uniqueSorted(
    paths
      .filter((path) => path.startsWith('wiki/global/') && path.endsWith('.md'))
      .filter((path) => !path.slice('wiki/global/'.length, -'.md'.length).includes('/'))
      .map((path) => path.slice('wiki/global/'.length, -'.md'.length)),
  );
}

export async function deriveFinalizationTouchedSources(
  input: DeriveTouchedSourcesInput,
): Promise<DeriveTouchedSourcesResult> {
  const touched = new Map<string, TouchedSlSource>();
  const unresolvedPaths: string[] = [];

  for (const path of input.changedPaths) {
    if (!path.startsWith('semantic-layer/') || !(path.endsWith('.yaml') || path.endsWith('.yml'))) {
      continue;
    }
    const parts = path.split('/');
    const connectionId = parts[1] ?? '';
    if (!connectionId) {
      unresolvedPaths.push(path);
      continue;
    }
    if (parts[2] !== '_schema') {
      const fileName = parts.at(-1) ?? '';
      const sourceName = fileName.replace(/\.ya?ml$/, '');
      if (!sourceName) {
        unresolvedPaths.push(path);
        continue;
      }
      touched.set(`${connectionId}:${sourceName}`, { connectionId, sourceName });
      continue;
    }

    const changedNames = changedSourceNames(
      input.beforeSourcesByConnection.get(connectionId) ?? [],
      input.afterSourcesByConnection.get(connectionId) ?? [],
    );
    if (changedNames.length === 0) {
      unresolvedPaths.push(path);
      continue;
    }
    for (const sourceName of changedNames) {
      touched.set(`${connectionId}:${sourceName}`, { connectionId, sourceName });
    }
  }

  return {
    touchedSources: [...touched.values()].sort((left, right) => touchedKey(left).localeCompare(touchedKey(right))),
    unresolvedPaths: uniqueSorted(unresolvedPaths),
  };
}

export function compareFinalizationDeclarations(
  input: CompareFinalizationDeclarationsInput,
): IngestReportFinalizationMismatch[] {
  const mismatches: IngestReportFinalizationMismatch[] = [];
  const declaredSl = new Set(input.declaredTouchedSources.map(touchedKey));
  const derivedSl = new Set(input.derivedTouchedSources.map(touchedKey));
  const declaredWiki = new Set(input.declaredChangedWikiPageKeys);
  const derivedWiki = new Set(input.derivedChangedWikiPageKeys);

  for (const key of [...derivedSl].sort()) {
    if (!declaredSl.has(key)) {
      mismatches.push({ artifactKind: 'sl', key, direction: 'missing_from_adapter_declaration' });
    }
  }
  for (const key of [...declaredSl].sort()) {
    if (!derivedSl.has(key)) {
      mismatches.push({ artifactKind: 'sl', key, direction: 'extra_in_adapter_declaration' });
    }
  }
  for (const key of [...derivedWiki].sort()) {
    if (!declaredWiki.has(key)) {
      mismatches.push({ artifactKind: 'wiki', key, direction: 'missing_from_adapter_declaration' });
    }
  }
  for (const key of [...declaredWiki].sort()) {
    if (!derivedWiki.has(key)) {
      mismatches.push({ artifactKind: 'wiki', key, direction: 'extra_in_adapter_declaration' });
    }
  }
  return mismatches;
}
```

- [ ] **Step 3: Run the focused helper tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/finalization-scope.test.ts
```

Expected: PASS.

### Task 3: Wire runner-owned finalization

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.test.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`

- [ ] **Step 1: Add a unit test for successful finalization**

In `packages/context/src/ingest/ingest-bundle.runner.test.ts`, replace the
post-processor success test with a finalization success test:

```ts
  it('runs adapter finalization before squash, records the outcome, and reindexes touched sources', async () => {
    const deps = makeDeps();
    deps.adapter.source = 'metricflow';
    deps.registry.get.mockReturnValue(deps.adapter);
    deps.adapter.chunk.mockResolvedValue({
      workUnits: [{ unitKey: 'u1', rawFiles: ['semantic_models.yml'], peerFileIndex: [], dependencyPaths: [] }],
      parseArtifacts: { semanticModels: [{ name: 'orders' }] },
    });
    deps.adapter.listTargetConnectionIds = vi.fn().mockResolvedValue(['warehouse-2']);
    deps.adapter.finalize = vi.fn().mockResolvedValue({
      result: { sourcesTouched: 1 },
      warnings: ['kept going'],
      errors: [],
      touchedSources: [{ connectionId: 'warehouse-2', sourceName: 'orders' }],
      changedWikiPageKeys: [],
      actions: [{ target: 'sl', type: 'updated', key: 'orders', targetConnectionId: 'warehouse-2', detail: 'Finalized orders usage', rawPaths: ['semantic_models.yml'] }],
    });
    deps.semanticLayerService.loadAllSources.mockImplementation((connectionId: string) =>
      Promise.resolve({ sources: [{ name: `${connectionId}_source` }], loadErrors: [] }),
    );
    deps.sessionWorktree.git.diffNameStatus.mockImplementation(async (from: string, to: string) =>
      from === 'pre-finalization' && to === 'post-finalization'
        ? [{ status: 'M', path: 'semantic-layer/warehouse-2/orders.yaml' }]
        : [],
    );
    deps.sessionWorktree.git.revParseHead
      .mockResolvedValueOnce('pre-finalization')
      .mockResolvedValueOnce('post-finalization');
    deps.sessionWorktree.git.commitFiles.mockResolvedValue({ created: true, commitHash: 'finalization-sha' });

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['semantic_models.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/metricflow/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'metricflow',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    expect(deps.adapter.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'c1',
        sourceKey: 'metricflow',
        syncId: expect.any(String),
        jobId: 'j1',
        runId: 'run-1',
        workdir: '/tmp/wt',
        parseArtifacts: { semanticModels: [{ name: 'orders' }] },
        overrideReplay: undefined,
      }),
    );
    expect(deps.reportsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          finalization: expect.objectContaining({
            sourceKey: 'metricflow',
            status: 'success',
            commitSha: 'finalization-sha',
            touchedPaths: ['semantic-layer/warehouse-2/orders.yaml'],
            derivedTouchedSources: [{ connectionId: 'warehouse-2', sourceName: 'orders' }],
            declaredTouchedSources: [{ connectionId: 'warehouse-2', sourceName: 'orders' }],
            actions: [expect.objectContaining({ key: 'orders' })],
          }),
        }),
      }),
    );
    expect(deps.semanticLayerService.loadAllSources).toHaveBeenCalledWith('warehouse-2');
    expect(deps.slSearchService.indexSources).toHaveBeenCalledWith('warehouse-2', [{ name: 'warehouse-2_source' }]);
  });
```

Adjust the mocked `revParseHead` and `diffNameStatus` values to match the
current helper names in `makeDeps()` if the test harness already sequences
those calls differently.

- [ ] **Step 2: Add real-git ordering and overlap tests**

In `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`,
add two tests inside the isolated-diff describe block:

```ts
  it('runs finalization before wiki sl-ref repair and final gates', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'wiki-page', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      adapter.finalize = vi.fn(async ({ workdir }) => {
        await mkdir(join(workdir, 'semantic-layer/warehouse'), { recursive: true });
        await mkdir(join(workdir, 'wiki/global'), { recursive: true });
        await writeFile(
          join(workdir, 'semantic-layer/warehouse/orders.yaml'),
          'name: orders\ngrain: [order_id]\ncolumns: [{name: order_id, type: string}]\njoins: []\nmeasures:\n  - name: total_orders\n    expr: count(*)\n',
        );
        await writeFile(
          join(workdir, 'wiki/global/finalized-orders.md'),
          '---\nsummary: Finalized orders\nusage_mode: auto\nsl_refs: []\n---\n\nOrders use `orders.total_orders`.\n',
        );
        return {
          warnings: [],
          errors: [],
          touchedSources: [{ connectionId: 'warehouse', sourceName: 'orders' }],
          changedWikiPageKeys: ['finalized-orders'],
          actions: [
            { target: 'sl', type: 'created', key: 'orders', detail: 'Finalized orders', rawPaths: ['cards/source.json'] },
            { target: 'wiki', type: 'created', key: 'finalized-orders', detail: 'Finalized wiki', rawPaths: ['cards/source.json'] },
          ],
        };
      });
      deps.agentRunner.runLoop = vi.fn(async () => ({ stopReason: 'natural' as const })) as never;
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);

      await runner.run({ jobId: 'job-finalization', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } });

      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-finalization/trace.jsonl'), 'utf-8');
      expect(trace.indexOf('finalization_committed')).toBeLessThan(trace.indexOf('wiki_sl_refs_repaired'));
      expect(trace.indexOf('wiki_sl_refs_repaired')).toBeLessThan(trace.indexOf('final_artifact_gates'));
      await expect(readFile(join(runtime.configDir, 'wiki/global/finalized-orders.md'), 'utf-8')).resolves.toContain(
        'sl_refs:\n  - orders',
      );
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('fails when finalization edits a path already changed earlier in the run', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'wiki-page', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(join(root, 'wiki/global/orders.md'), '---\nsummary: Orders\nusage_mode: auto\n---\n\nWU body\n');
        currentSession.actions.push({ target: 'wiki', type: 'created', key: 'orders', detail: 'WU orders' });
        await currentSession.gitService.commitFiles(['wiki/global/orders.md'], 'wu orders', 'KTX Test', 'system@ktx.local');
        return { stopReason: 'natural' as const };
      }) as never;
      adapter.finalize = vi.fn(async ({ workdir }) => {
        await writeFile(join(workdir, 'wiki/global/orders.md'), '---\nsummary: Orders\nusage_mode: auto\n---\n\nFinalized body\n');
        return {
          warnings: [],
          errors: [],
          touchedSources: [],
          changedWikiPageKeys: ['orders'],
          actions: [{ target: 'wiki', type: 'updated', key: 'orders', detail: 'Conflicting finalization' }],
        };
      });
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);

      await expect(
        runner.run({ jobId: 'job-finalization-overlap', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/finalization modified path\(s\) already changed earlier in this run: wiki\/global\/orders\.md/);
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

Add a target-policy regression in the same file:

```ts
  it('rejects finalization writes to unauthorized semantic-layer targets', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({ workUnits: [] });
      adapter.finalize = vi.fn(async ({ workdir }) => {
        await mkdir(join(workdir, 'semantic-layer/other-warehouse'), { recursive: true });
        await writeFile(
          join(workdir, 'semantic-layer/other-warehouse/orders.yaml'),
          'name: orders\ngrain: [order_id]\ncolumns: [{name: order_id, type: string}]\njoins: []\nmeasures: []\n',
        );
        return {
          warnings: [],
          errors: [],
          touchedSources: [{ connectionId: 'other-warehouse', sourceName: 'orders' }],
          changedWikiPageKeys: [],
          actions: [{ target: 'sl', type: 'created', key: 'orders', targetConnectionId: 'other-warehouse', detail: 'Forbidden target', rawPaths: ['cards/source.json'] }],
        };
      });
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);

      await expect(
        runner.run({ jobId: 'job-finalization-target-policy', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/unauthorized semantic-layer target/);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-finalization-target-policy/trace.jsonl'), 'utf-8');
      expect(trace).toContain('finalization_committed');
      expect(trace).toContain('semantic_layer_target_policy');
      expect(trace).toContain('ingest_failed');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 3: Implement the runner finalization phase**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, import the helpers:

```ts
import {
  compareFinalizationDeclarations,
  deriveFinalizationTouchedSources,
  deriveFinalizationWikiPageKeys,
} from './finalization-scope.js';
```

Near the existing `latestReportProvenanceRows` and `latestReconciliationActions`
variables at the top of `runInternal()`, add:

```ts
      let latestFinalizationOutcome: IngestReportFinalizationOutcome | undefined;
```

Replace the post-processor block after reconciliation with this shape:

```ts
      const preFinalizationSha = await sessionWorktree.git.revParseHead();
      const preFinalizationSourcesByConnection = await this.loadSourcesByConnection(
        sessionWorktree.workdir,
        slConnectionIds,
      );
      let finalizationOutcome: IngestReportFinalizationOutcome | undefined;
      let finalizationActions: MemoryAction[] = [];
      let finalizationTouchedPaths: string[] = [];
      let finalizationTouchedSources: TouchedSlSource[] = [];
      let finalizationChangedWikiPageKeys: string[] = [];
      let finalizationSha: string | null = null;

      activePhase = 'finalization';
      if (adapter.finalize) {
        emitStageProgress('finalization', 87, 'Running deterministic finalization');
        await runTrace.event('debug', 'finalization', 'finalization_started', { sourceKey: job.sourceKey });
        const result = await adapter.finalize({
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          syncId,
          jobId: job.jobId,
          runId: createdRunRow.id,
          stagedDir,
          workdir: sessionWorktree.workdir,
          ...(overrideReport ? {} : { parseArtifacts }),
          stageIndex,
          workUnitOutcomes,
          reconciliationActions: reconcileActions,
          ...(overrideReport
            ? {
                overrideReplay: {
                  priorJobId: overrideReport.jobId,
                  priorRunId: overrideReport.runId,
                  priorSyncId: overrideReport.body.syncId,
                  evictionRawPaths: overrideReport.body.evictionInputs,
                },
              }
            : {}),
        });
        if (result.errors.length > 0) {
          finalizationOutcome = {
            sourceKey: job.sourceKey,
            status: 'failed',
            commitSha: null,
            touchedPaths: [],
            declaredTouchedSources: result.touchedSources,
            derivedTouchedSources: [],
            declaredChangedWikiPageKeys: result.changedWikiPageKeys,
            derivedChangedWikiPageKeys: [],
            mismatches: [],
            result: result.result,
            errors: result.errors,
            warnings: result.warnings,
            actions: result.actions ?? [],
            provenanceExclusions: [],
          };
          latestFinalizationOutcome = finalizationOutcome;
          await runTrace.event('error', 'finalization', 'finalization_failed', {
            sourceKey: job.sourceKey,
            errors: result.errors,
            warnings: result.warnings,
          });
          throw new Error(`deterministic finalization failed: ${result.errors.join('; ')}`);
        }

        const changedBeforeFinalization = new Set([
          ...projectionTouchedPaths,
          ...workUnitOutcomes.flatMap((outcome) => outcome.patchTouchedPaths ?? []),
          ...(preReconciliationSha && preFinalizationSha !== preReconciliationSha
            ? (await sessionWorktree.git.diffNameStatus(preReconciliationSha, preFinalizationSha)).map((entry) => entry.path)
            : []),
        ]);
        const changedStatus = await sessionWorktree.git.changedPaths();
        finalizationTouchedPaths = changedStatus;
        const overlapping = finalizationTouchedPaths.filter((path) => changedBeforeFinalization.has(path));
        if (overlapping.length > 0) {
          await runTrace.event('error', 'finalization', 'finalization_failed', {
            sourceKey: job.sourceKey,
            reason: 'path_overlap',
            overlappingPaths: overlapping.sort(),
          });
          throw new Error(`finalization modified path(s) already changed earlier in this run: ${overlapping.sort().join(', ')}`);
        }

        const finalizationCommit =
          finalizationTouchedPaths.length > 0
            ? await sessionWorktree.git.commitFiles(
                finalizationTouchedPaths,
                `ingest(${job.sourceKey}): deterministic finalization syncId=${syncId}`,
                this.deps.storage.systemGitAuthor.name,
                this.deps.storage.systemGitAuthor.email,
              )
            : await sessionWorktree.git.commitStaged(
                `ingest(${job.sourceKey}): deterministic finalization syncId=${syncId}`,
                this.deps.storage.systemGitAuthor.name,
                this.deps.storage.systemGitAuthor.email,
              );
        finalizationSha = finalizationCommit.created ? finalizationCommit.commitHash : null;
        const postFinalizationSha = await sessionWorktree.git.revParseHead();
        finalizationTouchedPaths =
          preFinalizationSha !== postFinalizationSha
            ? (await sessionWorktree.git.diffNameStatus(preFinalizationSha, postFinalizationSha)).map((entry) => entry.path)
            : [];

        const changedConnectionIds = [
          ...new Set([
            ...slConnectionIds,
            ...finalizationTouchedPaths
              .filter((path) => path.startsWith('semantic-layer/'))
              .map((path) => path.split('/')[1])
              .filter((connectionId): connectionId is string => Boolean(connectionId)),
          ]),
        ].sort();
        const postFinalizationSourcesByConnection = await this.loadSourcesByConnection(
          sessionWorktree.workdir,
          changedConnectionIds,
        );
        const scope = await deriveFinalizationTouchedSources({
          changedPaths: finalizationTouchedPaths,
          beforeSourcesByConnection: preFinalizationSourcesByConnection,
          afterSourcesByConnection: postFinalizationSourcesByConnection,
        });
        if (scope.unresolvedPaths.length > 0) {
          await runTrace.event('error', 'finalization', 'finalization_failed', {
            sourceKey: job.sourceKey,
            reason: 'unresolved_semantic_layer_paths',
            unresolvedPaths: scope.unresolvedPaths,
          });
          throw new Error(`could not resolve finalization semantic-layer path(s): ${scope.unresolvedPaths.join(', ')}`);
        }
        finalizationTouchedSources = scope.touchedSources;
        finalizationChangedWikiPageKeys = deriveFinalizationWikiPageKeys(finalizationTouchedPaths);
        const mismatches = compareFinalizationDeclarations({
          declaredTouchedSources: result.touchedSources,
          derivedTouchedSources: finalizationTouchedSources,
          declaredChangedWikiPageKeys: result.changedWikiPageKeys,
          derivedChangedWikiPageKeys: finalizationChangedWikiPageKeys,
        });
        if (mismatches.length > 0) {
          finalizationOutcome = {
            sourceKey: job.sourceKey,
            status: 'failed',
            commitSha: finalizationSha,
            touchedPaths: finalizationTouchedPaths,
            declaredTouchedSources: result.touchedSources,
            derivedTouchedSources: finalizationTouchedSources,
            declaredChangedWikiPageKeys: result.changedWikiPageKeys,
            derivedChangedWikiPageKeys: finalizationChangedWikiPageKeys,
            mismatches,
            result: result.result,
            errors: ['finalization touched artifact declaration mismatch'],
            warnings: result.warnings,
            actions: result.actions ?? [],
            provenanceExclusions: [],
          };
          latestFinalizationOutcome = finalizationOutcome;
          await runTrace.event('error', 'finalization', 'finalization_failed', {
            sourceKey: job.sourceKey,
            reason: 'declaration_mismatch',
            mismatches,
          });
          throw new Error(`finalization touched artifact declaration mismatch: ${mismatches.map((m) => `${m.direction}:${m.artifactKind}:${m.key}`).join(', ')}`);
        }
        finalizationActions = result.actions ?? [];
        finalizationOutcome = {
          sourceKey: job.sourceKey,
          status: 'success',
          commitSha: finalizationSha,
          touchedPaths: finalizationTouchedPaths,
          declaredTouchedSources: result.touchedSources,
          derivedTouchedSources: finalizationTouchedSources,
          declaredChangedWikiPageKeys: result.changedWikiPageKeys,
          derivedChangedWikiPageKeys: finalizationChangedWikiPageKeys,
          mismatches,
          result: result.result,
          errors: [],
          warnings: result.warnings,
          actions: finalizationActions,
          provenanceExclusions: [],
        };
        latestFinalizationOutcome = finalizationOutcome;
        await runTrace.event('debug', 'finalization', 'finalization_committed', {
          sourceKey: job.sourceKey,
          commitSha: finalizationSha,
          touchedPaths: finalizationTouchedPaths,
          touchedSources: finalizationTouchedSources,
          changedWikiPageKeys: finalizationChangedWikiPageKeys,
          warnings: result.warnings,
        });
      } else {
        await runTrace.event('debug', 'finalization', 'finalization_skipped', { sourceKey: job.sourceKey });
      }
```

In the runner `catch` block failure report body, include the latest
finalization outcome:

```ts
            finalization: latestFinalizationOutcome,
```

Add `GitService.changedPaths()` in `packages/context/src/core/git.service.ts`
or use an equivalent existing helper:

```ts
  async changedPaths(): Promise<string[]> {
    const raw = await this.git.raw(['status', '--porcelain=v1', '-z']);
    const fields = raw.split('\0').filter(Boolean);
    const paths: string[] = [];
    for (const field of fields) {
      const path = field.slice(3);
      if (path.length > 0) {
        paths.push(path);
      }
    }
    return [...new Set(paths)].sort();
  }
```

Add a private runner helper:

```ts
  private async loadSourcesByConnection(
    workdir: string,
    connectionIds: string[],
  ): Promise<Map<string, SemanticLayerSource[]>> {
    const service = this.deps.semanticLayerService.forWorktree(workdir);
    const result = new Map<string, SemanticLayerSource[]>();
    for (const connectionId of connectionIds) {
      const { sources } = await service.loadAllSources(connectionId);
      result.set(connectionId, sources);
    }
    return result;
  }
```

- [ ] **Step 4: Feed finalization into repair, target policy, and gates**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, replace uses of
post-processor scope:

```ts
        ...(postProcessorOutcome?.touchedSources ?? [])
```

with:

```ts
        ...finalizationTouchedSources
```

Replace final wiki page scope additions so finalization wiki keys are included:

```ts
        ...finalizationChangedWikiPageKeys,
```

Replace the final target policy post-processor path mapping with:

```ts
        ...finalizationTouchedPaths,
```

Replace report body field:

```ts
        finalization: finalizationOutcome,
```

Replace SL reindex touched connections so it includes finalization actions and
derived touched sources:

```ts
              .concat(finalizationActions)
              .filter((action) => action.target === 'sl')
              .map((action) => actionTargetConnectionId(action, job.connectionId))
              .concat(finalizationTouchedSources.map((source) => source.connectionId)),
```

- [ ] **Step 5: Run focused runner tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.test.ts src/ingest/ingest-bundle.runner.isolated-diff.test.ts
```

Expected: PASS after the runner wiring is complete.

### Task 4: Add finalization provenance and override replay behavior

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.test.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`

- [ ] **Step 1: Add unit tests for provenance partitioning and override context**

Add these tests to `packages/context/src/ingest/ingest-bundle.runner.test.ts`:

```ts
  it('reports finalization actions excluded from provenance when raw paths are not defensible', async () => {
    const deps = makeDeps();
    deps.adapter.finalize = vi.fn().mockResolvedValue({
      warnings: [],
      errors: [],
      touchedSources: [],
      changedWikiPageKeys: [],
      actions: [
        { target: 'wiki', type: 'updated', key: 'historic-sql-pattern', detail: 'No raw path' },
        { target: 'sl', type: 'updated', key: 'orders', detail: 'Invalid raw path', rawPaths: ['missing.json'] },
      ],
    });
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['current.json', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({ jobId: 'j1', connectionId: 'c1', sourceKey: 'fake', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload-x' } });

    expect(deps.reportsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          finalization: expect.objectContaining({
            provenanceExclusions: [
              expect.objectContaining({ reason: 'missing_raw_paths' }),
              expect.objectContaining({ reason: 'raw_path_not_defensible', invalidRawPaths: ['missing.json'] }),
            ],
          }),
        }),
      }),
    );
    expect(deps.provenanceRepo.insertMany).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ rawPath: 'missing.json' })]),
    );
  });

  it('passes explicit override replay metadata and no current work unit outcomes', async () => {
    const deps = makeDeps();
    deps.reportsRepo.findByJobId.mockResolvedValue({
      id: 'prior-report',
      runId: 'prior-run',
      jobId: 'prior-job',
      connectionId: 'c1',
      sourceKey: 'fake',
      createdAt: '2026-05-18T00:00:00.000Z',
      body: {
        status: 'completed',
        syncId: 'prior-sync',
        diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
        commitSha: 'prior-sha',
        workUnits: [
          {
            unitKey: 'prior-unit',
            rawFiles: ['prior.json'],
            status: 'success',
            actions: [{ target: 'wiki', type: 'created', key: 'prior', detail: 'prior' }],
            touchedSlSources: [],
          },
        ],
        failedWorkUnits: [],
        reconciliationSkipped: false,
        conflictsResolved: [],
        evictionsApplied: [{ rawPath: 'do-not-replay.json', artifactKind: 'wiki', artifactKey: 'old', action: 'removed', reason: 'prior' }],
        unmappedFallbacks: [],
        artifactResolutions: [],
        evictionInputs: ['evicted-from-prior-report.json'],
        unresolvedCards: [],
        supersededBy: null,
        overrideOf: null,
        provenanceRows: [],
        toolTranscripts: [],
      },
    });
    deps.adapter.finalize = vi.fn().mockResolvedValue({
      warnings: [],
      errors: [],
      touchedSources: [],
      changedWikiPageKeys: [],
      actions: [],
    });
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['prior.json', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/prior-sync',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/prior');

    await runner.run({ jobId: 'override-job', connectionId: 'c1', sourceKey: 'fake', trigger: 'manual_override', bundleRef: { kind: 'override', priorJobId: 'prior-job' } });

    expect(deps.adapter.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        workUnitOutcomes: [],
        parseArtifacts: undefined,
        overrideReplay: {
          priorJobId: 'prior-job',
          priorRunId: 'prior-run',
          priorSyncId: 'prior-sync',
          evictionRawPaths: ['evicted-from-prior-report.json'],
        },
      }),
    );
  });
```

- [ ] **Step 2: Partition finalization actions for provenance**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, extend
`ProvenanceRowOrigin` with:

```ts
  | {
      source: 'finalization_action';
      actionIndex: number;
      action: MemoryAction;
    };
```

Add this private helper:

```ts
  private partitionFinalizationActionsForProvenance(input: {
    actions: MemoryAction[];
    currentRawPaths: Set<string>;
    currentEvictionRawPaths: Set<string>;
    overrideEvictionRawPaths: Set<string>;
  }): { actions: MemoryAction[]; exclusions: IngestReportFinalizationProvenanceExclusion[] } {
    const defensible = new Set([
      ...input.currentRawPaths,
      ...input.currentEvictionRawPaths,
      ...input.overrideEvictionRawPaths,
    ]);
    const actions: MemoryAction[] = [];
    const exclusions: IngestReportFinalizationProvenanceExclusion[] = [];
    for (const action of input.actions) {
      const rawPaths = action.rawPaths ?? [];
      if (rawPaths.length === 0) {
        exclusions.push({ action, reason: 'missing_raw_paths' });
        continue;
      }
      const invalidRawPaths = rawPaths.filter((rawPath) => !defensible.has(rawPath)).sort();
      if (invalidRawPaths.length > 0) {
        exclusions.push({ action, reason: 'raw_path_not_defensible', invalidRawPaths });
        continue;
      }
      actions.push(action);
    }
    return { actions, exclusions };
  }
```

Update `buildProvenancePlan()` input to accept:

```ts
    finalizationActions: MemoryAction[];
```

Then append finalization rows before artifact resolutions:

```ts
    input.finalizationActions.forEach((action, actionIndex) => {
      for (const rawPath of action.rawPaths ?? []) {
        pushActionProvenance(rawPath, action, {
          source: 'finalization_action',
          actionIndex,
          action,
        });
      }
    });
```

Before calling `buildProvenancePlan()`, partition finalization actions:

```ts
      const finalizationProvenance = this.partitionFinalizationActionsForProvenance({
        actions: finalizationActions,
        currentRawPaths: new Set(currentHashes.keys()),
        currentEvictionRawPaths: new Set(stageIndex.evictionsApplied.map((entry) => entry.rawPath)),
        overrideEvictionRawPaths: new Set(overrideReport?.body.evictionInputs ?? []),
      });
      if (finalizationOutcome) {
        finalizationOutcome.provenanceExclusions = finalizationProvenance.exclusions;
      }
      const provenancePlan = this.buildProvenancePlan({
        job,
        syncId,
        currentHashes,
        stageIndex,
        reconcileActions,
        finalizationActions: finalizationProvenance.actions,
      });
```

- [ ] **Step 3: Include finalization actions in memory flow**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, replace:

```ts
      const memoryFlowSavedActions = stageIndex.workUnits.flatMap((wu) => wu.actions).concat(reconcileActions);
```

with:

```ts
      const memoryFlowSavedActions = stageIndex.workUnits
        .flatMap((wu) => wu.actions)
        .concat(reconcileActions)
        .concat(finalizationActions);
```

Remove post-processor memory-count additions from the saved event.

- [ ] **Step 4: Run focused provenance tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.test.ts -t "finalization"
```

Expected: PASS.

### Task 5: Move historic-SQL projection into adapter finalization

**Files:**
- Modify: `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/projection.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.ts`

- [ ] **Step 1: Rename post-processor tests to projection tests**

Move durable behavior coverage from
`packages/context/src/ingest/adapters/historic-sql/post-processor.test.ts` to
`packages/context/src/ingest/adapters/historic-sql/projection.test.ts`.
The first test must call `projectHistoricSqlEvidence()` directly and assert:

```ts
expect(result.touchedSources).toEqual([{ connectionId: 'warehouse', sourceName: 'orders' }]);
expect(result.changedWikiPageKeys).toContain('historic-sql-revenue-pattern');
expect(result.actions).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ target: 'sl', key: 'orders', rawPaths: ['tables/public/orders.json'] }),
    expect.objectContaining({ target: 'wiki', key: 'historic-sql-revenue-pattern', rawPaths: ['patterns/revenue.json'] }),
  ]),
);
```

Add an override-safe no-op test:

```ts
  it('does not mark stale or archive pages when override replay has no current-run evidence', async () => {
    const result = await projectHistoricSqlEvidence({
      workdir,
      connectionId: 'warehouse',
      syncId: 'override-sync',
      runId: 'override-run',
      overrideReplay: {
        priorJobId: 'prior-job',
        priorRunId: 'prior-run',
        priorSyncId: 'prior-sync',
        evictionRawPaths: ['tables/public/orders.json'],
      },
    });

    expect(result.tableUsageMerged).toBe(0);
    expect(result.staleTablesMarked).toBe(0);
    expect(result.patternPagesWritten).toBe(0);
    expect(result.stalePatternPagesMarked).toBe(0);
    expect(result.archivedPatternPages).toBe(0);
    expect(result.touchedSources).toEqual([]);
    expect(result.changedWikiPageKeys).toEqual([]);
    expect(result.actions).toEqual([]);
  });
```

- [ ] **Step 2: Extend historic-SQL projection result metadata**

In `packages/context/src/ingest/adapters/historic-sql/projection.ts`, add
`overrideReplay`, `changedWikiPageKeys`, and `actions`:

```ts
import type { FinalizationOverrideReplay } from '../../types.js';
import type { MemoryAction } from '../../../memory/index.js';

export interface HistoricSqlProjectionInput {
  workdir: string;
  connectionId: string;
  syncId: string;
  runId: string;
  overrideReplay?: FinalizationOverrideReplay;
}

export interface HistoricSqlProjectionResult {
  tableUsageMerged: number;
  staleTablesMarked: number;
  patternPagesWritten: number;
  stalePatternPagesMarked: number;
  archivedPatternPages: number;
  touchedSources: Array<{ connectionId: string; sourceName: string }>;
  changedWikiPageKeys: string[];
  actions: MemoryAction[];
  warnings: string[];
}
```

Initialize the new fields:

```ts
    changedWikiPageKeys: [],
    actions: [],
```

After loading evidence, add the override-safe no-op guard:

```ts
  if (input.overrideReplay && evidence.length === 0) {
    result.warnings.push('historic-sql finalization skipped stale/archive cleanup during override replay without current-run evidence');
    return result;
  }
  if (evidence.length === 0) {
    result.warnings.push('historic-sql finalization skipped because no current-run evidence was emitted');
    return result;
  }
```

When table usage is merged, push a descriptive action:

```ts
          result.actions.push({
            target: 'sl',
            type: 'updated',
            key: sourceName,
            targetConnectionId: input.connectionId,
            detail: `Merged historic-SQL usage for ${matchingEvidence.table}`,
            rawPaths: [matchingEvidence.rawPath],
          });
```

When a table is marked stale without a defensible raw path, push an action
without `rawPaths`:

```ts
          result.actions.push({
            target: 'sl',
            type: 'updated',
            key: sourceName,
            targetConnectionId: input.connectionId,
            detail: `Marked historic-SQL usage stale for ${tableRef}`,
          });
```

When a pattern page is written, record the key and action:

```ts
    result.changedWikiPageKeys.push(key);
    result.actions.push({
      target: 'wiki',
      type: reusable ? 'updated' : 'created',
      key,
      detail: `Projected historic-SQL pattern ${pattern.pattern.title}`,
      rawPaths: [pattern.rawPath],
    });
```

When a pattern page is marked stale or archived, record the key and action
without raw paths:

```ts
      result.changedWikiPageKeys.push(page.key);
      result.actions.push({
        target: 'wiki',
        type: 'updated',
        key: page.key,
        detail: `Archived stale historic-SQL pattern page ${page.key}`,
      });
```

and:

```ts
    result.changedWikiPageKeys.push(page.key);
    result.actions.push({
      target: 'wiki',
      type: 'updated',
      key: page.key,
      detail: `Marked historic-SQL pattern page ${page.key} stale`,
    });
```

Deduplicate `changedWikiPageKeys` before returning:

```ts
  result.changedWikiPageKeys = [...new Set(result.changedWikiPageKeys)].sort();
  return result;
```

- [ ] **Step 3: Implement `HistoricSqlSourceAdapter.finalize()`**

In `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.ts`,
update the type import:

```ts
import type {
  ChunkResult,
  DeterministicFinalizationContext,
  DiffSet,
  FetchContext,
  FinalizationResult,
  ScopeDescriptor,
  SourceAdapter,
} from '../../types.js';
```

Import the projector:

```ts
import { projectHistoricSqlEvidence } from './projection.js';
```

Add this method to the class:

```ts
  async finalize(ctx: DeterministicFinalizationContext): Promise<FinalizationResult> {
    const projection = await projectHistoricSqlEvidence({
      workdir: ctx.workdir,
      connectionId: ctx.connectionId,
      syncId: ctx.syncId,
      runId: ctx.runId,
      overrideReplay: ctx.overrideReplay,
    });
    return {
      result: projection,
      warnings: projection.warnings,
      errors: [],
      touchedSources: projection.touchedSources,
      changedWikiPageKeys: projection.changedWikiPageKeys,
      actions: projection.actions,
    };
  }
```

- [ ] **Step 4: Run historic-SQL projection tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/projection.test.ts src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts
```

Expected: PASS.

### Task 6: Remove post-processor infrastructure

**Files:**
- Delete: `packages/context/src/ingest/adapters/historic-sql/post-processor.ts`
- Delete: `packages/context/src/ingest/adapters/historic-sql/post-processor.test.ts`
- Modify: `packages/context/src/ingest/ports.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Modify: `packages/context/src/ingest/index.ts`
- Modify: `packages/context/src/package-exports.test.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.test.ts`
- Modify: `packages/cli/src/ingest.test.ts`
- Modify: `packages/cli/src/setup.ts`

- [ ] **Step 1: Remove port and dependency types**

Delete these interfaces from `packages/context/src/ingest/ports.ts`:

```ts
export interface IngestBundlePostProcessorInput {
  connectionId: string;
  sourceKey: string;
  syncId: string;
  jobId: string;
  runId: string;
  workdir: string;
  parseArtifacts: unknown;
}

export interface IngestBundlePostProcessorResult {
  result?: unknown;
  warnings: string[];
  errors: string[];
  touchedSources: TouchedSlSource[];
}

export interface IngestBundlePostProcessorPort {
  run(input: IngestBundlePostProcessorInput): Promise<IngestBundlePostProcessorResult>;
}
```

Delete this field from `IngestBundleRunnerDeps`:

```ts
  postProcessors?: Record<string, IngestBundlePostProcessorPort>;
```

- [ ] **Step 2: Remove local runtime wiring**

In `packages/context/src/ingest/local-bundle-runtime.ts`, delete:

```ts
import { HistoricSqlProjectionPostProcessor } from './adapters/historic-sql/post-processor.js';
```

and delete the dependency object field:

```ts
    postProcessors: {
      'historic-sql': new HistoricSqlProjectionPostProcessor(),
    },
```

- [ ] **Step 3: Remove exports and package-export assertions**

In `packages/context/src/ingest/index.ts`, delete:

```ts
export { HistoricSqlProjectionPostProcessor } from './adapters/historic-sql/post-processor.js';
```

In `packages/context/src/package-exports.test.ts`, delete:

```ts
    expect(ingest.HistoricSqlProjectionPostProcessor).toBeTypeOf('function');
```

- [ ] **Step 4: Delete post-processor files**

Delete:

```bash
rm packages/context/src/ingest/adapters/historic-sql/post-processor.ts
rm packages/context/src/ingest/adapters/historic-sql/post-processor.test.ts
```

- [ ] **Step 5: Replace test assertions using `postProcessor`**

Search:

```bash
rg -n "postProcessor|post_processor|postProcessors|HistoricSqlProjectionPostProcessor|IngestBundlePostProcessor" packages/context/src packages/cli/src
```

Expected remaining matches: none in production code, exports, report schemas,
or tests. Historical matches in `docs/superpowers/plans/` do not need changes.

For CLI tests that used a `postProcessor` report fixture, replace the fixture
with:

```ts
finalization: {
  sourceKey: 'historic-sql',
  status: 'success',
  commitSha: 'finalization-sha',
  touchedPaths: ['semantic-layer/c1/_schema/public.yaml', 'wiki/global/historic-sql-orders.md'],
  declaredTouchedSources: [{ connectionId: 'c1', sourceName: 'orders' }],
  derivedTouchedSources: [{ connectionId: 'c1', sourceName: 'orders' }],
  declaredChangedWikiPageKeys: ['historic-sql-orders'],
  derivedChangedWikiPageKeys: ['historic-sql-orders'],
  mismatches: [],
  errors: [],
  warnings: [],
  actions: [
    { target: 'sl', type: 'updated', key: 'orders', detail: 'Merged usage', targetConnectionId: 'c1', rawPaths: ['tables/public/orders.json'] },
    { target: 'wiki', type: 'created', key: 'historic-sql-orders', detail: 'Projected pattern', rawPaths: ['patterns/orders.json'] },
  ],
  provenanceExclusions: [],
}
```

- [ ] **Step 6: Run the removal checks**

Run:

```bash
rg -n "postProcessor|post_processor|postProcessors|HistoricSqlProjectionPostProcessor|IngestBundlePostProcessor" packages/context/src packages/cli/src
pnpm --filter @ktx/context exec vitest run src/package-exports.test.ts src/ingest/ingest-bundle.runner.test.ts src/ingest/report-snapshot.test.ts
```

Expected: `rg` returns no matches, and Vitest passes.

### Task 7: Full verification

**Files:**
- No source changes beyond prior tasks.

- [ ] **Step 1: Run focused context tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/finalization-scope.test.ts \
  src/ingest/report-snapshot.test.ts \
  src/ingest/ingest-bundle.runner.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  src/ingest/adapters/historic-sql/projection.test.ts \
  src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts \
  src/package-exports.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Run package tests**

Run:

```bash
pnpm --filter @ktx/context run test
```

Expected: PASS.

- [ ] **Step 4: Run dead-code check**

Run:

```bash
pnpm run dead-code
```

Expected: PASS. If Knip reports only historical Markdown references to removed
post-processor names, leave those Markdown references alone.

- [ ] **Step 5: Run pre-commit on changed TypeScript and Markdown files**

Run:

```bash
uv run pre-commit run --files \
  packages/context/src/ingest/types.ts \
  packages/context/src/ingest/reports.ts \
  packages/context/src/ingest/report-snapshot.ts \
  packages/context/src/ingest/finalization-scope.ts \
  packages/context/src/ingest/finalization-scope.test.ts \
  packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/ingest-bundle.runner.test.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  packages/context/src/ingest/adapters/historic-sql/projection.ts \
  packages/context/src/ingest/adapters/historic-sql/projection.test.ts \
  packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.ts \
  packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts \
  packages/context/src/ingest/local-bundle-runtime.ts \
  packages/context/src/ingest/ports.ts \
  packages/context/src/ingest/index.ts \
  packages/context/src/package-exports.test.ts \
  docs/superpowers/plans/2026-05-18-adapter-owned-finalization-v1.md
```

Expected: PASS. If pre-commit is unavailable because the local `uv` version is
older than the project pin, report the mismatch and keep the focused pnpm
checks as verification evidence.

## Documentation decision

No `docs-site/content/docs/` update is required for this plan. The change
removes an internal runner extension point and changes ingest report internals,
but it does not add or rename a public CLI command, flag, configuration key,
connector setup flow, or user-facing workflow.
