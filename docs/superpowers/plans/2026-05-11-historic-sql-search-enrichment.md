# Historic SQL Search Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make historic-SQL table usage searchable through semantic-layer search and return lean query-mode context with `frequencyTier` and an FTS snippet.

**Architecture:** This is the second slice of the historic SQL redesign, covering spec §6.2.3-§6.2.5 and the search-hit tier in §7. It builds on the already implemented foundation slice: `SemanticLayerSource.usage` is the source of truth, the SL search text builder indexes usage narrative and structured usage fields, SQLite FTS returns snippets from indexed search text, and local/MCP list responses hydrate `frequencyTier` from the source while keeping the full `usage` block available through `agent sl read`.

**Tech Stack:** TypeScript ESM/NodeNext, Vitest, better-sqlite3 FTS5, zod-backed TypeScript types.

---

## Starting Point

Spec: `docs/superpowers/specs/2026-05-11-historic-sql-redesign-design.md`

Plans found that are based on this spec:

- `docs/superpowers/plans/2026-05-11-historic-sql-foundations.md`

Implemented status:

- `2026-05-11-historic-sql-foundations.md` is implemented in this worktree. Evidence in code: `packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts`, `SemanticLayerSource.usage` in `packages/context/src/sl/types.ts`, `mergeUsagePreservingExternal()` in `packages/context/src/ingest/adapters/live-database/manifest.ts`, `SqlAnalysisPort.analyzeBatch()` in `packages/context/src/sql-analysis/ports.ts`, and `/sql/analyze-batch` in `python/ktx-daemon/src/ktx_daemon/app.py`.
- Focused TypeScript foundation verification passed: `pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/skill-schemas.test.ts src/sl/semantic-layer.service.test.ts src/ingest/adapters/live-database/manifest.test.ts src/scan/local-enrichment-artifacts.test.ts src/sql-analysis/http-sql-analysis-port.test.ts` reported 5 files and 53 tests passed.
- `uv run pytest python/ktx-daemon/tests/test_sql_analysis.py python/ktx-daemon/tests/test_app.py -q` is blocked by the repo's exact uv pin: required `==0.11.11`, local `0.11.13`. Closest available check after activating `.venv` passed: `source .venv/bin/activate && python -m pytest python/ktx-daemon/tests/test_sql_analysis.py python/ktx-daemon/tests/test_app.py -q` reported 20 passed.

Not yet implemented:

- `buildSemanticLayerSourceSearchText()` in `packages/context/src/sl/sl-search.service.ts` does not include `source.usage`.
- `SqliteSlSourcesIndex` does not select `snippet(local_sl_sources_fts, ...)`.
- `LocalSlSourceSearchResult` and `KtxSemanticLayerSourceSummary` do not expose `frequencyTier` or `snippet`.
- `createLocalProjectMcpContextPorts().semanticLayer.listSources()` drops any future snippet/frequency metadata.

This plan does not rewrite the historic-SQL adapter, readers, skills, projection, or cleanup path. The next plan after this one should cover the new adapter hot path from spec §4 and §10.3 step 3.

## File Structure

Modify:

- `packages/context/src/sl/sl-search.service.ts`
  Adds usage narrative, frequency, filters, group-bys, joins, and stale marker to the canonical SL search text. Preserves snippets returned by repository search for direct `SlSearchService.search()` callers.
- `packages/context/src/sl/sl-search.service.test.ts`
  Tests usage search-text content and direct service snippet pass-through.
- `packages/context/src/sl/ports.ts`
  Extends `SlSourcesIndexPort.search()` rows with optional `snippet`.
- `packages/context/src/sl/sqlite-sl-sources-index.ts`
  Adds FTS5 `snippet()` selection to lexical candidate search and direct index search.
- `packages/context/src/sl/sqlite-sl-sources-index.test.ts`
  Locks snippet behavior for both direct search and lexical lane candidates.
- `packages/context/src/sl/local-sl.ts`
  Adds `frequencyTier` and `snippet` to query-mode `LocalSlSourceSearchResult`; collects snippets from the lexical lane and hydrates frequency from `SemanticLayerSource.usage`.
- `packages/context/src/sl/local-sl.test.ts`
  Tests that usage-only terms can find a source and that results include `frequencyTier` and FTS snippet.
- `packages/context/src/sl/pglite-sl-search-prototype.ts`
  Propagates `frequencyTier` for the prototype backend so the shared result type stays truthful.
- `packages/context/src/mcp/types.ts`
  Adds `frequencyTier` and `snippet` to `KtxSemanticLayerSourceSummary`.
- `packages/context/src/mcp/local-project-ports.ts`
  Includes `frequencyTier` and `snippet` in `semanticLayer.listSources()` output.
- `packages/context/src/mcp/local-project-ports.test.ts`
  Tests the agent/MCP-facing list response.

## Task 1: Index Historic SQL Usage In SL Search Text

**Files:**
- Modify: `packages/context/src/sl/sl-search.service.test.ts`
- Modify: `packages/context/src/sl/sl-search.service.ts`

- [ ] **Step 1: Write the failing usage search-text test**

Add this test at the end of the existing `describe('SlSearchService', ...)` block in `packages/context/src/sl/sl-search.service.test.ts`:

```typescript
  it('includes historic SQL usage in semantic-layer search text', () => {
    const source: SemanticLayerSource = {
      name: 'orders',
      descriptions: { user: 'Customer orders' },
      table: 'public.orders',
      grain: ['order_id'],
      columns: [{ name: 'order_id', type: 'string' }],
      joins: [],
      measures: [],
      usage: {
        narrative: 'Analysts inspect paid and refunded order lifecycle trends by customer segment.',
        frequencyTier: 'high',
        commonFilters: ['status', 'created_at'],
        commonGroupBys: ['customer_segment'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
        staleSince: '2026-05-01T00:00:00.000Z',
      },
    };

    const text = buildSemanticLayerSourceSearchText(source);

    expect(text).toContain('usage: Analysts inspect paid and refunded order lifecycle trends by customer segment.');
    expect(text).toContain('frequency: high');
    expect(text).toContain('commonly filtered by: status, created_at');
    expect(text).toContain('commonly grouped by: customer_segment');
    expect(text).toContain('commonly joined to public.customers on customer_id');
    expect(text).toContain('stale since 2026-05-01T00:00:00.000Z');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sl/sl-search.service.test.ts
```

Expected: FAIL because the search text does not contain `usage: Analysts inspect paid and refunded order lifecycle trends by customer segment.`

- [ ] **Step 3: Add usage fields to the canonical search text**

In `packages/context/src/sl/sl-search.service.ts`, insert this block after the existing `freshness` block and before `return parts.join('. ');`:

```typescript
  if (source.usage) {
    const usage = source.usage;
    parts.push(`usage: ${usage.narrative}`);
    parts.push(`frequency: ${usage.frequencyTier}`);
    if (usage.commonFilters.length > 0) {
      parts.push(`commonly filtered by: ${usage.commonFilters.join(', ')}`);
    }
    if (usage.commonGroupBys?.length) {
      parts.push(`commonly grouped by: ${usage.commonGroupBys.join(', ')}`);
    }
    for (const join of usage.commonJoins) {
      parts.push(`commonly joined to ${join.table} on ${join.on.join(',')}`);
    }
    if (usage.staleSince) {
      parts.push(`stale since ${usage.staleSince}`);
    }
  }
```

- [ ] **Step 4: Run the search-text test to verify it passes**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sl/sl-search.service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/context/src/sl/sl-search.service.ts packages/context/src/sl/sl-search.service.test.ts
git commit -m "feat: index historic sql usage in sl search text"
```

## Task 2: Return SQLite FTS Snippets From SL Search

**Files:**
- Modify: `packages/context/src/sl/ports.ts`
- Modify: `packages/context/src/sl/sqlite-sl-sources-index.ts`
- Modify: `packages/context/src/sl/sqlite-sl-sources-index.test.ts`
- Modify: `packages/context/src/sl/sl-search.service.ts`
- Modify: `packages/context/src/sl/sl-search.service.test.ts`

- [ ] **Step 1: Write failing SQLite snippet assertions**

Replace the existing `creates SQLite tables and searches indexed source text` test in `packages/context/src/sl/sqlite-sl-sources-index.test.ts` with:

```typescript
  it('creates SQLite tables and searches indexed source text with FTS snippets', async () => {
    const index = new SqliteSlSourcesIndex({ dbPath });

    await index.upsertSources('warehouse', [
      {
        sourceName: 'orders',
        searchText: 'orders table: public.orders measure: total_revenue sum(revenue) gross revenue',
        embedding: null,
      },
      {
        sourceName: 'tickets',
        searchText: 'tickets table: public.tickets measure: ticket_count count(*) support queue',
        embedding: null,
      },
    ]);

    await expect(access(dbPath)).resolves.toBeUndefined();

    const directResults = await index.search('warehouse', null, 'gross revenue', 10);
    expect(directResults).toEqual([
      expect.objectContaining({
        sourceName: 'orders',
        rrfScore: expect.any(Number),
        snippet: expect.stringContaining('<mark>'),
      }),
    ]);
    expect(directResults[0]?.snippet).toContain('revenue');

    const lexicalCandidates = await index.searchLexicalCandidates({ queryText: 'gross revenue', limit: 10 });
    expect(lexicalCandidates).toEqual([
      expect.objectContaining({
        id: 'warehouse/orders',
        connectionId: 'warehouse',
        sourceName: 'orders',
        snippet: expect.stringContaining('<mark>'),
      }),
    ]);
  });
```

- [ ] **Step 2: Write the failing direct service snippet test**

Add this test at the end of `packages/context/src/sl/sl-search.service.test.ts`:

```typescript
  it('preserves FTS snippets returned by the source index', async () => {
    const service = new SlSearchService(
      {
        maxBatchSize: 16,
        computeEmbedding: vi.fn(async () => [1, 0]),
        computeEmbeddingsBulk: vi.fn(),
      },
      {
        upsertSources: vi.fn(),
        getExistingSearchTexts: vi.fn(),
        deleteStale: vi.fn(),
        deleteByConnection: vi.fn(),
        deleteByConnectionAndName: vi.fn(),
        search: vi.fn(async () => [
          {
            sourceName: 'orders',
            rrfScore: 0.75,
            snippet: 'usage: paid <mark>order</mark> lifecycle',
          },
        ]),
      },
    );

    await expect(service.search('warehouse', 'order lifecycle', 10)).resolves.toEqual([
      {
        sourceName: 'orders',
        score: 0.75,
        snippet: 'usage: paid <mark>order</mark> lifecycle',
      },
    ]);
  });
```

- [ ] **Step 3: Run the snippet tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sl/sqlite-sl-sources-index.test.ts src/sl/sl-search.service.test.ts
```

Expected: FAIL because `snippet` is missing from SQLite search rows and `SlSearchService.search()` drops repository snippets.

- [ ] **Step 4: Extend the index port result type**

In `packages/context/src/sl/ports.ts`, replace the `search()` return type in `SlSourcesIndexPort` with:

```typescript
  search(
    connectionId: string,
    queryEmbedding: number[] | null,
    queryText: string,
    limit: number,
    minRrfScore?: number,
  ): Promise<Array<{ sourceName: string; rrfScore: number; snippet?: string }>>;
```

- [ ] **Step 5: Add snippet fields and SQL selection in the SQLite index**

In `packages/context/src/sl/sqlite-sl-sources-index.ts`, replace the `SearchRow` type with:

```typescript
type SearchRow = {
  connection_id?: string;
  source_name: string;
  rank: number;
  snippet?: string | null;
};
```

In the `SlSqliteLaneCandidate` interface, add the optional snippet property:

```typescript
export interface SlSqliteLaneCandidate {
  id: string;
  connectionId: string;
  sourceName: string;
  rank: number;
  rawScore: number;
  snippet?: string;
}
```

In `searchLexicalCandidates()`, replace the SELECT list with:

```sql
        SELECT
          connection_id,
          source_name,
          bm25(local_sl_sources_fts) AS rank,
          snippet(local_sl_sources_fts, 2, '<mark>', '</mark>', '...', 12) AS snippet
        FROM local_sl_sources_fts
```

Then replace the returned row mapping in `searchLexicalCandidates()` with:

```typescript
    return rows.map((row, index) => ({
      id: candidateId(row.connection_id, row.source_name),
      connectionId: row.connection_id,
      sourceName: row.source_name,
      rank: index + 1,
      rawScore: Number(row.rank),
      ...(typeof row.snippet === 'string' && row.snippet.length > 0 ? { snippet: row.snippet } : {}),
    }));
```

In the direct `search()` method, replace the SELECT list with:

```sql
        SELECT
          source_name,
          bm25(local_sl_sources_fts) AS rank,
          snippet(local_sl_sources_fts, 2, '<mark>', '</mark>', '...', 12) AS snippet
        FROM local_sl_sources_fts
```

Then replace the direct `search()` return mapping with:

```typescript
    return rows
      .map((row) => ({
        sourceName: row.source_name,
        rrfScore: scoreFromRank(row.rank),
        ...(typeof row.snippet === 'string' && row.snippet.length > 0 ? { snippet: row.snippet } : {}),
      }))
      .filter((row) => row.rrfScore >= minRrfScore);
```

- [ ] **Step 6: Preserve snippets in direct `SlSearchService.search()` results**

In `packages/context/src/sl/sl-search.service.ts`, replace the `search()` method signature and final return with:

```typescript
  async search(
    connectionId: string,
    query: string,
    limit = 15,
    minRrfScore = 0,
  ): Promise<Array<{ sourceName: string; score: number; snippet?: string }>> {
    let queryEmbedding: number[] | null = null;
    try {
      queryEmbedding = await this.embeddingService.computeEmbedding(query);
    } catch (error) {
      this.logger.warn(
        `Failed to compute query embedding, falling back to FTS + trigram: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const results = await this.slSourcesRepository.search(connectionId, queryEmbedding, query, limit, minRrfScore);
    return results.map((result) => ({
      sourceName: result.sourceName,
      score: result.rrfScore,
      ...(result.snippet ? { snippet: result.snippet } : {}),
    }));
  }
```

- [ ] **Step 7: Run the snippet tests to verify they pass**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sl/sqlite-sl-sources-index.test.ts src/sl/sl-search.service.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/context/src/sl/ports.ts packages/context/src/sl/sqlite-sl-sources-index.ts packages/context/src/sl/sqlite-sl-sources-index.test.ts packages/context/src/sl/sl-search.service.ts packages/context/src/sl/sl-search.service.test.ts
git commit -m "feat: return sl search snippets"
```

## Task 3: Hydrate Query-Mode SL Results With Frequency And Snippet

**Files:**
- Modify: `packages/context/src/sl/local-sl.ts`
- Modify: `packages/context/src/sl/local-sl.test.ts`
- Modify: `packages/context/src/sl/pglite-sl-search-prototype.ts`

- [ ] **Step 1: Write the failing local search hydration test**

Add this test after `searches local semantic-layer source text through SQLite FTS` in `packages/context/src/sl/local-sl.test.ts`:

```typescript
  it('searches historic SQL usage and returns frequency tier plus FTS snippet', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      `tables:
  orders:
    table: public.orders
    usage:
      narrative: Analysts inspect paid order lifecycle by customer segment.
      frequencyTier: high
      commonFilters:
        - status
        - created_at
      commonGroupBys:
        - customer_segment
      commonJoins:
        - table: public.customers
          on:
            - customer_id
    columns:
      - name: order_id
        type: string
      - name: status
        type: string
`,
      'ktx',
      'ktx@example.com',
      'Add usage-backed manifest shard',
    );

    const results = await searchLocalSlSources(project, {
      connectionId: 'warehouse',
      query: 'paid lifecycle customer segment',
    });

    expect(results).toEqual([
      expect.objectContaining({
        connectionId: 'warehouse',
        name: 'orders',
        path: 'semantic-layer/warehouse/_schema/public.yaml#orders',
        frequencyTier: 'high',
        snippet: expect.stringContaining('<mark>'),
        matchReasons: expect.arrayContaining(['lexical']),
      }),
    ]);
    expect(results[0]?.snippet).toContain('lifecycle');
  });
```

- [ ] **Step 2: Run the local search test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sl/local-sl.test.ts
```

Expected: FAIL because the query cannot match usage text yet if Task 1 is not present, and because `frequencyTier` and `snippet` are not hydrated into `LocalSlSourceSearchResult`.

- [ ] **Step 3: Extend the local search result type**

In `packages/context/src/sl/local-sl.ts`, replace the `LocalSlSourceSearchResult` interface with:

```typescript
export interface LocalSlSourceSearchResult extends LocalSlSourceSummary {
  score: number;
  frequencyTier?: NonNullable<SemanticLayerSource['usage']>['frequencyTier'];
  snippet?: string;
  matchReasons?: SlSearchMatchReason[];
  dictionaryMatches?: SlDictionaryMatch[];
  lanes?: SlSearchLaneSummary[];
}
```

Then add this helper after `candidateKey()`:

```typescript
function searchResultUsageFields(source: SemanticLayerSource): Pick<LocalSlSourceSearchResult, 'frequencyTier'> {
  return source.usage?.frequencyTier ? { frequencyTier: source.usage.frequencyTier } : {};
}
```

- [ ] **Step 4: Include frequency tier in the non-SQLite token fallback**

In `searchLocalSlSources()`, inside the `project.config.storage.search !== 'sqlite-fts5'` branch, replace the final mapped object with:

```typescript
      .map((result) => ({
        ...result.candidate.summary,
        score: result.score,
        matchReasons: ['token'],
        ...searchResultUsageFields(result.candidate.source),
      }))
```

- [ ] **Step 5: Collect lexical snippets during hybrid search**

In `searchLocalSlSources()`, after `const dictionaryEvidence = new Map<string, SlDictionaryMatch[]>();`, add:

```typescript
  const lexicalSnippets = new Map<string, string>();
```

Inside the lexical generator, immediately after `const rows = await index.searchLexicalCandidates({ ... });`, add:

```typescript
        for (const row of rows) {
          if (row.snippet) {
            lexicalSnippets.set(row.id, row.snippet);
          }
        }
```

- [ ] **Step 6: Hydrate frequency tier and snippet in SQLite hybrid results**

In the final hydration loop in `searchLocalSlSources()`, replace the `hydrated.push({ ... })` block with:

```typescript
    const dictionaryMatches = dictionaryEvidence.get(fused.id);
    const snippet = lexicalSnippets.get(fused.id);
    hydrated.push({
      ...candidate.summary,
      score: fused.score,
      ...searchResultUsageFields(candidate.source),
      ...(snippet ? { snippet } : {}),
      matchReasons: fused.matchReasons as SlSearchMatchReason[],
      ...(dictionaryMatches && dictionaryMatches.length > 0 ? { dictionaryMatches } : {}),
      lanes: result.lanes,
    });
```

- [ ] **Step 7: Propagate frequency tier in the PGlite prototype backend**

In `packages/context/src/sl/pglite-sl-search-prototype.ts`, inside the final hydration loop, replace the `hydrated.push({ ... })` block with:

```typescript
      const dictionaryMatches = dictionaryEvidence.get(result.id);
      const frequencyTier = candidate.source.usage?.frequencyTier;
      hydrated.push({
        ...candidate.summary,
        score: result.score,
        ...(frequencyTier ? { frequencyTier } : {}),
        matchReasons: result.matchReasons as SlSearchMatchReason[],
        ...(dictionaryMatches && dictionaryMatches.length > 0 ? { dictionaryMatches } : {}),
        lanes: fused.lanes,
      });
```

- [ ] **Step 8: Run the local search test to verify it passes**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sl/local-sl.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/context/src/sl/local-sl.ts packages/context/src/sl/local-sl.test.ts packages/context/src/sl/pglite-sl-search-prototype.ts
git commit -m "feat: hydrate sl search usage metadata"
```

## Task 4: Expose Frequency And Snippet Through Agent/MCP SL List

**Files:**
- Modify: `packages/context/src/mcp/types.ts`
- Modify: `packages/context/src/mcp/local-project-ports.ts`
- Modify: `packages/context/src/mcp/local-project-ports.test.ts`

- [ ] **Step 1: Write the failing agent-facing list test**

Add this test after `returns semantic-layer hybrid search metadata through local project ports` in `packages/context/src/mcp/local-project-ports.test.ts`:

```typescript
  it('returns historic SQL usage frequency and snippet through semantic-layer list search', async () => {
    const project = await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      `tables:
  orders:
    table: public.orders
    usage:
      narrative: Analysts inspect paid order lifecycle by customer segment.
      frequencyTier: high
      commonFilters:
        - status
      commonGroupBys:
        - customer_segment
      commonJoins:
        - table: public.customers
          on:
            - customer_id
    columns:
      - name: order_id
        type: string
      - name: status
        type: string
`,
      'ktx',
      'ktx@example.com',
      'Seed usage-backed manifest shard',
    );

    const ports = createLocalProjectMcpContextPorts(project);
    await expect(
      ports.semanticLayer?.listSources({ connectionId: 'warehouse', query: 'paid order lifecycle' }),
    ).resolves.toEqual({
      sources: [
        expect.objectContaining({
          connectionId: 'warehouse',
          connectionName: 'warehouse',
          name: 'orders',
          frequencyTier: 'high',
          snippet: expect.stringContaining('<mark>'),
          score: expect.any(Number),
          matchReasons: expect.arrayContaining(['lexical']),
        }),
      ],
      totalSources: 1,
    });
  });
```

- [ ] **Step 2: Run the local project ports test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/local-project-ports.test.ts
```

Expected: FAIL because `frequencyTier` and `snippet` are missing from `semanticLayer.listSources()` responses.

- [ ] **Step 3: Add fields to the MCP summary type**

In `packages/context/src/mcp/types.ts`, replace the ingest import with:

```typescript
import type { IngestReportSnapshot, MemoryFlowReplayInput, TableUsageOutput } from '../ingest/index.js';
```

Then add these optional fields to `KtxSemanticLayerSourceSummary` after `joinCount`:

```typescript
  frequencyTier?: TableUsageOutput['frequencyTier'];
  snippet?: string;
```

- [ ] **Step 4: Pass fields through local project ports**

In `packages/context/src/mcp/local-project-ports.ts`, inside the object built in `semanticLayer.listSources()`, add these two spread lines after `joinCount: source.joinCount,`:

```typescript
          ...(hasSlSearchMetadata(source) && source.frequencyTier ? { frequencyTier: source.frequencyTier } : {}),
          ...(hasSlSearchMetadata(source) && source.snippet ? { snippet: source.snippet } : {}),
```

- [ ] **Step 5: Run the agent-facing list test to verify it passes**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/local-project-ports.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/mcp/types.ts packages/context/src/mcp/local-project-ports.ts packages/context/src/mcp/local-project-ports.test.ts
git commit -m "feat: expose sl search usage snippets"
```

## Task 5: Final Verification

**Files:**
- Verify: `packages/context/src/sl/sl-search.service.ts`
- Verify: `packages/context/src/sl/sqlite-sl-sources-index.ts`
- Verify: `packages/context/src/sl/local-sl.ts`
- Verify: `packages/context/src/mcp/local-project-ports.ts`

- [ ] **Step 1: Run all focused tests from this plan**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sl/sl-search.service.test.ts src/sl/sqlite-sl-sources-index.test.ts src/sl/local-sl.test.ts src/mcp/local-project-ports.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the context type check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Confirm the adapter rewrite is still untouched**

Run:

```bash
git diff -- packages/context/src/ingest/adapters/historic-sql/stage.ts packages/context/src/ingest/adapters/historic-sql/stage-pgss.ts packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.ts
```

Expected: no diff output.

- [ ] **Step 4: Confirm no placeholder text remains in the plan**

Run:

```bash
node - <<'NODE'
import { readFileSync } from 'node:fs';

const path = 'docs/superpowers/plans/2026-05-11-historic-sql-search-enrichment.md';
const text = readFileSync(path, 'utf8');
const redFlags = [
  'T' + 'BD',
  'TO' + 'DO',
  'implement ' + 'later',
  'fill in ' + 'details',
  'Add appropriate ' + 'error handling',
  'add ' + 'validation',
  'handle edge ' + 'cases',
  'Write tests for ' + 'the above',
  'Similar to ' + 'Task',
];

let failed = false;
for (const flag of redFlags) {
  if (text.includes(flag)) {
    console.error(`${path}: contains red-flag placeholder text: ${flag}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
NODE
```

Expected: exits 0 with no output.

- [ ] **Step 5: Commit verification notes if a verification-only edit was needed**

If Step 1 or Step 2 required a code correction, commit only those corrected files:

```bash
git status --short
git add packages/context/src/sl/sl-search.service.ts packages/context/src/sl/sl-search.service.test.ts packages/context/src/sl/ports.ts packages/context/src/sl/sqlite-sl-sources-index.ts packages/context/src/sl/sqlite-sl-sources-index.test.ts packages/context/src/sl/local-sl.ts packages/context/src/sl/local-sl.test.ts packages/context/src/sl/pglite-sl-search-prototype.ts packages/context/src/mcp/types.ts packages/context/src/mcp/local-project-ports.ts packages/context/src/mcp/local-project-ports.test.ts
git commit -m "test: verify historic sql search enrichment"
```

If Step 1 and Step 2 pass without changes, skip this commit.

## Self-Review

Spec coverage:

- Spec §6.2.3 is covered by Task 1: usage fields are included in `buildSemanticLayerSourceSearchText()`.
- Spec §6.2.4 is already covered by the foundation behavior in `SlSearchService.indexSources()`, which compares search text before re-embedding; Task 1 makes usage changes part of that search-text drift.
- Spec §6.2.5 is covered by Tasks 2-4: SQLite FTS snippets are selected and exposed through query-mode list results, and `frequencyTier` is hydrated from the source.
- Spec §7 search-hit tier is covered by Tasks 3-4: query-mode results carry name, table summary counts, description, score, frequency tier, and snippet. Full `usage` remains available through source read because the foundation plan added `SemanticLayerSource.usage`.

Placeholder scan:

- This plan contains no deferred implementation markers or unspecified code steps.

Type consistency:

- `frequencyTier` uses `TableUsageOutput['frequencyTier']` at the MCP boundary and `NonNullable<SemanticLayerSource['usage']>['frequencyTier']` in local SL search results.
- `snippet` is consistently optional because lexical FTS may not contribute to every hybrid result.
