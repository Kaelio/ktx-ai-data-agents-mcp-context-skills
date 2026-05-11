# Historic SQL End-To-End Retrieval Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one focused regression test that proves the redesigned historic-SQL pipeline reaches both agent retrieval surfaces after a real scheduled local ingest run.

**Architecture:** All historic-SQL redesign implementation slices are already present. This plan adds acceptance coverage around the existing production `HistoricSqlSourceAdapter`: a fake aggregate reader and fake batch SQL analysis drive the deterministic hot path, a fake `AgentRunnerService` emits typed table and pattern evidence through `emit_historic_sql_evidence`, and the normal local ingest runner performs projection, squash, wiki indexing, and semantic-layer reindexing.

**Tech Stack:** TypeScript ESM/NodeNext, Vitest, YAML, SQLite FTS5 local search, existing local ingest runner, existing historic-SQL adapter.

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
- `docs/superpowers/plans/2026-05-11-historic-sql-projection-archive-hardening.md`

Implemented status verified from this worktree:

- `2026-05-11-historic-sql-foundations.md` is implemented. Evidence: `packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts`, `packages/context/src/sql-analysis/ports.ts` exposes `analyzeBatch()`, `python/ktx-daemon/src/ktx_daemon/app.py` registers `/sql/analyze-batch`, `packages/context/src/sl/types.ts` has `SemanticLayerSource.usage`, and `packages/context/src/ingest/adapters/live-database/manifest.ts` has `mergeUsagePreservingExternal()`.
- `2026-05-11-historic-sql-search-enrichment.md` is implemented. Evidence: `packages/context/src/sl/sl-search.service.ts` indexes `source.usage`, `packages/context/src/sl/sqlite-sl-sources-index.ts` selects FTS snippets, and local/MCP list surfaces expose `frequencyTier` and `snippet`.
- `2026-05-11-historic-sql-unified-hot-path.md` is implemented. Evidence: `stageHistoricSqlAggregatedSnapshot()`, `chunkHistoricSqlUnifiedStagedDir()`, `PostgresPgssReader`, aggregate BigQuery/Snowflake `fetchAggregated()` methods, unified schemas, and package exports exist.
- `2026-05-11-historic-sql-skills-projection-cutover.md` is implemented. Evidence: `HistoricSqlSourceAdapter` uses the unified stager/chunker, `packages/context/skills/historic_sql_table_digest/` and `packages/context/skills/historic_sql_patterns/` exist, `emit_historic_sql_evidence` exists, `HistoricSqlProjectionPostProcessor` is wired in `packages/context/src/ingest/local-bundle-runtime.ts`, and legacy skill names no longer grep in `packages/context` or `packages/cli`.
- `2026-05-11-historic-sql-cross-dialect-readiness.md` is implemented. Evidence: `packages/cli/src/local-adapters.test.ts` covers Postgres, BigQuery, and Snowflake historic-SQL registration, and `packages/cli/src/historic-sql-doctor.test.ts` covers low `pg_stat_statements.max` as informational output.
- `2026-05-11-historic-sql-docs-smoke-and-config-cleanup.md` is implemented. Evidence: `packages/cli/src/setup-databases.test.ts` expects canonical `historicSql.filters.serviceAccounts`, `examples/postgres-historic/scripts/smoke.sh` asserts unified `manifest.json`, `tables/*.json`, `patterns-input.json`, and zero WorkUnits on the unchanged run, and public docs use `minExecutions`.
- `2026-05-11-historic-sql-projection-archive-hardening.md` is implemented. Evidence: `projection.ts` has `isArchivedPatternPage()`, excludes archived pages from active slug matching, and `projection.test.ts` covers reappearing archived patterns, stable archived pages, stale table marking, and legacy query-page deletion.

Remaining acceptance gap this plan covers:

- The current Postgres example smoke is intentionally stage-only, so it verifies raw artifacts and zero unchanged WorkUnits but does not prove table/pattern evidence projection and retrieval.
- `packages/context/src/ingest/local-bundle-ingest.test.ts` verifies the historic-SQL post-processor with a source-dir test adapter, but it does not exercise the production `HistoricSqlSourceAdapter` scheduled-pull path or the `historic_sql_patterns` WorkUnit.
- Existing SL and wiki search tests prove the search layers independently, but no single regression proves spec §7's retrieval chain after historic-SQL ingest writes `_schema` usage and `knowledge/global/historic-sql/*.md`.

## File Structure

Create:

- `packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts`  
  Owns the end-to-end local regression for the redesigned historic-SQL pipeline. It uses the real adapter and local ingest runner, with fake deterministic reader/analysis/agent components so the test does not need a live database or LLM provider.

## Task 1: Add Real-Adapter Local Ingest Acceptance Coverage

**Files:**
- Create: `packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts`

- [ ] **Step 1: Verify the acceptance test does not exist yet**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts
```

Expected: FAIL with "No test files found" because no end-to-end historic-SQL retrieval acceptance test exists yet.

- [ ] **Step 2: Write the acceptance test**

Create `packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts`:

```typescript
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { AgentRunnerService } from '../../../agent/index.js';
import { initKtxProject, loadKtxProject, type KtxLocalProject } from '../../../project/index.js';
import { type SqlAnalysisPort } from '../../../sql-analysis/index.js';
import { searchLocalSlSources } from '../../../sl/local-sl.js';
import { searchLocalKnowledgePages } from '../../../wiki/local-knowledge.js';
import { runLocalIngest } from '../../local-ingest.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoricSqlSourceAdapter } from './historic-sql.adapter.js';
import type { AggregatedTemplate, HistoricSqlReader, HistoricSqlUnifiedPullConfig } from './types.js';

class AcceptanceHistoricSqlReader implements HistoricSqlReader {
  async probe() {
    return { warnings: [], info: [] };
  }

  async *fetchAggregated(
    _client: unknown,
    _window: { start: Date; end: Date },
    _config: HistoricSqlUnifiedPullConfig,
  ): AsyncIterable<AggregatedTemplate> {
    yield {
      templateId: 'pg:orders-lifecycle',
      canonicalSql:
        'select o.status, c.segment, count(*) from public.orders o join public.customers c on c.id = o.customer_id where o.status = $1 group by o.status, c.segment',
      dialect: 'postgres',
      stats: {
        executions: 42,
        distinctUsers: 4,
        firstSeen: '2026-05-01T00:00:00.000Z',
        lastSeen: '2026-05-11T00:00:00.000Z',
        p50RuntimeMs: 18,
        p95RuntimeMs: 84,
        errorRate: 0,
        rowsProduced: 420,
      },
      topUsers: [{ user: 'analyst@example.test', executions: 42 }],
    };
  }
}

class HistoricSqlAcceptanceAgentRunner extends AgentRunnerService {
  override runLoop = vi.fn(async (params: any) => {
    if (params.telemetryTags?.operationName !== 'ingest-bundle-wu') {
      return { stopReason: 'natural' as const };
    }

    const emitEvidence = params.toolSet.emit_historic_sql_evidence;
    if (!emitEvidence?.execute) {
      throw new Error('emit_historic_sql_evidence tool was not available to the historic-SQL WorkUnit');
    }

    if (params.telemetryTags.unitKey === 'historic-sql-table-public-orders') {
      const result = await emitEvidence.execute(
        {
          kind: 'table_usage',
          table: 'public.orders',
          rawPath: 'tables/public.orders.json',
          usage: {
            narrative: 'Analysts repeatedly inspect paid order lifecycle by customer segment.',
            frequencyTier: 'high',
            commonFilters: ['status'],
            commonGroupBys: ['status', 'segment'],
            commonJoins: [{ table: 'public.customers', on: ['customer_id', 'id'] }],
            staleSince: null,
          },
        },
        { toolCallId: 'historic-sql-orders-usage' },
      );
      if (!String(result).includes('Recorded historic-SQL table_usage evidence')) {
        throw new Error(`Unexpected orders evidence result: ${String(result)}`);
      }
    }

    if (params.telemetryTags.unitKey === 'historic-sql-table-public-customers') {
      const result = await emitEvidence.execute(
        {
          kind: 'table_usage',
          table: 'public.customers',
          rawPath: 'tables/public.customers.json',
          usage: {
            narrative: 'Customers provide segment context for paid order lifecycle analysis.',
            frequencyTier: 'mid',
            commonFilters: [],
            commonGroupBys: ['segment'],
            commonJoins: [{ table: 'public.orders', on: ['id', 'customer_id'] }],
            staleSince: null,
          },
        },
        { toolCallId: 'historic-sql-customers-usage' },
      );
      if (!String(result).includes('Recorded historic-SQL table_usage evidence')) {
        throw new Error(`Unexpected customers evidence result: ${String(result)}`);
      }
    }

    if (params.telemetryTags.unitKey === 'historic-sql-patterns') {
      const result = await emitEvidence.execute(
        {
          kind: 'pattern',
          rawPath: 'patterns-input.json',
          pattern: {
            slug: 'paid-order-lifecycle',
            title: 'Paid Order Lifecycle',
            narrative: 'Analysts join orders and customers to compare paid order lifecycle by segment.',
            definitionSql:
              'select o.status, c.segment, count(*) from public.orders o join public.customers c on c.id = o.customer_id group by o.status, c.segment',
            tablesInvolved: ['public.orders', 'public.customers'],
            slRefs: ['orders', 'customers'],
            constituentTemplateIds: ['pg:orders-lifecycle'],
          },
        },
        { toolCallId: 'historic-sql-pattern' },
      );
      if (!String(result).includes('Recorded historic-SQL pattern evidence')) {
        throw new Error(`Unexpected pattern evidence result: ${String(result)}`);
      }
    }

    return { stopReason: 'natural' as const };
  });

  constructor() {
    super({ llmProvider: { getModel: () => ({}) as never } as never });
  }
}

function acceptanceSqlAnalysis(): SqlAnalysisPort {
  return {
    analyzeForFingerprint: async () => {
      throw new Error('analyzeForFingerprint should not be used by unified historic-SQL ingest');
    },
    analyzeBatch: vi.fn(async (items) => {
      return new Map(
        items.map((item) => [
          item.id,
          {
            tablesTouched: ['public.orders', 'public.customers'],
            columnsByClause: {
              select: ['status', 'segment'],
              where: ['status'],
              join: ['customer_id', 'id'],
              groupBy: ['status', 'segment'],
            },
          },
        ]),
      );
    }),
  };
}

async function writeHistoricSqlProject(project: KtxLocalProject): Promise<KtxLocalProject> {
  await writeFile(
    join(project.projectDir, 'ktx.yaml'),
    [
      'project: warehouse',
      'connections:',
      '  warehouse:',
      '    driver: postgres',
      '    historicSql:',
      '      enabled: true',
      '      dialect: postgres',
      '      minExecutions: 2',
      'ingest:',
      '  adapters:',
      '    - historic-sql',
      '  embeddings:',
      '    backend: deterministic',
      'storage:',
      '  state: sqlite',
      '  search: sqlite-fts5',
      '  git:',
      '    auto_commit: false',
      '    author: KTX Test <system@ktx.local>',
      '',
    ].join('\n'),
    'utf-8',
  );

  const loaded = await loadKtxProject({ projectDir: project.projectDir });
  await loaded.fileStore.writeFile(
    'semantic-layer/warehouse/_schema/public.yaml',
    YAML.stringify({
      tables: {
        orders: {
          table: 'public.orders',
          columns: [
            { name: 'id', type: 'string' },
            { name: 'status', type: 'string' },
            { name: 'customer_id', type: 'string' },
          ],
        },
        customers: {
          table: 'public.customers',
          columns: [
            { name: 'id', type: 'string' },
            { name: 'segment', type: 'string' },
          ],
        },
      },
    }),
    'KTX Test',
    'system@ktx.local',
    'Seed schema shard',
  );
  return loaded;
}

describe('historic-SQL local ingest retrieval acceptance', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-historic-sql-acceptance-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('projects table and pattern evidence into semantic-layer and wiki retrieval surfaces', async () => {
    const initialized = await initKtxProject({ projectDir: join(tempDir, 'project'), projectName: 'warehouse' });
    const project = await writeHistoricSqlProject(initialized);
    const sqlAnalysis = acceptanceSqlAnalysis();
    const agentRunner = new HistoricSqlAcceptanceAgentRunner();
    const adapter = new HistoricSqlSourceAdapter({
      reader: new AcceptanceHistoricSqlReader(),
      queryClient: {},
      sqlAnalysis,
      now: () => new Date('2026-05-11T00:00:00.000Z'),
    });

    const result = await runLocalIngest({
      project,
      adapters: [adapter],
      adapter: 'historic-sql',
      connectionId: 'warehouse',
      jobId: 'historic-sql-retrieval-acceptance',
      agentRunner,
    });

    expect(sqlAnalysis.analyzeBatch).toHaveBeenCalledTimes(1);
    expect(result.result.failedWorkUnits).toEqual([]);
    expect(result.result.workUnitCount).toBe(3);
    expect(agentRunner.runLoop).toHaveBeenCalledTimes(3);
    expect(result.report.body.postProcessor).toMatchObject({
      sourceKey: 'historic-sql',
      status: 'success',
      result: {
        tableUsageMerged: 2,
        patternPagesWritten: 1,
      },
      touchedSources: [
        { connectionId: 'warehouse', sourceName: 'customers' },
        { connectionId: 'warehouse', sourceName: 'orders' },
      ],
    });

    await expect(readFile(join(project.projectDir, 'semantic-layer/warehouse/_schema/public.yaml'), 'utf-8')).resolves
      .toContain('Analysts repeatedly inspect paid order lifecycle by customer segment.');
    await expect(readFile(join(project.projectDir, 'knowledge/global/historic-sql/paid-order-lifecycle.md'), 'utf-8'))
      .resolves.toContain('Paid Order Lifecycle');

    const reloaded = await loadKtxProject({ projectDir: project.projectDir });
    await expect(
      searchLocalSlSources(reloaded, { connectionId: 'warehouse', query: 'paid order lifecycle', limit: 5 }),
    ).resolves.toEqual([
      expect.objectContaining({
        name: 'orders',
        frequencyTier: 'high',
        snippet: expect.stringContaining('<mark>'),
        matchReasons: expect.arrayContaining(['lexical']),
      }),
    ]);
    await expect(
      searchLocalKnowledgePages(reloaded, { query: 'paid order lifecycle', userId: 'local', limit: 5 }),
    ).resolves.toEqual([
      expect.objectContaining({
        key: 'historic-sql/paid-order-lifecycle',
        summary: 'Paid Order Lifecycle',
        matchReasons: expect.arrayContaining(['lexical']),
      }),
    ]);
  });
});
```

- [ ] **Step 3: Run the focused acceptance test after creating the file**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts
```

Expected: PASS. The output reports one passing test and `sqlAnalysis.analyzeBatch` is called exactly once by the test assertion.

- [ ] **Step 4: Commit the acceptance test**

```bash
git add packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts
git commit -m "test: cover historic sql retrieval acceptance"
```

## Task 2: Run Adjacent Historic-SQL Regression Checks

**Files:**
- Verify: `packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts`
- Verify: `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`
- Verify: `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`
- Verify: `packages/context/src/ingest/adapters/historic-sql/chunk-unified.test.ts`
- Verify: `packages/context/src/sl/local-sl.test.ts`
- Verify: `packages/context/src/wiki/local-knowledge.test.ts`

- [ ] **Step 1: Run the new acceptance test with the adjacent historic-SQL unit tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts \
  src/ingest/adapters/historic-sql/projection.test.ts \
  src/ingest/adapters/historic-sql/stage-unified.test.ts \
  src/ingest/adapters/historic-sql/chunk-unified.test.ts \
  src/sl/local-sl.test.ts \
  src/wiki/local-knowledge.test.ts
```

Expected: PASS. These suites cover the new acceptance chain plus the deterministic projection, stager, chunker, SL search, and wiki search layers it depends on.

- [ ] **Step 2: Run pre-commit for the new test file**

Run:

```bash
uv run pre-commit run --files packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts
```

Expected: PASS. If `uv` refuses to run because the local binary does not satisfy the repo pin, activate `.venv` and run the closest TypeScript checks instead:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts
```

- [ ] **Step 3: Confirm no unrelated files are included**

Run:

```bash
git status --short
```

Expected: either an empty status after the Task 1 commit, or only intentionally changed plan/test files if the worker is preserving an uncommitted plan handoff.

## Self-Review

Spec coverage:

- Spec §4 hot path is covered because the test uses `HistoricSqlSourceAdapter.fetch()` with `stageHistoricSqlAggregatedSnapshot()`, a fake `HistoricSqlReader.fetchAggregated()`, and one `SqlAnalysisPort.analyzeBatch()` call.
- Spec §5 cold path is covered because the fake agent emits `table_usage` and `pattern` evidence through `emit_historic_sql_evidence`, and the normal `HistoricSqlProjectionPostProcessor` projects that evidence.
- Spec §6 and §7 retrieval surfaces are covered because the same test verifies `searchLocalSlSources()` returns `frequencyTier` and an FTS snippet and `searchLocalKnowledgePages()` returns `historic-sql/paid-order-lifecycle`.
- Spec §10.4 search retrieval acceptance is covered without requiring a live warehouse or LLM credentials.

Placeholder scan:

- The placeholder scan is clean, and the plan contains concrete file paths, code, commands, and expected outputs.
- The only fallback in the plan is the explicit `uv` version-mismatch path required by repository instructions.

Type consistency:

- `HistoricSqlReader`, `HistoricSqlUnifiedPullConfig`, `SqlAnalysisPort`, `HistoricSqlSourceAdapter`, `runLocalIngest`, `searchLocalSlSources`, and `searchLocalKnowledgePages` match existing exported APIs.
- Evidence payloads match `emit_historic_sql_evidence` input schemas: table evidence omits `connectionId` because the tool injects it; projected persisted evidence includes it.

Plan complete and saved to `docs/superpowers/plans/2026-05-11-historic-sql-end-to-end-retrieval-acceptance.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
