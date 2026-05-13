# Historic SQL Redaction Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `historicSql.redactionPatterns` actually redact sensitive SQL substrings from historic-SQL staged artifacts and WorkUnit inputs.

**Architecture:** Keep the unified hot path parseable by sending original SQL to the local deterministic SQL-analysis daemon, then redact only the SQL text that is written to `tables/*.json` and `patterns-input.json`. Add a focused redaction helper so regex compatibility and error messages are tested independently from staging, then add a stager regression proving raw sensitive values do not reach files consumed by LLM skills.

**Tech Stack:** TypeScript ESM/NodeNext, zod 4, Vitest, existing historic-SQL unified stager.

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
- `docs/superpowers/plans/2026-05-11-historic-sql-end-to-end-retrieval-acceptance.md`

Implemented status verified from this worktree:

- `2026-05-11-historic-sql-foundations.md` is implemented. Evidence: `packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts`, `packages/context/src/sql-analysis/ports.ts` exposes `analyzeBatch()`, `python/ktx-daemon/src/ktx_daemon/app.py` registers `/sql/analyze-batch`, `packages/context/src/sl/types.ts` has `SemanticLayerSource.usage`, and `packages/context/src/ingest/adapters/live-database/manifest.ts` has `mergeUsagePreservingExternal()`.
- `2026-05-11-historic-sql-search-enrichment.md` is implemented. Evidence: `packages/context/src/sl/sl-search.service.ts` indexes `source.usage`, `packages/context/src/sl/sqlite-sl-sources-index.ts` selects FTS snippets, and local/MCP list surfaces expose `frequencyTier` and `snippet`.
- `2026-05-11-historic-sql-unified-hot-path.md` is implemented. Evidence: `stageHistoricSqlAggregatedSnapshot()`, `chunkHistoricSqlUnifiedStagedDir()`, `PostgresPgssReader`, aggregate BigQuery/Snowflake `fetchAggregated()` methods, unified schemas, and package exports exist.
- `2026-05-11-historic-sql-skills-projection-cutover.md` is implemented. Evidence: `HistoricSqlSourceAdapter` uses the unified stager/chunker, `packages/context/skills/historic_sql_table_digest/` and `packages/context/skills/historic_sql_patterns/` exist, `emit_historic_sql_evidence` exists, `HistoricSqlProjectionPostProcessor` is wired in `packages/context/src/ingest/local-bundle-runtime.ts`, and legacy skill names no longer grep in `packages/context` or `packages/cli`.
- `2026-05-11-historic-sql-cross-dialect-readiness.md` is implemented. Evidence: `packages/cli/src/local-adapters.test.ts` covers Postgres, BigQuery, and Snowflake historic-SQL registration, and `packages/cli/src/historic-sql-doctor.test.ts` covers low `pg_stat_statements.max` as informational output.
- `2026-05-11-historic-sql-docs-smoke-and-config-cleanup.md` is implemented. Evidence: `packages/cli/src/setup-databases.test.ts` expects canonical `historicSql.filters.serviceAccounts`, `examples/postgres-historic/scripts/smoke.sh` asserts unified `manifest.json`, `tables/*.json`, `patterns-input.json`, and zero WorkUnits on the unchanged run, and public docs use `minExecutions`.
- `2026-05-11-historic-sql-projection-archive-hardening.md` is implemented. Evidence: `packages/context/src/ingest/adapters/historic-sql/projection.ts` has `isArchivedPatternPage()`, excludes archived pages from active slug matching, and `projection.test.ts` covers reappearing archived patterns, stable archived pages, stale table marking, and legacy query-page deletion.
- `2026-05-11-historic-sql-end-to-end-retrieval-acceptance.md` is implemented. Evidence: `packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts` exercises the production `HistoricSqlSourceAdapter`, fake `emit_historic_sql_evidence` calls, projection, semantic-layer search, and wiki search.

Focused verification before writing this plan:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts src/ingest/adapters/historic-sql/projection.test.ts src/ingest/adapters/historic-sql/stage-unified.test.ts src/ingest/adapters/historic-sql/types.test.ts
```

Observed: 4 files passed, 10 tests passed.

Remaining spec gap this plan covers:

- Spec §8 exposes `historicSql.redactionPatterns`, and setup/docs already write that field.
- `packages/context/src/ingest/adapters/historic-sql/types.ts` parses `redactionPatterns`, but `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts` never applies them.
- Staged `tables/{schema}.{table}.json` and `patterns-input.json` currently copy `AggregatedTemplate.canonicalSql` unchanged into `topTemplates[].canonicalSql` and `templates[].canonicalSql`.
- Those staged files are WorkUnit inputs for `historic_sql_table_digest` and `historic_sql_patterns`, so sensitive substrings can reach LLM prompts even when the user configured redaction.

## File Structure

Create:

- `packages/context/src/ingest/adapters/historic-sql/redaction.ts`
  Owns compilation and application of historic-SQL SQL-text redaction patterns. Supports JavaScript regex strings and the documented `(?i)` case-insensitive prefix used by setup tests/docs.
- `packages/context/src/ingest/adapters/historic-sql/redaction.test.ts`
  Tests raw regex replacement, `(?i)` compatibility, empty config behavior, and invalid-pattern diagnostics.

Modify:

- `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`
  Compiles `config.redactionPatterns` once per fetch. Keeps original SQL for filtering and `SqlAnalysisPort.analyzeBatch()`, then stores redacted SQL in `ParsedTemplate.template.canonicalSql` before `toStagedTable()` and `toPatternsInput()` serialize files.
- `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`
  Adds a regression proving raw secrets are absent from staged artifacts while `analyzeBatch()` still receives the original SQL.

## Task 1: Add Historic SQL Redaction Helper

**Files:**
- Create: `packages/context/src/ingest/adapters/historic-sql/redaction.test.ts`
- Create: `packages/context/src/ingest/adapters/historic-sql/redaction.ts`

- [ ] **Step 1: Write the failing redaction helper test**

Create `packages/context/src/ingest/adapters/historic-sql/redaction.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { compileHistoricSqlRedactionPatterns, redactHistoricSqlText } from './redaction.js';

describe('historic-SQL redaction', () => {
  it('redacts regex matches and supports the (?i) case-insensitive prefix', () => {
    const redactors = compileHistoricSqlRedactionPatterns([
      'sk_live_[A-Za-z0-9]+',
      '(?i)secret_token_[a-z0-9]+',
    ]);

    const sql =
      "select * from public.api_events where api_key = 'sk_live_abc123' and note = 'Secret_Token_9f'"; // pragma: allowlist secret

    expect(redactHistoricSqlText(sql, redactors)).toBe(
      "select * from public.api_events where api_key = '[REDACTED]' and note = '[REDACTED]'",
    );
  });

  it('returns the original SQL text when no redaction patterns are configured', () => {
    const sql = "select * from public.orders where status = 'paid'";

    expect(redactHistoricSqlText(sql, compileHistoricSqlRedactionPatterns([]))).toBe(sql);
  });

  it('throws a config-focused error for invalid redaction regex patterns', () => {
    expect(() => compileHistoricSqlRedactionPatterns(['[broken'])).toThrow(
      'Invalid historicSql.redactionPatterns entry "[broken"',
    );
  });

  it('throws a config-focused error for empty redaction regex patterns', () => {
    expect(() => compileHistoricSqlRedactionPatterns(['   '])).toThrow(
      'Invalid historicSql.redactionPatterns entry "   "',
    );
  });
});
```

- [ ] **Step 2: Run the redaction helper test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/redaction.test.ts
```

Expected: FAIL because `./redaction.js` does not exist.

- [ ] **Step 3: Add the redaction helper implementation**

Create `packages/context/src/ingest/adapters/historic-sql/redaction.ts`:

```typescript
export interface HistoricSqlRedactionPattern {
  pattern: string;
  expression: RegExp;
}

const CASE_INSENSITIVE_PREFIX = '(?i)';
const REDACTION_TOKEN = '[REDACTED]';

export function compileHistoricSqlRedactionPatterns(patterns: readonly string[]): HistoricSqlRedactionPattern[] {
  return patterns.map((pattern) => {
    const trimmed = pattern.trim();
    const caseInsensitive = trimmed.startsWith(CASE_INSENSITIVE_PREFIX);
    const source = caseInsensitive ? trimmed.slice(CASE_INSENSITIVE_PREFIX.length) : trimmed;
    if (source.length === 0) {
      throw new Error(`Invalid historicSql.redactionPatterns entry "${pattern}": pattern must not be empty`);
    }

    try {
      return {
        pattern,
        expression: new RegExp(source, caseInsensitive ? 'gi' : 'g'),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid historicSql.redactionPatterns entry "${pattern}": ${reason}`);
    }
  });
}

export function redactHistoricSqlText(text: string, redactors: readonly HistoricSqlRedactionPattern[]): string {
  let next = text;
  for (const redactor of redactors) {
    redactor.expression.lastIndex = 0;
    next = next.replace(redactor.expression, REDACTION_TOKEN);
  }
  return next;
}
```

- [ ] **Step 4: Run the redaction helper test to verify it passes**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/redaction.test.ts
```

Expected: PASS. The output reports 1 test file passed and 4 tests passed.

- [ ] **Step 5: Commit the redaction helper**

```bash
git add packages/context/src/ingest/adapters/historic-sql/redaction.ts packages/context/src/ingest/adapters/historic-sql/redaction.test.ts
git commit -m "feat: add historic sql redaction helper"
```

## Task 2: Apply Redaction To Unified Staged Artifacts

**Files:**
- Modify: `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`
- Verify: `packages/context/src/ingest/adapters/historic-sql/redaction.ts`

- [ ] **Step 1: Add the failing staged-artifact redaction test**

Append this test inside the existing `describe('stageHistoricSqlAggregatedSnapshot', ...)` block in `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`:

```typescript
  it('redacts configured SQL substrings in staged artifacts while analyzing original SQL', async () => {
    const stagedDir = await tempDir();
    const originalSql =
      "select * from public.api_events where api_key = 'sk_live_abc123' and note = 'Secret_Token_9f'"; // pragma: allowlist secret
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: [], info: [] };
      },
      async *fetchAggregated() {
        yield aggregate({
          templateId: 'api-events-with-secret',
          canonicalSql: originalSql,
          stats: {
            executions: 15,
            distinctUsers: 2,
            firstSeen: '2026-05-01T00:00:00.000Z',
            lastSeen: '2026-05-11T00:00:00.000Z',
            p50RuntimeMs: 12,
            p95RuntimeMs: 25,
            errorRate: 0,
            rowsProduced: 15,
          },
        });
      },
    };
    const sqlAnalysis: SqlAnalysisPort = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(async () => new Map([
        [
          'api-events-with-secret',
          {
            tablesTouched: ['public.api_events'],
            columnsByClause: {
              select: [],
              where: ['api_key', 'note'],
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
      pullConfig: {
        dialect: 'postgres',
        redactionPatterns: ['sk_live_[A-Za-z0-9]+', '(?i)secret_token_[a-z0-9]+'],
      },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    expect(sqlAnalysis.analyzeBatch).toHaveBeenCalledWith(
      [{ id: 'api-events-with-secret', sql: originalSql }],
      'postgres',
    );

    const tableJson = await readFile(join(stagedDir, 'tables/public.api_events.json'), 'utf-8');
    const patternsJson = await readFile(join(stagedDir, 'patterns-input.json'), 'utf-8');
    expect(tableJson).not.toContain('sk_live_abc123');
    expect(tableJson).not.toContain('Secret_Token_9f');
    expect(patternsJson).not.toContain('sk_live_abc123');
    expect(patternsJson).not.toContain('Secret_Token_9f');
    expect(tableJson).toContain('[REDACTED]');
    expect(patternsJson).toContain('[REDACTED]');
  });
```

- [ ] **Step 2: Run the staged-artifact test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/stage-unified.test.ts
```

Expected: FAIL because `tables/public.api_events.json` and `patterns-input.json` still contain `sk_live_abc123` and `Secret_Token_9f`.

- [ ] **Step 3: Import the redaction helper in the stager**

In `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`, add this import below the existing `./buckets.js` import block:

```typescript
import {
  compileHistoricSqlRedactionPatterns,
  redactHistoricSqlText,
  type HistoricSqlRedactionPattern,
} from './redaction.js';
```

- [ ] **Step 4: Add a small template redaction helper**

In `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`, add this helper after `shouldDropTemplate()`:

```typescript
function redactTemplateSql(
  template: AggregatedTemplate,
  redactors: readonly HistoricSqlRedactionPattern[],
): AggregatedTemplate {
  if (redactors.length === 0) {
    return template;
  }
  return {
    ...template,
    canonicalSql: redactHistoricSqlText(template.canonicalSql, redactors),
  };
}
```

- [ ] **Step 5: Compile redaction patterns once per staged snapshot**

In `stageHistoricSqlAggregatedSnapshot()` in `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`, replace this opening block:

```typescript
  const config = historicSqlUnifiedPullConfigSchema.parse(input.pullConfig);
  const now = input.now ?? new Date();
  const windowStart = new Date(now.getTime() - config.windowDays * 24 * 60 * 60 * 1000);
```

with:

```typescript
  const config = historicSqlUnifiedPullConfigSchema.parse(input.pullConfig);
  const redactors = compileHistoricSqlRedactionPatterns(config.redactionPatterns);
  const now = input.now ?? new Date();
  const windowStart = new Date(now.getTime() - config.windowDays * 24 * 60 * 60 * 1000);
```

- [ ] **Step 6: Store redacted SQL only after batch analysis has used original SQL**

In `stageHistoricSqlAggregatedSnapshot()` in `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`, replace this `parsedTemplates.push()` block:

```typescript
    parsedTemplates.push({
      template,
      tablesTouched,
      columnsByClause: Object.fromEntries(
        Object.entries(parsed.columnsByClause).map(([clause, columns]) => [clause, [...new Set(columns)].sort()]),
      ),
    });
```

with:

```typescript
    parsedTemplates.push({
      template: redactTemplateSql(template, redactors),
      tablesTouched,
      columnsByClause: Object.fromEntries(
        Object.entries(parsed.columnsByClause).map(([clause, columns]) => [clause, [...new Set(columns)].sort()]),
      ),
    });
```

- [ ] **Step 7: Run staged-artifact and redaction tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/redaction.test.ts src/ingest/adapters/historic-sql/stage-unified.test.ts
```

Expected: PASS. The output reports 2 test files passed and the staged-artifact test confirms both raw sensitive substrings are absent.

- [ ] **Step 8: Commit the stager redaction**

```bash
git add packages/context/src/ingest/adapters/historic-sql/stage-unified.ts packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts
git commit -m "feat: redact historic sql staged artifacts"
```

## Task 3: Run Focused Historic-SQL Regression Checks

**Files:**
- Verify: `packages/context/src/ingest/adapters/historic-sql/redaction.test.ts`
- Verify: `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`
- Verify: `packages/context/src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts`
- Verify: `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`
- Verify: `packages/context/src/ingest/adapters/historic-sql/types.test.ts`

- [ ] **Step 1: Run focused historic-SQL tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/redaction.test.ts src/ingest/adapters/historic-sql/stage-unified.test.ts src/ingest/adapters/historic-sql/local-ingest-acceptance.test.ts src/ingest/adapters/historic-sql/projection.test.ts src/ingest/adapters/historic-sql/types.test.ts
```

Expected: PASS. The output reports 5 test files passed.

- [ ] **Step 2: Run the context package type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS with TypeScript completing without diagnostics.

- [ ] **Step 3: Confirm the implementation did not reintroduce legacy historic-SQL codepaths**

Run:

```bash
rg -n "stagePgStatStatementsTemplates|expandCategoricalTemplates|classifySlot|pgss-baseline|historic_sql_ingest|historic_sql_curator" packages/context/src packages/context/skills packages/cli/src
```

Expected: no matches.

- [ ] **Step 4: Commit verification-only adjustments if any were required**

If Task 3 required a source or test correction, commit the verified files:

```bash
git add packages/context/src/ingest/adapters/historic-sql/redaction.ts packages/context/src/ingest/adapters/historic-sql/redaction.test.ts packages/context/src/ingest/adapters/historic-sql/stage-unified.ts packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts
git commit -m "test: verify historic sql redaction hardening"
```

If Task 3 did not require changes, leave the existing commits from Task 1 and Task 2 unchanged.

## Self-Review

**Spec coverage:** This plan covers the remaining practical gap in spec §8's `redactionPatterns` config by applying it before SQL text reaches staged artifacts and LLM WorkUnit inputs. It does not alter reader SQL, projection, search enrichment, or setup output because those slices are already implemented.

**Placeholder scan:** The plan contains no `TBD`, no `TODO`, and no missing code bodies. Every code-writing step includes the exact test or implementation block to add.

**Type consistency:** `HistoricSqlRedactionPattern`, `compileHistoricSqlRedactionPatterns()`, and `redactHistoricSqlText()` are defined in Task 1 and imported with the same names in Task 2. `redactTemplateSql()` returns `AggregatedTemplate`, preserving the existing `ParsedTemplate.template` type.

Plan complete and saved to `docs/superpowers/plans/2026-05-11-historic-sql-redaction-hardening.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
