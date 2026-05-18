# Isolated Diff Ingestion V1 Gates and Trace Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining v1-blocking isolated-diff ingestion gaps so the
actual final integration tree is globally gated and every failed run leaves a
persistent trace and stored failure report that are useful for postmortems.

**Architecture:** Keep the isolated-diff runner private to the runner-owned
source allowlist, but make its safety boundary match the design: per-patch
gates still run during integration, reconciliation and follow-on deterministic
mutations are diffed, and one final global artifact gate runs after every
mutating integration-stage operation and before squash. Persistent JSONL traces
become the operational source of truth for postmortems, with start/finish/fail
events, timings, state snapshots, conflict classification, and a stored failure
report that lets `ktx ingest status <runId|jobId>` surface the trace path even
when the run fails before the normal success report.

**Tech Stack:** TypeScript ESM/NodeNext, Vitest, simple-git, existing
`IngestBundleRunner`, `GitService`, `SessionWorktreeService`,
`SemanticLayerService`, `KnowledgeWikiService`, ingest report schemas, and CLI
status rendering.

---

## Audit Summary

The latest plan and commits implemented the first isolated-diff path and the
focused tests pass:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/ingest-trace.test.ts \
  src/ingest/wiki-body-refs.test.ts \
  src/ingest/artifact-gates.test.ts \
  src/ingest/isolated-diff/git-patch.test.ts \
  src/ingest/isolated-diff/work-unit-executor.test.ts \
  src/ingest/isolated-diff/patch-integrator.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts
```

Current result: `7 passed`, `20 passed`.

The remaining gaps below are v1-blocking:

- The isolated branch runs `final_artifact_gates` immediately after accepted
  WorkUnit patches, but reconciliation, post-processors, and wiki `sl_refs`
  repair can still mutate the integration worktree afterward. The tree that is
  squashed is therefore not globally gated after every mutating stage.
- Reconciliation changes are not captured as a diff against the
  pre-reconciliation integration `HEAD`, and reconciliation-touched artifacts
  are not included in a post-reconciliation artifact gate.
- Wiki frontmatter `sl_refs` validation checks only source existence. It does
  not validate measure-level references such as
  `mart_account_segments.total_contract_arr_cents`.
- Wiki body reference parsing treats every two-part inline-code token as a
  semantic-layer reference, even when the left side is not a visible source. The
  spec says those tokens must be ignored unless they name a visible source.
- Semantic-layer final gates validate only touched sources. They do not expand
  the touched set to direct declared-join neighbors, including sources joined
  from touched sources and sources that join to touched sources.
- `slDisallowed` and patch policy rejections can throw before integration emits
  a structured conflict event or stored failure report.
- Failed runs before success-report creation do not leave a stored ingest
  report, so `ktx ingest status <runId|jobId>` cannot surface the trace path.
- Trace coverage does not yet cover fetch/stage/detect/planning decisions,
  reconciliation, post-processing, wiki repair, provenance validation and
  insertion, squash, report creation, and failure-report creation with timings
  and state needed for postmortem reconstruction.
- Failed child WorkUnit worktrees are preserved with `cleanup('crash')`. The
  spec requires child worktrees to be cleaned up after diff, transcript, and
  outcome metadata are persisted. Only the integration worktree should be
  preserved for version-one resolver conflicts.

Non-blocking gaps remain after this plan:

- Migrating Notion, LookML, Looker, dbt, MetricFlow, and historic-SQL direct
  durable writes to the isolated path.
- Promoting isolated diffs as the default for all connectors.
- Removing the old shared-worktree WorkUnit execution path.
- Interactive, CLI, or agent-driven conflict resolution.
- Auto-merging semantic conflicts that cannot be proven correct.
- Transitive SQL-projection dependency expansion beyond direct declared joins.
- Moving provenance rows to worktree files.
- Public connector knobs such as `executionMode`, `planningStrategy`, or
  `conflictPolicy`.

## File Structure

- Modify `packages/context/src/ingest/wiki-body-refs.ts`.
  Fix inline-code grammar so unknown two-part tokens are ignored, while
  explicit `source:` and `table:` references remain validated.
- Modify `packages/context/src/ingest/wiki-body-refs.test.ts`.
  Add regression coverage for ignored non-source two-part tokens.
- Modify `packages/context/src/ingest/artifact-gates.ts`.
  Add source/entity frontmatter validation, direct join-neighbor expansion, and
  reusable gate-scope helpers.
- Modify `packages/context/src/ingest/artifact-gates.test.ts`.
  Cover measure-level `sl_refs`, direct dependency validation, and final body
  ref behavior.
- Modify `packages/context/src/ingest/ingest-bundle.runner.ts`.
  Move the final global gate after reconciliation, post-processing, and wiki
  ref repair. Add trace events around every meaningful phase, create stored
  failure reports, and preserve only the integration worktree on conflicts.
- Modify `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`.
  Add regressions for reconciliation-created stale refs, failed-run report
  trace surfacing, and trace event completeness.
- Modify `packages/context/src/ingest/isolated-diff/work-unit-executor.ts`.
  Stop enforcing patch policy during collection, record patch metadata only,
  and always remove child worktrees after outcome metadata is emitted.
- Modify `packages/context/src/ingest/isolated-diff/work-unit-executor.test.ts`.
  Cover cleanup on failed WorkUnits.
- Modify `packages/context/src/ingest/isolated-diff/patch-integrator.ts`.
  Classify patch policy rejections as structured textual conflicts and emit
  trace events before returning.
- Modify `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`.
  Cover `slDisallowed` policy rejection as a traced textual conflict.
- Modify `packages/context/src/ingest/reports.ts`.
  Add report-level `status` and `failure` fields.
- Modify `packages/context/src/ingest/report-snapshot.ts`.
  Parse the new failure report fields while preserving old reports.
- Modify `packages/context/src/ingest/report-snapshot.test.ts`.
  Cover failed report parsing.
- Modify `packages/cli/src/ingest.ts`.
  Render failed stored reports as `Status: error` even when no WorkUnit failed,
  and keep the trace path near run identifiers.
- Modify `packages/cli/src/ingest.test.ts`.
  Cover status output for a failed report with a trace path.
- Modify `docs-site/content/docs/cli-reference/ktx-ingest.mdx`.
  Document that failed runs also write stored reports and that trace events
  include phase timings, state snapshots, decisions, errors, and final outcome.

---

### Task 1: Correct artifact gate semantics

**Files:**
- Modify: `packages/context/src/ingest/wiki-body-refs.test.ts`
- Modify: `packages/context/src/ingest/wiki-body-refs.ts`
- Modify: `packages/context/src/ingest/artifact-gates.test.ts`
- Modify: `packages/context/src/ingest/artifact-gates.ts`

- [ ] **Step 1: Write failing wiki body grammar tests**

Append these tests inside the existing `describe('wiki body refs', ...)` block
in `packages/context/src/ingest/wiki-body-refs.test.ts`:

```ts
  it('ignores two-part inline code when the source is not visible', async () => {
    const invalid = await findInvalidWikiBodyRefs({
      pageKey: 'engineering-notes',
      body: [
        'A version token like `node.v22` is not a semantic-layer reference.',
        'A raw table must use `table:analytics.mart_account_segments`.',
      ].join('\n'),
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => sources,
      tableExists: async (_connectionId, tableRef) => tableRef === 'analytics.mart_account_segments',
    });

    expect(invalid).toEqual([]);
  });

  it('still rejects explicit missing source and table references', async () => {
    const invalid = await findInvalidWikiBodyRefs({
      pageKey: 'account-segments',
      body: [
        '`source:missing_source`',
        '`warehouse/source:missing_source`',
        '`table:analytics.missing_table`',
      ].join('\n'),
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => sources,
      tableExists: async () => false,
    });

    expect(invalid).toEqual([
      'account-segments: unknown semantic-layer source missing_source',
      'account-segments: unknown semantic-layer source warehouse/missing_source',
      'account-segments: unknown raw table analytics.missing_table',
    ]);
  });
```

- [ ] **Step 2: Run wiki body tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/wiki-body-refs.test.ts
```

Expected: FAIL because `node.v22` is treated as an unknown semantic-layer
source.

- [ ] **Step 3: Implement the wiki body grammar fix**

In `packages/context/src/ingest/wiki-body-refs.ts`, replace
`findInvalidWikiBodyRefs()` with this implementation:

```ts
export async function findInvalidWikiBodyRefs(input: WikiBodyRefValidationInput): Promise<string[]> {
  const errors: string[] = [];
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
        errors.push(`${input.pageKey}: unknown raw table ${ref.connectionId ? `${ref.connectionId}/` : ''}${ref.tableRef}`);
      }
      continue;
    }

    const found = await findSource(connectionIds, ref.sourceName);
    if (!found) {
      if (ref.kind === 'sl_source') {
        errors.push(
          `${input.pageKey}: unknown semantic-layer source ${ref.connectionId ? `${ref.connectionId}/` : ''}${ref.sourceName}`,
        );
      }
      continue;
    }

    if (ref.kind === 'sl_entity' && !entityNames(found.source).has(ref.entityName)) {
      errors.push(`${input.pageKey}: unknown semantic-layer entity ${ref.sourceName}.${ref.entityName}`);
    }
  }

  return errors;
}
```

- [ ] **Step 4: Run wiki body tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/wiki-body-refs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing artifact gate tests**

Append these tests inside `describe('artifact gates', ...)` in
`packages/context/src/ingest/artifact-gates.test.ts`:

```ts
  it('fails measure-level wiki frontmatter sl_refs that point at missing entities', async () => {
    const wikiService = {
      readPage: vi.fn().mockResolvedValue({
        pageKey: 'account-segments',
        frontmatter: {
          summary: 'Account segments',
          usage_mode: 'auto',
          sl_refs: ['mart_account_segments.total_contract_arr_cents'],
        },
        content: 'ARR uses a renamed measure.',
      }),
    };
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
        validateTouchedSources: async () => ({ invalidSources: [], validSources: ['warehouse:mart_account_segments'] }),
        tableExists: async () => true,
      }),
    ).rejects.toThrow(/unknown sl_refs entity mart_account_segments\.total_contract_arr_cents/);
  });

  it('validates direct declared-join neighbors of touched semantic-layer sources', async () => {
    const semanticLayerService = {
      loadAllSources: vi.fn().mockResolvedValue({
        sources: [
          {
            name: 'orders',
            grain: ['order_id'],
            columns: [{ name: 'order_id', type: 'string' }, { name: 'account_id', type: 'string' }],
            joins: [{ to: 'accounts', on: 'orders.account_id = accounts.account_id', relationship: 'many_to_one' }],
            measures: [{ name: 'order_count', expr: 'count(*)' }],
          },
          {
            name: 'accounts',
            grain: ['account_id'],
            columns: [{ name: 'account_id', type: 'string' }],
            joins: [],
            measures: [{ name: 'account_count', expr: 'count(*)' }],
          },
          {
            name: 'segments',
            grain: ['segment_id'],
            columns: [{ name: 'segment_id', type: 'string' }, { name: 'account_id', type: 'string' }],
            joins: [{ to: 'accounts', on: 'segments.account_id = accounts.account_id', relationship: 'many_to_one' }],
            measures: [],
          },
        ],
        loadErrors: [],
      }),
    };
    const validateTouchedSources = vi.fn().mockResolvedValue({ invalidSources: [], validSources: [] });

    await validateFinalIngestArtifacts({
      connectionIds: ['warehouse'],
      changedWikiPageKeys: [],
      touchedSlSources: [{ connectionId: 'warehouse', sourceName: 'accounts' }],
      wikiService: { readPage: vi.fn() } as never,
      semanticLayerService: semanticLayerService as never,
      validateTouchedSources,
      tableExists: async () => true,
    });

    expect(validateTouchedSources).toHaveBeenCalledWith([
      { connectionId: 'warehouse', sourceName: 'accounts' },
      { connectionId: 'warehouse', sourceName: 'orders' },
      { connectionId: 'warehouse', sourceName: 'segments' },
    ]);
  });
```

- [ ] **Step 6: Run artifact gate tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/artifact-gates.test.ts
```

Expected: FAIL because frontmatter entity refs and join-neighbor expansion are
not implemented.

- [ ] **Step 7: Implement frontmatter entity refs and direct dependency expansion**

In `packages/context/src/ingest/artifact-gates.ts`, replace the existing
`bareSlRef()` helper and `validateWikiSlRefs()` with this code, then update
`validateFinalIngestArtifacts()` as shown below:

```ts
function parseSlRef(ref: string): { connectionId: string | null; sourceName: string; entityName: string | null } {
  const withoutConnection = ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref;
  const connectionId = ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : null;
  const [sourceName = '', entityName = null] = withoutConnection.split('.', 2);
  return { connectionId, sourceName, entityName };
}

function slEntityNames(source: Awaited<ReturnType<SemanticLayerService['loadAllSources']>>['sources'][number]): Set<string> {
  return new Set([
    ...(source.measures ?? []).map((measure) => measure.name),
    ...(source.columns ?? []).map((column) => column.name),
    ...(source.segments ?? []).map((segment) => segment.name),
  ]);
}

function uniqueTouchedSources(sources: TouchedSlSource[]): TouchedSlSource[] {
  const seen = new Set<string>();
  const unique: TouchedSlSource[] = [];
  for (const source of sources) {
    const key = `${source.connectionId}:${source.sourceName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(source);
  }
  return unique.sort((left, right) => {
    const byConnection = left.connectionId.localeCompare(right.connectionId);
    return byConnection === 0 ? left.sourceName.localeCompare(right.sourceName) : byConnection;
  });
}

async function expandTouchedSlSourcesWithDirectJoinNeighbors(input: FinalArtifactGateInput): Promise<TouchedSlSource[]> {
  const expanded = [...input.touchedSlSources];
  const touchedByConnection = new Map<string, Set<string>>();
  for (const source of input.touchedSlSources) {
    const bucket = touchedByConnection.get(source.connectionId) ?? new Set<string>();
    bucket.add(source.sourceName);
    touchedByConnection.set(source.connectionId, bucket);
  }

  for (const connectionId of input.connectionIds) {
    const touched = touchedByConnection.get(connectionId);
    if (!touched || touched.size === 0) {
      continue;
    }
    const { sources } = await input.semanticLayerService.loadAllSources(connectionId);
    for (const source of sources) {
      const sourceIsTouched = touched.has(source.name);
      if (sourceIsTouched) {
        for (const join of source.joins ?? []) {
          expanded.push({ connectionId, sourceName: join.to });
        }
      }
      if ((source.joins ?? []).some((join) => touched.has(join.to))) {
        expanded.push({ connectionId, sourceName: source.name });
      }
    }
  }

  return uniqueTouchedSources(expanded);
}

async function validateWikiSlRefs(input: FinalArtifactGateInput): Promise<string[]> {
  const errors: string[] = [];
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
        errors.push(`${pageKey}: unknown sl_refs entry ${ref}`);
        continue;
      }
      if (parsed.entityName && !slEntityNames(source).has(parsed.entityName)) {
        errors.push(`${pageKey}: unknown sl_refs entity ${ref}`);
      }
    }
  }
  return errors;
}
```

Then replace the first two lines inside `validateFinalIngestArtifacts()` with:

```ts
  const touchedWithDependencies = await expandTouchedSlSourcesWithDirectJoinNeighbors(input);
  const validation = await input.validateTouchedSources(touchedWithDependencies);
```

- [ ] **Step 8: Run artifact gate tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/artifact-gates.test.ts src/ingest/wiki-body-refs.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit artifact gate fixes**

```bash
git add packages/context/src/ingest/wiki-body-refs.ts \
  packages/context/src/ingest/wiki-body-refs.test.ts \
  packages/context/src/ingest/artifact-gates.ts \
  packages/context/src/ingest/artifact-gates.test.ts
git commit -m "fix(ingest): tighten final artifact gates"
```

### Task 2: Gate the actual final integration tree

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`

- [ ] **Step 1: Write failing reconciliation stale-reference regression**

Append this test to `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`
inside the existing `describe('IngestBundleRunner isolated diff path', ...)`
block:

```ts
  it('runs final artifact gates after reconciliation mutates the integration tree', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'card-source', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
          await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
          await writeFile(
            join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
            'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
          );
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
          currentSession.actions.push({
            target: 'sl',
            type: 'created',
            key: 'mart_account_segments',
            detail: 'Source with renamed ARR measure',
            targetConnectionId: 'warehouse',
            rawPaths: ['cards/source.json'],
          });
          await currentSession.gitService.commitFiles(['semantic-layer/warehouse/mart_account_segments.yaml'], 'wu source', 'KTX Test', 'system@ktx.local');
        } else {
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(
            join(root, 'wiki/global/account-segments.md'),
            '---\nsummary: Account segments\nusage_mode: auto\nsl_refs:\n  - mart_account_segments\n---\n\nReconcile wrote stale ARR `mart_account_segments.total_contract_arr_cents`.\n',
          );
          currentSession.actions.push({
            target: 'wiki',
            type: 'created',
            key: 'account-segments',
            detail: 'Stale reconcile wiki page',
            rawPaths: ['cards/source.json'],
          });
          await currentSession.gitService.commitFiles(['wiki/global/account-segments.md'], 'reconcile wiki', 'KTX Test', 'system@ktx.local');
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);

      await expect(
        runner.run({ jobId: 'job-reconcile-stale', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/total_contract_arr_cents/);

      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-reconcile-stale/trace.jsonl'), 'utf-8');
      expect(trace).toContain('reconciliation_finished');
      expect(trace).toContain('final_artifact_gates_failed');
      expect(trace).toContain('ingest_failed');
      expect(await runtime.git.revParseHead()).not.toContain('reconcile wiki');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the failing reconciliation regression**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts -t "after reconciliation"
```

Expected: FAIL because the current runner gates before reconciliation and then
squashes the invalid reconciled page.

- [ ] **Step 3: Add final gate scope helpers to the runner**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, add these private
helpers after `touchedSlSourcesFromPaths()`:

```ts
  private touchedSlSourcesFromActions(actions: MemoryAction[], fallbackConnectionId: string): TouchedSlSource[] {
    return actions
      .filter((action) => action.target === 'sl')
      .map((action) => ({
        connectionId: actionTargetConnectionId(action, fallbackConnectionId),
        sourceName: action.key,
      }));
  }

  private wikiPageKeysFromActions(actions: MemoryAction[]): string[] {
    return actions.filter((action) => action.target === 'wiki').map((action) => action.key);
  }

  private uniqueWikiPageKeys(keys: string[]): string[] {
    return [...new Set(keys.filter((key) => key.length > 0))].sort();
  }

  private uniqueTouchedSlSources(sources: TouchedSlSource[]): TouchedSlSource[] {
    const seen = new Set<string>();
    const unique: TouchedSlSource[] = [];
    for (const source of sources) {
      const key = `${source.connectionId}:${source.sourceName}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(source);
    }
    return unique.sort((left, right) => {
      const byConnection = left.connectionId.localeCompare(right.connectionId);
      return byConnection === 0 ? left.sourceName.localeCompare(right.sourceName) : byConnection;
    });
  }
```

- [ ] **Step 4: Track integration mutations after WorkUnit patch integration**

In `runInner()` in `packages/context/src/ingest/ingest-bundle.runner.ts`, add
these variables before the Stage 4 reconciliation block:

```ts
      const preReconciliationSha = await sessionWorktree.git.revParseHead();
```

Remove the isolated-branch `traceTimed(... 'final_artifact_gates' ...)` block
that currently runs before the `else if (!overrideReport)` branch ends. Keep
per-patch `validateAppliedTree` in `integrateWorkUnitPatch()` unchanged.

- [ ] **Step 5: Run the final global gate after reconciliation, post-processing, and repair**

In `runInner()`, immediately after `wikiSlRefRepairResult = await
repairWikiSlRefs(...)` and before Stage 6 starts, add this block:

```ts
      const postReconciliationSha = await sessionWorktree.git.revParseHead();
      const postReconciliationPaths =
        preReconciliationSha && postReconciliationSha && preReconciliationSha !== postReconciliationSha
          ? (await sessionWorktree.git.diffNameStatus(preReconciliationSha, postReconciliationSha)).map((entry) => entry.path)
          : [];
      const finalChangedWikiPageKeys = this.uniqueWikiPageKeys([
        ...(isolatedDiffEnabled ? projectionChangedWikiPageKeys : []),
        ...workUnitOutcomes
          .flatMap((outcome) => outcome.patchTouchedPaths ?? [])
          .flatMap((path) => this.wikiPageKeysFromPaths([path])),
        ...this.wikiPageKeysFromActions(reconcileActions),
        ...postReconciliationPaths.flatMap((path) => this.wikiPageKeysFromPaths([path])),
        ...wikiSlRefRepairResult.repairs
          .filter((repair) => repair.scope === 'GLOBAL')
          .map((repair) => repair.pageKey),
      ]);
      const finalTouchedSlSources = this.uniqueTouchedSlSources([
        ...(isolatedDiffEnabled ? projectionTouchedSources : []),
        ...workUnitOutcomes.flatMap((outcome) => outcome.touchedSlSources),
        ...this.touchedSlSourcesFromActions(reconcileActions, job.connectionId),
        ...this.touchedSlSourcesFromPaths(postReconciliationPaths),
        ...(postProcessorOutcome?.touchedSources ?? []),
      ]);

      await traceTimed(
        runTrace,
        'final_gates',
        'final_artifact_gates',
        {
          changedWikiPageKeys: finalChangedWikiPageKeys,
          touchedSlSources: finalTouchedSlSources,
          preReconciliationSha,
          postReconciliationSha,
          postReconciliationPaths,
          reconciliationActionCount: reconcileActions.length,
          wikiSlRefRepairCount: wikiSlRefRepairResult.repairs.length,
        },
        async () => {
          await validateFinalIngestArtifacts({
            connectionIds: repairConnectionIds,
            changedWikiPageKeys: finalChangedWikiPageKeys,
            touchedSlSources: finalTouchedSlSources,
            wikiService: this.deps.wikiService.forWorktree(sessionWorktree.workdir),
            semanticLayerService: this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
            validateTouchedSources: (touched) =>
              validateWuTouchedSources(
                {
                  semanticLayerService: this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
                  connections: this.deps.connections,
                  configService: sessionWorktree.config,
                  gitService: sessionWorktree.git,
                  slSourcesRepository: this.deps.slSourcesRepository,
                  probeRowCount: this.deps.settings.probeRowCount,
                  slValidator: this.deps.slValidator,
                },
                touched,
              ),
            tableExists: (connectionId, tableRef) =>
              this.tableRefExistsInSemanticLayer(
                this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
                [connectionId],
                tableRef,
              ),
          });
        },
      );
```

Use the existing `projectionTouchedSources` and `projectionChangedWikiPageKeys`
variables from the isolated branch by declaring them before the branch instead
of inside it:

```ts
      let projectionTouchedSources: TouchedSlSource[] = [];
      let projectionChangedWikiPageKeys: string[] = [];
```

- [ ] **Step 6: Run the reconciliation regression**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts -t "after reconciliation"
```

Expected: PASS.

- [ ] **Step 7: Run isolated runner tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit final gate ordering**

```bash
git add packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts
git commit -m "fix(ingest): gate isolated final integration tree"
```

### Task 3: Complete persistent traces and failed-run surfacing

**Files:**
- Modify: `packages/context/src/ingest/reports.ts`
- Modify: `packages/context/src/ingest/report-snapshot.ts`
- Modify: `packages/context/src/ingest/report-snapshot.test.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`
- Modify: `packages/cli/src/ingest.ts`
- Modify: `packages/cli/src/ingest.test.ts`
- Modify: `docs-site/content/docs/cli-reference/ktx-ingest.mdx`

- [ ] **Step 1: Add failing report schema coverage for failed runs**

Append this test to `packages/context/src/ingest/report-snapshot.test.ts`:

```ts
  it('parses failed ingest reports with trace and failure details', () => {
    const snapshot = parseIngestReportSnapshot({
      id: 'report-failed',
      runId: 'run-failed',
      jobId: 'job-failed',
      connectionId: 'warehouse',
      sourceKey: 'metabase',
      createdAt: '2026-05-17T12:00:00.000Z',
      body: {
        status: 'failed',
        syncId: 'sync-failed',
        diffSummary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
        commitSha: null,
        tracePath: '/project/.ktx/ingest-traces/job-failed/trace.jsonl',
        failure: {
          phase: 'final_gates',
          message: 'final artifact gates failed',
        },
        workUnits: [],
        failedWorkUnits: [],
        reconciliationSkipped: true,
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
        evictionInputs: [],
        unresolvedCards: [],
        supersededBy: null,
        overrideOf: null,
        provenanceRows: [],
        toolTranscripts: [],
      },
    });

    expect(snapshot.body.status).toBe('failed');
    expect(snapshot.body.failure).toEqual({
      phase: 'final_gates',
      message: 'final artifact gates failed',
    });
    expect(snapshot.body.tracePath).toContain('trace.jsonl');
  });
```

- [ ] **Step 2: Run report snapshot test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/report-snapshot.test.ts -t "failed ingest reports"
```

Expected: FAIL because `status` and `failure` are not typed or parsed.

- [ ] **Step 3: Add report status and failure fields**

In `packages/context/src/ingest/reports.ts`, add this interface after
`IngestReportPostProcessorOutcome`:

```ts
export interface IngestReportFailure {
  phase: string;
  message: string;
}
```

Then add these fields to `IngestReportBody`:

```ts
  status?: 'completed' | 'failed';
  failure?: IngestReportFailure;
```

In `packages/context/src/ingest/report-snapshot.ts`, add this schema near the
other body field schemas:

```ts
const ingestReportFailureSchema = z.object({
  phase: z.string().min(1),
  message: z.string().min(1),
});
```

Then add these fields to the `body` object schema:

```ts
        status: z.enum(['completed', 'failed']).optional(),
        failure: ingestReportFailureSchema.optional(),
```

- [ ] **Step 4: Run report snapshot tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/report-snapshot.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing CLI status test for failed reports**

In `packages/cli/src/ingest.test.ts`, add a test near the existing ingest
status tests:

```ts
  it('prints trace path and error status for stored failed ingest reports', async () => {
    const io = makeIo();
    const report = {
      id: 'report-failed',
      runId: 'run-failed',
      jobId: 'job-failed',
      connectionId: 'warehouse',
      sourceKey: 'metabase',
      createdAt: '2026-05-17T12:00:00.000Z',
      body: {
        status: 'failed',
        syncId: 'sync-failed',
        diffSummary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
        commitSha: null,
        tracePath: '/project/.ktx/ingest-traces/job-failed/trace.jsonl',
        failure: { phase: 'final_gates', message: 'final artifact gates failed' },
        workUnits: [],
        failedWorkUnits: [],
        reconciliationSkipped: true,
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
        evictionInputs: [],
        unresolvedCards: [],
        supersededBy: null,
        overrideOf: null,
        provenanceRows: [],
        toolTranscripts: [],
      },
    };

    await runKtxIngest(
      { command: 'status', projectDir: '/project', runId: 'run-failed', outputMode: 'plain', inputMode: 'disabled' },
      {
        loadProject: vi.fn().mockResolvedValue({ projectDir: '/project' }),
        getLocalIngestStatus: vi.fn().mockResolvedValue(report),
      } as never,
      io,
    );

    expect(io.stdout()).toContain('Trace: /project/.ktx/ingest-traces/job-failed/trace.jsonl');
    expect(io.stdout()).toContain('Status: error');
    expect(io.stdout()).toContain('Error: final artifact gates failed');
  });
```

Use the actual local test helpers in `packages/cli/src/ingest.test.ts`. If the
file names the command function or IO helper differently, keep the assertions
exactly as written and adapt only the helper calls.

- [ ] **Step 6: Update CLI rendering**

In `packages/cli/src/ingest.ts`, replace `reportStatus()` with:

```ts
function reportStatus(report: IngestReportSnapshot): 'done' | 'error' {
  return report.body.status === 'failed' || report.body.failedWorkUnits.length > 0 ? 'error' : 'done';
}
```

In `failedReportMessage()`, add this block before reading `failedCount`:

```ts
  if (report.body.status === 'failed' && report.body.failure?.message) {
    return sanitizeMemoryFlowError(report.body.failure.message);
  }
```

- [ ] **Step 7: Add failed-run report creation state to the runner**

In `runInner()` in `packages/context/src/ingest/ingest-bundle.runner.ts`, add
these helpers near `createTrace()`:

```ts
  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
```

Inside `runInner()`, immediately after `const trace = this.createTrace(job);`,
add:

```ts
    let activeTrace: IngestTraceWriter = trace;
    let activePhase = 'run';
    let runRow: Awaited<IngestRunsPort['create']> | null = null;
    let latestDiffSummary: IngestDiffSummary = { added: 0, modified: 0, deleted: 0, unchanged: 0 };
    let latestWorkUnits: WorkUnitOutcome[] = [];
    let latestFailedWorkUnits: string[] = [];
    let latestReconciliationSkipped = true;
    let latestIsolatedDiffSummary:
      | {
          enabled: boolean;
          integrationWorktreePath?: string;
          ingestionBaseSha?: string;
          projectionSha?: string | null;
          acceptedPatches: number;
          textualConflicts: number;
          semanticConflicts: number;
        }
      | undefined;
```

Replace the existing inner `const runRow = await this.deps.runs.create(...)`
with:

```ts
      runRow = await this.deps.runs.create({
        jobId: job.jobId,
        connectionId: job.connectionId,
        sourceKey: job.sourceKey,
        syncId,
        trigger: job.trigger,
        scopeFingerprint: scopeDescriptor?.fingerprint ?? null,
      });
```

After creating `runTrace`, set:

```ts
      activeTrace = runTrace;
```

After computing `diffSummary`, set:

```ts
      latestDiffSummary = diffSummary;
```

After `workUnitOutcomes.push(...)`, set:

```ts
        latestWorkUnits = workUnitOutcomes;
        latestFailedWorkUnits = failedWorkUnits;
```

After `isolatedDiffSummary` is created, set:

```ts
      latestIsolatedDiffSummary = isolatedDiffSummary;
```

After reconciliation finishes, set:

```ts
      latestReconciliationSkipped = reconcileOutcome.skipped;
```

In the success `reportBody`, add:

```ts
        status: 'completed' as const,
```

In the outer `catch`, replace the existing trace event with:

```ts
      await activeTrace.event(
        'error',
        'run',
        'ingest_failed',
        {
          tracePath: activeTrace.tracePath,
          phase: activePhase,
          runId: runRow?.id ?? null,
          syncId,
        },
        error,
      );
      if (runRow) {
        await this.deps.reports.create({
          runId: runRow.id,
          jobId: job.jobId,
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          body: {
            status: 'failed' as const,
            syncId,
            diffSummary: latestDiffSummary,
            commitSha: null,
            tracePath: activeTrace.tracePath,
            isolatedDiff: latestIsolatedDiffSummary,
            failure: {
              phase: activePhase,
              message: this.errorMessage(error),
            },
            workUnits: latestWorkUnits.map((wu) => ({
              unitKey: wu.unitKey,
              rawFiles: [],
              status: wu.status,
              reason: wu.reason,
              actions: wu.actions,
              touchedSlSources: wu.touchedSlSources,
              slDisallowed: wu.slDisallowed,
              slDisallowedReason: wu.slDisallowedReason,
            })),
            failedWorkUnits: latestFailedWorkUnits,
            reconciliationSkipped: latestReconciliationSkipped,
            conflictsResolved: [],
            evictionsApplied: [],
            unmappedFallbacks: [],
            artifactResolutions: [],
            evictionInputs: [],
            reconciliationActions: [],
            evictionDecisions: [],
            unresolvedCards: [],
            supersededBy: null,
            overrideOf: null,
            provenanceRows: [],
            toolTranscripts: Array.from(transcriptSummaries.values()).map((summary) => ({
              unitKey: summary.unitKey,
              path: summary.path,
              toolCallCount: summary.toolCallCount,
              errorCount: summary.errorCount,
              toolNames: Array.from(summary.toolNames).sort(),
            })),
          },
        });
        await activeTrace.event('info', 'report', 'failure_report_created', {
          runId: runRow.id,
          jobId: job.jobId,
          tracePath: activeTrace.tracePath,
        });
      }
      throw error;
```

At each major phase, assign `activePhase` before work begins:

```ts
      activePhase = 'fetch';
      activePhase = 'stage_raw_files';
      activePhase = 'diff';
      activePhase = 'detect';
      activePhase = 'planning';
      activePhase = 'work_units';
      activePhase = 'integration';
      activePhase = 'reconciliation';
      activePhase = 'post_processor';
      activePhase = 'wiki_sl_ref_repair';
      activePhase = 'final_gates';
      activePhase = 'squash';
      activePhase = 'provenance';
      activePhase = 'report';
```

- [ ] **Step 8: Add trace timing and decision events for missing phases**

Wrap these existing operations in `traceTimed()` and include the listed data:

```ts
      activePhase = 'fetch';
      const stagedDir = await traceTimed(trace, 'fetch', 'resolve_staged_dir', {
        bundleRefKind: job.bundleRef.kind,
        sourceKey: job.sourceKey,
      }, () =>
        overrideReport
          ? this.materializeOverrideSnapshot(overrideReport, {
              connectionId: job.connectionId,
              sourceKey: job.sourceKey,
              jobId: job.jobId,
            })
          : this.resolveStagedDir(job.bundleRef, {
              connectionId: job.connectionId,
              sourceKey: job.sourceKey,
              jobId: job.jobId,
            }),
      );
```

Add explicit events after decisions:

```ts
      await runTrace.event('debug', 'detect', 'adapter_detected', { detected });
      await runTrace.event('debug', 'planning', 'work_units_planned', {
        workUnitCount: workUnits.length,
        evictionCount: eviction?.deletedRawPaths.length ?? 0,
        unresolvedCardCount: unresolvedCards?.length ?? 0,
        triageEnabled: triageResult?.enabled ?? false,
      });
      await runTrace.event('debug', 'planning', 'target_connections_resolved', {
        connectionIds: slConnectionIds,
      });
      await runTrace.event('debug', 'reconciliation', 'reconciliation_finished', {
        skipped: reconcileOutcome.skipped,
        stopReason: reconcileOutcome.stopReason ?? null,
        actionCount: reconcileActions.length,
        conflictCount: stageIndex.conflictsResolved.length,
        fallbackCount: stageIndex.unmappedFallbacks.length,
        artifactResolutionCount: stageIndex.artifactResolutions?.length ?? 0,
      });
      await runTrace.event('debug', 'post_processor', 'post_processor_finished', {
        sourceKey: job.sourceKey,
        status: postProcessorOutcome?.status ?? 'skipped',
        touchedSources: postProcessorOutcome?.touchedSources ?? [],
        warnings: postProcessorOutcome?.warnings ?? [],
      });
      await runTrace.event('debug', 'wiki_sl_ref_repair', 'wiki_sl_refs_repaired', {
        repairCount: wikiSlRefRepairResult.repairs.length,
        repairs: wikiSlRefRepairResult.repairs,
        warnings: wikiSlRefRepairResult.warnings,
      });
      await runTrace.event('debug', 'provenance', 'provenance_rows_validated', {
        rowCount: provenanceRows.length,
      });
      await runTrace.event('debug', 'squash', 'squash_finished', {
        commitSha,
        touchedPaths: mergeResult.touchedPaths,
      });
      await runTrace.event('debug', 'report', 'success_report_created', {
        reportId,
        runId: runRow.id,
        tracePath: runTrace.tracePath,
      });
```

Acceptance criteria for this step:

- A successful isolated run trace contains phase events for `fetch`,
  `snapshot`, `routing`, `planning`, `work_unit`, `integration`,
  `reconciliation`, `final_gates`, `squash`, `provenance`, `report`, and
  `run`.
- A failed isolated run trace contains an `ingest_failed` event with `runId`,
  `syncId`, `phase`, `tracePath`, and serialized error details.
- Failed runs after `runRow` creation have a stored report whose body includes
  `status: "failed"`, `failure.phase`, `failure.message`, and `tracePath`.

- [ ] **Step 9: Add isolated trace completeness test**

Append this test to `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`:

```ts
  it('stores a failure report and postmortem trace for final gate failures', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      const createdReports: any[] = [];
      deps.reports.create = vi.fn(async (args: any) => {
        createdReports.push(args);
        return { id: `report-${createdReports.length}` };
      });
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'card-wiki', rawFiles: ['cards/wiki.json'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'card-source', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        if (params.telemetryTags.unitKey === 'card-wiki') {
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(
            join(root, 'wiki/global/account-segments.md'),
            '---\nsummary: Account segments\nusage_mode: auto\nsl_refs:\n  - mart_account_segments\n---\n\nARR is `mart_account_segments.total_contract_arr_cents`.\n',
          );
          currentSession.actions.push({ target: 'wiki', type: 'created', key: 'account-segments', detail: 'Account segments', rawPaths: ['cards/wiki.json'] });
          await currentSession.gitService.commitFiles(['wiki/global/account-segments.md'], 'wu wiki', 'KTX Test', 'system@ktx.local');
        }
        if (params.telemetryTags.unitKey === 'card-source') {
          await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
          await writeFile(
            join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
            'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
          );
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
          currentSession.actions.push({ target: 'sl', type: 'created', key: 'mart_account_segments', detail: 'Dollar measure', targetConnectionId: 'warehouse', rawPaths: ['cards/source.json'] });
          await currentSession.gitService.commitFiles(['semantic-layer/warehouse/mart_account_segments.yaml'], 'wu source', 'KTX Test', 'system@ktx.local');
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['cards/wiki.json', 'h1'],
        ['cards/source.json', 'h2'],
      ]);

      await expect(
        runner.run({ jobId: 'job-trace-failure', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/total_contract_arr_cents/);

      const failureReport = createdReports.find((report) => report.body.status === 'failed');
      expect(failureReport.body.tracePath).toContain('job-trace-failure/trace.jsonl');
      expect(failureReport.body.failure).toMatchObject({ phase: 'final_gates' });

      const events = (await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-trace-failure/trace.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
        'ingest_started',
        'input_snapshot',
        'work_units_planned',
        'isolated_diff_enabled',
        'work_unit_child_created',
        'work_unit_patch_collected',
        'patch_apply_started',
        'patch_accepted',
        'reconciliation_finished',
        'final_artifact_gates_failed',
        'ingest_failed',
        'failure_report_created',
      ]));
      const failed = events.find((event) => event.event === 'ingest_failed');
      expect(failed).toMatchObject({
        runId: 'run-1',
        syncId: expect.any(String),
        data: { phase: 'final_gates', tracePath: expect.stringContaining('trace.jsonl') },
        error: { message: expect.stringContaining('total_contract_arr_cents') },
      });
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 10: Run context and CLI trace tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/report-snapshot.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts
pnpm --filter @ktx/cli exec vitest run src/ingest.test.ts -t "failed ingest reports"
```

Expected: PASS.

- [ ] **Step 11: Update trace inspection docs**

In `docs-site/content/docs/cli-reference/ktx-ingest.mdx`, replace the paragraph
under "Inspect source ingest traces" that starts with "Each line is a JSON
event" with:

```mdx
The trace file lives under the project directory at
`.ktx/ingest-traces/<jobId>/trace.jsonl`. Each line is a JSON event with the
job id, run id, sync id, connection id, source key, phase, event name, timing,
state snapshot, decision context, and error details. Failed runs also write a
stored ingest report with `status: "failed"`, `failure.phase`,
`failure.message`, and the same trace path, so `ktx ingest status <runId>` can
point you to the postmortem trace.
```

- [ ] **Step 12: Commit trace and failure report work**

```bash
git add packages/context/src/ingest/reports.ts \
  packages/context/src/ingest/report-snapshot.ts \
  packages/context/src/ingest/report-snapshot.test.ts \
  packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  packages/cli/src/ingest.ts \
  packages/cli/src/ingest.test.ts \
  docs-site/content/docs/cli-reference/ktx-ingest.mdx
git commit -m "fix(ingest): persist postmortem failure traces"
```

### Task 4: Structured policy conflicts and child cleanup

**Files:**
- Modify: `packages/context/src/ingest/isolated-diff/work-unit-executor.test.ts`
- Modify: `packages/context/src/ingest/isolated-diff/work-unit-executor.ts`
- Modify: `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`
- Modify: `packages/context/src/ingest/isolated-diff/patch-integrator.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`

- [ ] **Step 1: Add failing child cleanup test**

Append this test to `packages/context/src/ingest/isolated-diff/work-unit-executor.test.ts`:

```ts
  it('removes child worktrees after failed WorkUnit outcomes are traced', async () => {
    const { homeDir, git, baseSha } = await makeGit();
    const childDir = join(homeDir, '.worktrees/session-job-1-wu-fail');
    const sessionWorktreeService = {
      create: vi.fn(async (_key: string, startSha: string) => {
        await mkdir(join(homeDir, '.worktrees'), { recursive: true });
        await git.addWorktree(childDir, 'session/job-1-wu-fail', startSha);
        return {
          chatId: 'job-1-wu-fail',
          workdir: childDir,
          branch: 'session/job-1-wu-fail',
          baseSha: startSha,
          createdAt: new Date(),
          git: git.forWorktree(childDir),
          config: {},
        };
      }),
      cleanup: vi.fn(async () => undefined),
    };
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-1/trace.jsonl'),
      jobId: 'job-1',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await runIsolatedWorkUnit({
      unitIndex: 0,
      ingestionBaseSha: baseSha,
      sessionWorktreeService: sessionWorktreeService as never,
      patchDir: join(homeDir, '.ktx/ingest-patches/job-1'),
      trace,
      run: async () => ({
        unitKey: 'wu-fail',
        status: 'failed',
        reason: 'agent loop errored',
        preSha: baseSha,
        postSha: baseSha,
        actions: [],
        touchedSlSources: [],
      }),
      workUnit: { unitKey: 'wu-fail', rawFiles: ['a.json'], peerFileIndex: [], dependencyPaths: [] },
    });

    expect(result.status).toBe('failed');
    expect(sessionWorktreeService.cleanup).toHaveBeenCalledWith(expect.any(Object), 'success');
  });
```

- [ ] **Step 2: Run child cleanup test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/work-unit-executor.test.ts -t "failed WorkUnit"
```

Expected: FAIL because failed WorkUnits call `cleanup(..., 'crash')`.

- [ ] **Step 3: Cleanup child worktrees on failed outcomes and collect patch metadata only**

In `packages/context/src/ingest/isolated-diff/work-unit-executor.ts`, replace
the import:

```ts
import { assertPatchAllowedForWorkUnit } from './git-patch.js';
```

with:

```ts
import { parsePatchTouchedPaths } from './git-patch.js';
```

Then replace this failed-outcome block:

```ts
    if (outcome.status !== 'success') {
      cleanupOutcome = 'crash';
      await input.trace.event('error', 'work_unit', 'work_unit_failed_before_patch', {
        unitKey: input.workUnit.unitKey,
        reason: outcome.reason ?? 'unknown failure',
      });
      return { ...outcome, childWorktreePath: child.workdir };
    }
```

with:

```ts
    if (outcome.status !== 'success') {
      cleanupOutcome = 'success';
      await input.trace.event('error', 'work_unit', 'work_unit_failed_before_patch', {
        unitKey: input.workUnit.unitKey,
        reason: outcome.reason ?? 'unknown failure',
      });
      return { ...outcome, childWorktreePath: child.workdir };
    }
```

Replace patch policy enforcement:

```ts
    const touched = assertPatchAllowedForWorkUnit({
      unitKey: input.workUnit.unitKey,
      patch,
      slDisallowed: input.workUnit.slDisallowed === true,
    });
```

with:

```ts
    const touched = parsePatchTouchedPaths(patch);
```

In the `catch` block, set `cleanupOutcome = 'success'` after the error is
traced:

```ts
    cleanupOutcome = 'success';
```

- [ ] **Step 4: Run child cleanup tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/work-unit-executor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add failing policy rejection trace test**

Append this test to `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`:

```ts
  it('classifies slDisallowed patch policy failures as traced textual conflicts', async () => {
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    await mkdir(join(configDir, 'semantic-layer/c1'), { recursive: true });
    await git.commitFiles(['semantic-layer/c1'], 'empty sl dir', 'System User', 'system@example.com');
    const childDir = join(homeDir, 'child-policy');
    await git.addWorktree(childDir, 'child-policy', baseSha);
    const childGit = git.forWorktree(childDir);
    await mkdir(join(childDir, 'semantic-layer/c1'), { recursive: true });
    await writeFile(join(childDir, 'semantic-layer/c1/orders.yaml'), 'name: orders\ncolumns: []\njoins: []\nmeasures: []\n');
    await childGit.commitFiles(['semantic-layer/c1/orders.yaml'], 'forbidden sl', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/forbidden.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-policy/trace.jsonl'),
      jobId: 'job-policy',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'lookml-mismatch',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'KTX Test', email: 'system@ktx.local' },
      validateAppliedTree: vi.fn().mockResolvedValue(undefined),
      slDisallowed: true,
    });

    expect(result).toMatchObject({
      status: 'textual_conflict',
      touchedPaths: ['semantic-layer/c1/orders.yaml'],
    });
    const rawTrace = await readFile(trace.tracePath, 'utf-8');
    expect(rawTrace).toContain('patch_policy_rejected');
    expect(rawTrace).toContain('slDisallowed WorkUnit lookml-mismatch touched semantic-layer/c1/orders.yaml');
  });
```

- [ ] **Step 6: Run policy rejection test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/patch-integrator.test.ts -t "policy failures"
```

Expected: FAIL because policy rejection throws before a structured result.

- [ ] **Step 7: Classify policy rejections in the integrator**

In `packages/context/src/ingest/isolated-diff/patch-integrator.ts`, add
`parsePatchTouchedPaths` to the import from `git-patch.js`:

```ts
import { assertPatchAllowedForWorkUnit, parsePatchTouchedPaths } from './git-patch.js';
```

Replace lines that read and assert the patch with:

```ts
  const patch = await readFile(input.patchPath, 'utf-8');
  const touchedPaths = parsePatchTouchedPaths(patch).map((entry) => entry.path);
  try {
    assertPatchAllowedForWorkUnit({
      unitKey: input.unitKey,
      patch,
      slDisallowed: input.slDisallowed,
    });
  } catch (error) {
    await input.trace.event('error', 'integration', 'patch_policy_rejected', {
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      touchedPaths,
      reason: errorMessage(error),
    });
    return {
      status: 'textual_conflict',
      reason: errorMessage(error),
      touchedPaths,
    };
  }
```

Keep the existing `patch_apply`, `patch_textual_conflict`,
`semantic_gate`, and `patch_semantic_conflict` blocks unchanged.

- [ ] **Step 8: Update isolated slDisallowed regression expectations**

In `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`,
replace the `slDisallowed` rejection assertion with:

```ts
      await expect(
        runner.run({ jobId: 'job-sl-disallowed', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/isolated diff textual conflict/);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-sl-disallowed/trace.jsonl'), 'utf-8');
      expect(trace).toContain('patch_policy_rejected');
      expect(trace).toContain('slDisallowed WorkUnit lookml-mismatch touched semantic-layer/warehouse/orders.yaml');
```

- [ ] **Step 9: Run policy and isolated tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/isolated-diff/work-unit-executor.test.ts \
  src/ingest/isolated-diff/patch-integrator.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit policy and cleanup fixes**

```bash
git add packages/context/src/ingest/isolated-diff/work-unit-executor.ts \
  packages/context/src/ingest/isolated-diff/work-unit-executor.test.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.test.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts
git commit -m "fix(ingest): trace policy conflicts and cleanup child worktrees"
```

### Task 5: Final verification

**Files:**
- Verify: all files modified in Tasks 1-4

- [ ] **Step 1: Run focused context tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/ingest-trace.test.ts \
  src/ingest/wiki-body-refs.test.ts \
  src/ingest/artifact-gates.test.ts \
  src/ingest/isolated-diff/git-patch.test.ts \
  src/ingest/isolated-diff/work-unit-executor.test.ts \
  src/ingest/isolated-diff/patch-integrator.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  src/ingest/report-snapshot.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused CLI tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run package type checks**

Run:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 4: Run dead-code check because TypeScript exports and report fields changed**

Run:

```bash
pnpm run dead-code
```

Expected: PASS.

- [ ] **Step 5: Run pre-commit for touched files**

Run:

```bash
uv run pre-commit run --files \
  packages/context/src/ingest/wiki-body-refs.ts \
  packages/context/src/ingest/wiki-body-refs.test.ts \
  packages/context/src/ingest/artifact-gates.ts \
  packages/context/src/ingest/artifact-gates.test.ts \
  packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  packages/context/src/ingest/isolated-diff/work-unit-executor.ts \
  packages/context/src/ingest/isolated-diff/work-unit-executor.test.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.test.ts \
  packages/context/src/ingest/reports.ts \
  packages/context/src/ingest/report-snapshot.ts \
  packages/context/src/ingest/report-snapshot.test.ts \
  packages/cli/src/ingest.ts \
  packages/cli/src/ingest.test.ts \
  docs-site/content/docs/cli-reference/ktx-ingest.mdx
```

Expected: PASS. If the local `uv` version does not satisfy the repository pin,
record the version mismatch and run the focused `pnpm` checks above.

- [ ] **Step 6: Inspect one failed trace manually**

Run the final-gate failure test and inspect the trace:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  -t "postmortem trace"
```

Open the trace path printed in the assertion failure output or the test temp
directory if the test logs it. The trace must let a human reconstruct:

- the job, run, sync, source, connection, and input snapshot;
- routing into isolated diffs;
- WorkUnit child creation, patch collection, patch application, and accepted
  patch order;
- reconciliation status and action counts;
- final gate input scope and failure reason;
- failure report creation; and
- final `ingest_failed` event with phase and serialized error.

- [ ] **Step 7: Inspect git status**

Run:

```bash
git status --short
```

Expected: only intended source, test, CLI, and docs files are modified before
the final commit.

- [ ] **Step 8: Commit verification updates if any**

If test or docs edits were needed during verification:

```bash
git add packages/context/src/ingest packages/cli/src/ingest.ts packages/cli/src/ingest.test.ts docs-site/content/docs/cli-reference/ktx-ingest.mdx
git commit -m "test(ingest): verify isolated diff postmortem coverage"
```

If no files changed during verification, do not create an empty commit.

## Self-Review

Spec coverage:

- Isolated WorkUnits and binary no-rename patches are already implemented in
  the previous plan. Task 4 moves policy rejection to the integration layer and
  keeps child cleanup aligned with the spec.
- Artifact-aware gates are completed by Task 1 for semantic-layer YAML, wiki
  frontmatter source/entity refs, wiki body refs, and direct join dependencies.
- The final global gate moves to the correct point in Task 2, after
  reconciliation, post-processing, and wiki repair, and before squash.
- Reconciliation mutation tracking is added in Task 2 through a diff from
  pre-reconciliation `HEAD` to post-repair `HEAD`.
- Persistent postmortem observability is completed by Task 3 with trace events,
  timings, state snapshots, stored failure reports, and CLI status surfacing.
- Version-one resolver behavior remains fail-fast and preserves the integration
  worktree on conflicts.

Placeholder scan:

- The plan contains no placeholder tasks.
- Each code-changing step includes concrete code or exact replacement blocks.
- Verification commands and expected outcomes are explicit.

Type consistency:

- New report fields are named `status` and `failure` consistently in
  `reports.ts`, `report-snapshot.ts`, runner report bodies, and CLI rendering.
- Final gate scope uses existing `TouchedSlSource`, `MemoryAction`,
  `WorkUnitOutcome`, and `WikiSlRefRepairResult` types.
- Trace event names are stable and asserted by tests:
  `reconciliation_finished`, `final_artifact_gates_failed`,
  `failure_report_created`, `patch_policy_rejected`, and `ingest_failed`.
