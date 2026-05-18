# Parallel Ingest Dependency Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the wall-clock win from parallel source ingest while preventing
source adapters from running or finalizing against incomplete repository
context.

**Architecture:** Split top-level public ingest into dependency stages:
database targets run first, then source targets run with
`ingest.sources.maxConcurrency`. Inside each source run, keep work-unit
integration deterministic. Before reconciliation and again during the final
gate/squash window, refresh the source session worktree from the latest root
commit under the existing `config:repo` lock so final gates validate the tree
that will actually be merged. Add a narrow Metabase guardrail for missing
schema context so agent output fails before inventing overlays or dangling
semantic refs.

**Tech Stack:** TypeScript ESM/NodeNext, Vitest, `p-limit`, existing
`GitService`, `InProcessIngestLock`, `IngestBundleRunner`, `SessionWorktree`,
semantic-layer final gates, Fumadocs docs-site.

---

## Root Cause Summary

Fresh verification with `/tmp/ktx-newingest3/ktx.yaml` proved source dispatch
is concurrent, but the run failed after about 993 seconds because source
sessions observed stale or incomplete context:

- `metabase` started before the warehouse schema and query-history/dbt context
  were safely visible. A WorkUnit saw no manifest entry, then attempted an
  overlay for `mart_account_segments`; the tool correctly rejected it.
- `notion` finalized wiki refs to dbt-created pages, but its source worktree
  was based on an older root commit, so final gates could not see
  `activation-policy-change-jan-2026` or `account-segmentation-rules`.
- Later `metabase` repair still failed a final semantic gate because the page
  referenced an `accounts` SL source that was not present in the stale session
  view.

The lock and mutation queue are not the primary bug now. `InProcessIngestLock`
already serializes `config:repo`, and `GitService.squashMergeIntoMain()` already
uses `withMutationQueue()`. The remaining issue is dependency freshness:
source work is parallel, but source planning and finalization need a current
base tree at specific boundaries.

## Scope

In scope:

- Add a database-before-sources barrier to `ktx ingest --all`.
- Preserve source result rendering in original plan order.
- Refresh source session worktrees from the latest root commit before Stage 4
  reconciliation.
- Move final refresh, final artifact gates, provenance gates, cleanliness
  assertion, and squash merge into one `config:repo` finalization window.
- Add Metabase prompt guidance for missing schema context.
- Add focused regression tests and rerun live verification.

Out of scope:

- Parallelizing database scans.
- Serializing full source runs.
- Adding CLI flags.
- Compatibility aliases for older config names.
- Changing resolver integration order or raw `git apply` determinism.

## File Structure

- Modify `packages/cli/src/public-ingest.ts`.
- Modify `packages/cli/src/public-ingest.test.ts`.
- Modify `packages/context/src/core/git.service.ts`.
- Modify `packages/context/src/core/git.service.test.ts`.
- Modify `packages/context/src/ingest/ingest-bundle.runner.ts`.
- Modify `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`.
- Modify `packages/context/skills/metabase_ingest/SKILL.md`.
- Optionally modify `packages/context/src/ingest/ingest-runtime-assets.test.ts`
  if the Metabase guardrail needs an asset regression.
- Update `.context/parallelization-results.md` after live verification.

---

### Task 1: Add Public Ingest Barrier Tests

**Files:**

- Modify: `packages/cli/src/public-ingest.test.ts`

- [ ] **Step 1: Add a failing test proving source targets wait for database targets**

Add this test near the existing source concurrency test:

```ts
it('waits for database targets before starting parallel source targets', async () => {
  const io = makeIo();
  const baseConfig = buildDefaultKtxProjectConfig();
  const project: KtxPublicIngestProject = {
    projectDir: '/tmp/project',
    config: {
      ...baseConfig,
      ingest: {
        ...baseConfig.ingest,
        sources: { maxConcurrency: 2 },
      } as KtxProjectConfig['ingest'],
      connections: {
        warehouse: { driver: 'postgres', context: { depth: 'deep' } },
        docs: { driver: 'notion' },
        prod_metabase: { driver: 'metabase', api_url: 'https://metabase.example.com' },
      },
    },
  };
  const events: string[] = [];
  const schema = deferred<number>();
  const runScan = vi.fn<NonNullable<KtxPublicIngestDeps['runScan']>>(async () => {
    events.push('scan:start');
    return schema.promise;
  });
  const runIngest = vi.fn<NonNullable<KtxPublicIngestDeps['runIngest']>>(async (ingestArgs) => {
    if (ingestArgs.command !== 'run') return 1;
    events.push(`ingest:${ingestArgs.connectionId}:${ingestArgs.adapter}`);
    return 0;
  });

  const run = runKtxPublicIngest(
    { command: 'run', projectDir: '/tmp/project', all: true, json: false, inputMode: 'disabled' },
    io.io,
    {
      loadProject: vi.fn(async () => project),
      runScan,
      runIngest,
    },
  );

  await vi.waitFor(() => expect(events).toEqual(['scan:start']));
  await Promise.resolve();
  expect(runIngest).not.toHaveBeenCalled();

  schema.resolve(0);
  await expect(run).resolves.toBe(0);
  expect(events).toEqual([
    'scan:start',
    'ingest:docs:notion',
    'ingest:prod_metabase:metabase',
  ]);
});
```

- [ ] **Step 2: Keep the existing source-concurrency test**

Do not weaken the existing test named
`runs public ingest targets concurrently up to ingest.sources.maxConcurrency and renders in plan order`.
It must still prove source targets overlap after the database stage completes.

- [ ] **Step 3: Run the focused CLI test**

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts
```

Expected state before implementation: the new barrier test fails because
`runKtxPublicIngest()` currently puts database and source targets in one
`p-limit` pool.

---

### Task 2: Implement Dependency-Staged Public Ingest Dispatch

**Files:**

- Modify: `packages/cli/src/public-ingest.ts`

- [ ] **Step 1: Add a small batch helper near `runKtxPublicIngest()`**

```ts
interface IndexedPublicIngestTarget {
  index: number;
  target: KtxPublicIngestPlanTarget;
}

async function executePublicIngestTargetBatch(
  entries: IndexedPublicIngestTarget[],
  maxConcurrency: number,
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
  io: KtxCliIo,
  deps: KtxPublicIngestDeps,
): Promise<Array<{ index: number; result: KtxPublicIngestTargetResult }>> {
  const limit = pLimit(maxConcurrency);
  return Promise.all(
    entries.map((entry) =>
      limit(async () => ({
        index: entry.index,
        result: await executePublicIngestTarget(entry.target, args, io, deps),
      })),
    ),
  );
}
```

- [ ] **Step 2: Partition plan targets by operation**

Replace the current single `p-limit` map in `runKtxPublicIngest()` with:

```ts
const indexedTargets = plan.targets.map((target, index) => ({ index, target }));
const databaseTargets = indexedTargets.filter((entry) => entry.target.operation === 'database-ingest');
const sourceTargets = indexedTargets.filter((entry) => entry.target.operation === 'source-ingest');

const orderedResults = [
  ...(await executePublicIngestTargetBatch(databaseTargets, 1, args, io, deps)),
  ...(await executePublicIngestTargetBatch(sourceTargets, sourceMaxConcurrency, args, io, deps)),
];
results.push(
  ...orderedResults
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.result),
);
```

Notes:

- Database targets stay sequential in this plan. That preserves the previous
  default safety profile and avoids scanning multiple warehouses into the same
  root repo at once.
- Source targets keep the configured `ingest.sources.maxConcurrency`.
- Result table order stays tied to `plan.targets`, not completion order.

- [ ] **Step 3: Re-run focused CLI tests**

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts
pnpm --filter @ktx/cli run type-check
```

---

### Task 3: Add a GitService Root Refresh Primitive

**Files:**

- Modify: `packages/context/src/core/git.service.ts`
- Modify: `packages/context/src/core/git.service.test.ts`

- [ ] **Step 1: Add tests first**

Add tests covering:

- merging a root commit into a session worktree with no conflicts;
- no-op behavior when the session already has the target commit;
- conflict behavior that aborts the merge and leaves the session clean.

Use the existing GitService test harness. The core assertion for conflict
cleanup should look like:

```ts
const result = await session.git.mergeCommitIntoCurrent(rootHead);

expect(result).toMatchObject({ ok: false, conflict: true });
await expect(session.git.assertWorktreeClean()).resolves.toBeUndefined();
expect(await session.git.revParseHead()).toBe(sessionHeadBeforeMerge);
```

- [ ] **Step 2: Add result types**

```ts
export type MergeCommitIntoCurrentResult =
  | { ok: true; headSha: string; changed: boolean }
  | { ok: false; conflict: true; conflictPaths: string[] };
```

- [ ] **Step 3: Implement the method using the existing mutation queue**

```ts
async mergeCommitIntoCurrent(commitish: string): Promise<MergeCommitIntoCurrentResult> {
  return this.withMutationQueue(() => this.mergeCommitIntoCurrentUnlocked(commitish));
}

private async mergeCommitIntoCurrentUnlocked(commitish: string): Promise<MergeCommitIntoCurrentResult> {
  const before = (await this.git.revparse(['HEAD'])).trim();
  const target = (await this.git.revparse([commitish])).trim();
  if (before === target) {
    return { ok: true, headSha: before, changed: false };
  }

  let mergeError: unknown = null;
  try {
    await this.git.raw(['merge', '--no-edit', target]);
  } catch (error) {
    mergeError = error;
  }

  const unmergedOut = await this.git.raw(['diff', '--name-only', '--diff-filter=U']).catch(() => '');
  const unmergedPaths = unmergedOut
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const conflictPaths = mergeConflictPaths(unmergedPaths, mergeError);

  if (conflictPaths.length > 0 || mergeError !== null) {
    await this.git.raw(['merge', '--abort']).catch(() => undefined);
    await this.git.raw(['reset', '--hard', before]).catch(() => undefined);
    return { ok: false, conflict: true, conflictPaths };
  }

  const headSha = (await this.git.revparse(['HEAD'])).trim();
  return { ok: true, headSha, changed: headSha !== before };
}
```

This method intentionally belongs on `GitService`, not the runner, because it
must use the same in-process mutation queue and cleanup behavior as other
repository mutation helpers.

- [ ] **Step 4: Run focused GitService tests**

```bash
pnpm --filter @ktx/context exec vitest run src/core/git.service.test.ts
```

---

### Task 4: Refresh Source Session Worktrees Before Reconciliation and Finalization

**Files:**

- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`

- [ ] **Step 1: Add runner helpers for session refresh**

Inside `IngestBundleRunner`, add an unlocked helper plus a locked wrapper. The
unlocked helper is used by finalization after the caller already holds
`config:repo`.

```ts
private async refreshSessionFromRootHeadAlreadyLocked(input: {
  sessionWorktree: IngestSessionWorktree;
  runTrace: IngestTraceWriter;
  phase: 'before_reconciliation' | 'before_final_squash';
}): Promise<void> {
  const rootHead = await this.deps.gitService.revParseHead();
  if (!rootHead) {
    throw new Error('ingest-bundle: config repo has no HEAD');
  }
  const result = await input.sessionWorktree.git.mergeCommitIntoCurrent(rootHead);

  await input.runTrace.event('debug', 'refresh', 'session_refreshed_from_root', {
    phase: input.phase,
    result,
  });

  if (!result.ok) {
    throw new Error(`source refresh conflict before ${input.phase}: ${result.conflictPaths.join(', ')}`);
  }
}

private async refreshSessionFromRootHead(input: {
  sessionWorktree: IngestSessionWorktree;
  runTrace: IngestTraceWriter;
  phase: 'before_reconciliation' | 'before_final_squash';
}): Promise<void> {
  await this.deps.lockingService.withLock('config:repo', () =>
    this.refreshSessionFromRootHeadAlreadyLocked(input),
  );
}
```

Use the real imported types from the file. If `IngestTraceWriter` is not
currently imported as a value/type in this file, add the type import instead of
using `any`.

- [ ] **Step 2: Refresh before Stage 4 reconciliation**

Right after work-unit integration and candidate carryforward/dedup complete,
but before `preReconciliationSha` and `reconcileSession` are created, call:

```ts
await this.refreshSessionFromRootHead({
  sessionWorktree,
  runTrace,
  phase: 'before_reconciliation',
});
const preReconciliationSha = await sessionWorktree.git.revParseHead();
```

This lets reconciliation agents see pages and semantic-layer files committed by
database, dbt, historic-sql, or earlier sibling source runs.

- [ ] **Step 3: Refresh and gate inside the final root mutation window**

Move the final refresh and final gates into the existing `config:repo` lock that
currently wraps only `revParseHead()` and `squashMergeIntoMain()`.

The shape should be:

```ts
const squashResult = await this.deps.lockingService.withLock('config:repo', async () => {
  await this.refreshSessionFromRootHeadAlreadyLocked({
    sessionWorktree,
    runTrace,
    phase: 'before_final_squash',
  });

  await validateFinalIngestArtifacts({
    // use the existing final-gate inputs, still scoped to sessionWorktree
  });
  await validateProvenanceRawPaths({
    // use the existing provenance-gate inputs
  });
  await sessionWorktree.git.assertWorktreeClean();

  const preSquashSha = await this.deps.gitService.revParseHead();
  const merge = await this.deps.gitService.squashMergeIntoMain(
    sessionWorktree.branch,
    this.deps.storage.systemGitAuthor.name,
    this.deps.storage.systemGitAuthor.email,
    commitMessage,
  );
  return { preSquashSha, merge };
});
```

Do not call the locked `refreshSessionFromRootHead()` wrapper from inside this
block.

Rationale: a sibling source can squash between final gates and squash merge
today. Holding the lock across refresh, gates, cleanliness assertion, and squash
ensures the session was validated against the same root tree it merges into.

- [ ] **Step 4: Add finalization freshness tests**

In `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`,
add focused coverage for these cases:

- A source session starts from `baseSha`, root receives a wiki page commit before
  source finalization, the source writes a wiki ref to that page, and final
  gates pass because the finalization refresh merged the root page.
- A refresh conflict fails the run with `source refresh conflict` and leaves the
  session worktree available with a conflict sentinel.
- Two concurrent source runs cannot overlap the final refresh/gate/squash
  window. Use a fake lock that records `final:start` and `final:end`, plus
  deferred promises around `squashMergeIntoMain()`.

The concurrency assertion should be direct:

```ts
expect(events).toEqual([
  'source-a:final:start',
  'source-a:final:end',
  'source-b:final:start',
  'source-b:final:end',
]);
```

- [ ] **Step 5: Run focused context checks**

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts
pnpm --filter @ktx/context run type-check
```

---

### Task 5: Harden Metabase Missing-Schema Guidance

**Files:**

- Modify: `packages/context/skills/metabase_ingest/SKILL.md`
- Optionally modify: `packages/context/src/ingest/ingest-runtime-assets.test.ts`

- [ ] **Step 1: Update the Metabase decision tree**

In the `Decision tree` section, replace the loose "if `sl_discover` returns
nothing, you can write a standalone source" rule with a stricter version:

```md
If `sl_discover` returns no match for a candidate source name, treat that as
unknown, not permission. First prove the source with `entity_details` against
the warehouse table reference or with a `sql_execution(... LIMIT 0)` probe for
derived SQL. If both source discovery and physical/SQL probes fail, stop for
that card and do not call `sl_write_source`, `wiki_write`, or
`emit_unmapped_fallback` with invented `sl_refs`.
```

Also add:

```md
Never call `sl_write_source` with overlay shape for a name that `sl_discover`
did not report as manifest-backed. Missing schema context is a hard stop for
overlays.
```

- [ ] **Step 2: Add a lightweight asset regression if useful**

If this repository already uses content assertions for bundled ingest skills,
add an assertion that `metabase_ingest` contains the phrase
`Missing schema context is a hard stop for overlays`. If there is no local
pattern for prompt content assertions, skip the brittle assertion and rely on
runtime asset smoke coverage.

- [ ] **Step 3: Run focused asset tests**

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-runtime-assets.test.ts
```

---

### Task 6: Update Timing Notes and Docs if Behavior Changes Need It

**Files:**

- Modify: `.context/parallelization-results.md`
- Modify docs-site only if the implementation changes user-facing config or
  command behavior beyond the already-documented concurrency settings.

- [ ] **Step 1: Append the root-cause note**

Append a section to `.context/parallelization-results.md` with:

- fresh project directory used;
- exact `ktx ingest --all` command;
- exit code;
- wall-clock timing;
- whether `.ktx/worktrees/` was empty after success/failure;
- the root-cause classification:
  `dependency freshness issue, not mutation queue overlap`.

- [ ] **Step 2: Decide whether docs-site changes are required**

If the public behavior is simply "database targets are prerequisites before
source targets", update `docs-site/content/docs/cli-reference/ktx-ingest.mdx`
with one sentence:

```md
For `ktx ingest --all`, database schema and query-history targets complete
before source adapters start; `ingest.sources.maxConcurrency` applies to the
source-adapter stage.
```

Run the docs checks only if the repo has a focused docs command; otherwise rely
on TypeScript checks and note that docs were edited.

---

### Task 7: Full Verification

- [ ] **Step 1: Run focused checks**

```bash
pnpm --filter @ktx/cli run type-check
pnpm --filter @ktx/cli run test
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/context run test
```

- [ ] **Step 2: Run workspace checks if focused checks pass**

```bash
pnpm run type-check
pnpm run test
pnpm run dead-code
```

- [ ] **Step 3: Run a fresh live ingest if `/tmp/ktx-newingest3/ktx.yaml` is available**

Create a fresh project directory, copy the config, set source concurrency to 4
if it is not already set, and run:

```bash
set -o pipefail
/usr/bin/time -p pnpm run ktx -- --project-dir /tmp/<fresh-project> ingest --all --yes --plain 2>&1 | tee .context/<fresh-project-name>.log
```

Then record:

```bash
find /tmp/<fresh-project>/.ktx/worktrees -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | sort
```

Success criteria:

- database target starts before any source target;
- source targets overlap after the database stage;
- final table remains in plan order;
- no final gate failures caused by sibling-source stale context;
- successful run leaves `.ktx/worktrees/` empty;
- failed run leaves only intentional conflict/crash sentinels with root-cause
  trace entries.
