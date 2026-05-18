# Isolated Diff Ingestion V1 Shared Worktree Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the old shared-worktree WorkUnit execution path so every
non-override bundle ingest uses isolated WorkUnit diffs.

**Architecture:** Keep `IngestBundleRunner` with one non-override execution
path: raw snapshot, optional deterministic projection, child WorkUnit
worktrees, patch integration, reconciliation, final gates, provenance
validation, and squash. Delete the private fallback routing setting and all
legacy tests, traces, and agent instructions that existed only for shared
WorkUnit state.

**Tech Stack:** TypeScript, Vitest, pnpm, KTX ingest runner, Git worktrees.

---

## Audit summary

This audit read the original design in
`docs/superpowers/specs/2026-05-17-isolated-diff-ingestion-design.md`, every
implemented plan matching
`docs/superpowers/plans/2026-05-17-isolated-diff-ingestion-*.md` and
`docs/superpowers/plans/2026-05-18-isolated-diff-ingestion-*.md`, and the
current implementation under `packages/context/src/ingest/`,
`packages/context/prompts/`, and `packages/context/skills/`.

Implemented v1 rollout coverage:

- Rollout steps 1 and 2 exist in code: isolated child worktrees, binary
  no-rename patch collection, and `git apply --3way --index` patch integration.
- Rollout step 3 exists in code:
  `packages/context/src/ingest/isolated-diff/textual-conflict-resolver.ts` is
  wired through the patch integrator and runner.
- Rollout steps 4, 5, and 6 exist in code: final wiki and semantic-layer gates,
  provenance validation before squash, target policy checks, bounded gate
  repair, failed reports, and trace counters.
- Rollout step 7 exists in code: the Metabase stale body-reference regression
  is covered in `ingest-bundle.runner.isolated-diff.test.ts`.
- Rollout step 8 is committed: Notion, LookML, Looker, dbt, and MetricFlow
  route through isolated child worktrees, and MetricFlow projection runs before
  WorkUnits.
- Rollout step 10 is committed: non-override ingests default to isolated diffs,
  and the old branch is reachable only through the private
  `sharedWorktreeSourceKeys` fallback setting.

## Remaining gaps

The remaining v1-blocking gaps are all part of rollout step 11:

- `packages/context/src/ingest/ports.ts` still exposes the private
  `sharedWorktreeSourceKeys?: string[]` setting.
- `packages/context/src/ingest/isolated-diff/source-routing.ts` and its test
  exist only to support the fallback setting.
- `packages/context/src/ingest/local-bundle-runtime.ts` still installs
  `sharedWorktreeSourceKeys: []`.
- `packages/context/src/ingest/ingest-bundle.runner.ts` still checks
  `isSharedWorktreeFallbackEnabled()` and contains the
  `shared_worktree_path_enabled` branch that runs WorkUnits against the mutable
  integration worktree.
- `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`
  still has a regression proving the shared-worktree fallback is reachable.
- `packages/context/src/ingest/ingest-bundle.runner.test.ts` keeps broad runner
  tests on the legacy path through `sharedWorktreeSourceKeys`; those tests must
  either use the isolated mock harness or move coverage into the real-git
  isolated suite.
- `packages/context/prompts/memory_agent_bundle_ingest_work_unit.md` and
  `packages/context/skills/ingest_triage/SKILL.md` still tell WorkUnit agents
  that prior WorkUnit writes in the same job are visible in the current working
  branch. That instruction is false after isolated diffs and must be removed
  with the shared path.

Non-blocking gaps after this plan:

- Rollout step 9 deterministic semantic merge helpers remain intentionally
  deferred until resolver metrics show frequent mechanical repairs.
- Semantic-layer dependency expansion remains direct declared joins only; the
  spec explicitly defers transitive SQL-projection closure.
- Provenance remains in the ingest provenance store and report body; moving it
  to worktree files is a separate schema migration.
- Resolver context can later include richer transcript excerpts and explicit
  overlap summaries for every previously applied patch.
- Failures before an ingest run row exists still have deterministic trace files
  but no stored ingest report.

## File structure

- Modify `packages/context/src/ingest/ports.ts`. Remove the private fallback
  setting from `IngestSettingsPort`.
- Modify `packages/context/src/ingest/local-bundle-runtime.ts`. Stop importing
  and installing default shared-worktree fallback settings.
- Delete `packages/context/src/ingest/isolated-diff/source-routing.ts`. This
  helper has no responsibility once fallback routing is removed.
- Delete `packages/context/src/ingest/isolated-diff/source-routing.test.ts`.
  Its assertions exist only for the fallback helper.
- Modify `packages/context/src/ingest/ingest-bundle.runner.ts`. Delete
  `isSharedWorktreeFallbackEnabled()`, the old shared-worktree WorkUnit branch,
  and helper methods that only served that branch.
- Modify `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`.
  Remove fallback reachability coverage and add a stale-setting regression that
  proves a runtime object cannot opt out of isolated diffs.
- Modify `packages/context/src/ingest/ingest-bundle.runner.test.ts`. Remove
  the fallback setting from the broad test harness and make its mocked Git
  session support no-op isolated patch collection.
- Modify `packages/context/src/ingest/local-bundle-runtime.test.ts`. Assert
  local runtime settings do not contain the fallback key.
- Modify `packages/context/prompts/memory_agent_bundle_ingest_work_unit.md`.
  Replace shared-branch WorkUnit visibility instructions with isolated-diff
  instructions.
- Modify `packages/context/skills/ingest_triage/SKILL.md`. Remove Stage 3
  prior-WorkUnit visibility language and keep cross-WorkUnit sweep guidance in
  Stage 4 reconciliation.

---

### Task 1: Add removal-contract regressions

**Files:**
- Modify: `packages/context/src/ingest/local-bundle-runtime.test.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`

- [ ] **Step 1: Update the local runtime settings type**

In `packages/context/src/ingest/local-bundle-runtime.test.ts`, replace
`RuntimeWithSettingsDeps` with:

```ts
type RuntimeWithSettingsDeps = {
  deps: {
    settings: Record<string, unknown>;
  };
};
```

- [ ] **Step 2: Replace the local runtime fallback-setting assertion**

In `packages/context/src/ingest/local-bundle-runtime.test.ts`, replace the test
named `defaults local bundle ingest to isolated diffs without an allowlist` with:

```ts
  it('defaults local bundle ingest to isolated diffs without a shared-worktree fallback setting', () => {
    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      agentRunner: testAgentRunner(),
    });

    const settings = (runtime.runner as unknown as RuntimeWithSettingsDeps).deps.settings;

    expect(settings).not.toHaveProperty('sharedWorktreeSourceKeys');
    expect(Object.keys(settings).sort()).toEqual([
      'ingestTraceLevel',
      'memoryIngestionModel',
      'probeRowCount',
      'workUnitFailureMode',
      'workUnitMaxConcurrency',
      'workUnitStepBudget',
    ]);
  });
```

- [ ] **Step 3: Remove the source-routing import from the isolated runner test**

In `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`,
delete this import:

```ts
import { defaultSharedWorktreeSourceKeys } from './isolated-diff/source-routing.js';
```

Then remove the `sharedWorktreeSourceKeys` line from the `settings` object in
`makeDeps()`:

```ts
    settings: {
      memoryIngestionModel: 'test',
      probeRowCount: 1,
      ingestTraceLevel: 'trace',
      ...settings,
    },
```

- [ ] **Step 4: Replace the shared fallback reachability test**

In `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`,
replace the test named
`keeps the shared-worktree path reachable through explicit private fallback settings`
with this stale-setting regression:

```ts
  it('does not support shared-worktree fallback settings', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const sourceKey = 'legacy-source';
      const staleSettings = {
        sharedWorktreeSourceKeys: ['legacy-source'],
      } as Partial<IngestBundleRunnerDeps['settings']> & Record<string, unknown>;
      const { deps, adapter } = makeDeps(runtime, sourceKey, staleSettings);
      adapter.chunk.mockResolvedValue({
        workUnits: [
          {
            unitKey: 'legacy-wiki',
            rawFiles: ['legacy/page.json'],
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
        if (params.telemetryTags.operationName !== 'ingest-bundle-wu') {
          return { stopReason: 'natural' };
        }
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(
          join(root, 'wiki/global/legacy-isolated.md'),
          '---\nsummary: Legacy isolated write\nusage_mode: auto\n---\n\nLegacy isolated write.\n',
          'utf-8',
        );
        currentSession.actions.push({
          target: 'wiki',
          type: 'created',
          key: 'legacy-isolated',
          detail: 'Legacy isolated write',
          rawPaths: ['legacy/page.json'],
        });
        await currentSession.gitService.commitFiles(
          ['wiki/global/legacy-isolated.md'],
          'legacy isolated wiki',
          'KTX Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['legacy/page.json', 'h1']], sourceKey);

      await expect(
        runner.run({
          jobId: 'job-legacy-isolated',
          connectionId: 'warehouse',
          sourceKey,
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).resolves.toMatchObject({
        jobId: 'job-legacy-isolated',
        failedWorkUnits: [],
        workUnitCount: 1,
      });

      const trace = await readFile(
        join(runtime.configDir, '.ktx/ingest-traces/job-legacy-isolated/trace.jsonl'),
        'utf-8',
      );
      expect(trace).toContain('isolated_diff_enabled');
      expect(trace).toContain('work_unit_child_created');
      expect(trace).not.toContain('shared_worktree_path_enabled');

      const reportCreate = vi.mocked(deps.reports.create).mock.calls.at(-1)?.[0];
      const reportBody = reportCreate?.body as { isolatedDiff?: unknown } | undefined;
      expect(reportBody?.isolatedDiff).toMatchObject({
        enabled: true,
        acceptedPatches: 1,
      });
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 5: Run the removal regressions and confirm they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/local-bundle-runtime.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  -t "shared-worktree fallback|stale|defaults local bundle ingest|unlisted direct-writing source"
```

Expected: FAIL. The local runtime still exposes `sharedWorktreeSourceKeys`, and
the stale-setting runner test still reaches `shared_worktree_path_enabled`.

---

### Task 2: Remove the fallback setting and routing module

**Files:**
- Modify: `packages/context/src/ingest/ports.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Delete: `packages/context/src/ingest/isolated-diff/source-routing.ts`
- Delete: `packages/context/src/ingest/isolated-diff/source-routing.test.ts`

- [ ] **Step 1: Remove the fallback setting from the runner settings port**

In `packages/context/src/ingest/ports.ts`, replace `IngestSettingsPort` with:

```ts
export interface IngestSettingsPort {
  memoryIngestionModel: string;
  probeRowCount: number;
  workUnitMaxConcurrency?: number;
  workUnitStepBudget?: number;
  workUnitFailureMode?: 'abort' | 'continue';
  ingestTraceLevel?: IngestTraceLevel;
}
```

- [ ] **Step 2: Remove the local runtime source-routing import**

In `packages/context/src/ingest/local-bundle-runtime.ts`, delete this import:

```ts
import { defaultSharedWorktreeSourceKeys } from './isolated-diff/source-routing.js';
```

- [ ] **Step 3: Remove the local runtime fallback setting**

In `packages/context/src/ingest/local-bundle-runtime.ts`, replace the settings
object with:

```ts
    settings: {
      memoryIngestionModel: options.project.config.llm.models.default ?? 'local-ingest-model',
      probeRowCount: 0,
      workUnitMaxConcurrency: options.project.config.ingest.workUnits.maxConcurrency,
      workUnitStepBudget: options.project.config.ingest.workUnits.stepBudget,
      workUnitFailureMode: options.project.config.ingest.workUnits.failureMode,
      ingestTraceLevel: ingestTraceLevelFromEnv(),
    },
```

- [ ] **Step 4: Delete the fallback routing helper files**

Delete:

```bash
git rm packages/context/src/ingest/isolated-diff/source-routing.ts
git rm packages/context/src/ingest/isolated-diff/source-routing.test.ts
```

- [ ] **Step 5: Confirm no fallback helper imports remain**

Run:

```bash
rg -n "defaultSharedWorktreeSourceKeys|isSharedWorktreeFallbackSourceKey|source-routing" packages/context/src
```

Expected: FAIL with no matches. `rg` exits with status 1 when the cleanup is
complete.

---

### Task 3: Delete the shared-worktree runner branch

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`

- [ ] **Step 1: Remove helper methods used only by the shared branch**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, delete these private
methods:

```ts
  private buildFailedWorkUnitOutcome(wu: WorkUnit, error: unknown): WorkUnitOutcome {
    return {
      unitKey: wu.unitKey,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      preSha: '',
      postSha: '',
      actions: [],
      touchedSlSources: [],
      slDisallowed: wu.slDisallowed,
      slDisallowedReason: wu.slDisallowedReason,
    };
  }

  private formatWorkUnitFailure(outcome: WorkUnitOutcome): string {
    return `WorkUnit ${outcome.unitKey} failed: ${outcome.reason ?? 'unknown failure'}`;
  }

  private isSharedWorktreeFallbackEnabled(sourceKey: string): boolean {
    return (this.deps.settings.sharedWorktreeSourceKeys ?? []).includes(sourceKey);
  }
```

- [ ] **Step 2: Make non-override isolated routing unconditional**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, replace:

```ts
      const isolatedDiffEnabled = !overrideReport && !this.isSharedWorktreeFallbackEnabled(job.sourceKey);
```

with:

```ts
      const isolatedDiffEnabled = !overrideReport;
```

Then replace:

```ts
      if (!overrideReport && isolatedDiffEnabled) {
```

with:

```ts
      if (!overrideReport) {
```

- [ ] **Step 3: Delete the old shared-worktree branch**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, delete the whole
branch that starts with:

```ts
      } else if (!overrideReport) {
        await runTrace.event('info', 'routing', 'shared_worktree_path_enabled', {
          sourceKey: job.sourceKey,
          reason: 'explicit_private_fallback',
        });
```

and ends with:

```ts
        latestReportWorkUnits = this.toReportWorkUnits(stageIndex);
      }
```

After the deletion, the surrounding code must read:

```ts
        }

      }
      const carryForwardResult =
        contextReport && this.deps.contextCandidateCarryforward
          ? await this.deps.contextCandidateCarryforward.carryForward({
              runId: runRow.id,
              connectionId: job.connectionId,
              sourceKey: job.sourceKey,
            })
          : null;
```

- [ ] **Step 4: Confirm the branch trace event is gone**

Run:

```bash
rg -n "shared_worktree_path_enabled|explicit_private_fallback|isSharedWorktreeFallbackEnabled|sharedWorktreeSourceKeys" packages/context/src/ingest/ingest-bundle.runner.ts
```

Expected: FAIL with no matches.

---

### Task 4: Update runner tests for isolated-only execution

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.test.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`

- [ ] **Step 1: Remove the fallback setting from the broad runner test harness**

In `packages/context/src/ingest/ingest-bundle.runner.test.ts`, replace the
`settings` block in `buildRunner()` with:

```ts
    settings: {
      probeRowCount: 1,
      memoryIngestionModel: 'test-model',
    },
```

- [ ] **Step 2: Add no-op isolated patch support to the broad mock Git**

In `packages/context/src/ingest/ingest-bundle.runner.test.ts`, replace the
`scopedGit` object in `makeDeps()` with:

```ts
  const scopedGit = {
    revParseHead: vi.fn().mockResolvedValue('h'),
    commitFiles: vi.fn().mockResolvedValue({ created: true, commitHash: 'h' }),
    commitStaged: vi.fn().mockResolvedValue({ created: false, commitHash: 'h' }),
    resetHardTo: vi.fn(),
    assertWorktreeClean: vi.fn().mockResolvedValue(undefined),
    writeBinaryNoRenamePatch: vi.fn(async (_base: string, _head: string, patchPath: string) => {
      await writeFile(patchPath, '', 'utf-8');
    }),
    applyPatchFile3WayIndex: vi.fn(),
    diffNameStatus: vi.fn().mockResolvedValue([]),
  };
```

- [ ] **Step 3: Update the custom sequencer test Git mock**

In the test named
`refuses to squash-merge when the session worktree has an in-progress sequencer op`,
replace the `sessionGit` object with:

```ts
    const sessionGit = {
      revParseHead: vi.fn().mockResolvedValue('h'),
      commitFiles: vi.fn().mockResolvedValue({ created: true, commitHash: 'h' }),
      commitStaged: vi.fn().mockResolvedValue({ created: false, commitHash: 'h' }),
      resetHardTo: vi.fn(),
      assertWorktreeClean: vi.fn().mockRejectedValue(assertError),
      writeBinaryNoRenamePatch: vi.fn(async (_base: string, _head: string, patchPath: string) => {
        await writeFile(patchPath, '', 'utf-8');
      }),
      applyPatchFile3WayIndex: vi.fn(),
      diffNameStatus: vi.fn().mockResolvedValue([]),
    };
```

- [ ] **Step 4: Move the failed-WorkUnit integration regression to the isolated suite**

In `packages/context/src/ingest/ingest-bundle.runner.test.ts`, delete the test
named `squash-merges only successful WUs into main when one WU fails sl_validate`.

In `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`,
add this test near the other real-git isolated runner regressions:

```ts
  it('does not integrate failed isolated WorkUnit patches', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime, 'fake');
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'wu-good', rawFiles: ['good.raw'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'wu-bad', rawFiles: ['bad.raw'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      deps.diffSetService.compute = vi.fn().mockResolvedValue({
        added: ['good.raw', 'bad.raw'],
        modified: [],
        deleted: [],
        unchanged: [],
      });
      deps.slValidator.validateSingleSource = vi.fn(
        async (_validationDeps: unknown, _connectionId: string, sourceName: string) => ({
          errors: sourceName === 'bad' ? [{ message: 'bad source rejected' }] : [],
          warnings: [],
        }),
      ) as never;

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags.operationName !== 'ingest-bundle-wu') {
          return { stopReason: 'natural' };
        }
        const unitKey = params.telemetryTags.unitKey;
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
        if (unitKey === 'wu-good') {
          await writeFile(join(root, 'semantic-layer/warehouse/good.yaml'), 'name: good\n', 'utf-8');
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'good');
          currentSession.actions.push({
            target: 'sl',
            type: 'created',
            key: 'good',
            detail: 'good source',
            targetConnectionId: 'warehouse',
            rawPaths: ['good.raw'],
          });
          await currentSession.gitService.commitFiles(
            ['semantic-layer/warehouse/good.yaml'],
            'test: add good source',
            'KTX Test',
            'system@ktx.local',
          );
        }
        if (unitKey === 'wu-bad') {
          await writeFile(join(root, 'semantic-layer/warehouse/bad.yaml'), 'name: bad\n', 'utf-8');
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'bad');
          currentSession.actions.push({
            target: 'sl',
            type: 'created',
            key: 'bad',
            detail: 'bad source',
            targetConnectionId: 'warehouse',
            rawPaths: ['bad.raw'],
          });
          await currentSession.gitService.commitFiles(
            ['semantic-layer/warehouse/bad.yaml'],
            'test: add bad source',
            'KTX Test',
            'system@ktx.local',
          );
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(
        runner,
        runtime,
        [
          ['good.raw', 'good-hash'],
          ['bad.raw', 'bad-hash'],
        ],
        'fake',
      );

      const result = await runner.run({
        jobId: 'job-failed-wu-isolated',
        connectionId: 'warehouse',
        sourceKey: 'fake',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });

      expect(result.failedWorkUnits).toEqual(['wu-bad']);
      await expect(readFile(join(runtime.configDir, 'semantic-layer/warehouse/good.yaml'), 'utf-8')).resolves.toContain(
        'good',
      );
      await expect(readFile(join(runtime.configDir, 'semantic-layer/warehouse/bad.yaml'), 'utf-8')).rejects.toThrow();

      const reportCreate = vi.mocked(deps.reports.create).mock.calls.at(-1)?.[0];
      const reportBody = reportCreate?.body as { isolatedDiff?: { acceptedPatches?: number }; failedWorkUnits?: string[] };
      expect(reportBody.failedWorkUnits).toEqual(['wu-bad']);
      expect(reportBody.isolatedDiff).toMatchObject({ enabled: true, acceptedPatches: 1 });

      const trace = await readFile(
        join(runtime.configDir, '.ktx/ingest-traces/job-failed-wu-isolated/trace.jsonl'),
        'utf-8',
      );
      expect(trace).toContain('work_unit_failed_before_patch');
      expect(trace).toContain('patch_accepted');
      expect(trace).not.toContain('shared_worktree_path_enabled');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 5: Run the updated focused runner tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  src/ingest/local-bundle-runtime.test.ts \
  -t "does not support shared-worktree|does not integrate failed isolated|defaults local bundle ingest|unlisted direct-writing source"
```

Expected: PASS. The traces contain `isolated_diff_enabled`, child worktree
events, and no `shared_worktree_path_enabled`.

- [ ] **Step 6: Run the broad runner suite**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.test.ts
```

Expected: PASS. Broad runner coverage no longer depends on
`sharedWorktreeSourceKeys`.

- [ ] **Step 7: Commit the runner removal**

Run:

```bash
git add \
  packages/context/src/ingest/ports.ts \
  packages/context/src/ingest/local-bundle-runtime.ts \
  packages/context/src/ingest/local-bundle-runtime.test.ts \
  packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/ingest-bundle.runner.test.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  packages/context/src/ingest/isolated-diff/source-routing.ts \
  packages/context/src/ingest/isolated-diff/source-routing.test.ts
git commit -m "refactor(ingest): remove shared worktree WorkUnit path"
```

Expected: commit succeeds. The deleted routing files are included as deletions.

---

### Task 5: Remove shared-branch agent instructions

**Files:**
- Modify: `packages/context/prompts/memory_agent_bundle_ingest_work_unit.md`
- Modify: `packages/context/skills/ingest_triage/SKILL.md`
- Test: `packages/context/src/ingest/ingest-prompts.test.ts`
- Test: `packages/context/src/ingest/ingest-runtime-assets.test.ts`

- [ ] **Step 1: Update the WorkUnit role text**

In `packages/context/prompts/memory_agent_bundle_ingest_work_unit.md`, replace
the `<role>` block with:

```md
<role>
You are processing ONE WorkUnit of a multi-file ingest bundle. The WorkUnit
gives you a slice of raw source files (LookML views, dbt/MetricFlow YAMLs,
Metabase card JSONs, Notion pages, or similar) and you must translate that
slice into KTX semantic-layer sources and/or knowledge wiki pages, in one pass.
You run in an isolated WorkUnit worktree. Deterministic projection output,
existing project memory, and listed dependency paths are visible; sibling
WorkUnit edits from this same job are not visible until the runner integrates
accepted patches.
</role>
```

- [ ] **Step 2: Update the WorkUnit workflow text**

In the same prompt, replace workflow steps 2 and 4 with:

```md
2. Load the per-source review skill first (for example `lookml_ingest`,
   `metricflow_ingest`, or `dbt_ingest`), then `sl_capture` and
   `wiki_capture`, and `ingest_triage` last. The triage skill tells you how to
   react when existing project memory, deterministic projection output, or
   prior provenance overlaps with what this WorkUnit is about to write.
4. For each raw file: call `read_raw_file` (or `read_raw_span` for slicing large
   files) to load content. Before writing a new SL source or wiki page, call
   `discover_data` for each candidate source, table, metric, or topic name to
   find existing wiki pages, SL sources, deterministic projection output, prior
   sync artifacts, and raw warehouse matches; apply `ingest_triage` when you hit
   one, and apply any matching canonical pin before deciding whether to edit,
   rename, or skip.
```

- [ ] **Step 3: Update the WorkUnit do-not rule**

In the same prompt, replace:

```md
- Do not silently accept a name collision with a prior WU's write when the formula differs. Trigger `ingest_triage`.
```

with:

```md
- Do not silently accept a name collision with visible existing memory,
  deterministic projection output, or prior provenance when the formula differs.
  Trigger `ingest_triage`.
```

- [ ] **Step 4: Update ingest triage caller guidance**

In `packages/context/skills/ingest_triage/SKILL.md`, replace:

```md
This skill is loaded in two contexts:
- By a Stage 3 WorkUnit agent when `sl_discover` reveals that a prior WU (or a prior sync) already wrote something that overlaps with what the current WU is about to write.
- By the Stage 4 reconciliation agent for cross-WU sweeps and for eviction decisions.
```

with:

```md
This skill is loaded in two contexts:
- By a Stage 3 WorkUnit agent when `sl_discover`, deterministic projection
  output, existing project memory, or prior provenance overlaps with what the
  current WorkUnit is about to write.
- By the Stage 4 reconciliation agent for cross-WorkUnit sweeps, accepted patch
  overlap, and eviction decisions.
```

- [ ] **Step 5: Update same-ingest wording in ingest triage**

In `packages/context/skills/ingest_triage/SKILL.md`, replace:

```md
4. **If there's no prior-sync row (both are from THIS job), check for same-ingest contradictions:**
```

with:

```md
4. **If reconciliation sees accepted patches from this same job with no
prior-sync row, check for same-ingest contradictions:**
```

- [ ] **Step 6: Search for stale shared-state prompt language**

Run:

```bash
rg -n "prior WU|prior-WU|Prior WorkUnits|same job may have already written|visible on the working branch|shared_worktree_path_enabled|shared-worktree path reachable" packages/context/prompts packages/context/skills packages/context/src/ingest
```

Expected: FAIL with no matches.

- [ ] **Step 7: Run prompt asset tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/ingest-prompts.test.ts \
  src/ingest/ingest-runtime-assets.test.ts
```

Expected: PASS. Prompt assets still load from packaged KTX assets.

- [ ] **Step 8: Commit the prompt cleanup**

Run:

```bash
git add \
  packages/context/prompts/memory_agent_bundle_ingest_work_unit.md \
  packages/context/skills/ingest_triage/SKILL.md
git commit -m "docs(ingest): align WorkUnit prompts with isolated diffs"
```

Expected: commit succeeds.

---

### Task 6: Final verification

**Files:**
- Verify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Verify: `packages/context/src/ingest/ports.ts`
- Verify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Verify: `packages/context/src/ingest/ingest-bundle.runner.test.ts`
- Verify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`
- Verify: `packages/context/prompts/memory_agent_bundle_ingest_work_unit.md`
- Verify: `packages/context/skills/ingest_triage/SKILL.md`

- [ ] **Step 1: Run the isolated-diff focused suite**

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
  src/ingest/final-gate-repair.test.ts \
  src/ingest/report-snapshot.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts
```

Expected: PASS. The output includes the isolated-diff runner tests and no
`source-routing.test.ts`.

- [ ] **Step 2: Run the full context test suite**

Run:

```bash
pnpm --filter @ktx/context run test
```

Expected: PASS.

- [ ] **Step 3: Run context type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS. There are no `sharedWorktreeSourceKeys` type errors because the
setting no longer exists.

- [ ] **Step 4: Run dead-code checks**

Run:

```bash
pnpm run dead-code
```

Expected: PASS. Knip does not report deleted source-routing exports, and Biome
does not report stale imports.

- [ ] **Step 5: Search for removed legacy path names**

Run:

```bash
rg -n "sharedWorktreeSourceKeys|defaultSharedWorktreeSourceKeys|isSharedWorktreeFallbackSourceKey|shared_worktree_path_enabled|explicit_private_fallback|source-routing" packages docs/superpowers/plans/2026-05-18-isolated-diff-ingestion-v1-shared-worktree-removal.md
```

Expected: matches only in this plan file. There must be no matches under
`packages/`.

- [ ] **Step 6: Confirm docs-site does not need an update**

Run:

```bash
rg -n "sharedWorktree|isolatedDiffSourceKeys|sharedWorktreeSourceKeys|executionMode|planningStrategy|conflictPolicy" docs-site README.md packages/*/README.md
```

Expected: either no matches or matches unrelated to a public user-facing knob.
This change removes an internal runner fallback and does not add, remove, or
rename public CLI behavior, configuration, or docs-site content.

- [ ] **Step 7: Commit final verification notes if files changed**

Run:

```bash
git status --short
```

Expected: clean after the two implementation commits. If this command reports
new changes, stop and inspect them before finishing; final verification should
not create extra source changes.

## Self-review

Spec coverage:

- Rollout step 11 is covered by Tasks 1 through 4: the private fallback setting,
  helper module, old runner branch, trace event, and fallback tests are deleted.
- The isolated-diff WorkUnit flow remains covered by existing real-git tests and
  the new failed-WorkUnit regression in Task 4.
- Agent-facing instructions are aligned with the spec's worktree invariant in
  Task 5: sibling WorkUnit edits are not visible inside a child worktree.
- Override ingestion remains outside the WorkUnit execution branch and still
  uses prior report materialization plus serial reconciliation.

Placeholder scan:

- This plan contains exact file paths, test names, replacement snippets,
  commands, and expected results.
- There are no deferred implementation markers or unspecified edge-case
  instructions.

Type consistency:

- `IngestSettingsPort` no longer includes `sharedWorktreeSourceKeys`.
- `isolatedDiffEnabled` remains the runner's internal summary flag and is
  equivalent to `!overrideReport`.
- The removed trace event is `shared_worktree_path_enabled`; retained isolated
  events include `isolated_diff_enabled`, `work_unit_child_created`, and
  `work_unit_patch_collected`.

Execution handoff:

Plan complete and saved to
`docs/superpowers/plans/2026-05-18-isolated-diff-ingestion-v1-shared-worktree-removal.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task,
   review between tasks, and keep iteration fast.
2. **Inline Execution** - Execute tasks in this session using
   `superpowers:executing-plans`, with batch execution and checkpoints.
