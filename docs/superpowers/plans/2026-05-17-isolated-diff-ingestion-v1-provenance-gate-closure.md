# Isolated Diff Ingestion V1 Provenance Gate Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure invalid provenance raw paths are rejected before isolated-diff
ingestion squashes any integration worktree changes into the main project
worktree.

**Architecture:** Keep provenance insertion after squash, but derive and
validate the planned provenance rows immediately after final artifact gates and
before the squash stage. This makes provenance validation part of the final
pre-main safety boundary while preserving the existing report and database
write shape.

**Tech Stack:** TypeScript ESM/NodeNext, Vitest, existing
`IngestBundleRunner`, `validateProvenanceRawPaths`, ingest reports, and
persistent ingest traces.

---

## Audit Summary

The implemented isolated-diff path now covers the core v1 safety surface:
child worktrees, binary no-rename patches, `git apply --3way --index`, patch
policy rejection, final wiki and semantic-layer gates after reconciliation and
post-processing, failure reports, and persistent JSONL traces. The focused
isolated-diff test suite passes:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/ingest-trace.test.ts \
  src/ingest/wiki-body-refs.test.ts \
  src/ingest/artifact-gates.test.ts \
  src/ingest/isolated-diff/git-patch.test.ts \
  src/ingest/isolated-diff/work-unit-executor.test.ts \
  src/ingest/isolated-diff/patch-integrator.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts
```

Current result: `7 passed`, `28 passed`.

One v1-blocking gap remains. `validateProvenanceRawPaths()` is called in
`packages/context/src/ingest/ingest-bundle.runner.ts` after
`squashMergeIntoMain()`. A work unit or reconciliation action can emit an
otherwise valid wiki or semantic-layer artifact whose `rawPaths` contain a path
outside the current raw snapshot and eviction set. Today the run fails during
provenance recording, but only after the invalidly-attributed artifacts have
already reached the main project worktree. That violates the spec requirement
that final global gates run before any changes reach main.

Observability for the already-implemented phases is sufficient for postmortem
reconstruction: traces include input snapshots, routing, child worktree
creation and cleanup, patch collection and application, conflict
classification, reconciliation, final gates, failure reports, and run outcome.
This plan adds only the missing provenance validation failure trace because it
corresponds to a concrete pre-main failure mode, not cosmetic trace expansion.

Non-blocking gaps that remain after this plan:

- Migrating Notion, LookML, Looker, dbt, MetricFlow, and historic-SQL direct
  durable writes to the isolated path.
- Promoting isolated diffs as the default for all connectors.
- Removing the old shared-worktree WorkUnit execution path.
- Interactive, CLI, or agent-driven conflict resolution.
- Auto-merging semantic conflicts that cannot be proven correct.
- Transitive SQL-projection dependency expansion beyond direct declared joins.
- Moving provenance rows to worktree files.
- Adding failure reports for failures that happen before an ingest run row
  exists. The trace file is still written at the deterministic job path.

## File Structure

- Modify `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`.
  Add a regression proving invalid provenance raw paths fail before squash,
  leave main unchanged, skip SQLite provenance insertion, and emit a
  postmortem-grade trace event.
- Modify `packages/context/src/ingest/ingest-bundle.runner.ts`.
  Extract provenance row construction into private helpers, run provenance
  raw-path validation before squash, trace validation success and failure, and
  reuse the prevalidated rows for insertion and reports after squash.

---

### Task 1: Add the pre-squash provenance regression

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`

- [ ] **Step 1: Write the failing runner test**

Append this test inside the existing
`describe('IngestBundleRunner isolated diff path', ...)` block in
`packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`:

```ts
  it('rejects invalid provenance raw paths before squash reaches main', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'card-valid-artifacts', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] }],
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
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-invalid-provenance/trace.jsonl'), 'utf-8');
      expect(trace).toContain('final_artifact_gates_finished');
      expect(trace).toContain('provenance_rows_validation_failed');
      expect(trace).toContain('cards/missing.json');
      expect(trace).toContain('ingest_failed');
      expect(trace).not.toContain('squash_finished');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the failing regression**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts -t "invalid provenance raw paths"
```

Expected: FAIL because the current runner validates provenance after
`squashMergeIntoMain()`, so `runtime.git.revParseHead()` changes and the trace
does not contain `provenance_rows_validation_failed`.

### Task 2: Move provenance validation into the pre-squash gate boundary

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`

- [ ] **Step 1: Import the provenance report and insert types**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, update the imports.

Replace this import block:

```ts
import type {
  ContextEvidenceIndexSummary,
  IngestBundleRunnerDeps,
  IngestProvenanceRow,
  IngestRunsPort,
  IngestSessionWorktree,
  PageTriageRunResult,
} from './ports.js';
```

With:

```ts
import type {
  ContextEvidenceIndexSummary,
  IngestBundleRunnerDeps,
  IngestProvenanceInsert,
  IngestProvenanceRow,
  IngestRunsPort,
  IngestSessionWorktree,
  PageTriageRunResult,
} from './ports.js';
```

Replace this import block:

```ts
import {
  buildStageIndexFromReportBody,
  postProcessorSavedMemoryCounts,
  type IngestReportPostProcessorOutcome,
  type IngestReportSnapshot,
} from './reports.js';
```

With:

```ts
import {
  buildStageIndexFromReportBody,
  postProcessorSavedMemoryCounts,
  type IngestReportPostProcessorOutcome,
  type IngestReportProvenanceDetail,
  type IngestReportSnapshot,
} from './reports.js';
```

- [ ] **Step 2: Add provenance row helpers**

Add these private methods after `private errorMessage(error: unknown): string`
in `packages/context/src/ingest/ingest-bundle.runner.ts`:

```ts
  private buildProvenanceRows(input: {
    job: IngestBundleJob;
    syncId: string;
    currentHashes: Map<string, string>;
    stageIndex: StageIndex;
    reconcileActions: MemoryAction[];
    eviction?: EvictionUnit;
  }): IngestProvenanceInsert[] {
    const provenanceRows: IngestProvenanceInsert[] = [];
    const actionToType = (action: MemoryAction): IngestProvenanceInsert['actionType'] => {
      if (action.target === 'wiki') {
        return 'wiki_written';
      }
      return action.type === 'created' ? 'source_created' : 'measure_added';
    };
    const producedPaths = new Set<string>();
    const pushActionProvenance = (rawPath: string, action: MemoryAction): void => {
      const hash = input.currentHashes.get(rawPath) ?? '';
      provenanceRows.push({
        connectionId: input.job.connectionId,
        sourceKey: input.job.sourceKey,
        syncId: input.syncId,
        rawPath,
        rawContentHash: hash,
        artifactKind: action.target,
        artifactKey: action.key,
        targetConnectionId: action.target === 'sl' ? actionTargetConnectionId(action, input.job.connectionId) : null,
        artifactContentHash: null,
        actionType: actionToType(action),
      });
      producedPaths.add(rawPath);
    };

    for (const wu of input.stageIndex.workUnits) {
      for (const action of wu.actions) {
        for (const rawPath of rawPathsForAction(action, wu.rawFiles)) {
          pushActionProvenance(rawPath, action);
        }
      }
    }
    for (const action of input.reconcileActions) {
      for (const rawPath of action.rawPaths ?? []) {
        pushActionProvenance(rawPath, action);
      }
    }
    for (const resolution of input.stageIndex.artifactResolutions ?? []) {
      const hash = input.currentHashes.get(resolution.rawPath) ?? '';
      provenanceRows.push({
        connectionId: input.job.connectionId,
        sourceKey: input.job.sourceKey,
        syncId: input.syncId,
        rawPath: resolution.rawPath,
        rawContentHash: hash,
        artifactKind: resolution.artifactKind,
        artifactKey: resolution.artifactKey,
        targetConnectionId: null,
        artifactContentHash: null,
        actionType: resolution.actionType,
      });
      producedPaths.add(resolution.rawPath);
    }
    for (const [rawPath, hash] of input.currentHashes) {
      if (producedPaths.has(rawPath)) {
        continue;
      }
      provenanceRows.push({
        connectionId: input.job.connectionId,
        sourceKey: input.job.sourceKey,
        syncId: input.syncId,
        rawPath,
        rawContentHash: hash,
        artifactKind: null,
        artifactKey: null,
        targetConnectionId: null,
        artifactContentHash: null,
        actionType: 'skipped',
      });
    }

    return provenanceRows;
  }

  private toReportProvenanceRows(rows: IngestProvenanceInsert[]): IngestReportProvenanceDetail[] {
    return rows.map(({ rawPath, artifactKind, artifactKey, actionType, targetConnectionId }) => ({
      rawPath,
      artifactKind,
      artifactKey,
      targetConnectionId: targetConnectionId ?? null,
      actionType,
    }));
  }
```

- [ ] **Step 3: Validate planned provenance rows before squash**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, find the code that
sets `activePhase = 'final_gates';` and runs `traceTimed(...,
'final_artifact_gates', ...)`. Immediately after that `await traceTimed(...)`
block and before the `// Stage 6 — squash commit` comment, insert:

```ts
      activePhase = 'provenance_validation';
      const provenanceRows = this.buildProvenanceRows({
        job,
        syncId,
        currentHashes,
        stageIndex,
        reconcileActions,
        eviction,
      });
      await traceTimed(
        runTrace,
        'provenance',
        'provenance_rows_validation',
        {
          rowCount: provenanceRows.length,
          currentRawPathCount: currentHashes.size,
          deletedRawPathCount: eviction?.deletedRawPaths.length ?? 0,
        },
        async () => {
          validateProvenanceRawPaths({
            rows: provenanceRows,
            currentRawPaths: new Set(currentHashes.keys()),
            deletedRawPaths: new Set(eviction?.deletedRawPaths ?? []),
          });
        },
      );
      const reportProvenanceRows = this.toReportProvenanceRows(provenanceRows);
```

- [ ] **Step 4: Replace the post-squash provenance construction block**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, in the
`activePhase = 'provenance';` section after squash, delete the current block
that starts with:

```ts
      // Provenance rows: per-artifact when the WU emitted actions, plus a `skipped`
      // fallback for raw files that produced nothing so the next DiffSet still sees
      // them.
      const provenanceRows: Parameters<typeof this.deps.provenance.insertMany>[0] = [];
```

And ends with:

```ts
      await runTrace.event('debug', 'provenance', 'provenance_rows_validated', {
        rowCount: provenanceRows.length,
      });
```

Do not delete the existing call to `await this.deps.provenance.insertMany(provenanceRows);`.
Immediately after that insertion call, add:

```ts
      await runTrace.event('debug', 'provenance', 'provenance_rows_inserted', {
        rowCount: provenanceRows.length,
      });
```

Then delete the later `const reportProvenanceRows = provenanceRows.map(...)`
block because `reportProvenanceRows` is now created before squash from the
prevalidated rows.

- [ ] **Step 5: Run the provenance regression**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts -t "invalid provenance raw paths"
```

Expected: PASS. The trace contains `provenance_rows_validation_failed`, main
HEAD remains unchanged, and `provenance.insertMany` is not called.

- [ ] **Step 6: Run the focused isolated-diff suite**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/ingest-trace.test.ts \
  src/ingest/wiki-body-refs.test.ts \
  src/ingest/artifact-gates.test.ts \
  src/ingest/isolated-diff/git-patch.test.ts \
  src/ingest/isolated-diff/work-unit-executor.test.ts \
  src/ingest/isolated-diff/patch-integrator.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts
```

Expected: PASS.

### Task 3: Type-check, dead-code check, and commit

**Files:**
- Verify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Verify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`

- [ ] **Step 1: Run the context package type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 2: Run the workspace dead-code check**

Run:

```bash
pnpm run dead-code
```

Expected: PASS, or only existing unrelated Knip/Biome findings. Investigate
any new findings in the two modified files before continuing.

- [ ] **Step 3: Commit the provenance gate closure**

Run:

```bash
git add packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts
git commit -m "fix(ingest): gate provenance before isolated diff squash"
```

Expected: one commit containing only the runner and isolated-diff runner test
changes.

## Self-Review

Spec coverage: this plan closes the remaining violation of the design's final
global gate invariant by proving invalid provenance raw paths fail before
squash and by moving provenance validation into the pre-main gate boundary.

Placeholder scan: no placeholder steps remain. Every implementation step names
the exact files, code, commands, and expected results.

Type consistency: the plan uses existing `IngestProvenanceInsert`,
`IngestReportProvenanceDetail`, `MemoryAction`, `EvictionUnit`, `StageIndex`,
`rawPathsForAction()`, and `validateProvenanceRawPaths()` names.
