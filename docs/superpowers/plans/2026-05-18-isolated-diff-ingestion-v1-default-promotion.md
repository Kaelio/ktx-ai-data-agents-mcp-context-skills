# Isolated Diff Ingestion V1 Default Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote isolated-diff WorkUnit execution to the default ingest runner
path while keeping the old shared-worktree branch reachable by an explicit
private fallback setting for the final cleanup rollout.

**Architecture:** The runner stops asking whether a source is on an
isolated-diff allowlist. Instead, non-override bundle ingests use isolated
diffs unless the private settings object lists the source in
`sharedWorktreeSourceKeys`. Local runtime defaults that fallback list to empty,
and tests keep the old path covered with an explicit legacy source setting so
rollout step 11 can delete it safely.

**Tech Stack:** TypeScript ESM/NodeNext, Vitest, pnpm workspace commands,
existing `IngestBundleRunner`, `IngestSettingsPort`, local ingest runtime, and
isolated-diff runner tests.

---

## Audit summary

This audit read the original spec at
`docs/superpowers/specs/2026-05-17-isolated-diff-ingestion-design.md`, all
plans matching
`docs/superpowers/plans/2026-05-17-isolated-diff-ingestion-*.md` and
`docs/superpowers/plans/2026-05-18-isolated-diff-ingestion-*.md`, and the
current ingest runner code under `packages/context/src/ingest/`.

Implemented v1 rollout coverage:

- Rollout steps 1 and 2 are implemented by the core plan: child worktrees,
  binary no-rename patch proposals, and `git apply --3way --index`
  integration exist.
- Rollout step 3 is implemented by the textual conflict resolver plan:
  `textual-conflict-resolver.ts` is wired through `patch-integrator.ts`.
- Rollout steps 4, 5, and 6 are implemented by the gates, provenance,
  reference, global wiki, and gate-repair plans: final gates, persistent traces,
  failure reports, provenance validation, target policy, and repair counters
  exist.
- Rollout step 7 is implemented by the core and follow-up plans: Metabase has
  isolated-diff stale-reference regression coverage.
- Rollout step 8 is implemented by
  `2026-05-18-isolated-diff-ingestion-v1-connector-migration.md` and the
  follow-up commits: Notion, LookML, Looker, dbt, and MetricFlow route through
  isolated child worktrees, and MetricFlow projection runs before WorkUnits.

Current v1-blocking gaps:

- Rollout step 10 is not complete. `IngestBundleRunner.isIsolatedDiffEnabled()`
  still checks `settings.isolatedDiffSourceKeys`, and
  `local-bundle-runtime.ts` still installs the internal allowlist returned by
  `defaultIsolatedDiffSourceKeys()`.
- Rollout step 11 remains blocked until step 10 lands. The old
  shared-worktree WorkUnit branch is still present and must stay reachable in
  this plan for final cleanup validation.

Non-blocking gaps:

- Rollout step 9 deterministic semantic merge helpers remain intentionally
  deferred until v1 resolver metrics show frequent mechanical repairs.
- Transitive SQL-projection dependency expansion remains outside v1; current
  gates cover direct declared join neighbors.
- Moving provenance into worktree files remains outside v1; the implemented
  source of truth is the ingest provenance store and report body.
- Public connector knobs such as `executionMode`, `planningStrategy`, and
  `conflictPolicy` remain non-goals and must not be added.
- Richer resolver context, such as full transcript excerpts for every
  overlapping patch, can be evaluated after the default path has production
  traces.

## File structure

- Modify `packages/context/src/ingest/isolated-diff/source-routing.ts`.
  Replace the isolated-diff direct-write allowlist with an empty default
  shared-worktree fallback list.
- Modify `packages/context/src/ingest/isolated-diff/source-routing.test.ts`.
  Lock the fallback list semantics and remove direct-write allowlist
  assertions.
- Modify `packages/context/src/ingest/ports.ts`.
  Replace `isolatedDiffSourceKeys?: string[]` with
  `sharedWorktreeSourceKeys?: string[]` on the private runner settings port.
- Modify `packages/context/src/ingest/ingest-bundle.runner.ts`.
  Make isolated diff the default for non-override runs and route to the old
  shared branch only when `sharedWorktreeSourceKeys` contains the source.
- Modify `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`.
  Prove an unlisted source uses isolated diffs by default and prove an
  explicit fallback source can still reach the shared-worktree branch.
- Modify `packages/context/src/ingest/local-bundle-runtime.ts`.
  Install the new empty fallback list instead of the old isolated-diff
  allowlist.
- Modify `packages/context/src/ingest/local-bundle-runtime.test.ts`.
  Assert local runtime settings do not expose `isolatedDiffSourceKeys` and do
  default `sharedWorktreeSourceKeys` to `[]`.

---

### Task 1: Replace source routing semantics

**Files:**
- Modify: `packages/context/src/ingest/isolated-diff/source-routing.test.ts`
- Modify: `packages/context/src/ingest/isolated-diff/source-routing.ts`
- Modify: `packages/context/src/ingest/ports.ts`

- [ ] **Step 1: Write the failing source-routing tests**

Replace `packages/context/src/ingest/isolated-diff/source-routing.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { defaultSharedWorktreeSourceKeys, isSharedWorktreeFallbackSourceKey } from './source-routing.js';

describe('isolated-diff source routing', () => {
  it('defaults every non-override source to isolated diffs', () => {
    expect(defaultSharedWorktreeSourceKeys()).toEqual([]);
  });

  it('returns a mutable copy for runtime settings', () => {
    const keys = defaultSharedWorktreeSourceKeys();
    keys.push('legacy-source');

    expect(defaultSharedWorktreeSourceKeys()).toEqual([]);
  });

  it('recognizes only explicitly configured shared-worktree fallback sources', () => {
    expect(isSharedWorktreeFallbackSourceKey('notion', [])).toBe(false);
    expect(isSharedWorktreeFallbackSourceKey('metricflow', [])).toBe(false);
    expect(isSharedWorktreeFallbackSourceKey('legacy-source', ['legacy-source'])).toBe(true);
    expect(isSharedWorktreeFallbackSourceKey('other-source', ['legacy-source'])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the source-routing tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/source-routing.test.ts
```

Expected: FAIL because `defaultSharedWorktreeSourceKeys()` and
`isSharedWorktreeFallbackSourceKey()` are not exported yet.

- [ ] **Step 3: Rewrite the routing helper**

Replace `packages/context/src/ingest/isolated-diff/source-routing.ts` with:

```ts
const DEFAULT_SHARED_WORKTREE_SOURCE_KEYS: readonly string[] = [];

export function defaultSharedWorktreeSourceKeys(): string[] {
  return [...DEFAULT_SHARED_WORKTREE_SOURCE_KEYS];
}

export function isSharedWorktreeFallbackSourceKey(
  sourceKey: string,
  sharedWorktreeSourceKeys: readonly string[] = DEFAULT_SHARED_WORKTREE_SOURCE_KEYS,
): boolean {
  return sharedWorktreeSourceKeys.includes(sourceKey);
}
```

- [ ] **Step 4: Rename the private settings field**

In `packages/context/src/ingest/ports.ts`, replace the
`IngestSettingsPort` interface with:

```ts
export interface IngestSettingsPort {
  memoryIngestionModel: string;
  probeRowCount: number;
  workUnitMaxConcurrency?: number;
  workUnitStepBudget?: number;
  workUnitFailureMode?: 'abort' | 'continue';
  sharedWorktreeSourceKeys?: string[];
  ingestTraceLevel?: IngestTraceLevel;
}
```

- [ ] **Step 5: Run the source-routing tests again**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/source-routing.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit routing semantics**

Run:

```bash
git add packages/context/src/ingest/isolated-diff/source-routing.ts \
  packages/context/src/ingest/isolated-diff/source-routing.test.ts \
  packages/context/src/ingest/ports.ts
git commit -m "feat(ingest): make isolated diff routing the private default"
```

### Task 2: Promote the runner default

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`

- [ ] **Step 1: Update the isolated runner test imports and harness**

In `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`,
replace the source-routing import with:

```ts
import { defaultSharedWorktreeSourceKeys } from './isolated-diff/source-routing.js';
```

Then change the `makeDeps()` signature and `settings` block to:

```ts
function makeDeps(
  runtime: Awaited<ReturnType<typeof makeRealGitRuntime>>,
  sourceKey = 'metabase',
  settings: Partial<IngestBundleRunnerDeps['settings']> = {},
) {
```

```ts
    settings: {
      memoryIngestionModel: 'test',
      probeRowCount: 1,
      sharedWorktreeSourceKeys: defaultSharedWorktreeSourceKeys(),
      ingestTraceLevel: 'trace',
      ...settings,
    },
```

- [ ] **Step 2: Add the default-promotion regression tests**

Insert these tests inside
`describe('IngestBundleRunner isolated diff path', ...)`, before the existing
non-Metabase routing matrix:

```ts
  it('routes an unlisted direct-writing source through isolated diffs by default', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const sourceKey = 'custom-direct-source';
      const { deps, adapter } = makeDeps(runtime, sourceKey);
      adapter.chunk.mockResolvedValue({
        workUnits: [
          {
            unitKey: 'custom-wiki',
            rawFiles: ['custom/page.json'],
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
          join(root, 'wiki/global/custom-isolated.md'),
          '---\nsummary: Custom isolated write\nusage_mode: auto\n---\n\nCustom isolated write.\n',
          'utf-8',
        );
        currentSession.actions.push({
          target: 'wiki',
          type: 'created',
          key: 'custom-isolated',
          detail: 'Custom isolated write',
          rawPaths: ['custom/page.json'],
        });
        await currentSession.gitService.commitFiles(
          ['wiki/global/custom-isolated.md'],
          'custom wiki',
          'KTX Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['custom/page.json', 'h1']], sourceKey);

      await expect(
        runner.run({
          jobId: 'job-custom-default',
          connectionId: 'warehouse',
          sourceKey,
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).resolves.toMatchObject({
        jobId: 'job-custom-default',
        failedWorkUnits: [],
        workUnitCount: 1,
      });

      const trace = await readFile(
        join(runtime.configDir, '.ktx/ingest-traces/job-custom-default/trace.jsonl'),
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

  it('keeps the shared-worktree path reachable through explicit private fallback settings', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const sourceKey = 'legacy-source';
      const { deps, adapter } = makeDeps(runtime, sourceKey, {
        sharedWorktreeSourceKeys: ['legacy-source'],
      });
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
          join(root, 'wiki/global/legacy-shared.md'),
          '---\nsummary: Legacy shared write\nusage_mode: auto\n---\n\nLegacy shared write.\n',
          'utf-8',
        );
        currentSession.actions.push({
          target: 'wiki',
          type: 'created',
          key: 'legacy-shared',
          detail: 'Legacy shared write',
          rawPaths: ['legacy/page.json'],
        });
        await currentSession.gitService.commitFiles(
          ['wiki/global/legacy-shared.md'],
          'legacy wiki',
          'KTX Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['legacy/page.json', 'h1']], sourceKey);

      await expect(
        runner.run({
          jobId: 'job-legacy-shared',
          connectionId: 'warehouse',
          sourceKey,
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).resolves.toMatchObject({
        jobId: 'job-legacy-shared',
        failedWorkUnits: [],
        workUnitCount: 1,
      });

      const trace = await readFile(
        join(runtime.configDir, '.ktx/ingest-traces/job-legacy-shared/trace.jsonl'),
        'utf-8',
      );
      expect(trace).toContain('shared_worktree_path_enabled');
      expect(trace).not.toContain('work_unit_child_created');

      const reportCreate = vi.mocked(deps.reports.create).mock.calls.at(-1)?.[0];
      const reportBody = reportCreate?.body as { isolatedDiff?: unknown } | undefined;
      expect(reportBody?.isolatedDiff).toMatchObject({
        enabled: false,
      });
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 3: Run the new runner tests to verify the default test fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts -t "unlisted direct-writing source|shared-worktree path reachable"
```

Expected: FAIL. The unlisted source still enters the old shared-worktree path
because the runner checks `isolatedDiffSourceKeys`.

- [ ] **Step 4: Change the runner routing decision**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, replace
`isIsolatedDiffEnabled()` with:

```ts
  private isSharedWorktreeFallbackEnabled(sourceKey: string): boolean {
    return (this.deps.settings.sharedWorktreeSourceKeys ?? []).includes(sourceKey);
  }
```

Then replace the isolated-diff routing line with:

```ts
      const isolatedDiffEnabled = !overrideReport && !this.isSharedWorktreeFallbackEnabled(job.sourceKey);
```

Finally, replace the shared-path trace event with:

```ts
        await runTrace.event('info', 'routing', 'shared_worktree_path_enabled', {
          sourceKey: job.sourceKey,
          reason: 'explicit_private_fallback',
        });
```

- [ ] **Step 5: Run the new runner tests again**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts -t "unlisted direct-writing source|shared-worktree path reachable"
```

Expected: PASS.

- [ ] **Step 6: Commit runner default promotion**

Run:

```bash
git add packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts
git commit -m "feat(ingest): promote isolated diff to default runner path"
```

### Task 3: Update local runtime defaults

**Files:**
- Modify: `packages/context/src/ingest/local-bundle-runtime.test.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.ts`

- [ ] **Step 1: Update the local runtime settings test type**

In `packages/context/src/ingest/local-bundle-runtime.test.ts`, replace
`RuntimeWithSettingsDeps` with:

```ts
type RuntimeWithSettingsDeps = {
  deps: {
    settings: {
      sharedWorktreeSourceKeys?: string[];
      isolatedDiffSourceKeys?: string[];
    };
  };
};
```

- [ ] **Step 2: Replace the local runtime settings assertion**

Replace the test named
`enables isolated-diff routing for direct durable-write connectors` with:

```ts
  it('defaults local bundle ingest to isolated diffs without an allowlist', () => {
    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      agentRunner: testAgentRunner(),
    });

    const settings = (runtime.runner as unknown as RuntimeWithSettingsDeps).deps.settings;

    expect(settings.sharedWorktreeSourceKeys).toEqual([]);
    expect('isolatedDiffSourceKeys' in settings).toBe(false);
  });
```

- [ ] **Step 3: Run the local runtime settings test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-bundle-runtime.test.ts -t "defaults local bundle ingest"
```

Expected: FAIL because `local-bundle-runtime.ts` still sets
`isolatedDiffSourceKeys`.

- [ ] **Step 4: Update local runtime imports and settings**

In `packages/context/src/ingest/local-bundle-runtime.ts`, replace the
source-routing import with:

```ts
import { defaultSharedWorktreeSourceKeys } from './isolated-diff/source-routing.js';
```

Then replace the settings field:

```ts
      isolatedDiffSourceKeys: defaultIsolatedDiffSourceKeys(),
```

with:

```ts
      sharedWorktreeSourceKeys: defaultSharedWorktreeSourceKeys(),
```

- [ ] **Step 5: Run the local runtime settings test again**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-bundle-runtime.test.ts -t "defaults local bundle ingest"
```

Expected: PASS.

- [ ] **Step 6: Commit local runtime defaults**

Run:

```bash
git add packages/context/src/ingest/local-bundle-runtime.ts \
  packages/context/src/ingest/local-bundle-runtime.test.ts
git commit -m "feat(ingest): default local ingest to isolated diffs"
```

### Task 4: Remove stale allowlist references

**Files:**
- Verify: `packages/context/src/ingest/isolated-diff/source-routing.ts`
- Verify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Verify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Verify: `packages/context/src/ingest/ports.ts`
- Verify: `packages/context/src/ingest/**/*.test.ts`

- [ ] **Step 1: Search for old allowlist names**

Run:

```bash
rg -n "isolatedDiffSourceKeys|defaultIsolatedDiffSourceKeys|ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEYS|isIsolatedDiffDirectWriteSourceKey" packages/context/src
```

Expected: no matches.

- [ ] **Step 2: Search for the new fallback setting**

Run:

```bash
rg -n "sharedWorktreeSourceKeys|defaultSharedWorktreeSourceKeys|isSharedWorktreeFallbackSourceKey" packages/context/src
```

Expected: matches only in these files:

```text
packages/context/src/ingest/ports.ts
packages/context/src/ingest/ingest-bundle.runner.ts
packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts
packages/context/src/ingest/isolated-diff/source-routing.ts
packages/context/src/ingest/isolated-diff/source-routing.test.ts
packages/context/src/ingest/local-bundle-runtime.ts
packages/context/src/ingest/local-bundle-runtime.test.ts
```

- [ ] **Step 3: Run a focused no-allowlist regression suite**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/isolated-diff/source-routing.test.ts \
  src/ingest/local-bundle-runtime.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  -t "source routing|defaults local bundle ingest|unlisted direct-writing source|shared-worktree path reachable|routes notion|routes lookml|routes looker|routes dbt|routes metricflow"
```

Expected: PASS.

- [ ] **Step 4: Commit stale-reference cleanup if needed**

If Step 1 or Step 2 required any edits, run:

```bash
git add packages/context/src/ingest
git commit -m "chore(ingest): remove isolated diff allowlist references"
```

If no files changed, record that no cleanup commit was needed in the execution
notes for this task.

### Task 5: Final verification

**Files:**
- Verify: `packages/context/src/ingest/isolated-diff/source-routing.ts`
- Verify: `packages/context/src/ingest/isolated-diff/source-routing.test.ts`
- Verify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Verify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`
- Verify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Verify: `packages/context/src/ingest/local-bundle-runtime.test.ts`
- Verify: `packages/context/src/ingest/ports.ts`
- Verify: `docs/superpowers/plans/2026-05-18-isolated-diff-ingestion-v1-default-promotion.md`

- [ ] **Step 1: Run the full isolated-diff focused suite**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/ingest-trace.test.ts \
  src/ingest/wiki-body-refs.test.ts \
  src/ingest/artifact-gates.test.ts \
  src/ingest/semantic-layer-target-policy.test.ts \
  src/ingest/isolated-diff/source-routing.test.ts \
  src/ingest/isolated-diff/git-patch.test.ts \
  src/ingest/isolated-diff/work-unit-executor.test.ts \
  src/ingest/isolated-diff/patch-integrator.test.ts \
  src/ingest/isolated-diff/textual-conflict-resolver.test.ts \
  src/ingest/final-gate-repair.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  src/ingest/report-snapshot.test.ts \
  src/ingest/local-bundle-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the MetricFlow local ingest regression**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-bundle-ingest.test.ts -t "runs full MetricFlow local ingest"
```

Expected: PASS. The report body includes `isolatedDiff.enabled: true`,
`acceptedPatches: 0`, and a string `projectionSha`.

- [ ] **Step 3: Run package type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 4: Run package tests**

Run:

```bash
pnpm --filter @ktx/context run test
```

Expected: PASS.

- [ ] **Step 5: Run TypeScript dead-code checks**

Run:

```bash
pnpm run dead-code
```

Expected: PASS, or only pre-existing findings unrelated to the files changed
by this plan. Investigate any finding that names `source-routing.ts`,
`ports.ts`, `local-bundle-runtime.ts`, or `ingest-bundle.runner.ts`.

- [ ] **Step 6: Decide whether docs-site needs an update**

No `docs-site/content/docs/` change is expected for this plan because the
change is an internal runner rollout switch and does not add or remove public
CLI commands, flags, config fields, connector setup steps, or user-facing
documentation concepts.

- [ ] **Step 7: Commit final verification notes**

Run:

```bash
git status --short
git add docs/superpowers/plans/2026-05-18-isolated-diff-ingestion-v1-default-promotion.md
git commit -m "docs: add isolated diff default promotion plan"
```

Only include the plan file in this commit if all implementation commits have
already captured their code changes.

## Completion criteria

This plan is complete when:

- `packages/context/src/ingest/ports.ts` has
  `sharedWorktreeSourceKeys?: string[]` and no `isolatedDiffSourceKeys` field.
- `IngestBundleRunner` uses isolated diffs for every non-override source unless
  `sharedWorktreeSourceKeys` explicitly contains that source.
- The trace for a default-routed source contains `isolated_diff_enabled` and
  not `shared_worktree_path_enabled`.
- The trace for an explicitly fallback-routed source contains
  `shared_worktree_path_enabled` and not `work_unit_child_created`.
- Local runtime settings default `sharedWorktreeSourceKeys` to `[]`.
- No production or test code under `packages/context/src` references the old
  isolated-diff allowlist names.
- The focused isolated-diff suite, MetricFlow local ingest regression,
  `@ktx/context` type-check, `@ktx/context` tests, and dead-code checks pass.

## Next rollout step

After this plan is implemented and verified, the only remaining v1-blocking
rollout item from the spec is step 11: remove the old shared-worktree WorkUnit
execution path and delete the private `sharedWorktreeSourceKeys` fallback
setting.
