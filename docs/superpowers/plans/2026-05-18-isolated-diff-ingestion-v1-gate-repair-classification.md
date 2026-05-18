# Isolated Diff Ingestion V1 Gate Repair Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent isolated-diff gate repair from automatically editing
high-risk semantic-layer or warehouse-validation failures while preserving
bounded repair for stale wiki reference drift.

**Architecture:** Keep the existing final gate and repair-agent modules, but
make artifact gate failures structured. A small repair-policy module classifies
structured issues before `repairFinalGateFailure()` is invoked from patch
integration or final composed-tree gates. Unknown or high-risk gate failures
fail before repair and before squash.

**Tech Stack:** TypeScript, Vitest, pnpm, existing KTX ingest runner,
`FinalArtifactGateFailure`, JSONL ingest traces.

---

## Audit summary

The implemented rollout covers isolated child worktrees, binary no-rename
patch proposals, `git apply --3way --index`, textual conflict repair, final
artifact gates, provenance pre-squash validation, connector migration, default
promotion, and old shared-worktree path removal.

One v1-blocking gap remains in the spec's Gate repair stage. The spec requires
the runner to classify final gate failures before deciding whether to repair or
fail. Repairable failures include stale wiki body references and stale wiki
frontmatter references. High-risk failures, including missing warehouse tables
or columns and invalid SQL sources, must fail without automatic repair unless a
later implementation adds a stronger evidence contract.

Current code calls `repairFinalGateFailure()` for every
`validateFinalIngestArtifacts()` error in both:

- `packages/context/src/ingest/isolated-diff/patch-integrator.ts`
- `packages/context/src/ingest/ingest-bundle.runner.ts`

That lets a repair agent edit semantic-layer files after a warehouse dry-run
failure. Rerunning gates is necessary, but not sufficient: the spec explicitly
forbids automatic repair when the repair would require choosing facts without
evidence.

Non-blocking gaps after this plan:

- Deterministic semantic merge helpers remain intentionally deferred as rollout
  step 9.
- Semantic-layer dependency expansion remains direct declared joins only.
- Provenance remains in the ingest provenance store and report body.
- Resolver and repair prompts can later include richer transcript excerpts,
  overlapping patch summaries, and raw evidence bundles.
- Failures before an ingest run row exists still have deterministic trace files
  but no stored ingest report.

## File structure

- Modify `packages/context/src/ingest/wiki-body-refs.ts`.
  Add structured wiki body reference issues while keeping the existing
  `findInvalidWikiBodyRefs()` string API for current callers.
- Modify `packages/context/src/ingest/wiki-body-refs.test.ts`.
  Cover structured issue codes for stale semantic-layer entities and missing
  raw tables.
- Modify `packages/context/src/ingest/stages/validate-wu-sources.ts`.
  Preserve validator error messages in `validateWuTouchedSources()` output.
- Modify `packages/context/src/ingest/stages/validate-wu-sources.test.ts`.
  Cover the new `issues` payload while keeping existing `validSources` and
  `invalidSources` behavior.
- Modify `packages/context/src/ingest/artifact-gates.ts`.
  Throw `FinalArtifactGateFailure` with structured issues from semantic-layer,
  wiki frontmatter, wiki page-reference, wiki body, and provenance-adjacent
  artifact gates.
- Modify `packages/context/src/ingest/artifact-gates.test.ts`.
  Assert structured issue codes for repairable and non-repairable gate
  failures.
- Create `packages/context/src/ingest/gate-repair-policy.ts`.
  Classify structured artifact gate failures as repairable or non-repairable.
- Create `packages/context/src/ingest/gate-repair-policy.test.ts`.
  Lock the policy for stale wiki refs versus high-risk semantic/warehouse
  errors.
- Modify `packages/context/src/ingest/isolated-diff/patch-integrator.ts`.
  Call the repair policy before patch-level semantic gate repair.
- Modify `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`.
  Prove high-risk semantic gate failures do not invoke the repair callback.
- Modify `packages/context/src/ingest/ingest-bundle.runner.ts`.
  Call the repair policy before final composed-tree gate repair and include
  non-repairable issue metadata in failure reports.
- Modify `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`.
  Add a final-gate regression where reconciliation creates an invalid
  semantic-layer source and the repair agent is not called.

### Task 1: Preserve structured artifact gate issues

**Files:**
- Modify: `packages/context/src/ingest/wiki-body-refs.ts`
- Modify: `packages/context/src/ingest/wiki-body-refs.test.ts`
- Modify: `packages/context/src/ingest/stages/validate-wu-sources.ts`
- Modify: `packages/context/src/ingest/stages/validate-wu-sources.test.ts`

- [ ] **Step 1: Add structured wiki body issue tests**

In `packages/context/src/ingest/wiki-body-refs.test.ts`, extend the import and
append this test inside `describe('wiki body refs', ...)`:

```ts
import { findInvalidWikiBodyRefIssues, findInvalidWikiBodyRefs, parseWikiBodyRefs } from './wiki-body-refs.js';
```

```ts
  it('returns structured issue codes for body reference failures', async () => {
    const invalid = await findInvalidWikiBodyRefIssues({
      pageKey: 'account-segments',
      body: [
        '`mart_account_segments.total_contract_arr_cents`',
        '`source:missing_source`',
        '`table:analytics.missing_table`',
      ].join('\n'),
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => sources,
      tableExists: async () => false,
    });

    expect(invalid).toEqual([
      {
        code: 'wiki_body_unknown_sl_entity',
        message: 'account-segments: unknown semantic-layer entity mart_account_segments.total_contract_arr_cents',
        pageKey: 'account-segments',
        ref: 'mart_account_segments.total_contract_arr_cents',
        sourceName: 'mart_account_segments',
        entityName: 'total_contract_arr_cents',
        connectionId: null,
      },
      {
        code: 'wiki_body_unknown_sl_source',
        message: 'account-segments: unknown semantic-layer source missing_source',
        pageKey: 'account-segments',
        ref: 'source:missing_source',
        sourceName: 'missing_source',
        connectionId: null,
      },
      {
        code: 'wiki_body_unknown_raw_table',
        message: 'account-segments: unknown raw table analytics.missing_table',
        pageKey: 'account-segments',
        ref: 'table:analytics.missing_table',
        tableRef: 'analytics.missing_table',
        connectionId: null,
      },
    ]);
  });
```

- [ ] **Step 2: Run the wiki body issue test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/wiki-body-refs.test.ts -t "structured issue codes"
```

Expected: FAIL with an export error for `findInvalidWikiBodyRefIssues`.

- [ ] **Step 3: Implement structured wiki body issues**

In `packages/context/src/ingest/wiki-body-refs.ts`, add this type after
`WikiBodyRefValidationInput`:

```ts
export type WikiBodyRefIssue =
  | {
      code: 'wiki_body_unknown_sl_source';
      message: string;
      pageKey: string;
      ref: string;
      sourceName: string;
      connectionId: string | null;
    }
  | {
      code: 'wiki_body_unknown_sl_entity';
      message: string;
      pageKey: string;
      ref: string;
      sourceName: string;
      entityName: string;
      connectionId: string | null;
    }
  | {
      code: 'wiki_body_unknown_raw_table';
      message: string;
      pageKey: string;
      ref: string;
      tableRef: string;
      connectionId: string | null;
    };

function renderConnectionScopedRef(connectionId: string | null, body: string): string {
  return connectionId ? `${connectionId}/${body}` : body;
}
```

Replace `findInvalidWikiBodyRefs()` with these two functions:

```ts
export async function findInvalidWikiBodyRefIssues(input: WikiBodyRefValidationInput): Promise<WikiBodyRefIssue[]> {
  const issues: WikiBodyRefIssue[] = [];
  const sourceCache = new Map<string, SemanticLayerSource[]>();
  const loadSources = async (connectionId: string): Promise<SemanticLayerSource[]> => {
    const cached = sourceCache.get(connectionId);
    if (cached) {
      return cached;
    }
    const sources = await input.loadSources(connectionId);
    sourceCache.set(connectionId, sources);
    return sources;
  };

  const findSource = async (
    connectionIds: string[],
    sourceName: string,
  ): Promise<{ connectionId: string; source: SemanticLayerSource } | null> => {
    for (const connectionId of connectionIds) {
      const source = (await loadSources(connectionId)).find((candidate) => candidate.name === sourceName);
      if (source) {
        return { connectionId, source };
      }
    }
    return null;
  };

  for (const ref of parseWikiBodyRefs(input.body)) {
    const connectionIds = ref.connectionId ? [ref.connectionId] : input.visibleConnectionIds;
    if (ref.kind === 'table') {
      const found = await Promise.all(connectionIds.map((connectionId) => input.tableExists(connectionId, ref.tableRef)));
      if (!found.some(Boolean)) {
        const renderedRef = renderConnectionScopedRef(ref.connectionId, `table:${ref.tableRef}`);
        issues.push({
          code: 'wiki_body_unknown_raw_table',
          message: `${input.pageKey}: unknown raw table ${renderConnectionScopedRef(ref.connectionId, ref.tableRef)}`,
          pageKey: input.pageKey,
          ref: renderedRef,
          tableRef: ref.tableRef,
          connectionId: ref.connectionId,
        });
      }
      continue;
    }

    const found = await findSource(connectionIds, ref.sourceName);
    if (!found) {
      if (ref.kind === 'sl_source') {
        const renderedRef = renderConnectionScopedRef(ref.connectionId, `source:${ref.sourceName}`);
        issues.push({
          code: 'wiki_body_unknown_sl_source',
          message: `${input.pageKey}: unknown semantic-layer source ${renderConnectionScopedRef(ref.connectionId, ref.sourceName)}`,
          pageKey: input.pageKey,
          ref: renderedRef,
          sourceName: ref.sourceName,
          connectionId: ref.connectionId,
        });
      }
      continue;
    }
    if (ref.kind === 'sl_entity' && !entityNames(found.source).has(ref.entityName)) {
      issues.push({
        code: 'wiki_body_unknown_sl_entity',
        message: `${input.pageKey}: unknown semantic-layer entity ${ref.sourceName}.${ref.entityName}`,
        pageKey: input.pageKey,
        ref: renderConnectionScopedRef(ref.connectionId, `${ref.sourceName}.${ref.entityName}`),
        sourceName: ref.sourceName,
        entityName: ref.entityName,
        connectionId: ref.connectionId,
      });
    }
  }

  return issues;
}

export async function findInvalidWikiBodyRefs(input: WikiBodyRefValidationInput): Promise<string[]> {
  return (await findInvalidWikiBodyRefIssues(input)).map((issue) => issue.message);
}
```

- [ ] **Step 4: Run the wiki body issue test to verify it passes**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/wiki-body-refs.test.ts -t "structured issue codes"
```

Expected: PASS.

- [ ] **Step 5: Add validator detail tests**

In `packages/context/src/ingest/stages/validate-wu-sources.test.ts`, replace
the first test's final expectation block with:

```ts
    expect(result).toEqual({
      validSources: ['warehouse-a:good'],
      invalidSources: ['warehouse-b:bad'],
      issues: [
        {
          connectionId: 'warehouse-b',
          sourceName: 'bad',
          sourceId: 'warehouse-b:bad',
          errors: ['bad.yaml: measure "revenue" dry-run failed.\n  Error: column missing_revenue does not exist'],
          warnings: ['bad.yaml: warehouse warning'],
        },
      ],
    });
```

Replace the mocked validator in that same test with:

```ts
    const validateSingleSource = vi
      .fn()
      .mockResolvedValueOnce({ errors: [], warnings: [] })
      .mockResolvedValueOnce({
        errors: ['bad.yaml: measure "revenue" dry-run failed.\n  Error: column missing_revenue does not exist'],
        warnings: ['bad.yaml: warehouse warning'],
      });
```

- [ ] **Step 6: Run the validator detail test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/stages/validate-wu-sources.test.ts
```

Expected: FAIL because `issues` is missing from the returned object.

- [ ] **Step 7: Preserve validator error details**

In `packages/context/src/ingest/stages/validate-wu-sources.ts`, replace the
interfaces and function with:

```ts
export interface WuValidationIssue {
  connectionId: string;
  sourceName: string;
  sourceId: string;
  errors: string[];
  warnings: string[];
}

export interface WuValidationResult {
  validSources: string[];
  invalidSources: string[];
  issues: WuValidationIssue[];
}

export async function validateWuTouchedSources(
  deps: SlValidationDeps & { slValidator: SlValidatorPort<SlValidationDeps> },
  touched: TouchedSlSource[],
): Promise<WuValidationResult> {
  const valid: string[] = [];
  const invalid: string[] = [];
  const issues: WuValidationIssue[] = [];
  for (const source of touched) {
    const sourceId = `${source.connectionId}:${source.sourceName}`;
    const result = await deps.slValidator.validateSingleSource(deps, source.connectionId, source.sourceName);
    if (result.errors.length === 0) {
      valid.push(sourceId);
    } else {
      invalid.push(sourceId);
      issues.push({
        connectionId: source.connectionId,
        sourceName: source.sourceName,
        sourceId,
        errors: result.errors,
        warnings: result.warnings,
      });
    }
  }
  return { validSources: valid, invalidSources: invalid, issues };
}
```

- [ ] **Step 8: Run the validator tests to verify they pass**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/stages/validate-wu-sources.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit structured issue foundations**

```bash
git add packages/context/src/ingest/wiki-body-refs.ts \
  packages/context/src/ingest/wiki-body-refs.test.ts \
  packages/context/src/ingest/stages/validate-wu-sources.ts \
  packages/context/src/ingest/stages/validate-wu-sources.test.ts
git commit -m "feat(ingest): preserve structured gate issue details"
```

### Task 2: Throw structured final artifact gate failures

**Files:**
- Modify: `packages/context/src/ingest/artifact-gates.ts`
- Modify: `packages/context/src/ingest/artifact-gates.test.ts`

- [ ] **Step 1: Add structured failure tests**

In `packages/context/src/ingest/artifact-gates.test.ts`, extend the import:

```ts
import { FinalArtifactGateFailure, validateFinalIngestArtifacts, validateProvenanceRawPaths } from './artifact-gates.js';
```

Append this test inside `describe('artifact gates', ...)`:

```ts
  it('throws structured final artifact gate issues', async () => {
    const wikiService = wikiServiceWithPages({
      'account-segments': {
        refs: ['missing-page'],
        slRefs: ['mart_account_segments.total_contract_arr_cents'],
        content: [
          'ARR is `mart_account_segments.total_contract_arr_cents`.',
          'Warehouse table `table:analytics.missing_table`.',
        ].join('\n'),
      },
    });
    const semanticLayerService = {
      loadAllSources: vi.fn().mockResolvedValue({
        sources: [
          {
            name: 'mart_account_segments',
            grain: ['account_id'],
            columns: [{ name: 'account_id', type: 'string' }],
            joins: [],
            measures: [{ name: 'total_contract_arr', expr: 'sum(contract_arr)' }],
            table: 'analytics.mart_account_segments',
          },
        ],
        loadErrors: [],
      }),
    };

    await expect(
      validateFinalIngestArtifacts({
        connectionIds: ['warehouse'],
        changedWikiPageKeys: ['account-segments'],
        touchedSlSources: [{ connectionId: 'warehouse', sourceName: 'mart_account_segments' }],
        wikiService: wikiService as never,
        semanticLayerService: semanticLayerService as never,
        validateTouchedSources: async () => ({
          invalidSources: ['warehouse:mart_account_segments'],
          validSources: [],
          issues: [
            {
              connectionId: 'warehouse',
              sourceName: 'mart_account_segments',
              sourceId: 'warehouse:mart_account_segments',
              errors: ['mart_account_segments.yaml: measure "total_contract_arr" dry-run failed.\n  Error: column missing_arr does not exist'],
              warnings: [],
            },
          ],
        }),
        tableExists: async () => false,
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'semantic_layer_validation_failed', sourceId: 'warehouse:mart_account_segments' }),
        expect.objectContaining({ code: 'wiki_sl_ref_unknown_entity', pageKey: 'account-segments' }),
        expect.objectContaining({ code: 'wiki_ref_missing_page', pageKey: 'account-segments', missingRef: 'missing-page' }),
        expect.objectContaining({ code: 'wiki_body_unknown_sl_entity', pageKey: 'account-segments' }),
        expect.objectContaining({ code: 'wiki_body_unknown_raw_table', pageKey: 'account-segments' }),
      ]),
    });
  });
```

- [ ] **Step 2: Run the structured failure test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/artifact-gates.test.ts -t "structured final artifact gate issues"
```

Expected: FAIL with an export error for `FinalArtifactGateFailure` or missing
`issues`.

- [ ] **Step 3: Add structured issue types and failure class**

In `packages/context/src/ingest/artifact-gates.ts`, change the wiki body import:

```ts
import { findInvalidWikiBodyRefIssues, type WikiBodyRefIssue } from './wiki-body-refs.js';
```

Replace the existing `TouchedValidationResult` interface with these exported
types:

```ts
export interface TouchedSourceValidationIssue {
  connectionId: string;
  sourceName: string;
  sourceId: string;
  errors: string[];
  warnings?: string[];
}

export interface TouchedValidationResult {
  invalidSources: string[];
  validSources: string[];
  issues?: TouchedSourceValidationIssue[];
}

export type FinalArtifactGateIssue =
  | {
      code: 'semantic_layer_validation_failed';
      message: string;
      connectionId: string | null;
      sourceName: string;
      sourceId: string;
      sourceErrors: string[];
    }
  | {
      code: 'wiki_sl_ref_unknown_source';
      message: string;
      pageKey: string;
      ref: string;
      sourceName: string;
      connectionId: string | null;
    }
  | {
      code: 'wiki_sl_ref_unknown_entity';
      message: string;
      pageKey: string;
      ref: string;
      sourceName: string;
      entityName: string;
      connectionId: string | null;
    }
  | {
      code: 'wiki_ref_missing_page';
      message: string;
      pageKey: string;
      missingRef: string;
    }
  | WikiBodyRefIssue;

export class FinalArtifactGateFailure extends Error {
  readonly issues: FinalArtifactGateIssue[];

  constructor(issues: FinalArtifactGateIssue[]) {
    super(`final artifact gates failed:\n${issues.map((issue) => issue.message).join('\n')}`);
    this.name = 'FinalArtifactGateFailure';
    this.issues = issues;
  }
}
```

- [ ] **Step 4: Return structured wiki frontmatter issues**

Replace `validateWikiSlRefs()` with:

```ts
async function validateWikiSlRefs(input: FinalArtifactGateInput): Promise<FinalArtifactGateIssue[]> {
  const issues: FinalArtifactGateIssue[] = [];
  const sourcesByConnection = new Map<string, Awaited<ReturnType<SemanticLayerService['loadAllSources']>>['sources']>();
  for (const connectionId of input.connectionIds) {
    const { sources } = await input.semanticLayerService.loadAllSources(connectionId);
    sourcesByConnection.set(connectionId, sources);
  }

  for (const pageKey of input.changedWikiPageKeys) {
    const page = await input.wikiService.readPage('GLOBAL', null, pageKey);
    if (!page) {
      continue;
    }
    for (const ref of page.frontmatter.sl_refs ?? []) {
      const parsed = parseSlRef(ref);
      const candidateConnections = parsed.connectionId ? [parsed.connectionId] : input.connectionIds;
      let source: Awaited<ReturnType<SemanticLayerService['loadAllSources']>>['sources'][number] | undefined;
      for (const connectionId of candidateConnections) {
        source = sourcesByConnection.get(connectionId)?.find((candidate) => candidate.name === parsed.sourceName);
        if (source) {
          break;
        }
      }
      if (!source) {
        issues.push({
          code: 'wiki_sl_ref_unknown_source',
          message: `${pageKey}: unknown sl_refs entry ${ref}`,
          pageKey,
          ref,
          sourceName: parsed.sourceName,
          connectionId: parsed.connectionId,
        });
        continue;
      }
      if (parsed.entityName && !slEntityNames(source).has(parsed.entityName)) {
        issues.push({
          code: 'wiki_sl_ref_unknown_entity',
          message: `${pageKey}: unknown sl_refs entity ${ref}`,
          pageKey,
          ref,
          sourceName: parsed.sourceName,
          entityName: parsed.entityName,
          connectionId: parsed.connectionId,
        });
      }
    }
  }
  return issues;
}
```

- [ ] **Step 5: Return structured wiki page reference issues**

Replace `validateWikiRefs()` with:

```ts
async function validateWikiRefs(input: FinalArtifactGateInput): Promise<FinalArtifactGateIssue[]> {
  const issues: FinalArtifactGateIssue[] = [];
  for (const pageKey of input.changedWikiPageKeys) {
    const page = await input.wikiService.readPage('GLOBAL', null, pageKey);
    if (!page) {
      continue;
    }
    const missingRefs = await findMissingWikiRefs({
      wikiService: input.wikiService,
      scope: 'GLOBAL',
      scopeId: null,
      pageKey,
      refs: page.frontmatter.refs,
      content: page.content,
    });
    for (const missingRef of missingRefs) {
      issues.push({
        code: 'wiki_ref_missing_page',
        message: `${pageKey} -> ${missingRef}`,
        pageKey,
        missingRef,
      });
    }
  }
  return issues;
}
```

- [ ] **Step 6: Throw `FinalArtifactGateFailure` from final gates**

Replace `validateFinalIngestArtifacts()` with:

```ts
export async function validateFinalIngestArtifacts(input: FinalArtifactGateInput): Promise<void> {
  const touchedWithDependencies = await expandTouchedSlSourcesWithDirectJoinNeighbors(input);
  const validation = await input.validateTouchedSources(touchedWithDependencies);
  const issues: FinalArtifactGateIssue[] = [];
  const validationIssues =
    validation.issues ??
    validation.invalidSources.map((sourceId) => {
      const [connectionId, sourceName] = sourceId.includes(':') ? sourceId.split(':', 2) : [null, sourceId];
      return {
        connectionId,
        sourceName: sourceName ?? sourceId,
        sourceId,
        errors: [`semantic-layer validation failed for ${sourceId}`],
        warnings: [],
      };
    });
  for (const issue of validationIssues) {
    issues.push({
      code: 'semantic_layer_validation_failed',
      message: `semantic-layer validation failed for ${issue.sourceId}`,
      connectionId: issue.connectionId,
      sourceName: issue.sourceName,
      sourceId: issue.sourceId,
      sourceErrors: issue.errors,
    });
  }

  issues.push(...(await validateWikiSlRefs(input)));
  const danglingWikiRefs = await validateWikiRefs(input);
  if (danglingWikiRefs.length > 0) {
    const combined = danglingWikiRefs.map((issue) => issue.message).join(', ');
    issues.push({
      code: 'wiki_ref_missing_page',
      message: `wiki references target missing page(s): ${combined}`,
      pageKey: danglingWikiRefs[0].pageKey,
      missingRef: danglingWikiRefs[0].missingRef,
    });
  }

  for (const pageKey of input.changedWikiPageKeys) {
    const page = await input.wikiService.readPage('GLOBAL', null, pageKey);
    if (!page) {
      continue;
    }
    issues.push(
      ...(await findInvalidWikiBodyRefIssues({
        pageKey,
        body: page.content,
        visibleConnectionIds: input.connectionIds,
        loadSources: async (connectionId) => {
          const { sources } = await input.semanticLayerService.loadAllSources(connectionId);
          return sources;
        },
        tableExists: input.tableExists,
      })),
    );
  }

  if (issues.length > 0) {
    throw new FinalArtifactGateFailure(issues);
  }
}
```

- [ ] **Step 7: Run artifact gate tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/artifact-gates.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit structured final gate failures**

```bash
git add packages/context/src/ingest/artifact-gates.ts \
  packages/context/src/ingest/artifact-gates.test.ts
git commit -m "feat(ingest): structure final artifact gate failures"
```

### Task 3: Add gate repair policy

**Files:**
- Create: `packages/context/src/ingest/gate-repair-policy.ts`
- Create: `packages/context/src/ingest/gate-repair-policy.test.ts`

- [ ] **Step 1: Add policy tests**

Create `packages/context/src/ingest/gate-repair-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FinalArtifactGateFailure, type FinalArtifactGateIssue } from './artifact-gates.js';
import { classifyFinalGateRepair } from './gate-repair-policy.js';

function failure(...issues: FinalArtifactGateIssue[]): FinalArtifactGateFailure {
  return new FinalArtifactGateFailure(issues);
}

describe('classifyFinalGateRepair', () => {
  it('allows stale wiki reference drift to use the repair agent', () => {
    const decision = classifyFinalGateRepair(
      failure({
        code: 'wiki_body_unknown_sl_entity',
        message: 'account-segments: unknown semantic-layer entity mart_account_segments.total_contract_arr_cents',
        pageKey: 'account-segments',
        ref: 'mart_account_segments.total_contract_arr_cents',
        sourceName: 'mart_account_segments',
        entityName: 'total_contract_arr_cents',
        connectionId: null,
      }),
    );

    expect(decision).toEqual({
      repairable: true,
      issueCodes: ['wiki_body_unknown_sl_entity'],
    });
  });

  it('blocks semantic-layer validation failures from automatic repair', () => {
    const decision = classifyFinalGateRepair(
      failure({
        code: 'semantic_layer_validation_failed',
        message: 'semantic-layer validation failed for warehouse:orders',
        connectionId: 'warehouse',
        sourceName: 'orders',
        sourceId: 'warehouse:orders',
        sourceErrors: ['orders.yaml: measure "revenue" dry-run failed.\n  Error: column missing_revenue does not exist'],
      }),
    );

    expect(decision).toEqual({
      repairable: false,
      reason: 'non-repairable artifact gate issue(s): semantic_layer_validation_failed',
      issueCodes: ['semantic_layer_validation_failed'],
    });
  });

  it('blocks missing raw table body references from automatic repair', () => {
    const decision = classifyFinalGateRepair(
      failure({
        code: 'wiki_body_unknown_raw_table',
        message: 'account-segments: unknown raw table analytics.missing_table',
        pageKey: 'account-segments',
        ref: 'table:analytics.missing_table',
        tableRef: 'analytics.missing_table',
        connectionId: null,
      }),
    );

    expect(decision).toEqual({
      repairable: false,
      reason: 'non-repairable artifact gate issue(s): wiki_body_unknown_raw_table',
      issueCodes: ['wiki_body_unknown_raw_table'],
    });
  });

  it('blocks unstructured errors by default', () => {
    expect(classifyFinalGateRepair(new Error('plain gate failure'))).toEqual({
      repairable: false,
      reason: 'unclassified artifact gate failure',
      issueCodes: [],
    });
  });
});
```

- [ ] **Step 2: Run policy tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/gate-repair-policy.test.ts
```

Expected: FAIL because `gate-repair-policy.ts` does not exist.

- [ ] **Step 3: Implement the policy module**

Create `packages/context/src/ingest/gate-repair-policy.ts`:

```ts
import { FinalArtifactGateFailure, type FinalArtifactGateIssue } from './artifact-gates.js';

export type GateRepairDecision =
  | { repairable: true; issueCodes: string[] }
  | { repairable: false; reason: string; issueCodes: string[] };

const repairableIssueCodes = new Set<FinalArtifactGateIssue['code']>([
  'wiki_body_unknown_sl_entity',
  'wiki_body_unknown_sl_source',
  'wiki_sl_ref_unknown_entity',
  'wiki_ref_missing_page',
]);

export function artifactGateIssueSummary(error: unknown): { message: string; issues: FinalArtifactGateIssue[] } {
  if (error instanceof FinalArtifactGateFailure) {
    return { message: error.message, issues: error.issues };
  }
  return { message: error instanceof Error ? error.message : String(error), issues: [] };
}

export function classifyFinalGateRepair(error: unknown): GateRepairDecision {
  const { issues } = artifactGateIssueSummary(error);
  if (issues.length === 0) {
    return {
      repairable: false,
      reason: 'unclassified artifact gate failure',
      issueCodes: [],
    };
  }

  const issueCodes = [...new Set(issues.map((issue) => issue.code))].sort();
  const nonRepairableCodes = issueCodes.filter(
    (code): code is FinalArtifactGateIssue['code'] => !repairableIssueCodes.has(code as FinalArtifactGateIssue['code']),
  );
  if (nonRepairableCodes.length > 0) {
    return {
      repairable: false,
      reason: `non-repairable artifact gate issue(s): ${nonRepairableCodes.join(', ')}`,
      issueCodes,
    };
  }

  return { repairable: true, issueCodes };
}
```

- [ ] **Step 4: Run policy tests to verify they pass**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/gate-repair-policy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the policy module**

```bash
git add packages/context/src/ingest/gate-repair-policy.ts \
  packages/context/src/ingest/gate-repair-policy.test.ts
git commit -m "feat(ingest): classify final gate repair safety"
```

### Task 4: Block non-repairable patch-level gate failures

**Files:**
- Modify: `packages/context/src/ingest/isolated-diff/patch-integrator.ts`
- Modify: `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`

- [ ] **Step 1: Add patch-level non-repairable regression**

In `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`,
extend the imports:

```ts
import { FinalArtifactGateFailure } from '../artifact-gates.js';
```

Append this test inside `describe('integrateWorkUnitPatch', ...)`:

```ts
  it('does not invoke gate repair for non-repairable semantic validation failures', async () => {
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    const childDir = join(homeDir, 'child-semantic-high-risk');
    await git.addWorktree(childDir, 'child-semantic-high-risk', baseSha);
    const childGit = git.forWorktree(childDir);
    await mkdir(join(childDir, 'semantic-layer/c1'), { recursive: true });
    await writeFile(
      join(childDir, 'semantic-layer/c1/orders.yaml'),
      'name: orders\ngrain: [id]\ncolumns: [{name: id, type: string}]\njoins: []\nmeasures:\n  - name: revenue\n    expr: sum(missing_revenue)\n',
    );
    await childGit.commitFiles(['semantic-layer/c1/orders.yaml'], 'invalid semantic edit', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/semantic-high-risk.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-semantic-high-risk/trace.jsonl'),
      jobId: 'job-semantic-high-risk',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });
    const repairGateFailure = vi.fn(async () => {
      throw new Error('repair must not run for high-risk semantic validation failures');
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-high-risk',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'KTX Test', email: 'system@ktx.local' },
      validateAppliedTree: vi.fn().mockRejectedValue(
        new FinalArtifactGateFailure([
          {
            code: 'semantic_layer_validation_failed',
            message: 'semantic-layer validation failed for c1:orders',
            connectionId: 'c1',
            sourceName: 'orders',
            sourceId: 'c1:orders',
            sourceErrors: ['orders.yaml: measure "revenue" dry-run failed.\n  Error: column missing_revenue does not exist'],
          },
        ]),
      ),
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['c1']),
      repairGateFailure,
    });

    expect(result).toMatchObject({
      status: 'semantic_conflict',
      reason: expect.stringContaining('semantic-layer validation failed for c1:orders'),
    });
    expect(repairGateFailure).not.toHaveBeenCalled();
    await expect(readFile(join(configDir, 'semantic-layer/c1/orders.yaml'), 'utf-8')).rejects.toThrow();
    await expect(readFile(trace.tracePath, 'utf-8')).resolves.toContain('patch_semantic_conflict_not_repairable');
  });
```

- [ ] **Step 2: Run the patch integrator regression to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/patch-integrator.test.ts -t "non-repairable semantic validation failures"
```

Expected: FAIL because `repairGateFailure` is called.

- [ ] **Step 3: Wire repair policy into patch integration**

In `packages/context/src/ingest/isolated-diff/patch-integrator.ts`, add:

```ts
import { artifactGateIssueSummary, classifyFinalGateRepair } from '../gate-repair-policy.js';
```

Inside the `catch (error)` block after the clean patch applies and
`validateAppliedTree(touchedPaths)` rejects, replace:

```ts
    const reason = errorMessage(error);
```

with:

```ts
    const gateFailure = artifactGateIssueSummary(error);
    const reason = gateFailure.message;
    const repairDecision = classifyFinalGateRepair(error);
```

Immediately after the existing `patch_semantic_conflict` trace event, insert:

```ts
    if (!repairDecision.repairable) {
      if (preApplyHead) {
        await input.integrationGit.resetHardTo(preApplyHead);
      }
      await input.trace.event('error', 'integration', 'patch_semantic_conflict_not_repairable', {
        unitKey: input.unitKey,
        patchPath: input.patchPath,
        touchedPaths,
        reason: repairDecision.reason,
        issueCodes: repairDecision.issueCodes,
      });
      return {
        status: 'semantic_conflict',
        reason,
        touchedPaths,
      };
    }
```

Then keep the existing `if (input.repairGateFailure) { ... }` block unchanged.
This means gate repair runs only when `repairDecision.repairable` is true.

- [ ] **Step 4: Convert existing semantic repair tests to structured repairable failures**

In `patch-integrator.test.ts`, change the repairable semantic-gate test's
mock rejection from:

```ts
      .mockRejectedValueOnce(new Error('final artifact gates failed:\na: unknown semantic-layer entity'))
```

to:

```ts
      .mockRejectedValueOnce(
        new FinalArtifactGateFailure([
          {
            code: 'wiki_body_unknown_sl_entity',
            message: 'a: unknown semantic-layer entity mart_account_segments.total_contract_arr_cents',
            pageKey: 'a',
            ref: 'mart_account_segments.total_contract_arr_cents',
            sourceName: 'mart_account_segments',
            entityName: 'total_contract_arr_cents',
            connectionId: null,
          },
        ]),
      )
```

- [ ] **Step 5: Run patch integrator tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/patch-integrator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit patch-level policy wiring**

```bash
git add packages/context/src/ingest/isolated-diff/patch-integrator.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.test.ts
git commit -m "fix(ingest): block high-risk patch gate repair"
```

### Task 5: Block non-repairable final composed-tree gate failures

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`

- [ ] **Step 1: Add final-gate non-repairable regression**

In `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`,
append this test inside `describe('IngestBundleRunner isolated diff path', ...)`
before the final gate repair success test:

```ts
  it('does not invoke final gate repair for semantic-layer warehouse validation failures', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'valid-page', rawFiles: ['pages/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      deps.slValidator.validateSingleSource = vi.fn().mockResolvedValue({
        errors: ['orders.yaml: measure "revenue" dry-run failed.\n  Error: column missing_revenue does not exist'],
        warnings: [],
      });

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags.operationName === 'ingest-isolated-diff-gate-repair') {
          throw new Error('gate repair must not run for semantic-layer validation failures');
        }

        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(join(root, 'wiki/global/valid-page.md'), '---\nsummary: Valid page\nusage_mode: auto\n---\n\nValid\n');
          currentSession.actions.push({
            target: 'wiki',
            type: 'created',
            key: 'valid-page',
            detail: 'Valid page',
            rawPaths: ['pages/source.json'],
          });
          await currentSession.gitService.commitFiles(['wiki/global/valid-page.md'], 'wu valid page', 'KTX Test', 'system@ktx.local');
          return { stopReason: 'natural' as const };
        }

        await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
        await writeFile(
          join(root, 'semantic-layer/warehouse/orders.yaml'),
          'name: orders\ngrain: [id]\ncolumns: [{name: id, type: string}]\njoins: []\nmeasures:\n  - name: revenue\n    expr: sum(missing_revenue)\n',
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'orders');
        currentSession.actions.push({
          target: 'sl',
          type: 'created',
          key: 'orders',
          detail: 'Invalid source from reconciliation',
          targetConnectionId: 'warehouse',
          rawPaths: ['pages/source.json'],
        });
        await currentSession.gitService.commitFiles(
          ['semantic-layer/warehouse/orders.yaml'],
          'reconcile invalid semantic source',
          'KTX Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' as const };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['pages/source.json', 'h1']]);
      const preRunHead = await runtime.git.revParseHead();

      await expect(
        runner.run({
          jobId: 'job-final-high-risk-semantic',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/semantic-layer validation failed for warehouse:orders/);

      expect(await runtime.git.revParseHead()).toBe(preRunHead);
      expect(deps.agentRunner.runLoop).not.toHaveBeenCalledWith(
        expect.objectContaining({
          telemetryTags: expect.objectContaining({
            operationName: 'ingest-isolated-diff-gate-repair',
          }),
        }),
      );
      const trace = await readFile(
        join(runtime.configDir, '.ktx/ingest-traces/job-final-high-risk-semantic/trace.jsonl'),
        'utf-8',
      );
      expect(trace).toContain('final_artifact_gates_failed');
      expect(trace).toContain('final_artifact_gates_not_repairable');
      expect(trace).toContain('semantic_layer_validation_failed');
      expect(trace).not.toContain('gate_repair_started');
      expect(trace).not.toContain('squash_finished');

      const failureReport = (deps.reports.create as any).mock.calls
        .map((call: any[]) => call[0])
        .find((report: any) => report.body.status === 'failed');
      expect(failureReport.body.failure).toMatchObject({
        phase: 'final_gates',
        message: expect.stringContaining('semantic-layer validation failed for warehouse:orders'),
        details: expect.objectContaining({
          gateRepairDecision: {
            repairable: false,
            reason: 'non-repairable artifact gate issue(s): semantic_layer_validation_failed',
            issueCodes: ['semantic_layer_validation_failed'],
          },
        }),
      });
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the final-gate regression to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts -t "semantic-layer warehouse validation failures"
```

Expected: FAIL because final gate repair is invoked for the semantic-layer
validation failure.

- [ ] **Step 3: Wire repair policy into the runner**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, add:

```ts
import { classifyFinalGateRepair } from './gate-repair-policy.js';
```

Inside the `catch (error)` block around final `validateFinalIngestArtifacts()`,
immediately after:

```ts
        const gateError = this.errorMessage(error);
```

insert:

```ts
        const gateRepairDecision = classifyFinalGateRepair(error);
        if (!gateRepairDecision.repairable) {
          activeFailureDetails = {
            ...finalArtifactGateTraceData,
            gateRepairDecision,
          };
          await runTrace.event('error', 'final_gates', 'final_artifact_gates_not_repairable', {
            ...finalArtifactGateTraceData,
            gateRepairDecision,
          });
          throw error;
        }
```

Leave the existing repair path unchanged after this insertion. It will run only
for repairable structured wiki-reference failures.

- [ ] **Step 4: Run the final-gate regression to verify it passes**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts -t "semantic-layer warehouse validation failures"
```

Expected: PASS.

- [ ] **Step 5: Update the invalid `sl_refs` regression**

In `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`,
find the test named
`rejects Notion-style changed wiki pages with invalid sl_refs`. Replace the
final assertion with:

```ts
      await expect(
        runner.run({ jobId: 'job-invalid-slrefs', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/unknown sl_refs entry missing_source/);

      expect(deps.agentRunner.runLoop).not.toHaveBeenCalledWith(
        expect.objectContaining({
          telemetryTags: expect.objectContaining({
            operationName: 'ingest-isolated-diff-gate-repair',
          }),
        }),
      );
```

Missing source-level `sl_refs` are non-repairable in v1 because selecting a
replacement source without evidence can invent semantic context.

- [ ] **Step 6: Run existing gate repair regressions**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts -t "repairs final wiki body refs|fails before squash when final gate repair makes no edit|invalid sl_refs"
```

Expected: PASS.

- [ ] **Step 7: Commit runner policy wiring**

```bash
git add packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts
git commit -m "fix(ingest): block high-risk final gate repair"
```

### Task 6: Verify the v1 closure

**Files:**
- Verify: `packages/context/src/ingest/**/*.ts`
- Verify: `packages/context/src/ingest/**/*.test.ts`

- [ ] **Step 1: Run the focused gate repair suite**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/wiki-body-refs.test.ts \
  src/ingest/artifact-gates.test.ts \
  src/ingest/gate-repair-policy.test.ts \
  src/ingest/final-gate-repair.test.ts \
  src/ingest/isolated-diff/patch-integrator.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  src/ingest/stages/validate-wu-sources.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the context type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Run the context test suite**

Run:

```bash
pnpm --filter @ktx/context run test
```

Expected: PASS.

- [ ] **Step 4: Run dead-code analysis**

Run:

```bash
pnpm run dead-code
```

Expected: PASS or only pre-existing findings unrelated to these files. If
there are findings in files changed by this plan, remove the dead code and run
the command again.

- [ ] **Step 5: Run pre-commit on changed TypeScript and plan files**

Run:

```bash
uv run pre-commit run --files \
  packages/context/src/ingest/wiki-body-refs.ts \
  packages/context/src/ingest/wiki-body-refs.test.ts \
  packages/context/src/ingest/stages/validate-wu-sources.ts \
  packages/context/src/ingest/stages/validate-wu-sources.test.ts \
  packages/context/src/ingest/artifact-gates.ts \
  packages/context/src/ingest/artifact-gates.test.ts \
  packages/context/src/ingest/gate-repair-policy.ts \
  packages/context/src/ingest/gate-repair-policy.test.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.test.ts \
  packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  docs/superpowers/plans/2026-05-18-isolated-diff-ingestion-v1-gate-repair-classification.md
```

Expected: PASS. If this repository does not have a pre-commit configuration or
the local `uv` binary cannot satisfy the pinned project version, record that
explicitly in the implementation summary and keep the TypeScript checks above
as the authoritative verification.

- [ ] **Step 6: Commit verification**

```bash
git status --short
git commit --allow-empty -m "chore(ingest): verify gate repair classification"
```

## Self-review

Spec coverage:

- The Gate repair stage classification requirement is covered by Tasks 2
  through 5. High-risk semantic-layer validation failures and missing raw table
  references are blocked before repair.
- Repairable stale wiki body references still run through bounded gate repair,
  rerun final gates, and commit only after validation passes.
- Patch-level semantic gate failures and final composed-tree gate failures use
  the same repair policy.
- The Global semantic gates section remains covered by the existing gates;
  this plan preserves direct declared-join validation and the existing wiki
  body grammar.
- Regression coverage now includes the spec's unrepairable final-gate failure
  class without relying on the repair agent choosing not to edit.

Remaining gaps:

- No v1-blocking gaps remain after this plan is implemented and verified.
- Deterministic semantic merge helpers remain rollout step 9 and are
  intentionally post-v1.
- Richer resolver and repair context can be added after v1 traces show the
  frequent repair shapes.

Placeholder scan:

- The plan contains exact file paths, concrete test code, concrete
  implementation snippets, commands, and expected outcomes.
- The plan contains no deferred implementation markers.

Type consistency:

- `FinalArtifactGateIssue`, `FinalArtifactGateFailure`,
  `WikiBodyRefIssue`, `TouchedSourceValidationIssue`,
  `classifyFinalGateRepair()`, and `artifactGateIssueSummary()` are introduced
  before use.
- `GateRepairDecision` uses `repairable`, `reason`, and `issueCodes`
  consistently in tests, traces, and failure-report details.

Plan complete and saved to
`docs/superpowers/plans/2026-05-18-isolated-diff-ingestion-v1-gate-repair-classification.md`.
