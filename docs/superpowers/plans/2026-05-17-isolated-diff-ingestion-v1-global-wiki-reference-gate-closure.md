# Isolated Diff Ingestion V1 Global Wiki Reference Gate Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject final trees where an isolated-diff run changes semantic-layer
sources or deletes wiki pages and leaves pre-existing wiki pages with stale
body, `sl_refs`, frontmatter `refs`, or inline `[[page-key]]` references.

**Architecture:** Keep `artifact-gates.ts` validation-only. The runner expands
the final wiki gate scope before the existing final artifact gate: changed pages
are always validated, and all global wiki pages are validated when the run
changes any semantic-layer source or removes any wiki page. The final-gate trace
records the expanded scope and why it was expanded.

**Tech Stack:** TypeScript, Vitest, pnpm workspace commands, existing
`IngestBundleRunner`, `KnowledgeWikiService`, and isolated-diff test fixtures.

---

## Audit Summary

The implemented isolated-diff plans cover the core v1 flow: child worktrees,
binary no-rename patch proposals, `git apply --3way --index`, policy rejection,
final gates after reconciliation and repair, pre-squash provenance raw-path
validation, target-connection enforcement, failed reports, and persistent JSONL
traces.

One v1-blocking correctness gap remains. Final wiki gates currently validate
wiki pages changed by the run. They do not validate unchanged pages that become
invalid because the run changes a semantic-layer source or deletes a referenced
wiki page. Two concrete failures can therefore squash into main:

- A pre-existing wiki page body contains
  `` `mart_account_segments.total_contract_arr_cents` `` while the run updates
  `semantic-layer/warehouse/mart_account_segments.yaml` to define only
  `total_contract_arr`.
- A pre-existing wiki page has `refs: [source-page]` or `[[source-page]]` while
  the run deletes `wiki/global/source-page.md`.

This plan does not expand connector rollout, promote isolated diffs to the
default, add interactive resolution, add semantic auto-merge, remove the old
path, expand transitive semantic-layer dependencies, or move provenance into
files.

## File Structure

- Modify `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`.
  Adds two failing end-to-end regressions for unchanged wiki pages made stale by
  semantic-layer changes and wiki-page deletion.
- Modify `packages/context/src/ingest/ingest-bundle.runner.ts`.
  Adds a final wiki gate scope helper, expands validation to all global wiki
  pages when final state changes can invalidate unchanged references, and records
  scope details in the final-gate trace and failed report.

---

### Task 1: Add failing unchanged wiki regressions

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`

- [ ] **Step 1: Add the stale existing wiki body regression**

Insert this test inside `describe('IngestBundleRunner isolated diff path', ...)`
after the existing Metabase stale-measure regression:

```ts
  it('rejects unchanged wiki body refs made stale by isolated semantic-layer changes', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      await mkdir(join(runtime.configDir, 'semantic-layer/warehouse'), { recursive: true });
      await mkdir(join(runtime.configDir, 'wiki/global'), { recursive: true });
      await writeFile(
        join(runtime.configDir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
        'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr_cents\n    expr: sum(contract_arr)\n',
      );
      await writeFile(
        join(runtime.configDir, 'wiki/global/account-segments.md'),
        '---\nsummary: Account segments\nusage_mode: auto\n---\n\nExisting ARR uses `mart_account_segments.total_contract_arr_cents`.\n',
      );
      await runtime.git.commitFiles(
        ['semantic-layer/warehouse/mart_account_segments.yaml', 'wiki/global/account-segments.md'],
        'seed existing wiki body ref',
        'KTX Test',
        'system@ktx.local',
      );
      const preRunHead = await runtime.git.revParseHead();

      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'source-only', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await writeFile(
          join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
          'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
        currentSession.actions.push({
          target: 'sl',
          type: 'updated',
          key: 'mart_account_segments',
          detail: 'Rename ARR measure',
          targetConnectionId: 'warehouse',
          rawPaths: ['cards/source.json'],
        });
        await currentSession.gitService.commitFiles(
          ['semantic-layer/warehouse/mart_account_segments.yaml'],
          'wu source rename',
          'KTX Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);

      await expect(
        runner.run({
          jobId: 'job-existing-body-stale',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/total_contract_arr_cents/);

      expect(await runtime.git.revParseHead()).toBe(preRunHead);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-existing-body-stale/trace.jsonl'), 'utf-8');
      expect(trace).toContain('final_artifact_gates_failed');
      expect(trace).toContain('account-segments');
      expect(trace).toContain('semantic_layer_changed');
      expect(trace).toContain('ingest_failed');
      expect(trace).toContain('failure_report_created');
      expect(trace).not.toContain('squash_finished');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Add the stale existing wiki page-reference regression**

Insert this test near the existing final wiki reference regression:

```ts
  it('rejects unchanged inbound wiki refs broken by an isolated wiki deletion', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      await mkdir(join(runtime.configDir, 'wiki/global'), { recursive: true });
      await writeFile(
        join(runtime.configDir, 'wiki/global/source-page.md'),
        '---\nsummary: Source page\nusage_mode: auto\n---\n\nSource page\n',
      );
      await writeFile(
        join(runtime.configDir, 'wiki/global/account-segments.md'),
        '---\nsummary: Account segments\nusage_mode: auto\nrefs:\n  - source-page\n---\n\nSee [[source-page]].\n',
      );
      await runtime.git.commitFiles(
        ['wiki/global/source-page.md', 'wiki/global/account-segments.md'],
        'seed inbound wiki refs',
        'KTX Test',
        'system@ktx.local',
      );
      const preRunHead = await runtime.git.revParseHead();

      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'delete-target-page', rawFiles: ['pages/delete.json'], peerFileIndex: [], dependencyPaths: [] }],
      });

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await rm(join(root, 'wiki/global/source-page.md'), { force: true });
        currentSession.actions.push({
          target: 'wiki',
          type: 'removed',
          key: 'source-page',
          detail: 'Delete referenced page',
          rawPaths: ['pages/delete.json'],
        });
        await currentSession.gitService.commitFiles(
          ['wiki/global/source-page.md'],
          'wu delete target page',
          'KTX Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['pages/delete.json', 'h1']]);

      await expect(
        runner.run({
          jobId: 'job-existing-wiki-ref-stale',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/wiki references target missing page\(s\): account-segments -> source-page/);

      expect(await runtime.git.revParseHead()).toBe(preRunHead);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-existing-wiki-ref-stale/trace.jsonl'), 'utf-8');
      expect(trace).toContain('final_artifact_gates_failed');
      expect(trace).toContain('account-segments -> source-page');
      expect(trace).toContain('wiki_page_removed');
      expect(trace).toContain('ingest_failed');
      expect(trace).toContain('failure_report_created');
      expect(trace).not.toContain('squash_finished');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 3: Run the focused regressions and verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts -t "unchanged wiki body refs|unchanged inbound wiki refs"
```

Expected: FAIL. The stale body test currently squashes successfully because the
unchanged `account-segments` page is not in `finalChangedWikiPageKeys`. The
inbound wiki ref test currently squashes successfully because the deleted
`source-page` is validated as a missing changed page and skipped, while the
unchanged page that references it is never validated.

---

### Task 2: Expand the final wiki validation scope

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`

- [ ] **Step 1: Add final wiki gate scope helpers**

Add these private methods after `uniqueTouchedSlSources()`:

```ts
  private removedWikiPageKeysFromActions(actions: MemoryAction[]): string[] {
    return this.uniqueWikiPageKeys(
      actions.filter((action) => action.target === 'wiki' && action.type === 'removed').map((action) => action.key),
    );
  }

  private async wikiPageKeysForFinalGates(input: {
    wikiService: ReturnType<KnowledgeWikiService['forWorktree']>;
    changedWikiPageKeys: string[];
    touchedSlSources: TouchedSlSource[];
    actions: MemoryAction[];
  }): Promise<{
    pageKeys: string[];
    trace: {
      global: boolean;
      reasons: string[];
      changedWikiPageKeys: string[];
      removedWikiPageKeys: string[];
      pageKeysValidated: string[];
    };
  }> {
    const changedWikiPageKeys = this.uniqueWikiPageKeys(input.changedWikiPageKeys);
    const removedWikiPageKeys = this.removedWikiPageKeysFromActions(input.actions);
    const reasons: string[] = [];
    if (input.touchedSlSources.length > 0) {
      reasons.push('semantic_layer_changed');
    }
    if (removedWikiPageKeys.length > 0) {
      reasons.push('wiki_page_removed');
    }

    let pageKeys = changedWikiPageKeys;
    if (reasons.length > 0) {
      pageKeys = this.uniqueWikiPageKeys([
        ...changedWikiPageKeys,
        ...(await input.wikiService.listPageKeys('GLOBAL', null)),
      ]);
    }

    return {
      pageKeys,
      trace: {
        global: reasons.length > 0,
        reasons,
        changedWikiPageKeys,
        removedWikiPageKeys,
        pageKeysValidated: pageKeys,
      },
    };
  }
```

- [ ] **Step 2: Use the expanded scope before final gates**

In `runInner()`, replace the current `finalChangedWikiPageKeys` and
`finalTouchedSlSources` block with this code:

```ts
      const baseFinalChangedWikiPageKeys = this.uniqueWikiPageKeys([
        ...(isolatedDiffEnabled ? projectionChangedWikiPageKeys : []),
        ...workUnitOutcomes
          .flatMap((outcome) => outcome.patchTouchedPaths ?? [])
          .flatMap((path) => this.wikiPageKeysFromPaths([path])),
        ...this.wikiPageKeysFromActions(reconcileActions),
        ...postReconciliationPaths.flatMap((path) => this.wikiPageKeysFromPaths([path])),
        ...wikiSlRefRepairResult.repairs.filter((repair) => repair.scope === 'GLOBAL').map((repair) => repair.pageKey),
      ]);
      const finalTouchedSlSources = this.uniqueTouchedSlSources([
        ...(isolatedDiffEnabled ? projectionTouchedSources : []),
        ...workUnitOutcomes.flatMap((outcome) => outcome.touchedSlSources),
        ...this.touchedSlSourcesFromActions(reconcileActions, job.connectionId),
        ...this.touchedSlSourcesFromPaths(postReconciliationPaths),
        ...(postProcessorOutcome?.touchedSources ?? []),
      ]);
      const finalWikiGateScope = await this.wikiPageKeysForFinalGates({
        wikiService: this.deps.wikiService.forWorktree(sessionWorktree.workdir),
        changedWikiPageKeys: baseFinalChangedWikiPageKeys,
        touchedSlSources: finalTouchedSlSources,
        actions: [...stageIndex.workUnits.flatMap((wu) => wu.actions), ...reconcileActions],
      });
      const finalChangedWikiPageKeys = finalWikiGateScope.pageKeys;
```

This keeps the existing variable name used by `validateFinalIngestArtifacts()`,
but the value now means "wiki page keys to validate in final gates."

- [ ] **Step 3: Add scope details to final-gate trace data**

In the `finalArtifactGateTraceData` object, add the
`wikiReferenceGateScope` field:

```ts
      const finalArtifactGateTraceData = {
        changedWikiPageKeys: finalChangedWikiPageKeys,
        wikiReferenceGateScope: finalWikiGateScope.trace,
        touchedSlSources: finalTouchedSlSources,
        projectionTouchedPaths,
        workUnitPatchTouchedPaths: workUnitOutcomes.flatMap((outcome) => outcome.patchTouchedPaths ?? []),
        preReconciliationSha,
        postReconciliationSha,
        postReconciliationPaths,
        reconciliationActionCount: reconcileActions.length,
        wikiSlRefRepairCount: wikiSlRefRepairResult.repairs.length,
      };
```

The failure report already stores `activeFailureDetails`, so this trace data
also becomes persistent failed-report context when final gates fail.

- [ ] **Step 4: Run the focused regressions and verify they pass**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts -t "unchanged wiki body refs|unchanged inbound wiki refs"
```

Expected: PASS. Both traces include `final_artifact_gates_failed`,
`failure_report_created`, no `squash_finished`, and
`wikiReferenceGateScope` with either `semantic_layer_changed` or
`wiki_page_removed`.

---

### Task 3: Verification and commit

**Files:**
- Verify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Verify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`

- [ ] **Step 1: Run the isolated-diff focused suite**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  src/ingest/artifact-gates.test.ts \
  src/ingest/wiki-body-refs.test.ts \
  src/ingest/semantic-layer-target-policy.test.ts \
  src/ingest/isolated-diff/git-patch.test.ts \
  src/ingest/isolated-diff/patch-integrator.test.ts \
  src/ingest/isolated-diff/work-unit-executor.test.ts \
  src/core/git.service.patch.test.ts
```

Expected: PASS.

- [ ] **Step 2: Type-check the context package**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Run dead-code analysis**

Run:

```bash
pnpm run dead-code
```

Expected: PASS, or only pre-existing findings unrelated to
`packages/context/src/ingest/ingest-bundle.runner.ts` and
`packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`.
Investigate any new finding before committing.

- [ ] **Step 4: Verify trace acceptance criteria**

Open the traces produced by the two new failing-run tests and confirm these
events and fields exist:

```text
job-existing-body-stale:
- final_artifact_gates_started
- final_artifact_gates_failed
- ingest_failed
- failure_report_created
- no squash_finished
- wikiReferenceGateScope.global is true
- wikiReferenceGateScope.reasons includes semantic_layer_changed
- wikiReferenceGateScope.pageKeysValidated includes account-segments
- error.message includes total_contract_arr_cents

job-existing-wiki-ref-stale:
- final_artifact_gates_started
- final_artifact_gates_failed
- ingest_failed
- failure_report_created
- no squash_finished
- wikiReferenceGateScope.global is true
- wikiReferenceGateScope.reasons includes wiki_page_removed
- wikiReferenceGateScope.removedWikiPageKeys includes source-page
- error.message includes account-segments -> source-page
```

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts
git commit -m "fix(ingest): gate global wiki references"
```

Expected: one commit containing only the runner and isolated-diff runner test
changes.

---

## Self-Review

Spec coverage:
- Final global wiki body reference validation now covers unchanged wiki pages
  when a run changes semantic-layer sources.
- Final global wiki page reference validation now covers unchanged inbound
  references when a run deletes wiki pages.
- The plan keeps resolver behavior fail-fast and stops before squash.
- Persistent trace and failed-report acceptance criteria are explicit and tied
  to the concrete failure modes.

Non-blocking gaps unchanged:
- Broader connector rollout.
- Isolated-diff default promotion.
- Old shared-worktree path removal.
- Interactive conflict resolution.
- Semantic auto-merge.
- Transitive semantic-layer dependency expansion.
- Provenance-as-files.
