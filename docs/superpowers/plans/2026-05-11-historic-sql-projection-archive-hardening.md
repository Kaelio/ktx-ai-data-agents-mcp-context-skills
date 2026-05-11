# Historic SQL Projection Archive Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep historic-SQL archived pattern pages stable across runs and add projection regression coverage for archive, stale-table, and legacy-page behavior from the redesign spec.

**Architecture:** The redesigned historic-SQL pipeline is already cut over. This plan only hardens the deterministic projection step by treating `knowledge/global/historic-sql/_archived/*.md` pages as historical records, not active candidates for slug reuse or stale/archive processing. Tests stay in the existing projection unit suite because the behavior is pure filesystem projection.

**Tech Stack:** TypeScript ESM/NodeNext, Vitest, YAML, local filesystem fixtures.

---

## Starting Point

Spec: `docs/superpowers/specs/2026-05-11-historic-sql-redesign-design.md`

Plans found that are based on this spec:

- `docs/superpowers/plans/2026-05-11-historic-sql-foundations.md`
- `docs/superpowers/plans/2026-05-11-historic-sql-search-enrichment.md`
- `docs/superpowers/plans/2026-05-11-historic-sql-unified-hot-path.md`
- `docs/superpowers/plans/2026-05-11-historic-sql-skills-projection-cutover.md`
- `docs/superpowers/plans/2026-05-11-historic-sql-cross-dialect-readiness.md`
- `docs/superpowers/plans/2026-05-11-historic-sql-docs-smoke-and-config-cleanup.md`

Implemented status verified from this worktree:

- `2026-05-11-historic-sql-foundations.md` is implemented. Evidence: `packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts`, `packages/context/src/sql-analysis/ports.ts` exposes `analyzeBatch()`, `python/ktx-daemon/src/ktx_daemon/app.py` registers `/sql/analyze-batch`, `packages/context/src/sl/types.ts` has `SemanticLayerSource.usage`, and `packages/context/src/ingest/adapters/live-database/manifest.ts` has `mergeUsagePreservingExternal()`.
- `2026-05-11-historic-sql-search-enrichment.md` is implemented. Evidence: `packages/context/src/sl/sl-search.service.ts` indexes `source.usage`, `packages/context/src/sl/sqlite-sl-sources-index.ts` selects FTS snippets, and local/MCP list surfaces expose `frequencyTier` and `snippet`.
- `2026-05-11-historic-sql-unified-hot-path.md` is implemented. Evidence: `stageHistoricSqlAggregatedSnapshot()`, `chunkHistoricSqlUnifiedStagedDir()`, `PostgresPgssReader`, aggregate BigQuery/Snowflake `fetchAggregated()` methods, unified schemas, and exports exist.
- `2026-05-11-historic-sql-skills-projection-cutover.md` is implemented. Evidence: `HistoricSqlSourceAdapter` uses the unified stager/chunker, `packages/context/skills/historic_sql_table_digest/` and `packages/context/skills/historic_sql_patterns/` exist, `emit_historic_sql_evidence` exists, `HistoricSqlProjectionPostProcessor` is wired in `packages/context/src/ingest/local-bundle-runtime.ts`, and legacy skill names no longer grep in `packages/context` or `packages/cli`.
- `2026-05-11-historic-sql-cross-dialect-readiness.md` is implemented. Evidence: `packages/cli/src/local-adapters.test.ts` covers Postgres, BigQuery, and Snowflake historic-SQL registration, and `packages/cli/src/historic-sql-doctor.test.ts` covers low `pg_stat_statements.max` as informational output.
- `2026-05-11-historic-sql-docs-smoke-and-config-cleanup.md` is implemented. Evidence: `packages/cli/src/setup-databases.test.ts` expects canonical `historicSql.filters.serviceAccounts`, `examples/postgres-historic/scripts/smoke.sh` asserts `manifest.json`, `tables/*.json`, `patterns-input.json`, and zero WorkUnits on the unchanged run, and public docs use `minExecutions`.

Remaining issue this plan fixes:

- `packages/context/src/ingest/adapters/historic-sql/projection.ts` recursively loads every markdown page below `knowledge/global/historic-sql`, including pages already under `_archived/`.
- Because archived pages still have `source: historic-sql` and tags `['historic-sql', 'pattern', 'archived']`, they are currently active candidates for slug reuse and stale/archive processing.
- A reappearing pattern can be written back to `_archived/<slug>.md` instead of active `historic-sql/<slug>.md`.
- A later no-pattern run can move an already archived page to `_archived/_archived/<slug>.md`.
- `projection.test.ts` does not cover stale table marking, legacy query-page deletion, or the archived-page stability behavior required by spec §5.3 and §10.2.

## File Structure

- Modify `packages/context/src/ingest/adapters/historic-sql/projection.ts`: add an archived-page predicate and exclude archived pages from active pattern slug matching and stale/archive loops.
- Modify `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`: add failing tests for archived-page stability, active slug restoration after a pattern reappears, stale table marking, and legacy query-page cleanup.

### Task 1: Add Archived Pattern Projection Regression Tests

**Files:**
- Modify: `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`

- [ ] **Step 1: Add failing tests for archived page handling**

Append these tests inside the existing `describe('projectHistoricSqlEvidence', ...)` block in `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`:

```typescript
  it('writes a reappearing pattern to the active slug instead of reusing an archived page key', async () => {
    const workdir = await tempWorkdir();
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/manifest.json', {
      source: 'historic-sql',
      connectionId: 'warehouse',
      dialect: 'postgres',
      fetchedAt: '2026-05-11T00:00:00.000Z',
      windowStart: '2026-02-10T00:00:00.000Z',
      windowEnd: '2026-05-11T00:00:00.000Z',
      snapshotRowCount: 2,
      touchedTableCount: 2,
      parseFailures: 0,
      warnings: [],
      probeWarnings: [],
      staleArchiveAfterDays: 30,
    });
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/tables/public.orders.json', { table: 'public.orders' });
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/tables/public.customers.json', { table: 'public.customers' });
    await writeText(
      workdir,
      'knowledge/global/historic-sql/_archived/order-lifecycle-analysis.md',
      [
        '---',
        YAML.stringify({
          summary: 'Archived order lifecycle page',
          tags: ['historic-sql', 'pattern', 'archived'],
          refs: [],
          sl_refs: ['orders'],
          usage_mode: 'auto',
          source: 'historic-sql',
          tables: ['public.orders', 'public.customers'],
          fingerprints: ['pg:1'],
          stale_since: '2026-01-01T00:00:00.000Z',
        }).trimEnd(),
        '---',
        '',
        'Archived body',
        '',
      ].join('\n'),
    );
    await writeJson(workdir, '.ktx/ingest-evidence/historic-sql/run-1/pattern.json', {
      kind: 'pattern',
      connectionId: 'warehouse',
      rawPath: 'patterns-input.json',
      pattern: {
        slug: 'order-lifecycle-analysis',
        title: 'Order Lifecycle Analysis',
        narrative: 'Analysts compare order status with customer segment again.',
        definitionSql: 'select * from public.orders join public.customers on customers.id = orders.customer_id',
        tablesInvolved: ['public.orders', 'public.customers'],
        slRefs: ['orders', 'customers'],
        constituentTemplateIds: ['pg:1', 'pg:2'],
      },
    });

    const result = await projectHistoricSqlEvidence({ workdir, connectionId: 'warehouse', syncId: 'sync-1', runId: 'run-1' });

    expect(result.patternPagesWritten).toBe(1);
    await expect(readFile(join(workdir, 'knowledge/global/historic-sql/order-lifecycle-analysis.md'), 'utf-8')).resolves.toContain(
      'Order Lifecycle Analysis',
    );
    await expect(readFile(join(workdir, 'knowledge/global/historic-sql/_archived/order-lifecycle-analysis.md'), 'utf-8')).resolves.toContain(
      'Archived body',
    );
    await expect(
      readFile(join(workdir, 'knowledge/global/historic-sql/_archived/_archived/order-lifecycle-analysis.md'), 'utf-8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves already archived pattern pages stable when they are still absent', async () => {
    const workdir = await tempWorkdir();
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/manifest.json', {
      source: 'historic-sql',
      connectionId: 'warehouse',
      dialect: 'postgres',
      fetchedAt: '2026-05-11T00:00:00.000Z',
      windowStart: '2026-02-10T00:00:00.000Z',
      windowEnd: '2026-05-11T00:00:00.000Z',
      snapshotRowCount: 0,
      touchedTableCount: 0,
      parseFailures: 0,
      warnings: [],
      probeWarnings: [],
      staleArchiveAfterDays: 30,
    });
    await writeText(
      workdir,
      'knowledge/global/historic-sql/_archived/retired-pattern.md',
      [
        '---',
        YAML.stringify({
          summary: 'Retired pattern',
          tags: ['historic-sql', 'pattern', 'archived'],
          refs: [],
          sl_refs: [],
          usage_mode: 'auto',
          source: 'historic-sql',
          tables: ['public.tickets'],
          fingerprints: ['pg:9'],
          stale_since: '2026-01-01T00:00:00.000Z',
        }).trimEnd(),
        '---',
        '',
        'Archived retired body',
        '',
      ].join('\n'),
    );

    const result = await projectHistoricSqlEvidence({ workdir, connectionId: 'warehouse', syncId: 'sync-1', runId: 'run-1' });

    expect(result.archivedPatternPages).toBe(0);
    expect(result.stalePatternPagesMarked).toBe(0);
    await expect(readFile(join(workdir, 'knowledge/global/historic-sql/_archived/retired-pattern.md'), 'utf-8')).resolves.toContain(
      'Archived retired body',
    );
    await expect(readFile(join(workdir, 'knowledge/global/historic-sql/_archived/_archived/retired-pattern.md'), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
```

- [ ] **Step 2: Run projection tests to verify the archived-page tests fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/projection.test.ts
```

Expected: FAIL. The first new test should fail because `knowledge/global/historic-sql/order-lifecycle-analysis.md` is not written. The second new test should fail because `result.archivedPatternPages` is `1` or `_archived/_archived/retired-pattern.md` exists.

### Task 2: Exclude Archived Pages From Active Projection Processing

**Files:**
- Modify: `packages/context/src/ingest/adapters/historic-sql/projection.ts`
- Test: `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`

- [ ] **Step 1: Add the archived-page predicate**

In `packages/context/src/ingest/adapters/historic-sql/projection.ts`, add this function after `isLegacyQueryPage()`:

```typescript
function isArchivedPatternPage(page: HistoricSqlPatternPage): boolean {
  const tags = Array.isArray(page.frontmatter.tags) ? page.frontmatter.tags : [];
  return page.key.startsWith('_archived/') || tags.includes('archived');
}
```

- [ ] **Step 2: Use only active pattern pages for slug matching and stale/archive processing**

In `projectHistoricSqlEvidence()`, replace:

```typescript
  const allPages = await loadPatternPages(wikiRoot);
  const patternPages = allPages.filter(isHistoricPatternPage);
```

with:

```typescript
  const allPages = await loadPatternPages(wikiRoot);
  const activePages = allPages.filter((page) => !isArchivedPatternPage(page));
  const patternPages = activePages.filter(isHistoricPatternPage);
```

- [ ] **Step 3: Run projection tests to verify the archived-page fix passes**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/projection.test.ts
```

Expected: PASS. All projection tests pass, including the two archived-page tests from Task 1.

- [ ] **Step 4: Commit**

```bash
git add packages/context/src/ingest/adapters/historic-sql/projection.ts packages/context/src/ingest/adapters/historic-sql/projection.test.ts
git commit -m "fix: keep historic sql archived patterns stable"
```

### Task 3: Add Stale Table And Legacy Page Cleanup Regression Coverage

**Files:**
- Modify: `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`

- [ ] **Step 1: Add projection coverage for table drift and legacy query-page cleanup**

Append this test inside the existing `describe('projectHistoricSqlEvidence', ...)` block in `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`:

```typescript
  it('marks missing table usage stale and deletes legacy historic SQL query pages', async () => {
    const workdir = await tempWorkdir();
    await writeText(
      workdir,
      'semantic-layer/warehouse/_schema/public.yaml',
      YAML.stringify({
        tables: {
          orders: {
            table: 'public.orders',
            usage: {
              narrative: 'Orders were active before.',
              frequencyTier: 'high',
              commonFilters: ['status'],
              commonGroupBys: ['status'],
              commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
              ownerNote: 'keep analyst annotation',
            },
            columns: [{ name: 'id', type: 'string' }],
          },
        },
      }),
    );
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/manifest.json', {
      source: 'historic-sql',
      connectionId: 'warehouse',
      dialect: 'postgres',
      fetchedAt: '2026-05-11T00:00:00.000Z',
      windowStart: '2026-02-10T00:00:00.000Z',
      windowEnd: '2026-05-11T00:00:00.000Z',
      snapshotRowCount: 0,
      touchedTableCount: 0,
      parseFailures: 0,
      warnings: [],
      probeWarnings: [],
      staleArchiveAfterDays: 90,
    });
    await writeText(
      workdir,
      'knowledge/global/historic-sql/legacy-template.md',
      [
        '---',
        YAML.stringify({
          summary: 'Legacy template page',
          tags: ['historic-sql', 'query-pattern'],
          refs: [],
          sl_refs: ['orders'],
          usage_mode: 'auto',
          source: 'historic-sql',
          tables: ['public.orders'],
          fingerprints: ['legacy:1'],
        }).trimEnd(),
        '---',
        '',
        'Legacy body',
        '',
      ].join('\n'),
    );

    const result = await projectHistoricSqlEvidence({ workdir, connectionId: 'warehouse', syncId: 'sync-1', runId: 'run-1' });

    expect(result.staleTablesMarked).toBe(1);
    expect(result.legacyPagesDeleted).toBe(1);
    expect(result.touchedSources).toEqual([{ connectionId: 'warehouse', sourceName: 'orders' }]);
    const shard = YAML.parse(await readFile(join(workdir, 'semantic-layer/warehouse/_schema/public.yaml'), 'utf-8'));
    expect(shard.tables.orders.usage).toEqual({
      ownerNote: 'keep analyst annotation',
      narrative: 'No recent historic SQL usage was observed in the latest snapshot.',
      frequencyTier: 'unused',
      commonFilters: [],
      commonGroupBys: [],
      commonJoins: [],
      staleSince: '2026-05-11T00:00:00.000Z',
    });
    await expect(readFile(join(workdir, 'knowledge/global/historic-sql/legacy-template.md'), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
```

- [ ] **Step 2: Run projection tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/projection.test.ts
```

Expected: PASS. The new regression test should pass with the current implementation after Task 2, proving stale table drift and legacy query-page cleanup stay covered.

- [ ] **Step 3: Commit**

```bash
git add packages/context/src/ingest/adapters/historic-sql/projection.test.ts
git commit -m "test: cover historic sql projection cleanup"
```

### Task 4: Final Verification

**Files:**
- Verify: `packages/context/src/ingest/adapters/historic-sql/projection.ts`
- Verify: `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`

- [ ] **Step 1: Run the focused projection test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/projection.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the focused historic-SQL adapter test group**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/adapters/historic-sql/evidence.test.ts \
  src/ingest/adapters/historic-sql/evidence-tool.test.ts \
  src/ingest/adapters/historic-sql/projection.test.ts \
  src/ingest/adapters/historic-sql/post-processor.test.ts \
  src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run context type check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 4: Confirm old historic-SQL code paths remain absent**

Run:

```bash
rg -n "stagePgStatStatementsTemplates|expandCategoricalTemplates|classifySlot|historic_sql_ingest|historic_sql_curator|PostgresPgssQueryHistoryReader|historic_sql_template" packages/context packages/cli
```

Expected: no output and exit code 1.

- [ ] **Step 5: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 6: Commit verification fixes only if verification changed files**

If verification required an edit, commit the exact touched files:

```bash
git add packages/context/src/ingest/adapters/historic-sql/projection.ts packages/context/src/ingest/adapters/historic-sql/projection.test.ts
git commit -m "test: verify historic sql projection archive hardening"
```

If verification made no edits, do not create an empty commit.

## Self-Review

Spec coverage:

- Spec §5.3 stale pattern handling is covered by Task 1 and Task 2: archived pages are historical records and are not repeatedly archived or reused as active slug targets.
- Spec §10.2 legacy wiki page cleanup is covered by Task 3.
- Spec §10.4 drift behavior is covered by Task 3: a table absent from the latest snapshot receives `usage.staleSince` while external usage keys remain intact.
- Spec §10.6 slug churn and user-edited usage risks are covered by Task 1 and Task 3.

Placeholder scan:

- The plan contains no unresolved marker text from the forbidden-pattern list.
- Every code-changing step names exact files, exact inserted or replacement code, exact commands, and expected outcomes.

Type consistency:

- `staleSince`, `frequencyTier`, `commonFilters`, `commonGroupBys`, and `commonJoins` match `tableUsageOutputSchema`.
- `stale_since`, `tags`, `tables`, and `fingerprints` match the existing wiki frontmatter shape used in `projection.ts`.
- `archivedPatternPages`, `stalePatternPagesMarked`, `staleTablesMarked`, and `legacyPagesDeleted` match `HistoricSqlProjectionResult`.

Plan complete and saved to `docs/superpowers/plans/2026-05-11-historic-sql-projection-archive-hardening.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
