# Historic SQL Pattern WorkUnit Sharding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep historic-SQL pattern WorkUnit inputs under the raw-file and prompt-size limits by writing deterministic bounded pattern shards while preserving `patterns-input.json` as the full audit artifact.

**Architecture:** The stager continues to write full `patterns-input.json` for audit and diff visibility, then writes bounded `patterns-input/part-0001.json` style shards that contain only cross-table pattern candidates. The chunker emits one `historic_sql_patterns` WorkUnit per changed shard and never asks the skill to read the full audit file. Pattern projection is unchanged because emitted evidence already carries a free-form `rawPath`.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Zod, Vitest, pnpm workspace commands.

---

## Spec And Existing Plan Status

Spec: `docs/superpowers/specs/2026-05-11-historic-sql-redesign-design.md`

Plans derived from this spec:

- `docs/superpowers/plans/2026-05-11-historic-sql-foundations.md` - implemented. Current evidence includes `packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts`, `SqlAnalysisPort.analyzeBatch()`, daemon `/sql/analyze-batch`, `SemanticLayerSource.usage`, and `mergeUsagePreservingExternal()`.
- `docs/superpowers/plans/2026-05-11-historic-sql-search-enrichment.md` - implemented. Current evidence includes usage-aware `buildSemanticLayerSourceSearchText()`, FTS snippets in `sqlite-sl-sources-index.ts`, and list surfaces exposing `frequencyTier` plus `snippet`.
- `docs/superpowers/plans/2026-05-11-historic-sql-unified-hot-path.md` - implemented. Current evidence includes `stageHistoricSqlAggregatedSnapshot()`, `chunkHistoricSqlUnifiedStagedDir()`, `PostgresPgssReader`, aggregate BigQuery/Snowflake readers, unified schemas, and package exports.
- `docs/superpowers/plans/2026-05-11-historic-sql-skills-projection-cutover.md` - implemented. Current evidence includes production adapter cutover, `historic_sql_table_digest`, `historic_sql_patterns`, `emit_historic_sql_evidence`, `HistoricSqlProjectionPostProcessor`, and removal of legacy skill names from runtime code.
- `docs/superpowers/plans/2026-05-11-historic-sql-cross-dialect-readiness.md` - implemented. Current evidence includes local adapter registration tests for Postgres, BigQuery, and Snowflake plus PG doctor coverage for informational `pg_stat_statements.max`.
- `docs/superpowers/plans/2026-05-11-historic-sql-docs-smoke-and-config-cleanup.md` - implemented. Current evidence includes canonical setup config tests, docs using `minExecutions`, and the Postgres historic smoke script asserting unified staged artifacts and unchanged-run idempotency.
- `docs/superpowers/plans/2026-05-11-historic-sql-projection-archive-hardening.md` - implemented. Current evidence includes `isArchivedPatternPage()`, archive exclusion from active slug matching, stale table tests, and legacy query-page cleanup coverage.
- `docs/superpowers/plans/2026-05-11-historic-sql-end-to-end-retrieval-acceptance.md` - implemented. Current evidence includes `local-ingest-acceptance.test.ts` proving production adapter output reaches SL search and wiki search.
- `docs/superpowers/plans/2026-05-11-historic-sql-redaction-hardening.md` - implemented. Current evidence includes `redaction.ts`, `redaction.test.ts`, and `stage-unified.test.ts` proving original SQL is analyzed while staged artifacts contain `[REDACTED]`.

No existing spec-derived plan is currently unimplemented in this worktree. This plan covers the next uncovered implementation gap from spec section 5.2: `historic_sql_patterns` may need "a small handful" of deterministic chunks when `patterns-input.json` exceeds the LLM context budget. Current code always emits one WorkUnit with raw file `patterns-input.json`; `read_raw_file` rejects files larger than 120,000 bytes and WorkUnit prompt construction rejects prompts larger than 240,000 characters.

## File Structure

- Create `packages/context/src/ingest/adapters/historic-sql/pattern-inputs.ts`
  Owns deterministic pattern audit ordering, cross-table candidate filtering, byte-bounded shard creation, shard path constants, and shard path detection.
- Create `packages/context/src/ingest/adapters/historic-sql/pattern-inputs.test.ts`
  Covers deterministic shard ordering, single-table exclusion from WorkUnit shards, byte limits, and oversize-template manifest warnings.
- Modify `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`
  Writes full `patterns-input.json` plus bounded `patterns-input/part-0001.json` shard files, and appends shard warnings to `manifest.json`.
- Modify `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`
  Adds a regression for audit file preservation and sharded WorkUnit input creation.
- Modify `packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts`
  Emits one patterns WorkUnit per changed shard path, treats root `patterns-input.json` as audit-only, and includes shard paths in the scope descriptor and eviction calculation.
- Modify `packages/context/src/ingest/adapters/historic-sql/chunk-unified.test.ts`
  Updates root-file expectations and adds multi-shard diff behavior.
- Modify `packages/context/skills/historic_sql_patterns/SKILL.md`
  Tells the skill to read the exact pattern shard in `rawFiles` and emit evidence with that shard as `rawPath`.
- Modify `packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts`
  Updates the fake agent to emit pattern evidence for `historic-sql-patterns-part-0001`.
- Modify `packages/context/src/ingest/ingest-runtime-assets.test.ts`
  Keeps packaged skill assertions aligned with sharded pattern file guidance.

## Task 1: Add Pattern Input Sharding Helper

**Files:**
- Create: `packages/context/src/ingest/adapters/historic-sql/pattern-inputs.ts`
- Create: `packages/context/src/ingest/adapters/historic-sql/pattern-inputs.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `packages/context/src/ingest/adapters/historic-sql/pattern-inputs.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  HISTORIC_SQL_PATTERN_WORKUNIT_MAX_BYTES,
  isHistoricSqlPatternInputShardPath,
  serializedStagedPatternsInputByteLength,
  splitHistoricSqlPatternInputs,
} from './pattern-inputs.js';
import type { StagedPatternsInput } from './types.js';

type PatternTemplate = StagedPatternsInput['templates'][number];

function template(id: string, tablesTouched: string[], canonicalSql = 'select 1'): PatternTemplate {
  return {
    id,
    canonicalSql,
    tablesTouched,
    executionsBucket: '10-100',
    distinctUsersBucket: '2-5',
    dialect: 'postgres',
  };
}

describe('historic-SQL pattern input sharding', () => {
  it('keeps the audit input complete while sharding only cross-table pattern candidates', () => {
    const largeSql = `select * from public.orders join public.customers on true where marker = '${'x'.repeat(260)}'`;
    const input: StagedPatternsInput = {
      templates: [
        template('single-table-orders', ['public.orders']),
        template('orders-customers-2', ['public.orders', 'public.customers'], largeSql),
        template('orders-customers-1', ['public.customers', 'public.orders'], largeSql),
        template('orders-customers-payments', ['public.orders', 'public.customers', 'public.payments'], largeSql),
      ],
    };

    const result = splitHistoricSqlPatternInputs(input, { maxBytes: 760 });

    expect(result.auditInput.templates.map((entry) => entry.id)).toEqual([
      'orders-customers-1',
      'orders-customers-2',
      'orders-customers-payments',
      'single-table-orders',
    ]);
    expect(result.shards.length).toBeGreaterThan(1);
    expect(result.shards.map((shard) => shard.path)).toEqual(['patterns-input/part-0001.json', 'patterns-input/part-0002.json', 'patterns-input/part-0003.json']);
    expect(result.shards.flatMap((shard) => shard.input.templates.map((entry) => entry.id))).toEqual([
      'orders-customers-payments',
      'orders-customers-1',
      'orders-customers-2',
    ]);
    expect(result.shards.every((shard) => shard.byteLength <= 760)).toBe(true);
    expect(result.shards.flatMap((shard) => shard.input.templates).some((entry) => entry.id === 'single-table-orders')).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('omits a single oversized template from shards and reports a manifest warning', () => {
    const input: StagedPatternsInput = {
      templates: [
        template(
          'oversized-cross-table',
          ['public.orders', 'public.customers'],
          `select * from public.orders join public.customers on true where payload = '${'x'.repeat(500)}'`,
        ),
      ],
    };

    const result = splitHistoricSqlPatternInputs(input, { maxBytes: 240 });

    expect(result.auditInput.templates.map((entry) => entry.id)).toEqual(['oversized-cross-table']);
    expect(result.shards).toEqual([]);
    expect(result.warnings).toEqual(['patterns_input_template_too_large:oversized-cross-table']);
  });

  it('recognizes only generated pattern shard paths', () => {
    expect(isHistoricSqlPatternInputShardPath('patterns-input/part-0001.json')).toBe(true);
    expect(isHistoricSqlPatternInputShardPath('patterns-input/part-0012.json')).toBe(true);
    expect(isHistoricSqlPatternInputShardPath('patterns-input.json')).toBe(false);
    expect(isHistoricSqlPatternInputShardPath('patterns-input/part-1.json')).toBe(false);
    expect(isHistoricSqlPatternInputShardPath('patterns-input/readme.md')).toBe(false);
  });

  it('uses a production byte budget below read_raw_file maximum size', () => {
    expect(HISTORIC_SQL_PATTERN_WORKUNIT_MAX_BYTES).toBeLessThan(120_000);
    expect(serializedStagedPatternsInputByteLength({ templates: [] })).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run helper tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/pattern-inputs.test.ts
```

Expected: FAIL because `./pattern-inputs.js` does not exist.

- [ ] **Step 3: Add the sharding helper**

Create `packages/context/src/ingest/adapters/historic-sql/pattern-inputs.ts`:

```typescript
import { Buffer } from 'node:buffer';
import type { StagedPatternsInput } from './types.js';

export const HISTORIC_SQL_PATTERN_WORKUNIT_DIR = 'patterns-input';
export const HISTORIC_SQL_PATTERN_WORKUNIT_MAX_BYTES = 110_000;
export const HISTORIC_SQL_PATTERN_WORKUNIT_PATH_RE = /^patterns-input\/part-\d{4}\.json$/;

type PatternTemplate = StagedPatternsInput['templates'][number];

export interface HistoricSqlPatternInputShard {
  path: string;
  input: StagedPatternsInput;
  byteLength: number;
}

export interface HistoricSqlPatternInputSplitResult {
  auditInput: StagedPatternsInput;
  shards: HistoricSqlPatternInputShard[];
  warnings: string[];
}

export interface HistoricSqlPatternInputSplitOptions {
  maxBytes?: number;
}

export function isHistoricSqlPatternInputShardPath(path: string): boolean {
  return HISTORIC_SQL_PATTERN_WORKUNIT_PATH_RE.test(path);
}

export function serializeStagedPatternsInput(input: StagedPatternsInput): string {
  return `${JSON.stringify(input, null, 2)}\n`;
}

export function serializedStagedPatternsInputByteLength(input: StagedPatternsInput): number {
  return Buffer.byteLength(serializeStagedPatternsInput(input), 'utf-8');
}

function sortedAuditTemplates(templates: readonly PatternTemplate[]): PatternTemplate[] {
  return [...templates].sort((left, right) => left.id.localeCompare(right.id));
}

function sortedPatternCandidates(templates: readonly PatternTemplate[]): PatternTemplate[] {
  return [...templates]
    .filter((template) => template.tablesTouched.length >= 2)
    .map((template) => ({ ...template, tablesTouched: [...template.tablesTouched].sort() }))
    .sort((left, right) => {
      const cardinality = right.tablesTouched.length - left.tablesTouched.length;
      if (cardinality !== 0) return cardinality;
      const tableSignature = left.tablesTouched.join('\0').localeCompare(right.tablesTouched.join('\0'));
      if (tableSignature !== 0) return tableSignature;
      return left.id.localeCompare(right.id);
    });
}

function shardPath(index: number): string {
  return `${HISTORIC_SQL_PATTERN_WORKUNIT_DIR}/part-${String(index).padStart(4, '0')}.json`;
}

export function splitHistoricSqlPatternInputs(
  input: StagedPatternsInput,
  options: HistoricSqlPatternInputSplitOptions = {},
): HistoricSqlPatternInputSplitResult {
  const maxBytes = options.maxBytes ?? HISTORIC_SQL_PATTERN_WORKUNIT_MAX_BYTES;
  const auditInput: StagedPatternsInput = { templates: sortedAuditTemplates(input.templates) };
  const warnings: string[] = [];
  const shards: HistoricSqlPatternInputShard[] = [];
  let current: PatternTemplate[] = [];

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const shardInput: StagedPatternsInput = { templates: current };
    shards.push({
      path: shardPath(shards.length + 1),
      input: shardInput,
      byteLength: serializedStagedPatternsInputByteLength(shardInput),
    });
    current = [];
  };

  for (const template of sortedPatternCandidates(input.templates)) {
    const singleInput: StagedPatternsInput = { templates: [template] };
    if (serializedStagedPatternsInputByteLength(singleInput) > maxBytes) {
      warnings.push(`patterns_input_template_too_large:${template.id}`);
      continue;
    }

    const nextInput: StagedPatternsInput = { templates: [...current, template] };
    if (current.length > 0 && serializedStagedPatternsInputByteLength(nextInput) > maxBytes) {
      flush();
    }
    current.push(template);
  }

  flush();
  return { auditInput, shards, warnings };
}
```

- [ ] **Step 4: Run helper tests to verify they pass**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/pattern-inputs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the helper**

```bash
git add packages/context/src/ingest/adapters/historic-sql/pattern-inputs.ts packages/context/src/ingest/adapters/historic-sql/pattern-inputs.test.ts
git commit -m "feat: shard historic sql pattern inputs"
```

## Task 2: Write Pattern Shards During Staging

**Files:**
- Modify: `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`
- Test: `packages/context/src/ingest/adapters/historic-sql/pattern-inputs.test.ts`

- [ ] **Step 1: Add the failing stager regression**

Append this test inside the existing `describe('stageHistoricSqlAggregatedSnapshot', ...)` block in `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`:

```typescript
  it('preserves full patterns audit input and writes bounded cross-table pattern shards', async () => {
    const stagedDir = await tempDir();
    const largeSql = `select * from public.orders o join public.customers c on c.id = o.customer_id where payload = '${'x'.repeat(8000)}'`;
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: [], info: [] };
      },
      async *fetchAggregated() {
        yield aggregate({
          templateId: 'orders-customers-a',
          canonicalSql: largeSql,
          stats: {
            executions: 25,
            distinctUsers: 4,
            firstSeen: '2026-05-01T00:00:00.000Z',
            lastSeen: '2026-05-11T00:00:00.000Z',
            p50RuntimeMs: 15,
            p95RuntimeMs: 90,
            errorRate: 0,
            rowsProduced: 250,
          },
        });
        yield aggregate({
          templateId: 'orders-customers-b',
          canonicalSql: largeSql.replace('payload', 'payload_b'),
          stats: {
            executions: 22,
            distinctUsers: 3,
            firstSeen: '2026-05-01T00:00:00.000Z',
            lastSeen: '2026-05-11T00:00:00.000Z',
            p50RuntimeMs: 20,
            p95RuntimeMs: 95,
            errorRate: 0,
            rowsProduced: 220,
          },
        });
        yield aggregate({
          templateId: 'orders-single-table',
          canonicalSql: 'select count(*) from public.orders',
          stats: {
            executions: 30,
            distinctUsers: 2,
            firstSeen: '2026-05-01T00:00:00.000Z',
            lastSeen: '2026-05-11T00:00:00.000Z',
            p50RuntimeMs: 10,
            p95RuntimeMs: 20,
            errorRate: 0,
            rowsProduced: 30,
          },
        });
      },
    };
    const sqlAnalysis: SqlAnalysisPort = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(async () => new Map([
        [
          'orders-customers-a',
          {
            tablesTouched: ['public.orders', 'public.customers'],
            columnsByClause: {
              select: [],
              where: ['payload'],
              join: ['customer_id', 'id'],
              groupBy: [],
            },
          },
        ],
        [
          'orders-customers-b',
          {
            tablesTouched: ['public.orders', 'public.customers'],
            columnsByClause: {
              select: [],
              where: ['payload_b'],
              join: ['customer_id', 'id'],
              groupBy: [],
            },
          },
        ],
        [
          'orders-single-table',
          {
            tablesTouched: ['public.orders'],
            columnsByClause: {
              select: [],
              where: [],
              join: [],
              groupBy: [],
            },
          },
        ],
      ])),
    };

    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: {},
      reader,
      sqlAnalysis,
      pullConfig: { dialect: 'postgres' },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    const audit = await readJson<Record<string, any>>(stagedDir, 'patterns-input.json');
    expect(audit.templates.map((entry: any) => entry.id)).toEqual([
      'orders-customers-a',
      'orders-customers-b',
      'orders-single-table',
    ]);

    const firstShard = await readJson<Record<string, any>>(stagedDir, 'patterns-input/part-0001.json');
    expect(firstShard.templates.map((entry: any) => entry.id)).toEqual(['orders-customers-a', 'orders-customers-b']);
    expect(firstShard.templates.some((entry: any) => entry.id === 'orders-single-table')).toBe(false);

    const manifest = await readJson<Record<string, any>>(stagedDir, 'manifest.json');
    expect(manifest.warnings).toEqual([]);
  });
```

- [ ] **Step 2: Run the stager regression to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/stage-unified.test.ts
```

Expected: FAIL because `patterns-input/part-0001.json` is not written.

- [ ] **Step 3: Import the sharding helper in the stager**

In `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`, add this import below the bucket import block:

```typescript
import { splitHistoricSqlPatternInputs } from './pattern-inputs.js';
```

- [ ] **Step 4: Write the audit input and shard files**

In `stageHistoricSqlAggregatedSnapshot()` in `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`, replace this block:

```typescript
  await writeJson(input.stagedDir, 'patterns-input.json', toPatternsInput(parsedTemplates));
  await writeJson(input.stagedDir, 'manifest.json', {
    source: HISTORIC_SQL_SOURCE_KEY,
    connectionId: input.connectionId,
    dialect: config.dialect,
    fetchedAt: now.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    snapshotRowCount,
    touchedTableCount: byTable.size,
    parseFailures: warnings.filter((warning) => warning.startsWith('parse_failed:')).length,
    warnings,
    probeWarnings: probe.warnings,
    staleArchiveAfterDays: config.staleArchiveAfterDays,
  });
```

with this code:

```typescript
  const patternsInput = toPatternsInput(parsedTemplates);
  const patternInputSplit = splitHistoricSqlPatternInputs(patternsInput);
  const allWarnings = [...warnings, ...patternInputSplit.warnings];
  await writeJson(input.stagedDir, 'patterns-input.json', patternInputSplit.auditInput);
  for (const shard of patternInputSplit.shards) {
    await writeJson(input.stagedDir, shard.path, shard.input);
  }
  await writeJson(input.stagedDir, 'manifest.json', {
    source: HISTORIC_SQL_SOURCE_KEY,
    connectionId: input.connectionId,
    dialect: config.dialect,
    fetchedAt: now.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    snapshotRowCount,
    touchedTableCount: byTable.size,
    parseFailures: allWarnings.filter((warning) => warning.startsWith('parse_failed:')).length,
    warnings: allWarnings,
    probeWarnings: probe.warnings,
    staleArchiveAfterDays: config.staleArchiveAfterDays,
  });
```

- [ ] **Step 5: Run helper and stager tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/pattern-inputs.test.ts src/ingest/adapters/historic-sql/stage-unified.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit stager shard writing**

```bash
git add packages/context/src/ingest/adapters/historic-sql/pattern-inputs.ts packages/context/src/ingest/adapters/historic-sql/pattern-inputs.test.ts packages/context/src/ingest/adapters/historic-sql/stage-unified.ts packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts
git commit -m "feat: write historic sql pattern shards"
```

## Task 3: Emit Pattern WorkUnits From Shards

**Files:**
- Modify: `packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/chunk-unified.test.ts`
- Test: `packages/context/src/ingest/adapters/historic-sql/pattern-inputs.test.ts`

- [ ] **Step 1: Update chunk tests for sharded pattern WorkUnits**

In `packages/context/src/ingest/adapters/historic-sql/chunk-unified.test.ts`, replace the `patterns-input.json` write inside `writeUnifiedStagedDir()` with these writes:

```typescript
  await writeJson(root, 'patterns-input.json', {
    templates: [
      {
        id: 'orders',
        canonicalSql: 'select * from public.orders join public.customers on true',
        tablesTouched: ['public.orders', 'public.customers'],
        executionsBucket: '10-100',
        distinctUsersBucket: '2-5',
        dialect: 'postgres',
      },
    ],
  });
  await writeJson(root, 'patterns-input/part-0001.json', {
    templates: [
      {
        id: 'orders',
        canonicalSql: 'select * from public.orders join public.customers on true',
        tablesTouched: ['public.orders', 'public.customers'],
        executionsBucket: '10-100',
        distinctUsersBucket: '2-5',
        dialect: 'postgres',
      },
    ],
  });
```

In the first test, replace the patterns WorkUnit expectation with:

```typescript
      expect.objectContaining({
        unitKey: 'historic-sql-patterns-part-0001',
        displayLabel: 'Historic SQL cross-table patterns: part-0001',
        rawFiles: ['patterns-input/part-0001.json'],
        dependencyPaths: ['manifest.json'],
        notes: expect.stringContaining('patterns-input/part-0001.json'),
      }),
```

In the diff-set test, replace the second expectation with:

```typescript
    await expect(
      chunkHistoricSqlUnifiedStagedDir(stagedDir, {
        added: [],
        modified: ['patterns-input/part-0001.json'],
        deleted: [],
        unchanged: ['manifest.json', 'patterns-input.json', 'tables/public.orders.json'],
      }),
    ).resolves.toMatchObject({
      workUnits: [expect.objectContaining({ unitKey: 'historic-sql-patterns-part-0001' })],
    });

    await expect(
      chunkHistoricSqlUnifiedStagedDir(stagedDir, {
        added: [],
        modified: ['patterns-input.json'],
        deleted: [],
        unchanged: ['manifest.json', 'patterns-input/part-0001.json', 'tables/public.orders.json'],
      }),
    ).resolves.toMatchObject({
      workUnits: [],
    });
```

In the scope test, add these expectations:

```typescript
    expect(scope.isPathInScope('patterns-input/part-0001.json')).toBe(true);
    expect(scope.isPathInScope('patterns-input/part-1.json')).toBe(false);
```

Append this additional test inside the same `describe` block:

```typescript
  it('emits one patterns WorkUnit per changed shard', async () => {
    const stagedDir = await tempDir();
    await writeUnifiedStagedDir(stagedDir);
    await writeJson(stagedDir, 'patterns-input/part-0002.json', {
      templates: [
        {
          id: 'line-items',
          canonicalSql: 'select * from public.orders join public.line_items on true',
          tablesTouched: ['public.orders', 'public.line_items'],
          executionsBucket: '10-100',
          distinctUsersBucket: '2-5',
          dialect: 'postgres',
        },
      ],
    });

    const result = await chunkHistoricSqlUnifiedStagedDir(stagedDir, {
      added: ['patterns-input/part-0002.json'],
      modified: ['patterns-input/part-0001.json'],
      deleted: [],
      unchanged: ['manifest.json', 'patterns-input.json', 'tables/public.orders.json'],
    });

    expect(result.workUnits.map((unit) => unit.unitKey)).toEqual([
      'historic-sql-patterns-part-0001',
      'historic-sql-patterns-part-0002',
    ]);
    expect(result.workUnits.map((unit) => unit.rawFiles)).toEqual([
      ['patterns-input/part-0001.json'],
      ['patterns-input/part-0002.json'],
    ]);
  });
```

- [ ] **Step 2: Run chunk tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/chunk-unified.test.ts
```

Expected: FAIL because `chunkHistoricSqlUnifiedStagedDir()` still emits `historic-sql-patterns` from root `patterns-input.json`.

- [ ] **Step 3: Import shard path helpers in the chunker**

In `packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts`, add this import below the existing type imports:

```typescript
import { isHistoricSqlPatternInputShardPath } from './pattern-inputs.js';
```

- [ ] **Step 4: Emit WorkUnits from shard paths**

In `packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts`, replace the root `patterns-input.json` WorkUnit block:

```typescript
  if (files.includes('patterns-input.json') && touchedPath('patterns-input.json', touched)) {
    stagedPatternsInputSchema.parse(await readJson(stagedDir, 'patterns-input.json'));
    workUnits.push({
      unitKey: 'historic-sql-patterns',
      displayLabel: 'Historic SQL cross-table patterns',
      rawFiles: ['patterns-input.json'],
      dependencyPaths: ['manifest.json'],
      peerFileIndex: files.filter((file) => file !== 'patterns-input.json' && file !== 'manifest.json').sort(),
      notes:
        'Use historic_sql_patterns. Read patterns-input.json and emit pattern objects with emit_historic_sql_evidence. Do not call wiki_write or sl_write_source.',
    });
  }
```

with this code:

```typescript
  for (const path of files.filter(isHistoricSqlPatternInputShardPath)) {
    if (!touchedPath(path, touched)) {
      continue;
    }
    stagedPatternsInputSchema.parse(await readJson(stagedDir, path));
    const shardLabel = path.replace(/^patterns-input\//, '').replace(/\.json$/, '');
    workUnits.push({
      unitKey: `historic-sql-patterns-${safeUnitKey(shardLabel)}`,
      displayLabel: `Historic SQL cross-table patterns: ${shardLabel}`,
      rawFiles: [path],
      dependencyPaths: ['manifest.json'],
      peerFileIndex: files.filter((file) => file !== path && file !== 'manifest.json').sort(),
      notes:
        `Use historic_sql_patterns. Read ${path} and emit pattern objects with emit_historic_sql_evidence using rawPath "${path}". Do not call wiki_write or sl_write_source.`,
    });
  }
```

- [ ] **Step 5: Update eviction and scope matching**

In `packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts`, replace the deleted-path filter:

```typescript
  const deleted = diffSet?.deleted.filter((path) => path === 'patterns-input.json' || /^tables\/.+\.json$/.test(path)).sort();
```

with:

```typescript
  const deleted = diffSet?.deleted
    .filter((path) => isHistoricSqlPatternInputShardPath(path) || /^tables\/.+\.json$/.test(path))
    .sort();
```

In `describeHistoricSqlUnifiedScope()`, replace the scope predicate:

```typescript
    isPathInScope: (rawPath) =>
      rawPath === 'manifest.json' || rawPath === 'patterns-input.json' || /^tables\/.+\.json$/.test(rawPath),
```

with:

```typescript
    isPathInScope: (rawPath) =>
      rawPath === 'manifest.json' ||
      rawPath === 'patterns-input.json' ||
      isHistoricSqlPatternInputShardPath(rawPath) ||
      /^tables\/.+\.json$/.test(rawPath),
```

- [ ] **Step 6: Run helper, stage, and chunk tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/pattern-inputs.test.ts src/ingest/adapters/historic-sql/stage-unified.test.ts src/ingest/adapters/historic-sql/chunk-unified.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit chunker shard WorkUnits**

```bash
git add packages/context/src/ingest/adapters/historic-sql/pattern-inputs.ts packages/context/src/ingest/adapters/historic-sql/pattern-inputs.test.ts packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts packages/context/src/ingest/adapters/historic-sql/chunk-unified.test.ts packages/context/src/ingest/adapters/historic-sql/stage-unified.ts packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts
git commit -m "feat: emit historic sql pattern shard work units"
```

## Task 4: Update Skill Guidance And Acceptance Coverage

**Files:**
- Modify: `packages/context/skills/historic_sql_patterns/SKILL.md`
- Modify: `packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts`
- Modify: `packages/context/src/ingest/ingest-runtime-assets.test.ts`

- [ ] **Step 1: Update the packaged historic SQL patterns skill**

Replace `packages/context/skills/historic_sql_patterns/SKILL.md` with:

````markdown
---
name: historic_sql_patterns
description: Identify recurring cross-table historic-SQL analytical intents from a bounded pattern shard and emit typed pattern evidence for deterministic wiki projection.
callers: [memory_agent]
---

# Historic SQL Patterns

Use this skill when the WorkUnit raw file is a `patterns-input/part-0001.json` style shard from the `historic-sql` adapter. Older staged bundles may still provide root `patterns-input.json`; when that is the WorkUnit raw file, read it the same way.

## Required Workflow

1. Read the WorkUnit notes first.
2. Find the single pattern input file listed under the WorkUnit `rawFiles` section.
3. Call `read_raw_file` for that exact raw file path.
4. Identify recurring analytical intents that span at least two tables and have repeated usage signal.
5. Emit one `pattern` evidence object per durable cross-table intent by calling `emit_historic_sql_evidence`.
6. Set each evidence object's `rawPath` to the exact raw file path read in step 3.
7. Stop after all pattern evidence has been emitted.

## Evidence Shape

Each call to `emit_historic_sql_evidence` must use this shape:

```json
{
  "kind": "pattern",
  "rawPath": "patterns-input/part-0001.json",
  "pattern": {
    "slug": "order-lifecycle-analysis",
    "title": "Order Lifecycle Analysis",
    "narrative": "Analysts compare order statuses with customer segments to understand lifecycle movement.",
    "definitionSql": "select o.status, count(*) from public.orders o join public.customers c on c.id = o.customer_id group by o.status",
    "tablesInvolved": ["public.orders", "public.customers"],
    "slRefs": ["orders", "customers"],
    "constituentTemplateIds": ["pg:1", "pg:2"]
  }
}
```

The `pattern` object must match `patternOutputSchema`; multiple calls together must form `patternsArraySchema`.

## Pattern Selection Rules

- Prefer patterns that involve two or more tables.
- Prefer templates with `executionsBucket` at least `10-100` and `distinctUsersBucket` above solo usage.
- Merge templates into one pattern only when the business intent is the same.
- Use a stable kebab-case slug based on intent, not a template id.
- Set `definitionSql` to the clearest representative SQL from a constituent template.
- Set `slRefs` to source names when the source name is obvious from table names; omit uncertain refs rather than guessing.
- Treat each pattern shard independently; do not read peer shard files from `peerFileIndex`.

## Boundaries

- Do not call wiki_write.
- Do not call sl_write_source.
- Do not call sl_edit_source.
- Do not call context_candidate_write.
- Do not create single-table pattern pages.
- Do not copy credentials, tokens, user emails, or unredacted literals into evidence.
````

- [ ] **Step 2: Update runtime asset assertions**

In `packages/context/src/ingest/ingest-runtime-assets.test.ts`, replace this assertion:

```typescript
    expect(body).toContain('patterns-input.json');
```

with:

```typescript
    expect(body).toContain('patterns-input/part-0001.json');
```

- [ ] **Step 3: Update the local ingest acceptance fake agent**

In `packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts`, replace this block:

```typescript
    if (params.telemetryTags.unitKey === 'historic-sql-patterns') {
      const result = await emitEvidence.execute(
        {
          kind: 'pattern',
          rawPath: 'patterns-input.json',
          pattern: {
```

with:

```typescript
    if (params.telemetryTags.unitKey === 'historic-sql-patterns-part-0001') {
      const result = await emitEvidence.execute(
        {
          kind: 'pattern',
          rawPath: 'patterns-input/part-0001.json',
          pattern: {
```

The rest of the pattern object stays unchanged.

- [ ] **Step 4: Run skill and acceptance tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-runtime-assets.test.ts src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit skill and acceptance updates**

```bash
git add packages/context/skills/historic_sql_patterns/SKILL.md packages/context/src/ingest/ingest-runtime-assets.test.ts packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts
git commit -m "test: align historic sql pattern skill with shards"
```

## Task 5: Final Verification

**Files:**
- Verify: `packages/context/src/ingest/adapters/historic-sql/pattern-inputs.ts`
- Verify: `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`
- Verify: `packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts`
- Verify: `packages/context/skills/historic_sql_patterns/SKILL.md`

- [ ] **Step 1: Run focused historic SQL tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/adapters/historic-sql/pattern-inputs.test.ts \
  src/ingest/adapters/historic-sql/stage-unified.test.ts \
  src/ingest/adapters/historic-sql/chunk-unified.test.ts \
  src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts \
  src/ingest/ingest-runtime-assets.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run context package type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Verify no legacy historic SQL code path returned**

Run:

```bash
rg -n "stagePgStatStatementsTemplates|expandCategoricalTemplates|classifySlot|pgss-baseline|historic_sql_ingest|historic_sql_curator|PostgresPgssQueryHistoryReader|historic_sql_template" packages/context packages/cli
```

Expected: no matches in runtime or test source. Matches inside `docs/superpowers/plans/` are acceptable when searching docs separately, but this command does not search docs.

- [ ] **Step 4: Run pre-commit on changed files if configured**

Run:

```bash
uv run pre-commit run --files \
  packages/context/src/ingest/adapters/historic-sql/pattern-inputs.ts \
  packages/context/src/ingest/adapters/historic-sql/pattern-inputs.test.ts \
  packages/context/src/ingest/adapters/historic-sql/stage-unified.ts \
  packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts \
  packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts \
  packages/context/src/ingest/adapters/historic-sql/chunk-unified.test.ts \
  packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts \
  packages/context/src/ingest/ingest-runtime-assets.test.ts \
  packages/context/skills/historic_sql_patterns/SKILL.md
```

Expected: PASS. If the repository has no pre-commit config or the local `uv` version cannot satisfy the project pin, record the exact error and rely on the focused tests plus type-check above.

- [ ] **Step 5: Commit verification-only adjustments if any were needed**

If any test or type-check step required small follow-up edits, commit them:

```bash
git add packages/context/src/ingest/adapters/historic-sql/pattern-inputs.ts packages/context/src/ingest/adapters/historic-sql/pattern-inputs.test.ts packages/context/src/ingest/adapters/historic-sql/stage-unified.ts packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts packages/context/src/ingest/adapters/historic-sql/chunk-unified.test.ts packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts packages/context/src/ingest/ingest-runtime-assets.test.ts packages/context/skills/historic_sql_patterns/SKILL.md
git commit -m "test: verify historic sql pattern shard work units"
```

If there were no follow-up edits, do not create an empty commit.

## Self-Review

**Spec coverage:** This plan covers spec section 5.2's allowance for multiple deterministic pattern WorkUnits when `patterns-input.json` exceeds a context budget. It preserves section 4.6's full `patterns-input.json` audit artifact, keeps section 4.7's changed-file DiffSet behavior, and does not alter deterministic projection from section 5.3.

**Placeholder scan:** The plan contains concrete files, commands, expected outcomes, code snippets, and commit commands. It has no deferred implementation markers.

**Type consistency:** `StagedPatternsInput`, `splitHistoricSqlPatternInputs()`, `isHistoricSqlPatternInputShardPath()`, `HISTORIC_SQL_PATTERN_WORKUNIT_MAX_BYTES`, and `serializedStagedPatternsInputByteLength()` are introduced in Task 1 and imported with the same names in later tasks. Pattern shard raw paths use `patterns-input/part-0001.json` consistently in the stager, chunker, skill, and acceptance test.

Plan complete and saved to `docs/superpowers/plans/2026-05-11-historic-sql-pattern-workunit-sharding.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
