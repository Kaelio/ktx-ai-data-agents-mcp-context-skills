# Adapter-Owned Finalization V1 Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining adapter-owned finalization v1 verification gaps so the finalization contract is publicly typed and the historic-SQL local acceptance path passes through `SourceAdapter.finalize()`.

**Architecture:** The production runner already owns finalization execution, commits, target policy, final gates, reports, traces, and provenance. This plan keeps production behavior intact, exports the finalization adapter types through the ingest barrel, and updates the local historic-SQL acceptance fixture to model the real adapter-owned finalization path instead of the removed post-processor path.

**Tech Stack:** TypeScript ESM/NodeNext, Vitest, pnpm workspace commands, existing `SourceAdapter`, `projectHistoricSqlEvidence()`, and package export coverage.

---

## Audit summary

The audit compared
`docs/superpowers/specs/2026-05-18-adapter-owned-ingest-finalization-design.md`
against the implemented source, plan, and targeted tests.

Implemented v1 coverage:

- `SourceAdapter.finalize()` exists with typed context and result objects in
  `packages/context/src/ingest/types.ts`.
- `IngestBundleRunnerDeps.postProcessors`, `IngestBundlePostProcessorPort`,
  `HistoricSqlProjectionPostProcessor`, `post_processor` trace phases, and
  `postProcessor` report fields are absent from production source.
- The runner invokes finalization after reconciliation and before
  `wiki_sl_ref_repair`, target-policy checks, final artifact gates,
  provenance validation, and squash.
- The runner derives finalization touched paths from the integration-worktree
  diff, resolves semantic-layer scope including `_schema/*.yaml`, cross-checks
  adapter declarations, commits finalization, records reports/traces, rejects
  path overlap, and partitions finalization actions for provenance exclusions.
- Override replay passes explicit `overrideReplay` metadata, omits
  `parseArtifacts`, and leaves current-run `workUnitOutcomes` empty.
- Historic SQL implements adapter-owned `finalize()` and uses
  `projectHistoricSqlEvidence()` for aggregate projection maintenance.

V1-blocking gaps:

- `packages/context/src/ingest/index.ts` exports `SourceAdapter` and projection
  types, but not `DeterministicFinalizationContext`,
  `FinalizationOverrideReplay`, or `FinalizationResult`. The adapter contract is
  less usable from the public ingest barrel than the spec requires.
- The targeted verification command currently fails because
  `HistoricSqlEvidenceTestAdapter` in
  `packages/context/src/ingest/local-bundle-ingest.test.ts` lacks
  `finalize()`, so `result.report.body.finalization` is `undefined` in the
  local historic-SQL projection acceptance test.

Non-blocking gaps:

- Older historical plan documents still mention post-processors. They are
  archived implementation history and do not affect runtime behavior.
- The runner has helper-level declaration mismatch coverage, but no dedicated
  local-bundle integration test for a finalization declaration mismatch. The
  implementation path exists; adding a higher-level regression test can be a
  later hardening pass.
- Finalization wiki page deletion could use a future global wiki-reference gate
  regression. Historic-SQL v1 finalization updates or archives pages in place,
  so this is not required for the current v1 acceptance path.

## File structure

- Modify `packages/context/src/ingest/index.ts`.
  Re-export the typed finalization adapter contract next to the existing
  projection contract.
- Modify `packages/context/src/package-exports.test.ts`.
  Add compile-time coverage proving finalization adapter types are exported
  from the ingest barrel.
- Modify `packages/context/src/ingest/local-bundle-ingest.test.ts`.
  Make the historic-SQL local acceptance test adapter implement
  `finalize()` by delegating to `projectHistoricSqlEvidence()`, and rename the
  stale test label from post-processor to finalization.

---

### Task 1: Export finalization adapter contract types

**Files:**
- Modify: `packages/context/src/package-exports.test.ts`
- Modify: `packages/context/src/ingest/index.ts`

- [ ] **Step 1: Write failing type export coverage**

In `packages/context/src/package-exports.test.ts`, add this import after the
existing Vitest import:

```ts
import type {
  DeterministicFinalizationContext,
  FinalizationOverrideReplay,
  FinalizationResult,
} from './ingest/index.js';
```

Then add this constant after `scanTypeExportCoverage`:

```ts
const ingestFinalizationTypeExportCoverage: Partial<{
  context: DeterministicFinalizationContext;
  overrideReplay: FinalizationOverrideReplay;
  result: FinalizationResult;
}> = {};
```

Inside the existing package export test, place this assertion immediately after
`expect(scanTypeExportCoverage).toEqual({});`:

```ts
expect(ingestFinalizationTypeExportCoverage).toEqual({});
```

- [ ] **Step 2: Run type-check to verify the coverage fails**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: FAIL with TypeScript errors like:

```text
Module '"./ingest/index.js"' has no exported member 'DeterministicFinalizationContext'.
Module '"./ingest/index.js"' has no exported member 'FinalizationOverrideReplay'.
Module '"./ingest/index.js"' has no exported member 'FinalizationResult'.
```

- [ ] **Step 3: Export the finalization types**

In `packages/context/src/ingest/index.ts`, update the existing export block
from `./types.js` so the final lines read:

```ts
  WorkUnit,
  DeterministicProjectionContext,
  ProjectionResult,
  DeterministicFinalizationContext,
  FinalizationOverrideReplay,
  FinalizationResult,
} from './types.js';
```

- [ ] **Step 4: Run type-check and package export coverage**

Run:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/context exec vitest run src/package-exports.test.ts
```

Expected: both commands PASS.

- [ ] **Step 5: Commit the type export closure**

Run:

```bash
git add packages/context/src/ingest/index.ts packages/context/src/package-exports.test.ts
git commit -m "feat(ingest): export finalization adapter contract types"
```

### Task 2: Repair the local historic-SQL finalization acceptance fixture

**Files:**
- Modify: `packages/context/src/ingest/local-bundle-ingest.test.ts`

- [ ] **Step 1: Import the projection helper and finalization types**

In `packages/context/src/ingest/local-bundle-ingest.test.ts`, add this import
after the fake adapter import:

```ts
import { projectHistoricSqlEvidence } from './adapters/historic-sql/projection.js';
```

Replace the existing type import from `./types.js` with:

```ts
import type {
  ChunkResult,
  DeterministicFinalizationContext,
  DiffSet,
  FinalizationResult,
  SourceAdapter,
} from './types.js';
```

- [ ] **Step 2: Add adapter-owned finalization to the test adapter**

In `HistoricSqlEvidenceTestAdapter`, add this method after `chunk()`:

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

- [ ] **Step 3: Rename the stale test label**

Change the test name:

```ts
it('runs historic-SQL evidence projection through the local bundle post-processor', async () => {
```

to:

```ts
it('runs historic-SQL evidence projection through local bundle finalization', async () => {
```

- [ ] **Step 4: Run the focused failing test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-bundle-ingest.test.ts -t "historic-SQL evidence projection"
```

Expected: PASS, and the assertion at
`packages/context/src/ingest/local-bundle-ingest.test.ts:551` receives a
`result.report.body.finalization` object with `status: "success"`.

- [ ] **Step 5: Commit the local acceptance fixture**

Run:

```bash
git add packages/context/src/ingest/local-bundle-ingest.test.ts
git commit -m "test(ingest): exercise historic sql finalization locally"
```

### Task 3: Run final verification

**Files:**
- Verify: `packages/context/src/ingest/finalization-scope.test.ts`
- Verify: `packages/context/src/ingest/ingest-bundle.runner.test.ts`
- Verify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`
- Verify: `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`
- Verify: `packages/context/src/ingest/local-bundle-ingest.test.ts`
- Verify: `packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts`
- Verify: workspace TypeScript and dead-code checks

- [ ] **Step 1: Run the adapter-owned finalization targeted suite**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/finalization-scope.test.ts src/ingest/ingest-bundle.runner.test.ts src/ingest/ingest-bundle.runner.isolated-diff.test.ts src/ingest/adapters/historic-sql/projection.test.ts src/ingest/local-bundle-ingest.test.ts src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts
```

Expected: PASS with all six test files passing.

- [ ] **Step 2: Run TypeScript validation**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Run dead-code validation**

Run:

```bash
pnpm run dead-code
```

Expected: PASS.

- [ ] **Step 4: Inspect final status**

Run:

```bash
git status --short
```

Expected: only the intended committed changes are present, or the worktree is
clean after the two commits.

## Docs impact

No `docs-site/content/docs/` update is required. The remaining v1 work is an
adapter contract type export and test acceptance closure; it does not change
CLI behavior, user configuration, setup flow, connector behavior, or public
documentation examples.

## Self-review

- Spec coverage: The plan covers the remaining adapter API usability gap and
  the failing historic-SQL local finalization acceptance path. The main
  runner, reports, traces, provenance, override replay, and historic-SQL
  production finalization behavior already exist.
- Placeholder scan: The plan contains no placeholder tasks or unspecified
  implementation steps.
- Type consistency: `DeterministicFinalizationContext`,
  `FinalizationOverrideReplay`, and `FinalizationResult` match the existing
  names in `packages/context/src/ingest/types.ts`; the test adapter delegates
  to the existing `projectHistoricSqlEvidence()` result shape.
