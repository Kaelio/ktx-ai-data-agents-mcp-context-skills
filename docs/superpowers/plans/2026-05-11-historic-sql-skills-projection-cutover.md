# Historic SQL Skills Projection Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the production `historic-sql` adapter over to the unified staged shape, add the two replacement LLM skills, project their evidence into `_schema` usage and pattern wiki pages, and delete the legacy per-template code path.

**Architecture:** The deterministic fetch/chunk hot path is already present and remains LLM-free. WorkUnit skills emit typed evidence through a source-specific tool into ignored run-local files; a deterministic ingest post-processor reads those evidence files before the squash commit and writes `_schema` usage plus `knowledge/global/historic-sql/*.md` pattern pages. The existing `onPullSucceeded()` hook runs after the squash commit in this repo, so projection uses `IngestBundlePostProcessorPort`, which is the current pre-squash deterministic import hook.

**Tech Stack:** TypeScript ESM/NodeNext, zod 4, Vitest, YAML, existing ingest WorkUnit runner, existing semantic-layer and wiki file layouts.

---

## Starting Point

Spec: `docs/superpowers/specs/2026-05-11-historic-sql-redesign-design.md`

Plans found that are based on this spec:

- `docs/superpowers/plans/2026-05-11-historic-sql-foundations.md`
- `docs/superpowers/plans/2026-05-11-historic-sql-search-enrichment.md`
- `docs/superpowers/plans/2026-05-11-historic-sql-unified-hot-path.md`

Implemented status verified in this worktree:

- `2026-05-11-historic-sql-foundations.md` is implemented. Evidence: `packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts`, `SqlAnalysisPort.analyzeBatch()` in `packages/context/src/sql-analysis/ports.ts`, `/sql/analyze-batch` in `python/ktx-daemon/src/ktx_daemon/app.py`, `SemanticLayerSource.usage` in `packages/context/src/sl/types.ts`, and `mergeUsagePreservingExternal()` in `packages/context/src/ingest/adapters/live-database/manifest.ts`.
- `2026-05-11-historic-sql-search-enrichment.md` is implemented. Evidence: `packages/context/src/sl/sl-search.service.ts` indexes `source.usage`, `packages/context/src/sl/sqlite-sl-sources-index.ts` selects FTS snippets, and local/MCP list surfaces expose `frequencyTier` and `snippet`.
- `2026-05-11-historic-sql-unified-hot-path.md` is implemented as helper code. Evidence: `stageHistoricSqlAggregatedSnapshot()`, `chunkHistoricSqlUnifiedStagedDir()`, `PostgresPgssReader`, aggregate BigQuery/Snowflake reader methods, unified schemas, and exports exist.

Verification already run before writing this plan:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/skill-schemas.test.ts src/sl/semantic-layer.service.test.ts src/ingest/adapters/live-database/manifest.test.ts src/scan/local-enrichment-artifacts.test.ts src/sql-analysis/http-sql-analysis-port.test.ts src/sl/sl-search.service.test.ts src/sl/sqlite-sl-sources-index.test.ts src/sl/local-sl.test.ts src/mcp/local-project-ports.test.ts src/ingest/adapters/historic-sql/types.test.ts src/ingest/adapters/historic-sql/buckets.test.ts src/ingest/adapters/historic-sql/stage-unified.test.ts src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts src/ingest/adapters/historic-sql/chunk-unified.test.ts src/package-exports.test.ts
```

Expected and observed: 17 files passed, 119 tests passed.

```bash
source .venv/bin/activate && python -m pytest python/ktx-daemon/tests/test_sql_analysis.py python/ktx-daemon/tests/test_app.py -q
```

Expected and observed: 20 passed.

Still not implemented:

- `HistoricSqlSourceAdapter` still calls `stagePgStatStatementsTemplates()` or `stageHistoricSqlTemplates()` and advertises `historic_sql_ingest` / `historic_sql_curator`.
- Old skills still exist: `packages/context/skills/historic_sql_ingest/SKILL.md` and `packages/context/skills/historic_sql_curator/SKILL.md`.
- Old template staging and PGSS baseline files still exist: `stage.ts`, `stage-pgss.ts`, `chunk.ts`, `postgres-pgss-query-history-reader.ts`, related tests/fixtures.
- CLI doctor/setup code still imports `PostgresPgssQueryHistoryReader`.
- Runtime asset tests and page-triage prompts still mention `historic_sql_template`, `historic_sql_ingest`, and `historic_sql_curator`.

## File Structure

Create:

- `packages/context/src/ingest/adapters/historic-sql/evidence.ts`
  Owns typed evidence envelopes, ignored evidence path helpers, and load/write helpers for table usage and pattern evidence.
- `packages/context/src/ingest/adapters/historic-sql/evidence.test.ts`
  Tests evidence schema validation, path normalization, and loader rejection of malformed evidence.
- `packages/context/src/ingest/adapters/historic-sql/evidence-tool.ts`
  Adds `emit_historic_sql_evidence`, the only write tool the two new historic-SQL skills use.
- `packages/context/src/ingest/adapters/historic-sql/evidence-tool.test.ts`
  Tests the tool writes ignored run-local JSON with `skipLock: true` and rejects non-historic ingest sessions.
- `packages/context/src/ingest/adapters/historic-sql/projection.ts`
  Projects table usage evidence into manifest shards, writes pattern wiki pages, marks stale usage/pages, and deletes legacy query pages.
- `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`
  Tests `_schema` merge, stale usage, pattern slug reuse, stale page tagging, archive movement, and legacy page cleanup.
- `packages/context/src/ingest/adapters/historic-sql/post-processor.ts`
  Implements `IngestBundlePostProcessorPort` for the deterministic projection phase.
- `packages/context/src/ingest/adapters/historic-sql/post-processor.test.ts`
  Tests post-processor path resolution from `workdir`, `connectionId`, `sourceKey`, and `syncId`.
- `packages/context/skills/historic_sql_table_digest/SKILL.md`
  Skill for one changed `tables/*.json` WorkUnit; emits one table usage evidence object.
- `packages/context/skills/historic_sql_patterns/SKILL.md`
  Skill for `patterns-input.json`; emits one pattern evidence object per recurring cross-table intent.

Modify:

- `packages/context/src/ingest/adapters/historic-sql/types.ts`
  Keep only unified config/staged schemas and reader contracts; extend config preprocessing for existing `serviceAccountUserPatterns` and `minCalls` aliases.
- `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`
  Add `staleArchiveAfterDays` to `manifest.json` so projection can archive stale pattern pages deterministically.
- `packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts`
  Keep the same WorkUnits, but mention `emit_historic_sql_evidence` in `notes`.
- `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.ts`
  Switch production fetch/chunk/scope to the unified hot path, replace skills, remove legacy triage support, and run legacy PGSS baseline cache cleanup.
- `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts`
  Rewrite around unified staging and new skills.
- `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.ts`
  Inline the PGSS probe logic so `postgres-pgss-query-history-reader.ts` can be deleted.
- `packages/context/src/ingest/local-adapters.ts`
  Use `PostgresPgssReader` for local Postgres historic SQL and return unified pull config.
- `packages/context/src/ingest/local-bundle-runtime.ts`
  Add the source-specific evidence tool to historic-SQL WorkUnits and register the historic-SQL post-processor.
- `packages/context/src/ingest/ingest-runtime-assets.test.ts`
  Replace old skill asset assertions with the two new skills.
- `packages/context/src/memory/memory-runtime-assets.test.ts`
  Replace old historic-SQL skill heading with the two new skill headings.
- `packages/context/src/package-exports.test.ts`
  Remove legacy export assertions and add evidence/projection export assertions.
- `packages/context/src/ingest/index.ts`
  Export new evidence/projection/post-processor helpers and remove legacy historic-SQL exports.
- `packages/cli/src/setup-databases.ts` and `packages/cli/src/historic-sql-doctor.ts`
  Import `PostgresPgssReader` instead of `PostgresPgssQueryHistoryReader`.
- `packages/cli/src/commands/setup-commands.ts`, `packages/cli/src/index.test.ts`, `packages/cli/src/setup-databases.test.ts`
  Rename generated config to `minExecutions` while accepting the old `--historic-sql-min-calls` flag for one release.
- `packages/context/prompts/skills/page_triage_classifier.md`, `packages/context/src/ingest/page-triage/page-triage.service.test.ts`, `packages/context/src/ingest/ingest-prompts.test.ts`
  Remove historic-SQL template triage examples because the new adapter no longer uses page triage.

Delete:

- `packages/context/src/ingest/adapters/historic-sql/stage.ts`
- `packages/context/src/ingest/adapters/historic-sql/stage.test.ts`
- `packages/context/src/ingest/adapters/historic-sql/stage-pgss.ts`
- `packages/context/src/ingest/adapters/historic-sql/stage-pgss.test.ts`
- `packages/context/src/ingest/adapters/historic-sql/stage-pgss-golden.test.ts`
- `packages/context/src/ingest/adapters/historic-sql/__fixtures__/postgres/`
- `packages/context/src/ingest/adapters/historic-sql/chunk.ts`
- `packages/context/src/ingest/adapters/historic-sql/chunk.test.ts`
- `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-query-history-reader.ts`
- `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-query-history-reader.test.ts`
- `packages/context/skills/historic_sql_ingest/SKILL.md`
- `packages/context/skills/historic_sql_curator/SKILL.md`

## Task 1: Add Typed Historic-SQL Evidence Emission

**Files:**
- Create: `packages/context/src/ingest/adapters/historic-sql/evidence.ts`
- Create: `packages/context/src/ingest/adapters/historic-sql/evidence.test.ts`
- Create: `packages/context/src/ingest/adapters/historic-sql/evidence-tool.ts`
- Create: `packages/context/src/ingest/adapters/historic-sql/evidence-tool.test.ts`
- Modify: `packages/context/src/ingest/index.ts`
- Modify: `packages/context/src/package-exports.test.ts`

- [ ] **Step 1: Write failing evidence schema tests**

Create `packages/context/src/ingest/adapters/historic-sql/evidence.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  historicSqlEvidenceEnvelopeSchema,
  historicSqlEvidencePath,
  historicSqlTableUsageEvidenceSchema,
} from './evidence.js';

describe('historic-sql evidence contracts', () => {
  it('validates table usage evidence emitted by table digest WorkUnits', () => {
    const parsed = historicSqlTableUsageEvidenceSchema.parse({
      kind: 'table_usage',
      connectionId: 'warehouse',
      table: 'public.orders',
      rawPath: 'tables/public.orders.json',
      usage: {
        narrative: 'Orders are repeatedly queried for paid/refunded lifecycle analysis.',
        frequencyTier: 'high',
        commonFilters: ['status', 'created_at'],
        commonGroupBys: ['status'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
        staleSince: null,
      },
    });

    expect(parsed.table).toBe('public.orders');
    expect(parsed.usage.frequencyTier).toBe('high');
  });

  it('validates pattern evidence emitted by the patterns WorkUnit', () => {
    const parsed = historicSqlEvidenceEnvelopeSchema.parse({
      kind: 'pattern',
      connectionId: 'warehouse',
      rawPath: 'patterns-input.json',
      pattern: {
        slug: 'order-lifecycle-analysis',
        title: 'Order Lifecycle Analysis',
        narrative: 'Analysts compare order status changes by customer segment.',
        definitionSql: 'select status, count(*) from public.orders group by status',
        tablesInvolved: ['public.orders', 'public.customers'],
        slRefs: ['orders', 'customers'],
        constituentTemplateIds: ['pg:1', 'pg:2'],
      },
    });

    expect(parsed.kind).toBe('pattern');
    expect(parsed.pattern.slug).toBe('order-lifecycle-analysis');
  });

  it('builds a stable ignored evidence path from run and WorkUnit identity', () => {
    expect(historicSqlEvidencePath('run-1', 'historic-sql-table-public-orders')).toBe(
      '.ktx/ingest-evidence/historic-sql/run-1/historic-sql-table-public-orders.json',
    );
  });
});
```

- [ ] **Step 2: Run the schema tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/evidence.test.ts
```

Expected: FAIL with an import error for `./evidence.js`.

- [ ] **Step 3: Add evidence schemas and path helpers**

Create `packages/context/src/ingest/adapters/historic-sql/evidence.ts`:

```typescript
import { z } from 'zod';
import { patternOutputSchema, tableUsageOutputSchema } from './skill-schemas.js';

function safeEvidenceSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!segment) {
    throw new Error(`Invalid historic-SQL evidence path segment: ${value}`);
  }
  return segment;
}

export const historicSqlTableUsageEvidenceSchema = z.object({
  kind: z.literal('table_usage'),
  connectionId: z.string().min(1),
  table: z.string().min(1),
  rawPath: z.string().min(1),
  usage: tableUsageOutputSchema,
});
export type HistoricSqlTableUsageEvidence = z.infer<typeof historicSqlTableUsageEvidenceSchema>;

export const historicSqlPatternEvidenceSchema = z.object({
  kind: z.literal('pattern'),
  connectionId: z.string().min(1),
  rawPath: z.string().min(1),
  pattern: patternOutputSchema,
});
export type HistoricSqlPatternEvidence = z.infer<typeof historicSqlPatternEvidenceSchema>;

export const historicSqlEvidenceEnvelopeSchema = z.discriminatedUnion('kind', [
  historicSqlTableUsageEvidenceSchema,
  historicSqlPatternEvidenceSchema,
]);
export type HistoricSqlEvidenceEnvelope = z.infer<typeof historicSqlEvidenceEnvelopeSchema>;

export function historicSqlEvidencePath(runId: string, unitKey: string): string {
  return `.ktx/ingest-evidence/historic-sql/${safeEvidenceSegment(runId)}/${safeEvidenceSegment(unitKey)}.json`;
}

export function serializeHistoricSqlEvidence(evidence: HistoricSqlEvidenceEnvelope): string {
  return `${JSON.stringify(historicSqlEvidenceEnvelopeSchema.parse(evidence), null, 2)}\n`;
}
```

- [ ] **Step 4: Write failing tool tests**

Create `packages/context/src/ingest/adapters/historic-sql/evidence-tool.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { createEmitHistoricSqlEvidenceTool } from './evidence-tool.js';

describe('emit_historic_sql_evidence tool', () => {
  it('writes table usage evidence to the ignored run evidence directory', async () => {
    const writeFile = vi.fn(async () => ({ success: true, commitHash: null }));
    const tool = createEmitHistoricSqlEvidenceTool();

    const result = await tool.execute!(
      {
        kind: 'table_usage',
        table: 'public.orders',
        rawPath: 'tables/public.orders.json',
        usage: {
          narrative: 'Orders are repeatedly queried by paid status.',
          frequencyTier: 'high',
          commonFilters: ['status'],
          commonJoins: [],
          staleSince: null,
        },
      },
      {
        toolCallId: 'call-1',
        messages: [],
        abortSignal: new AbortController().signal,
        experimental_context: {
          connectionId: 'warehouse',
          session: {
            ingest: { runId: 'run-1', jobId: 'job-1', syncId: 'sync-1', sourceKey: 'historic-sql' },
            configService: { writeFile },
          },
        },
      } as never,
    );

    expect(result).toBe('Recorded historic-SQL table_usage evidence for public.orders.');
    expect(writeFile).toHaveBeenCalledWith(
      '.ktx/ingest-evidence/historic-sql/run-1/historic-sql-table-public-orders.json',
      expect.stringContaining('"kind": "table_usage"'),
      'System User',
      'system@example.com',
      'Record historic-SQL evidence: historic-sql-table-public-orders',
      { skipLock: true },
    );
  });

  it('rejects non-historic ingest sessions', async () => {
    const tool = createEmitHistoricSqlEvidenceTool();

    await expect(
      tool.execute!(
        {
          kind: 'pattern',
          rawPath: 'patterns-input.json',
          pattern: {
            slug: 'orders',
            title: 'Orders',
            narrative: 'Orders pattern.',
            definitionSql: 'select * from public.orders',
            tablesInvolved: ['public.orders'],
            slRefs: ['orders'],
            constituentTemplateIds: ['pg:1'],
          },
        },
        {
          toolCallId: 'call-1',
          messages: [],
          abortSignal: new AbortController().signal,
          experimental_context: {
            connectionId: 'warehouse',
            session: {
              ingest: { runId: 'run-1', jobId: 'job-1', syncId: 'sync-1', sourceKey: 'notion' },
              configService: { writeFile: vi.fn() },
            },
          },
        } as never,
      ),
    ).resolves.toContain('Error: emit_historic_sql_evidence is only available during historic-sql ingest');
  });
});
```

- [ ] **Step 5: Run the tool tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/evidence-tool.test.ts
```

Expected: FAIL with an import error for `./evidence-tool.js`.

- [ ] **Step 6: Add the evidence tool**

Create `packages/context/src/ingest/adapters/historic-sql/evidence-tool.ts`:

```typescript
import { tool } from 'ai';
import { z } from 'zod';
import { historicSqlEvidencePath, serializeHistoricSqlEvidence } from './evidence.js';
import { patternOutputSchema, tableUsageOutputSchema } from './skill-schemas.js';

const SYSTEM_AUTHOR = 'System User';
const SYSTEM_EMAIL = 'system@example.com';

function unitKeyForEvidence(input: { kind: string; table?: string; pattern?: { slug: string } }): string {
  if (input.kind === 'table_usage') {
    return `historic-sql-table-${String(input.table).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
  }
  return `historic-sql-pattern-${String(input.pattern?.slug).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

export function createEmitHistoricSqlEvidenceTool() {
  return tool({
    description:
      'Record typed historic-SQL evidence for deterministic projection. Use this instead of wiki_write, sl_write_source, sl_edit_source, or context_candidate_write during historic-SQL WorkUnits.',
    inputSchema: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('table_usage'),
        table: z.string().min(1),
        rawPath: z.string().min(1),
        usage: tableUsageOutputSchema,
      }),
      z.object({
        kind: z.literal('pattern'),
        rawPath: z.string().min(1),
        pattern: patternOutputSchema,
      }),
    ]),
    execute: async (input, options): Promise<string> => {
      const context = options.experimental_context as
        | {
            connectionId?: string | null;
            session?: {
              ingest?: { runId: string; sourceKey: string };
              configService?: {
                writeFile(
                  path: string,
                  content: string,
                  author: string,
                  authorEmail: string,
                  commitMessage: string,
                  options?: { skipLock?: boolean },
                ): Promise<unknown>;
              };
            };
          }
        | undefined;
      const ingest = context?.session?.ingest;
      const configService = context?.session?.configService;
      if (!ingest || ingest.sourceKey !== 'historic-sql' || !configService || !context?.connectionId) {
        return 'Error: emit_historic_sql_evidence is only available during historic-sql ingest.';
      }

      const unitKey = unitKeyForEvidence(input);
      const content = serializeHistoricSqlEvidence({ ...input, connectionId: context.connectionId });
      await configService.writeFile(
        historicSqlEvidencePath(ingest.runId, unitKey),
        content,
        SYSTEM_AUTHOR,
        SYSTEM_EMAIL,
        `Record historic-SQL evidence: ${unitKey}`,
        { skipLock: true },
      );
      const label = input.kind === 'table_usage' ? input.table : input.pattern.slug;
      return `Recorded historic-SQL ${input.kind} evidence for ${label}.`;
    },
  });
}
```

- [ ] **Step 7: Export evidence helpers and verify tests pass**

Add these exports to `packages/context/src/ingest/index.ts`:

```typescript
export {
  historicSqlEvidenceEnvelopeSchema,
  historicSqlEvidencePath,
  historicSqlPatternEvidenceSchema,
  historicSqlTableUsageEvidenceSchema,
  serializeHistoricSqlEvidence,
} from './adapters/historic-sql/evidence.js';
export type {
  HistoricSqlEvidenceEnvelope,
  HistoricSqlPatternEvidence,
  HistoricSqlTableUsageEvidence,
} from './adapters/historic-sql/evidence.js';
export { createEmitHistoricSqlEvidenceTool } from './adapters/historic-sql/evidence-tool.js';
```

Add these assertions to the historic-SQL block in `packages/context/src/package-exports.test.ts`:

```typescript
    expect(ingest.historicSqlEvidenceEnvelopeSchema).toBeDefined();
    expect(ingest.historicSqlEvidencePath).toBeTypeOf('function');
    expect(ingest.createEmitHistoricSqlEvidenceTool).toBeTypeOf('function');
```

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/evidence.test.ts src/ingest/adapters/historic-sql/evidence-tool.test.ts src/package-exports.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/context/src/ingest/adapters/historic-sql/evidence.ts packages/context/src/ingest/adapters/historic-sql/evidence.test.ts packages/context/src/ingest/adapters/historic-sql/evidence-tool.ts packages/context/src/ingest/adapters/historic-sql/evidence-tool.test.ts packages/context/src/ingest/index.ts packages/context/src/package-exports.test.ts
git commit -m "feat: add historic sql evidence emission"
```

## Task 2: Add Replacement Historic-SQL Skills

**Files:**
- Create: `packages/context/skills/historic_sql_table_digest/SKILL.md`
- Create: `packages/context/skills/historic_sql_patterns/SKILL.md`
- Modify: `packages/context/src/ingest/ingest-runtime-assets.test.ts`
- Modify: `packages/context/src/memory/memory-runtime-assets.test.ts`

- [ ] **Step 1: Write failing runtime asset tests for the new skills**

In `packages/context/src/ingest/ingest-runtime-assets.test.ts`, replace `historic_sql_ingest` with `historic_sql_table_digest` and `historic_sql_patterns` in `adapterSkillNames`, and remove `historic_sql_curator` from `adapterReconcileSkillNames`.

Replace the two historic-SQL skill tests with:

```typescript
  it('packages historic-SQL table digest guidance from KTX assets', async () => {
    const registry = new SkillsRegistryService({ skillsDir });
    const skills = await registry.listSkills(['historic_sql_table_digest'], 'memory_agent');

    expect(skills.map((skill) => skill.name)).toEqual(['historic_sql_table_digest']);

    const body = await readFile(join(skills[0]!.path, 'SKILL.md'), 'utf-8');
    expect(body).toContain('# Historic SQL Table Digest');
    expect(body).toContain('tables/<schema>.<name>.json');
    expect(body).toContain('tableUsageOutputSchema');
    expect(body).toContain('emit_historic_sql_evidence');
    expect(body).toContain('Do not call wiki_write');
    expect(body).toContain('Do not call sl_write_source');
    expect(body).not.toMatch(forbiddenProductPattern());
  });

  it('packages historic-SQL patterns guidance from KTX assets', async () => {
    const registry = new SkillsRegistryService({ skillsDir });
    const skills = await registry.listSkills(['historic_sql_patterns'], 'memory_agent');

    expect(skills.map((skill) => skill.name)).toEqual(['historic_sql_patterns']);

    const body = await readFile(join(skills[0]!.path, 'SKILL.md'), 'utf-8');
    expect(body).toContain('# Historic SQL Patterns');
    expect(body).toContain('patterns-input.json');
    expect(body).toContain('patternsArraySchema');
    expect(body).toContain('emit_historic_sql_evidence');
    expect(body).toContain('cross-table');
    expect(body).not.toMatch(forbiddenProductPattern());
  });
```

In `packages/context/src/memory/memory-runtime-assets.test.ts`, change `expectedAdapterSkillHeadings` to include:

```typescript
  historic_sql_patterns: '# Historic SQL Patterns',
  historic_sql_table_digest: '# Historic SQL Table Digest',
```

and remove:

```typescript
  historic_sql_ingest: '# Historic SQL Ingest',
```

- [ ] **Step 2: Run runtime asset tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-runtime-assets.test.ts src/memory/memory-runtime-assets.test.ts
```

Expected: FAIL because `historic_sql_table_digest` and `historic_sql_patterns` skill directories do not exist yet.

- [ ] **Step 3: Add the table digest skill**

Create `packages/context/skills/historic_sql_table_digest/SKILL.md`:

```markdown
---
name: historic_sql_table_digest
description: Convert one changed historic-SQL table usage bucket into typed table usage evidence for deterministic _schema projection.
callers: [memory_agent]
---

# Historic SQL Table Digest

Use this skill when the WorkUnit raw file is one `tables/<schema>.<name>.json` file from the `historic-sql` adapter.

## Required Workflow

1. Read the WorkUnit notes first.
2. Call `read_raw_file` for the single `tables/<schema>.<name>.json` raw file.
3. Read `manifest.json` only if the table JSON omits the dialect or the WorkUnit notes are unclear.
4. Produce one concise usage narrative for this table from the staged table JSON.
5. Call `emit_historic_sql_evidence` exactly once with `kind: "table_usage"`.
6. Stop after the evidence tool succeeds.

## Evidence Shape

Call `emit_historic_sql_evidence` with this shape:

```json
{
  "kind": "table_usage",
  "table": "public.orders",
  "rawPath": "tables/public.orders.json",
  "usage": {
    "narrative": "Orders are repeatedly queried for paid/refunded lifecycle analysis and customer-level rollups.",
    "frequencyTier": "high",
    "commonFilters": ["status", "created_at"],
    "commonGroupBys": ["status"],
    "commonJoins": [{ "table": "public.customers", "on": ["customer_id"] }],
    "staleSince": null
  }
}
```

The `usage` object must match `tableUsageOutputSchema`.

## Interpretation Rules

- Treat `columnsByClause.where` as common filters.
- Treat `columnsByClause.groupBy` as common group-bys.
- Treat `observedJoins` as common joins.
- Use `stats.executionsBucket`, `stats.distinctUsersBucket`, and `stats.recencyBucket` to choose `frequencyTier`.
- Use `frequencyTier: "high"` only when executions and distinct users are both broad.
- Use `frequencyTier: "mid"` for repeated team usage that is not broad enough for high.
- Use `frequencyTier: "low"` for low-volume but present usage.
- Use `frequencyTier: "unused"` only when the table input explicitly says the table is stale or has no recent templates.
- Keep `narrative` short and concrete.

## Boundaries

- Do not call `wiki_write`.
- Do not call `sl_write_source`.
- Do not call `sl_edit_source`.
- Do not call `context_candidate_write`.
- Do not emit more than one table usage evidence object.
- Do not invent columns, joins, or tables that are absent from the staged JSON.
```

- [ ] **Step 4: Add the patterns skill**

Create `packages/context/skills/historic_sql_patterns/SKILL.md`:

```markdown
---
name: historic_sql_patterns
description: Identify recurring cross-table historic-SQL analytical intents and emit typed pattern evidence for deterministic wiki projection.
callers: [memory_agent]
---

# Historic SQL Patterns

Use this skill when the WorkUnit raw file is `patterns-input.json` from the `historic-sql` adapter.

## Required Workflow

1. Read the WorkUnit notes first.
2. Call `read_raw_file` for `patterns-input.json`.
3. Identify recurring analytical intents that span at least two tables and have repeated usage signal.
4. Emit one `pattern` evidence object per durable cross-table intent by calling `emit_historic_sql_evidence`.
5. Stop after all pattern evidence has been emitted.

## Evidence Shape

Each call to `emit_historic_sql_evidence` must use this shape:

```json
{
  "kind": "pattern",
  "rawPath": "patterns-input.json",
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

## Boundaries

- Do not call `wiki_write`.
- Do not call `sl_write_source`.
- Do not call `sl_edit_source`.
- Do not call `context_candidate_write`.
- Do not create single-table pattern pages.
- Do not copy credentials, tokens, user emails, or unredacted literals into evidence.
```

- [ ] **Step 5: Run runtime asset tests to verify they pass**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-runtime-assets.test.ts src/memory/memory-runtime-assets.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/context/skills/historic_sql_table_digest/SKILL.md packages/context/skills/historic_sql_patterns/SKILL.md packages/context/src/ingest/ingest-runtime-assets.test.ts packages/context/src/memory/memory-runtime-assets.test.ts
git commit -m "feat: add historic sql evidence skills"
```

## Task 3: Project Evidence Into _schema Usage And Pattern Wiki Pages

**Files:**
- Create: `packages/context/src/ingest/adapters/historic-sql/projection.ts`
- Create: `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/types.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`
- Modify: `packages/context/src/wiki/types.ts`
- Modify: `packages/context/src/ingest/index.ts`

- [ ] **Step 1: Extend staged manifest with stale archive policy**

In `packages/context/src/ingest/adapters/historic-sql/types.test.ts`, add `staleArchiveAfterDays: 90` to the manifest fixture and assert:

```typescript
    expect(
      stagedManifestSchema.parse({
        source: 'historic-sql',
        connectionId: 'warehouse',
        dialect: 'postgres',
        fetchedAt: '2026-05-11T00:00:00.000Z',
        windowStart: '2026-02-10T00:00:00.000Z',
        windowEnd: '2026-05-11T00:00:00.000Z',
        snapshotRowCount: 2,
        touchedTableCount: 1,
        parseFailures: 1,
        warnings: ['parse_failed:bad'],
        probeWarnings: [],
        staleArchiveAfterDays: 90,
      }).staleArchiveAfterDays,
    ).toBe(90);
```

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/types.test.ts src/ingest/adapters/historic-sql/stage-unified.test.ts
```

Expected: FAIL because `staleArchiveAfterDays` is not in `stagedManifestSchema` or written by staging.

- [ ] **Step 2: Implement staged manifest policy field**

Add this field to `stagedManifestSchema` in `packages/context/src/ingest/adapters/historic-sql/types.ts`:

```typescript
  staleArchiveAfterDays: z.number().int().positive().default(90),
```

Add this property to the manifest object written by `stageHistoricSqlAggregatedSnapshot()` in `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`:

```typescript
    staleArchiveAfterDays: config.staleArchiveAfterDays,
```

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/types.test.ts src/ingest/adapters/historic-sql/stage-unified.test.ts
```

Expected: PASS.

- [ ] **Step 3: Write failing projection tests**

Create `packages/context/src/ingest/adapters/historic-sql/projection.test.ts`:

```typescript
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { projectHistoricSqlEvidence } from './projection.js';

async function tempWorkdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'historic-sql-projection-'));
}

async function writeText(root: string, relPath: string, content: string): Promise<void> {
  const target = join(root, relPath);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content, 'utf-8');
}

async function writeJson(root: string, relPath: string, value: unknown): Promise<void> {
  await writeText(root, relPath, `${JSON.stringify(value, null, 2)}\n`);
}

describe('projectHistoricSqlEvidence', () => {
  it('merges table usage into matching _schema shards and preserves external usage keys', async () => {
    const workdir = await tempWorkdir();
    await writeText(
      workdir,
      'semantic-layer/warehouse/_schema/public.yaml',
      YAML.stringify({
        tables: {
          orders: {
            table: 'public.orders',
            usage: {
              narrative: 'Old generated usage.',
              frequencyTier: 'low',
              commonFilters: ['old_status'],
              commonJoins: [],
              ownerNote: 'keep me',
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
      snapshotRowCount: 1,
      touchedTableCount: 1,
      parseFailures: 0,
      warnings: [],
      probeWarnings: [],
      staleArchiveAfterDays: 90,
    });
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/tables/public.orders.json', { table: 'public.orders' });
    await writeJson(workdir, '.ktx/ingest-evidence/historic-sql/run-1/orders.json', {
      kind: 'table_usage',
      connectionId: 'warehouse',
      table: 'public.orders',
      rawPath: 'tables/public.orders.json',
      usage: {
        narrative: 'Orders are repeatedly queried for lifecycle analysis.',
        frequencyTier: 'high',
        commonFilters: ['status', 'created_at'],
        commonGroupBys: ['status'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
        staleSince: null,
      },
    });

    const result = await projectHistoricSqlEvidence({ workdir, connectionId: 'warehouse', syncId: 'sync-1', runId: 'run-1' });

    expect(result.touchedSources).toEqual([{ connectionId: 'warehouse', sourceName: 'orders' }]);
    const shard = YAML.parse(await readFile(join(workdir, 'semantic-layer/warehouse/_schema/public.yaml'), 'utf-8'));
    expect(shard.tables.orders.usage).toEqual({
      ownerNote: 'keep me',
      narrative: 'Orders are repeatedly queried for lifecycle analysis.',
      frequencyTier: 'high',
      commonFilters: ['status', 'created_at'],
      commonGroupBys: ['status'],
      commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      staleSince: null,
    });
  });

  it('writes pattern pages, reuses similar slugs, and marks missing old pattern pages stale', async () => {
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
      staleArchiveAfterDays: 90,
    });
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/tables/public.orders.json', { table: 'public.orders' });
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/tables/public.customers.json', { table: 'public.customers' });
    await writeText(
      workdir,
      'knowledge/global/historic-sql/old-order-lifecycle.md',
      [
        '---',
        YAML.stringify({
          summary: 'Old order lifecycle page',
          tags: ['historic-sql', 'pattern'],
          refs: [],
          sl_refs: ['orders'],
          usage_mode: 'auto',
          source: 'historic-sql',
          tables: ['public.orders', 'public.customers'],
          fingerprints: ['pg:1'],
        }).trimEnd(),
        '---',
        '',
        'Old body',
        '',
      ].join('\n'),
    );
    await writeText(
      workdir,
      'knowledge/global/historic-sql/retired-pattern.md',
      [
        '---',
        YAML.stringify({
          summary: 'Retired pattern',
          tags: ['historic-sql', 'pattern'],
          refs: [],
          sl_refs: [],
          usage_mode: 'auto',
          source: 'historic-sql',
          tables: ['public.tickets'],
          fingerprints: ['pg:9'],
        }).trimEnd(),
        '---',
        '',
        'Retired body',
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
        narrative: 'Analysts compare order status with customer segment.',
        definitionSql: 'select * from public.orders join public.customers on customers.id = orders.customer_id',
        tablesInvolved: ['public.orders', 'public.customers'],
        slRefs: ['orders', 'customers'],
        constituentTemplateIds: ['pg:1', 'pg:2'],
      },
    });

    const result = await projectHistoricSqlEvidence({ workdir, connectionId: 'warehouse', syncId: 'sync-1', runId: 'run-1' });

    expect(result.patternPagesWritten).toBe(1);
    await expect(readFile(join(workdir, 'knowledge/global/historic-sql/old-order-lifecycle.md'), 'utf-8')).resolves.toContain(
      'Order Lifecycle Analysis',
    );
    await expect(readFile(join(workdir, 'knowledge/global/historic-sql/retired-pattern.md'), 'utf-8')).resolves.toContain(
      'stale_since: "2026-05-11T00:00:00.000Z"',
    );
  });
});
```

- [ ] **Step 4: Run projection tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/projection.test.ts
```

Expected: FAIL with an import error for `./projection.js`.

- [ ] **Step 5: Implement projection helpers**

Create `packages/context/src/ingest/adapters/historic-sql/projection.ts` with these exported shapes and functions:

```typescript
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import YAML from 'yaml';
import { rawSourcesDirForSync } from '../../raw-sources-paths.js';
import { mergeUsagePreservingExternal } from '../live-database/manifest.js';
import { historicSqlEvidenceEnvelopeSchema, type HistoricSqlEvidenceEnvelope } from './evidence.js';
import { stagedManifestSchema } from './types.js';

export interface HistoricSqlProjectionInput {
  workdir: string;
  connectionId: string;
  syncId: string;
  runId: string;
}

export interface HistoricSqlProjectionResult {
  tableUsageMerged: number;
  staleTablesMarked: number;
  patternPagesWritten: number;
  stalePatternPagesMarked: number;
  archivedPatternPages: number;
  legacyPagesDeleted: number;
  touchedSources: Array<{ connectionId: string; sourceName: string }>;
  warnings: string[];
}

interface ManifestShard {
  tables?: Record<string, { table?: string; usage?: Record<string, unknown>; columns?: unknown[]; [key: string]: unknown }>;
}

function safeKnowledgeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9/-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
    .sort();
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8')) as unknown;
}

async function writeYamlAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, YAML.stringify(value, { indent: 2, lineWidth: 0 }), 'utf-8');
  await rename(tmp, path);
}

function tableSourceName(tableRef: string): string {
  return tableRef.split('.').filter(Boolean).at(-1) ?? tableRef;
}

function staleUsage(fetchedAt: string) {
  return {
    narrative: 'No recent historic SQL usage was observed in the latest snapshot.',
    frequencyTier: 'unused' as const,
    commonFilters: [],
    commonGroupBys: [],
    commonJoins: [],
    staleSince: fetchedAt,
  };
}

async function loadEvidence(workdir: string, runId: string): Promise<HistoricSqlEvidenceEnvelope[]> {
  const root = join(workdir, '.ktx/ingest-evidence/historic-sql', runId);
  const files = await walkFiles(root);
  const evidence: HistoricSqlEvidenceEnvelope[] = [];
  for (const file of files.filter((candidate) => candidate.endsWith('.json'))) {
    evidence.push(historicSqlEvidenceEnvelopeSchema.parse(await readJson(join(root, file))));
  }
  return evidence;
}

function renderPatternMarkdown(pattern: HistoricSqlEvidenceEnvelope & { kind: 'pattern' }): string {
  return [
    `# ${pattern.pattern.title}`,
    '',
    pattern.pattern.narrative,
    '',
    '## Representative SQL',
    '',
    '```sql',
    pattern.pattern.definitionSql,
    '```',
    '',
    '## Tables',
    '',
    ...pattern.pattern.tablesInvolved.map((table) => `- ${table}`),
    '',
    '## Constituent Templates',
    '',
    ...pattern.pattern.constituentTemplateIds.map((id) => `- ${id}`),
    '',
  ].join('\n');
}

function overlapRatio(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  const intersection = left.filter((value) => rightSet.has(value)).length;
  return left.length === 0 ? 0 : intersection / left.length;
}
```

In the same file, implement `projectHistoricSqlEvidence()` with this behavior:

- Read `manifest.json` from `join(workdir, rawSourcesDirForSync(connectionId, 'historic-sql', syncId), 'manifest.json')` and parse with `stagedManifestSchema`.
- Read every current table file under `raw-sources/<connectionId>/historic-sql/<syncId>/tables/*.json` and build a `Set<string>` of current staged table refs.
- Load every evidence JSON file from `.ktx/ingest-evidence/historic-sql/<runId>`.
- For each `_schema/*.yaml` shard in `semantic-layer/<connectionId>/_schema`:
  - Parse the shard as YAML.
  - For each table entry, match table evidence where `evidence.table === entry.table` or `tableSourceName(evidence.table) === tableName`.
  - Merge evidence usage with `mergeUsagePreservingExternal(entry.usage, evidence.usage)`.
  - If an entry has `usage` and its table ref is absent from the current staged table set, replace historic-SQL managed usage with `staleUsage(manifest.fetchedAt)` while preserving external keys through `mergeUsagePreservingExternal`.
  - Write the shard atomically only when serialized YAML changes.
- For patterns:
  - Read current pages under `knowledge/global/historic-sql/*.md`.
  - Treat pages with frontmatter `tags` containing both `historic-sql` and `pattern` as historic-SQL pattern pages.
  - For each pattern evidence, reuse an existing page key when overlap of `tables + constituentTemplateIds` against existing `tables + fingerprints` is at least `0.6`; otherwise write `historic-sql/<safe slug>`.
  - Write frontmatter with `summary`, `tags: ['historic-sql', 'pattern']`, `refs`, `sl_refs`, `usage_mode: 'auto'`, `source: 'historic-sql'`, `tables`, `representative_sql`, and `fingerprints`.
  - For existing pattern pages not written this run, add tag `stale` and `stale_since: manifest.fetchedAt`.
  - If an existing stale page has `stale_since` older than `manifest.staleArchiveAfterDays`, move it under `knowledge/global/historic-sql/_archived/<slug>.md` and add tag `archived`.
- Delete legacy old per-template pages whose frontmatter has `source: historic-sql`, tag `query-pattern`, and lacks tag `pattern`.
- Return counts and touched source names for every `_schema` entry whose usage changed.

- [ ] **Step 6: Extend wiki frontmatter type for stale pattern metadata**

In `packages/context/src/wiki/types.ts`, add:

```typescript
  stale_since?: string;
```

to `WikiFrontmatter`.

- [ ] **Step 7: Export projection and run tests**

Add this export to `packages/context/src/ingest/index.ts`:

```typescript
export { projectHistoricSqlEvidence } from './adapters/historic-sql/projection.js';
export type { HistoricSqlProjectionInput, HistoricSqlProjectionResult } from './adapters/historic-sql/projection.js';
```

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/projection.test.ts src/ingest/adapters/historic-sql/types.test.ts src/ingest/adapters/historic-sql/stage-unified.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/context/src/ingest/adapters/historic-sql/projection.ts packages/context/src/ingest/adapters/historic-sql/projection.test.ts packages/context/src/ingest/adapters/historic-sql/types.ts packages/context/src/ingest/adapters/historic-sql/types.test.ts packages/context/src/ingest/adapters/historic-sql/stage-unified.ts packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts packages/context/src/wiki/types.ts packages/context/src/ingest/index.ts
git commit -m "feat: project historic sql evidence"
```

## Task 4: Wire The Projection Post-Processor And Evidence Tool Runtime

**Files:**
- Create: `packages/context/src/ingest/adapters/historic-sql/post-processor.ts`
- Create: `packages/context/src/ingest/adapters/historic-sql/post-processor.test.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Modify: `packages/context/src/ingest/local-bundle-ingest.test.ts`
- Modify: `packages/context/src/ingest/index.ts`

- [ ] **Step 1: Write failing post-processor tests**

Create `packages/context/src/ingest/adapters/historic-sql/post-processor.test.ts`:

```typescript
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { HistoricSqlProjectionPostProcessor } from './post-processor.js';

async function tempWorkdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'historic-sql-post-processor-'));
}

async function writeJson(root: string, relPath: string, value: unknown): Promise<void> {
  const target = join(root, relPath);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('HistoricSqlProjectionPostProcessor', () => {
  it('projects current run evidence before the ingest squash commit', async () => {
    const workdir = await tempWorkdir();
    await mkdir(join(workdir, 'semantic-layer/warehouse/_schema'), { recursive: true });
    await writeFile(
      join(workdir, 'semantic-layer/warehouse/_schema/public.yaml'),
      YAML.stringify({ tables: { orders: { table: 'public.orders', columns: [{ name: 'id', type: 'string' }] } } }),
      'utf-8',
    );
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/manifest.json', {
      source: 'historic-sql',
      connectionId: 'warehouse',
      dialect: 'postgres',
      fetchedAt: '2026-05-11T00:00:00.000Z',
      windowStart: '2026-02-10T00:00:00.000Z',
      windowEnd: '2026-05-11T00:00:00.000Z',
      snapshotRowCount: 1,
      touchedTableCount: 1,
      parseFailures: 0,
      warnings: [],
      probeWarnings: [],
      staleArchiveAfterDays: 90,
    });
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/tables/public.orders.json', { table: 'public.orders' });
    await writeJson(workdir, '.ktx/ingest-evidence/historic-sql/run-1/orders.json', {
      kind: 'table_usage',
      connectionId: 'warehouse',
      table: 'public.orders',
      rawPath: 'tables/public.orders.json',
      usage: {
        narrative: 'Orders are repeatedly queried by lifecycle status.',
        frequencyTier: 'high',
        commonFilters: ['status'],
        commonJoins: [],
        staleSince: null,
      },
    });

    const result = await new HistoricSqlProjectionPostProcessor().run({
      connectionId: 'warehouse',
      sourceKey: 'historic-sql',
      syncId: 'sync-1',
      jobId: 'job-1',
      runId: 'run-1',
      workdir,
      parseArtifacts: null,
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.touchedSources).toEqual([{ connectionId: 'warehouse', sourceName: 'orders' }]);
    expect(result.result).toMatchObject({ tableUsageMerged: 1 });
    await expect(readFile(join(workdir, 'semantic-layer/warehouse/_schema/public.yaml'), 'utf-8')).resolves.toContain(
      'Orders are repeatedly queried by lifecycle status.',
    );
  });
});
```

- [ ] **Step 2: Run the post-processor test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/post-processor.test.ts
```

Expected: FAIL with an import error for `./post-processor.js`.

- [ ] **Step 3: Implement the post-processor**

Create `packages/context/src/ingest/adapters/historic-sql/post-processor.ts`:

```typescript
import type { IngestBundlePostProcessorInput, IngestBundlePostProcessorPort, IngestBundlePostProcessorResult } from '../../ports.js';
import { projectHistoricSqlEvidence } from './projection.js';

export class HistoricSqlProjectionPostProcessor implements IngestBundlePostProcessorPort {
  async run(input: IngestBundlePostProcessorInput): Promise<IngestBundlePostProcessorResult> {
    const projection = await projectHistoricSqlEvidence({
      workdir: input.workdir,
      connectionId: input.connectionId,
      syncId: input.syncId,
      runId: input.runId,
    });
    return {
      result: projection,
      warnings: projection.warnings,
      errors: [],
      touchedSources: projection.touchedSources,
    };
  }
}
```

- [ ] **Step 4: Add the evidence tool and post-processor to local ingest runtime**

In `packages/context/src/ingest/local-bundle-runtime.ts`, import:

```typescript
import { createEmitHistoricSqlEvidenceTool } from './adapters/historic-sql/evidence-tool.js';
import { HistoricSqlProjectionPostProcessor } from './adapters/historic-sql/post-processor.js';
```

In `LocalIngestToolsetFactory.createIngestWuToolset()`, return the historic-SQL evidence tool only for historic-SQL ingest sessions:

```typescript
  createIngestWuToolset(session: ToolSession, options?: { includeContextEvidenceTools?: boolean }): IngestToolsetLike {
    const sourceTools = session.ingest?.sourceKey === 'historic-sql' ? [createEmitHistoricSqlEvidenceTool()] : [];
    return new LocalIngestToolSet(
      options?.includeContextEvidenceTools
        ? [...this.baseTools, ...this.contextTools, ...sourceTools]
        : [...this.baseTools, ...sourceTools],
    );
  }
```

In the `deps` object passed to `new IngestBundleRunner(deps)`, add:

```typescript
    postProcessors: {
      'historic-sql': new HistoricSqlProjectionPostProcessor(),
    },
```

- [ ] **Step 5: Add runtime integration assertions**

In `packages/context/src/ingest/local-bundle-ingest.test.ts`, add a test using an injected `agentRunner` that calls `emit_historic_sql_evidence` for a planned historic-SQL WorkUnit and asserts the report `postProcessor` result contains `tableUsageMerged: 1`. Use the existing local-bundle ingest test patterns for injected tool execution; the key assertion is:

```typescript
await expect(readFile(join(projectDir, 'semantic-layer/warehouse/_schema/public.yaml'), 'utf-8')).resolves.toContain(
  'Orders are repeatedly queried by lifecycle status.',
);
```

- [ ] **Step 6: Export post-processor and verify tests pass**

Add this export to `packages/context/src/ingest/index.ts`:

```typescript
export { HistoricSqlProjectionPostProcessor } from './adapters/historic-sql/post-processor.js';
```

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/post-processor.test.ts src/ingest/local-bundle-ingest.test.ts src/package-exports.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/context/src/ingest/adapters/historic-sql/post-processor.ts packages/context/src/ingest/adapters/historic-sql/post-processor.test.ts packages/context/src/ingest/local-bundle-runtime.ts packages/context/src/ingest/local-bundle-ingest.test.ts packages/context/src/ingest/index.ts packages/context/src/package-exports.test.ts
git commit -m "feat: run historic sql deterministic projection"
```

## Task 5: Switch Production Adapter To Unified Hot Path

**Files:**
- Modify: `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/chunk-unified.test.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/types.ts`
- Modify: `packages/context/src/ingest/local-adapters.ts`
- Modify: `packages/context/src/ingest/local-adapters.test.ts`

- [ ] **Step 1: Write failing adapter metadata and fetch tests**

In `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts`, replace the metadata test expectations with:

```typescript
    expect(adapter.skillNames).toEqual(['historic_sql_table_digest', 'historic_sql_patterns']);
    expect(adapter.reconcileSkillNames).toEqual([]);
    expect(adapter.evidenceIndexing).toBeUndefined();
    expect(adapter.triageSupported).toBe(false);
```

Replace the legacy fetch tests with a unified fetch test:

```typescript
  it('fetches a unified aggregate snapshot and emits unified WorkUnits', async () => {
    const stagedDir = await tempDir();
    const reader = {
      async probe() {
        return { warnings: [] };
      },
      async *fetchAggregated() {
        yield {
          templateId: 'pg:1',
          canonicalSql: 'select status, count(*) from public.orders group by status',
          dialect: 'postgres',
          stats: {
            executions: 25,
            distinctUsers: 3,
            firstSeen: '2026-05-01T00:00:00.000Z',
            lastSeen: '2026-05-11T00:00:00.000Z',
            p50RuntimeMs: 10,
            p95RuntimeMs: 20,
            errorRate: 0,
            rowsProduced: 10,
          },
          topUsers: [{ user: 'analyst', executions: 25 }],
        };
      },
    };
    const sqlAnalysis = {
      async analyzeForFingerprint() {
        throw new Error('legacy analyzeForFingerprint must not be used');
      },
      async analyzeBatch() {
        return new Map([
          [
            'pg:1',
            {
              tablesTouched: ['public.orders'],
              columnsByClause: { select: ['status'], groupBy: ['status'] },
            },
          ],
        ]);
      },
    };
    const adapter = new HistoricSqlSourceAdapter({
      sqlAnalysis,
      reader,
      queryClient: {},
      now: () => new Date('2026-05-11T00:00:00.000Z'),
    });

    await adapter.fetch({ dialect: 'postgres', minExecutions: 5 }, stagedDir, {
      connectionId: 'warehouse',
      sourceKey: 'historic-sql',
    });

    await expect(adapter.detect(stagedDir)).resolves.toBe(true);
    await expect(adapter.chunk(stagedDir)).resolves.toMatchObject({
      workUnits: [
        { unitKey: 'historic-sql-table-public-orders' },
        { unitKey: 'historic-sql-patterns' },
      ],
    });
  });
```

- [ ] **Step 2: Run adapter tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts
```

Expected: FAIL because the adapter still advertises legacy skills and calls legacy staging.

- [ ] **Step 3: Update adapter dependency types**

In `packages/context/src/ingest/adapters/historic-sql/types.ts`, change `HistoricSqlSourceAdapterDeps` to:

```typescript
export interface HistoricSqlSourceAdapterDeps {
  sqlAnalysis: SqlAnalysisPort;
  reader: HistoricSqlReader;
  queryClient: unknown;
  legacyPostgresBaselineRootDir?: string;
  now?: () => Date;
}
```

Extend `historicSqlUnifiedPullConfigSchema` preprocessing to map existing local config keys:

```typescript
  const next: Record<string, unknown> = { ...value };
  if (next.minExecutions === undefined && typeof next.minCalls === 'number') {
    next.minExecutions = next.minCalls;
  }
  if (!next.filters && Array.isArray(next.serviceAccountUserPatterns)) {
    next.filters = {
      serviceAccounts: { patterns: next.serviceAccountUserPatterns, mode: 'exclude' },
      dropTrivialProbes: true,
    };
  }
  return next;
```

- [ ] **Step 4: Replace adapter implementation**

In `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.ts`, remove legacy imports and use:

```typescript
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChunkResult, DiffSet, FetchContext, ScopeDescriptor, SourceAdapter } from '../../types.js';
import { chunkHistoricSqlUnifiedStagedDir, describeHistoricSqlUnifiedScope } from './chunk-unified.js';
import { detectHistoricSqlStagedDir } from './detect.js';
import { stageHistoricSqlAggregatedSnapshot } from './stage-unified.js';
import { type HistoricSqlSourceAdapterDeps } from './types.js';

export class HistoricSqlSourceAdapter implements SourceAdapter {
  readonly source = 'historic-sql';
  readonly skillNames = ['historic_sql_table_digest', 'historic_sql_patterns'];
  readonly reconcileSkillNames: string[] = [];
  readonly triageSupported = false;

  constructor(private readonly deps: HistoricSqlSourceAdapterDeps) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectHistoricSqlStagedDir(stagedDir);
  }

  async fetch(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: ctx.connectionId,
      queryClient: this.deps.queryClient,
      reader: this.deps.reader,
      sqlAnalysis: this.deps.sqlAnalysis,
      pullConfig,
      now: this.deps.now?.(),
    });
    if (this.deps.legacyPostgresBaselineRootDir) {
      await rm(join(this.deps.legacyPostgresBaselineRootDir, ctx.connectionId, 'pgss-baseline.json'), {
        force: true,
      });
    }
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkHistoricSqlUnifiedStagedDir(stagedDir, diffSet);
  }

  describeScope(stagedDir: string): Promise<ScopeDescriptor> {
    return describeHistoricSqlUnifiedScope(stagedDir);
  }
}
```

- [ ] **Step 5: Update WorkUnit notes to mention the evidence tool**

In `packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts`, update notes to contain:

```typescript
'Use historic_sql_table_digest. Read this table usage JSON and emit exactly one table_usage object with emit_historic_sql_evidence. Do not call wiki_write or sl_write_source.'
```

and:

```typescript
'Use historic_sql_patterns. Read patterns-input.json and emit pattern objects with emit_historic_sql_evidence. Do not call wiki_write or sl_write_source.'
```

Update `chunk-unified.test.ts` assertions to check `emit_historic_sql_evidence`.

- [ ] **Step 6: Update local adapter wiring**

In `packages/context/src/ingest/local-adapters.ts`, import:

```typescript
import { PostgresPgssReader } from './adapters/historic-sql/postgres-pgss-reader.js';
```

Remove the `PostgresPgssQueryHistoryReader` import. Construct the local historic-SQL adapter as:

```typescript
    adapters.push(
      new HistoricSqlSourceAdapter({
        sqlAnalysis: options.historicSql.sqlAnalysis,
        reader: new PostgresPgssReader(),
        queryClient: options.historicSql.postgresQueryClient,
        legacyPostgresBaselineRootDir: options.historicSql.postgresBaselineRootDir,
        now: options.historicSql.now,
      }),
    );
```

In `localPullConfigForAdapter()`, parse with `historicSqlUnifiedPullConfigSchema` instead of `historicSqlPullConfigSchema`.

- [ ] **Step 7: Run adapter/local tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts src/ingest/adapters/historic-sql/chunk-unified.test.ts src/ingest/local-adapters.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.ts packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts packages/context/src/ingest/adapters/historic-sql/chunk-unified.test.ts packages/context/src/ingest/adapters/historic-sql/types.ts packages/context/src/ingest/local-adapters.ts packages/context/src/ingest/local-adapters.test.ts
git commit -m "feat: cut over historic sql adapter"
```

## Task 6: Delete Legacy Historic-SQL Code Path

**Files:**
- Modify: `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/detect.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/detect.test.ts`
- Modify: `packages/context/src/ingest/index.ts`
- Modify: `packages/context/src/package-exports.test.ts`
- Modify: `packages/cli/src/setup-databases.ts`
- Modify: `packages/cli/src/historic-sql-doctor.ts`
- Delete the legacy files listed in the File Structure section.

- [ ] **Step 1: Move PGSS probe behavior into `PostgresPgssReader`**

Update `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts` so the existing probe tests import `PostgresPgssReader` from `./postgres-pgss-reader.js` and assert the same probe warnings/errors now covered by `postgres-pgss-query-history-reader.test.ts`.

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts
```

Expected: FAIL until probe SQL and error mapping are inlined.

- [ ] **Step 2: Inline the probe logic**

In `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.ts`, remove:

```typescript
import { PostgresPgssQueryHistoryReader } from './postgres-pgss-query-history-reader.js';
```

Remove:

```typescript
  private readonly legacyReader = new PostgresPgssQueryHistoryReader();

  probe(client: unknown): Promise<PostgresPgssProbeResult> {
    return this.legacyReader.probe(client);
  }
```

Add the probe SQL and mapping currently used by `PostgresPgssQueryHistoryReader` into this file, and make `probe(client)` return `PostgresPgssProbeResult` directly. Preserve the existing doctor-facing checks for extension presence, grants, server version, `pg_stat_statements.track`, and informational `pg_stat_statements.max`.

- [ ] **Step 3: Update CLI doctor/setup imports**

In `packages/cli/src/setup-databases.ts` and `packages/cli/src/historic-sql-doctor.ts`, replace dynamic imports of `PostgresPgssQueryHistoryReader` with `PostgresPgssReader`:

```typescript
const [{ PostgresPgssReader }, { KtxPostgresHistoricSqlQueryClient, isKtxPostgresConnectionConfig }] =
  await Promise.all([import('@ktx/context/ingest'), import('./postgres-query-client.js')]);
```

Replace `new PostgresPgssQueryHistoryReader().probe(client)` with:

```typescript
new PostgresPgssReader().probe(client)
```

- [ ] **Step 4: Simplify detection to the unified manifest shape**

In `packages/context/src/ingest/adapters/historic-sql/detect.ts`, keep manifest-source detection and replace the old `templates/*/{metadata.json,page.md}` fallback with unified structural detection:

```typescript
  try {
    await readFile(join(stagedDir, 'patterns-input.json'), 'utf-8');
    const entries = await readdir(join(stagedDir, 'tables'), { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith('.json'));
  } catch {
    return false;
  }
```

Update `detect.test.ts` to use `stagedManifestSchema` and remove tests for legacy `historicSqlManifestSchema`, `historicSqlMetadataSchema`, and `historicSqlUsageSchema`.

- [ ] **Step 5: Remove legacy exports and assertions**

In `packages/context/src/ingest/index.ts`, delete exports for:

```typescript
chunkHistoricSqlStagedDir
describeHistoricSqlScope
PostgresPgssQueryHistoryReader
stageHistoricSqlTemplates
stagePgStatStatementsTemplates
PgssBaseline
StagePgStatStatementsTemplatesResult
historicSqlManifestSchema
historicSqlMetadataSchema
historicSqlPullConfigSchema
historicSqlUsageSchema
```

In `packages/context/src/package-exports.test.ts`, remove assertions for those exports.

- [ ] **Step 6: Delete legacy files and old skills**

Run:

```bash
rm -rf packages/context/src/ingest/adapters/historic-sql/__fixtures__/postgres
rm packages/context/src/ingest/adapters/historic-sql/stage.ts
rm packages/context/src/ingest/adapters/historic-sql/stage.test.ts
rm packages/context/src/ingest/adapters/historic-sql/stage-pgss.ts
rm packages/context/src/ingest/adapters/historic-sql/stage-pgss.test.ts
rm packages/context/src/ingest/adapters/historic-sql/stage-pgss-golden.test.ts
rm packages/context/src/ingest/adapters/historic-sql/chunk.ts
rm packages/context/src/ingest/adapters/historic-sql/chunk.test.ts
rm packages/context/src/ingest/adapters/historic-sql/postgres-pgss-query-history-reader.ts
rm packages/context/src/ingest/adapters/historic-sql/postgres-pgss-query-history-reader.test.ts
rm -rf packages/context/skills/historic_sql_ingest
rm -rf packages/context/skills/historic_sql_curator
```

Expected: files are removed from the worktree. Do not delete unified files: `stage-unified.ts`, `chunk-unified.ts`, `postgres-pgss-reader.ts`, `bigquery-query-history-reader.ts`, `snowflake-query-history-reader.ts`, `types.ts`, `skill-schemas.ts`, `evidence.ts`, `projection.ts`, and `post-processor.ts`.

- [ ] **Step 7: Remove page-triage historic-SQL prompt references**

In `packages/context/prompts/skills/page_triage_classifier.md`, remove the historic-SQL-specific block for `signals.objectType === "historic_sql_template"`. Update these tests to stop asserting that prompt text:

- `packages/context/src/ingest/page-triage/page-triage.service.test.ts`
- `packages/context/src/ingest/ingest-prompts.test.ts`
- `packages/context/src/ingest/ingest-runtime-assets.test.ts`

- [ ] **Step 8: Run no-old-code grep**

Run:

```bash
rg -n "stagePgStatStatementsTemplates|expandCategoricalTemplates|classifySlot|pgss-baseline|historic_sql_ingest|historic_sql_curator|PostgresPgssQueryHistoryReader|historic_sql_template" packages/context packages/cli
```

Expected: no matches in `packages/context` or `packages/cli`.

- [ ] **Step 9: Run focused deletion tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql src/ingest/ingest-runtime-assets.test.ts src/memory/memory-runtime-assets.test.ts src/package-exports.test.ts
pnpm --filter @ktx/cli exec vitest run src/historic-sql-doctor.test.ts src/setup-databases.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/context/src/ingest/adapters/historic-sql packages/context/skills packages/context/src/ingest/index.ts packages/context/src/package-exports.test.ts packages/context/src/ingest/ingest-runtime-assets.test.ts packages/context/src/memory/memory-runtime-assets.test.ts packages/context/prompts/skills/page_triage_classifier.md packages/context/src/ingest/page-triage/page-triage.service.test.ts packages/context/src/ingest/ingest-prompts.test.ts packages/cli/src/setup-databases.ts packages/cli/src/historic-sql-doctor.ts packages/cli/src/historic-sql-doctor.test.ts packages/cli/src/setup-databases.test.ts
git commit -m "refactor: remove legacy historic sql pipeline"
```

## Task 7: Rename Setup Config To minExecutions

**Files:**
- Modify: `packages/cli/src/commands/setup-commands.ts`
- Modify: `packages/cli/src/index.test.ts`
- Modify: `packages/cli/src/setup-databases.ts`
- Modify: `packages/cli/src/setup-databases.test.ts`

- [ ] **Step 1: Write failing setup CLI assertions**

In `packages/cli/src/index.test.ts`, update setup help assertions so both flags are accepted:

```typescript
expect(output).toContain('--historic-sql-min-executions');
expect(output).toContain('--historic-sql-min-calls');
```

In setup output/config tests, assert generated YAML uses:

```yaml
historicSql:
  enabled: true
  dialect: postgres
  minExecutions: 7
```

and does not write `minCalls`.

- [ ] **Step 2: Run setup tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/index.test.ts src/setup-databases.test.ts
```

Expected: FAIL because the CLI still writes `minCalls`.

- [ ] **Step 3: Add the new flag and preserve the old alias**

In `packages/cli/src/commands/setup-commands.ts`, add:

```typescript
    .option('--historic-sql-min-executions <number>', 'Minimum Historic SQL executions for a template', positiveInteger)
```

Keep `--historic-sql-min-calls` with help text:

```typescript
    .option('--historic-sql-min-calls <number>', 'Alias for --historic-sql-min-executions', positiveInteger)
```

When building setup options, resolve:

```typescript
const historicSqlMinExecutions = opts.historicSqlMinExecutions ?? opts.historicSqlMinCalls;
```

In `packages/cli/src/setup-databases.ts`, write `minExecutions` to config. Do not write `minCalls`.

- [ ] **Step 4: Run setup tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/index.test.ts src/setup-databases.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/setup-commands.ts packages/cli/src/index.test.ts packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts
git commit -m "feat: rename historic sql setup threshold"
```

## Task 8: Final Verification

**Files:**
- Verify: historic-SQL adapter, CLI setup/doctor, runtime assets, exports, Python daemon batch endpoint.

- [ ] **Step 1: Run all historic-SQL context tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql src/ingest/local-adapters.test.ts src/ingest/local-bundle-ingest.test.ts src/ingest/ingest-runtime-assets.test.ts src/memory/memory-runtime-assets.test.ts src/package-exports.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run CLI setup and doctor tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/historic-sql-doctor.test.ts src/setup-databases.test.ts src/index.test.ts src/ingest.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run Python daemon SQL analysis tests**

Run:

```bash
source .venv/bin/activate && python -m pytest python/ktx-daemon/tests/test_sql_analysis.py python/ktx-daemon/tests/test_app.py -q
```

Expected: PASS.

- [ ] **Step 4: Run package type checks**

Run:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 5: Run no-old-code grep**

Run:

```bash
rg -n "stagePgStatStatementsTemplates|expandCategoricalTemplates|classifySlot|pgss-baseline|historic_sql_ingest|historic_sql_curator|PostgresPgssQueryHistoryReader|historic_sql_template" packages/context packages/cli
```

Expected: no matches.

- [ ] **Step 6: Run pre-commit for touched files**

Run with the actual touched file list from `git diff --name-only`:

```bash
uv run pre-commit run --files $(git diff --name-only)
```

Expected: PASS. If local `uv` refuses due the repo's exact uv pin, activate `.venv` for Python checks and report the uv version mismatch exactly.

- [ ] **Step 7: Commit final verification notes if test snapshots changed**

If verification updated tracked snapshots or generated checked-in fixtures, commit only those intended files:

```bash
git add <changed verification fixture paths>
git commit -m "test: verify historic sql cutover"
```

Expected: either a small verification commit is created, or no commit is needed because `git status --short` is clean.

## Self-Review

Spec coverage:

- New skills `historic_sql_table_digest` and `historic_sql_patterns`: Task 2.
- LLM skills emit evidence instead of direct writes: Task 1 and Task 2.
- Deterministic projection of table usage into `_schema` shards: Task 3 and Task 4.
- Pattern wiki pages under `knowledge/global/historic-sql/{slug}.md`: Task 3 and Task 4.
- Slug stability and stale/archive handling: Task 3.
- Production adapter cutover to unified reader/stager/chunker: Task 5.
- Old skill and legacy code deletion: Task 6.
- PGSS baseline cleanup: Task 5 via `legacyPostgresBaselineRootDir` removal.
- CLI setup `minCalls` to `minExecutions` alias: Task 7.
- Search surfaces: already implemented by `2026-05-11-historic-sql-search-enrichment.md`; final verification keeps them covered.

Placeholder scan:

- No unresolved placeholder markers are present.
- Every code-changing task includes exact paths, test commands, and expected pass/fail outcomes.
- Complex projection internals are described as concrete behavior with named fields and deterministic matching rules.

Type consistency:

- `HistoricSqlEvidenceEnvelope`, `HistoricSqlProjectionResult`, `HistoricSqlProjectionPostProcessor`, and `HistoricSqlSourceAdapterDeps` names are introduced before use.
- Skill names match the new adapter metadata and runtime asset tests: `historic_sql_table_digest`, `historic_sql_patterns`.
- `PostgresPgssReader` remains the single public PGSS reader after legacy deletion.

Plan complete and saved to `docs/superpowers/plans/2026-05-11-historic-sql-skills-projection-cutover.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
