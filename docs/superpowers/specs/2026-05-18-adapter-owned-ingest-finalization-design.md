# Adapter-owned ingest finalization design

**Date:** 2026-05-18
**Author:** Andrey Avtomonov
**Status:** Design - pending implementation plan

## Background

The isolated-diff ingestion migration made KTX's shared bundle runner
responsible for one durable execution model: stage raw source data, run
source-planned work units in isolated child worktrees, integrate their diffs,
reconcile, run final gates, and squash the accepted integration tree back into
the project worktree.

That direction is correct, but the current code still has a runner-level
post-processing extension point. `IngestBundleRunnerDeps.postProcessors` maps a
source key to an arbitrary `IngestBundlePostProcessorPort`, and local runtime
wires `historic-sql` to `HistoricSqlProjectionPostProcessor`. That path can
write durable semantic-layer and wiki artifacts after work-unit integration and
reconciliation, outside the source adapter contract.

Historic SQL exposed why the extra path exists. Its table and pattern work units
emit typed evidence, then a deterministic projection step merges the evidence
into `_schema` usage and historic-SQL wiki pages. Some of that work is local to
one work unit, but other behavior is whole-run maintenance: marking stale table
usage, reusing existing pattern pages, and archiving old pattern pages. Those
aggregate decisions do not fit cleanly inside independent per-work-unit writes.

The design goal is to preserve legitimate adapter-owned deterministic
maintenance without keeping a generic runner-level escape hatch.

## Goals

This design tightens the isolated-diff architecture around a stable boundary:
the generic runner owns execution mechanics, and adapters own source semantics.

The design has these goals:

- Remove runner-level `postProcessors` as an alternate durable-write pipeline.
- Add a first-class `SourceAdapter.finalize?()` hook for deterministic
  post-work-unit source maintenance.
- Keep `finalize?()` constrained, observable, and subject to the same final
  validation gates as work-unit and reconciliation changes.
- Preserve historic-SQL aggregate projection behavior without treating it as a
  hidden fallback ingestion path.
- Keep public execution knobs out of the adapter API.

## Non-goals

This design does not rework source-specific chunking, fetch formats, wiki page
frontmatter, semantic-layer YAML, or raw source layouts. It does not replace
agent-authored work units with deterministic projectors. It also does not add a
public `executionMode`, `planningStrategy`, `conflictPolicy`, or source-key
allowlist.

Override ingest remains a special correction operation that reuses a prior raw
snapshot and forces reconciliation. It should be documented and tested as
override replay, not as a fallback pipeline. This design does not require
override ingest to run source work units.

## Locked design direction

The shared ingestion runner keeps one ordered pipeline for sources that can
write durable project artifacts.

```text
fetch raw
  -> adapter plans WorkUnit[]
  -> optional adapter project
  -> isolated WU diffs
  -> artifact-aware integration
  -> reconciliation
  -> optional adapter finalize
  -> runner wiki-SL-ref repair
  -> final target policy and artifact gates
  -> squash
```

The exact implementation may continue to call `chunk()` before `project()` so a
projector can consume `parseArtifacts`. The architectural invariant is that
`project()` runs in the integration worktree before child worktrees start, while
`finalize()` runs in the integration worktree after accepted work-unit and
reconciliation changes are present.

Adapters decide what source-specific work belongs in `project()`, work units,
or `finalize()`. The runner decides when those phases run, captures their git
effects, enforces target scope, runs gates, writes traces and reports, and
squashes the final tree.

## Adapter API

The source adapter contract should make deterministic source phases explicit.

```ts
interface SourceAdapter {
  readonly source: string;
  readonly skillNames: string[];
  readonly reconcileSkillNames?: string[];
  readonly evidenceIndexing?: 'documents';
  readonly triageSupported?: boolean;

  getTriageSignals?(stagedDir: string, externalId: string): Promise<TriageSignals>;
  detect(stagedDir: string): Promise<boolean>;
  fetch?(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void>;
  readFetchReport?(stagedDir: string): Promise<SourceFetchReport | null>;
  listTargetConnectionIds?(stagedDir: string): Promise<string[]>;
  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult>;
  clusterWorkUnits?(ctx: ClusterWorkUnitsContext): Promise<WorkUnit[]>;
  project?(ctx: DeterministicProjectionContext): Promise<ProjectionResult>;
  finalize?(ctx: DeterministicFinalizationContext): Promise<FinalizationResult>;
  describeScope?(stagedDir: string): Promise<ScopeDescriptor>;
  onPullSucceeded?(ctx: PullSucceededContext): Promise<void>;
}
```

`finalize?()` is not a compatibility wrapper for old post-processors. It is a
source-adapter method with a fixed location in the runner lifecycle.

```ts
interface DeterministicFinalizationContext {
  connectionId: string;
  sourceKey: string;
  syncId: string;
  jobId: string;
  runId: string;
  stagedDir: string;
  workdir: string;
  parseArtifacts?: unknown;
  stageIndex: StageIndex;
  workUnitOutcomes: WorkUnitOutcome[];
  reconciliationActions: MemoryAction[];
  overrideReplay?: FinalizationOverrideReplay;
}

interface FinalizationResult {
  warnings: string[];
  errors: string[];
  touchedSources: TouchedSlSource[];
  changedWikiPageKeys: string[];
  actions?: MemoryAction[];
  result?: unknown;
}

interface FinalizationOverrideReplay {
  priorJobId: string;
  priorRunId: string;
  priorSyncId: string;
  evictionRawPaths: string[];
}
```

The implementation plan can adjust exact type names to match the existing
module layout, but the contract must preserve these semantics:

- `finalize?()` is deterministic TypeScript code, not an agent loop.
- It runs only in the ingestion integration worktree.
- It may write ordinary durable project files.
- It must report the semantic-layer sources and wiki page keys it believes it
  touched so the runner can verify that declaration against the worktree diff.
- Outside override replay, `stageIndex` is the canonical runner index for
  accepted work-unit actions, touched sources, evictions, reconciliation records,
  and artifact resolutions visible to the current run.
- In override replay, `stageIndex` is a prior-run replay index for work-unit
  facts. It may contain prior-run work-unit actions, touched sources, and
  artifact records, and adapters must not treat those entries as current-run
  evidence. The runner must not replay prior-report `evictionsApplied` as
  current-run eviction evidence. If override reconciliation records eviction
  decisions, those records are fresh current-run `stageIndex.evictionsApplied`
  entries.
- `workUnitOutcomes` contains only work units executed in the current run. It
  is empty when override replay skips source work units.
- `reconciliationActions` contains only accepted reconciliation writes emitted
  through the reconciliation tool session in the current run. These actions have
  already mutated the integration worktree.
- `overrideReplay` being present is the canonical signal that source work units
  did not produce current-run evidence unless another context field explicitly
  carries fresh current-run deterministic input.
- `overrideReplay.evictionRawPaths` contains the deleted raw paths loaded from
  the prior report's `evictionInputs` for the reused raw snapshot. It is the
  only override-replay raw-path allowlist for removed-from-snapshot provenance.
  It is not, by itself, proof that a particular durable artifact is stale or was
  observed by current-run work units.
- `actions` in `FinalizationResult` are descriptive records for finalization
  writes that the adapter already performed. The runner must not re-apply them.
  When finalization actions are intended to create provenance rows, they must
  carry defensible `rawPaths`: current-snapshot paths from the current raw
  snapshot, removed-from-snapshot paths from current-run
  `stageIndex.evictionsApplied`, or removed-from-snapshot paths from
  `overrideReplay.evictionRawPaths` when override replay is present.
  Finalization actions without defensible raw-path attribution are still
  reported, but the runner must exclude them from provenance and surface that
  exclusion explicitly.
- It cannot mutate the main project worktree directly.
- The finalization context must not pass a root-scoped service that can bypass
  the integration worktree. `workdir` is the durable write boundary. If a future
  helper is added to the context, the contract must name it as worktree-scoped
  and state whether it is read-only or allowed to write.

The existing adapter API fields unrelated to deterministic projection and
finalization remain part of the contract. Adding `finalize?()` must not remove
triage or evidence-indexing support.

## Override replay

Override ingest remains a replay of a prior raw snapshot with forced
reconciliation. It does not execute source work units or call `adapter.chunk()`
in this design, so finalization must not silently assume fresh work-unit
evidence exists.

The runner should still enter the finalization phase for adapters that
implement `finalize?()`, but it must pass explicit override metadata. In that
mode, `workUnitOutcomes` is empty, `parseArtifacts` is absent,
`overrideReplay.evictionRawPaths` is populated from the prior report's
`evictionInputs`, `stageIndex` comes from the prior report with prior
`evictionsApplied` excluded, and `reconciliationActions` contains only new
override reconciliation actions.

If a future implementation intentionally re-parses the materialized override
raw snapshot, it must expose that fact through an explicit override-safe context
field instead of relying on `parseArtifacts` alone. `parseArtifacts` by itself
is never current work-unit evidence in override replay and never authorizes
historic-SQL whole-run cleanup.

Adapters must treat missing current-run deterministic inputs as a no-op, not as
negative evidence. For historic SQL, override replay must not mark tables stale,
mark pattern pages stale, or archive pattern pages from an empty current-run
evidence directory. Whole-run cleanup can run only when `overrideReplay` is
absent and current-run work-unit evidence exists, or when a future explicit
override-safe context field names equivalent facts. Any override-safe
finalization must be derived from the materialized raw snapshot or explicit
prior-report data. In particular, prior-run
`stageIndex.workUnits[*].actions`, prior-run touched sources, and prior-run
artifact records are not proof that the current override run observed or failed
to observe those artifacts.

## Runner responsibilities

The runner owns all reusable mechanics around `finalize?()`.

After reconciliation completes, the runner calls `adapter.finalize?()` if it
exists. The runner captures the pre-finalization commit, derives the
finalization changed paths from the integration-worktree git diff, commits those
changes, records the commit SHA and touched paths in the run trace/report,
includes finalization actions in saved-memory counts, and runs wiki-SL-ref
repair before final target-policy and artifact gates.

The integration-worktree diff is the source of truth for finalization touched
paths, changed wiki page keys, and semantic-layer paths. The adapter's
`touchedSources` and `changedWikiPageKeys` declaration is a verification input,
not the downstream authority. The runner must derive the final repair and gate
scope from the diff, cross-check the adapter declaration against that diff, and
fail the run on under-reporting or over-reporting that would make wiki-SL-ref
repair, target-policy checks, final gates, reports, traces, or provenance use a
different artifact set from the actual finalization commit.

The runner-derived semantic-layer scope must include logical
`TouchedSlSource` tuples, not only file paths. Standalone semantic-layer files
under `semantic-layer/<connectionId>/<sourceName>.yaml` can map structurally to
`{ connectionId, sourceName }`. Aggregate semantic-layer files, including
`semantic-layer/<connectionId>/_schema/*.yaml`, must be resolved by comparing
the pre-finalization and post-finalization materialized semantic-layer sources
with the worktree-scoped semantic-layer parser/loader. Wiki page keys continue
to map structurally from `wiki/global/<pageKey>.md`. If the runner cannot
resolve a changed semantic-layer path to logical touched sources with its own
resolver, the run must fail; it must not fall back to the adapter declaration as
the downstream scope.

`wiki_sl_ref_repair` remains a runner mechanic, not an adapter method. It runs
after finalization and before final gates, and it uses the normal target
connection set plus the runner-derived finalization touched sources to decide
which semantic-layer references are visible. Its writes are part of the same
integration worktree diff as finalization/reconciliation, so target-policy
checks, final artifact gates, reports, traces, and squash behavior cover those
writes before changes reach the main project worktree.

The runner must treat finalization like deterministic projection and
reconciliation, not like a free-form source-key plug-in. It must enforce the
same target-connection policy used for work-unit and reconciliation changes.
If finalization writes an unauthorized semantic-layer target, modifies artifacts
outside the authorized target set, references a missing semantic-layer entity, or
returns errors, the run fails before changes reach the main project worktree.

The runner should expose one trace phase named `finalization`. It should not
keep a `post_processor` stage, `IngestBundlePostProcessorPort`,
`deps.postProcessors`, or report fields that imply a parallel post-processor
pipeline.

## Adapter application

Each adapter continues to use the same generic runner mechanics, while keeping
source-specific choices inside the adapter.

- `metabase` fetches cards and dashboards, computes scope, plans
  card/dashboard work units, and usually does not need `project()` or
  `finalize()`.
- `notion` fetches pages, extracts triage signals, clusters page work units,
  and usually does not need deterministic finalization.
- `dbt` fetches the repository, parses dbt project metadata, plans model work
  units, and may later add `project()` if dbt YAML import becomes deterministic.
- `lookml` fetches LookML, produces validation artifacts, plans model and
  explore work units, and may later add `project()` for deterministic LookML to
  semantic-layer import.
- `looker` fetches runtime bundles, fetch reports, target connections, and
  triage signals. It continues to rely on work-unit diffs and shared gates.
- `metricflow` is the current strong `project()` example. It imports
  authoritative semantic models before child worktrees start, then lets any
  work units observe those projected files.
- `live-database` can remain work-unit based, but database schema introspection
  is a good future `project()` candidate because the schema is authoritative
  structured metadata.
- `historic-sql` should move current post-processor behavior into the adapter.
  Local table-usage and pattern-page writes may move into work-unit tools where
  they are genuinely per-unit. Whole-run maintenance such as stale table usage,
  pattern-page reuse, and stale/archive page decisions belongs in
  `HistoricSqlSourceAdapter.finalize()`.
- `fake` remains a test adapter and does not need deterministic phases.

## Historic-SQL migration

Historic SQL should stop using evidence-only tool output plus runner-level
post-processing as its durable projection path.

The preferred migration is:

1. Keep historic-SQL work units responsible for source-shaped analysis.
2. Use source-specific tools for per-unit durable writes when the output is
   local to that unit, such as a table's usage metadata or one pattern page.
3. Move whole-run deterministic cleanup into
   `HistoricSqlSourceAdapter.finalize()`.
4. Delete `HistoricSqlProjectionPostProcessor`, `IngestBundlePostProcessorPort`,
   `deps.postProcessors`, and `post_processor` memory-flow/report stages.

If the implementation keeps typed evidence as an internal handoff between
historic-SQL work units and `finalize()`, that evidence must be framed as
source-specific input to the adapter's deterministic finalization, not as a
generic runner post-processing mechanism. The evidence files must not become a
public compatibility surface.

Historic-SQL finalization must distinguish "no current-run evidence exists"
from "the current snapshot proves this artifact is stale." Whole-run cleanup
such as stale table usage, pattern-page staleness, and archive decisions can
run only when finalization has current-run historic-SQL evidence or an explicit
override-safe source of equivalent facts.

## Reports and observability

Reports should describe first-class pipeline phases, not historical extension
points. The isolated-diff summary should include finalization metadata when the
adapter implements `finalize?()`: whether it ran, finalization commit SHA,
touched paths, touched semantic-layer sources, changed wiki page keys,
warnings, descriptive finalization actions, and source-specific result payload.

Saved-memory counts should come from work-unit, reconciliation, and
finalization memory actions plus touched artifact reporting. Finalization
actions are reporting/provenance records for writes that already happened in
the integration worktree; they are not a second write channel. There should be
no special `postProcessorSavedMemoryCounts` or `postProcessor` report body.
Memory-flow phases should use `finalization` instead of `post_processor`.

The runner owns provenance for finalization. Adapters return touched artifacts
and optional descriptive actions, but they do not call the provenance port.
When finalization actions include valid `rawPaths`, the runner folds them into
the normal provenance plan using the current `sourceKey`, `syncId`, raw content
hashes, artifact kind, artifact key, target connection, and action type. The
finalization phase and commit SHA belong in trace/report metadata; they should
not be fabricated inside adapter-written files.

Finalization reports must show both the adapter-declared touched artifacts and
the runner-derived touched artifacts from the finalization git diff. When those
sets differ, the report and trace must include the mismatch and the run must
fail before wiki-SL-ref repair or final gates rely on the wrong scope. When a
finalization action is excluded from provenance because no defensible raw path
exists, the report must name the action and reason instead of silently dropping
it.

Traces must make finalization useful for postmortems. At minimum, record
`finalization_started`, `finalization_committed`, `finalization_skipped`, and
`finalization_failed` events with source key, touched paths, warnings, and
error summaries.

## Failure handling

Finalization failures are ingestion failures. If `finalize?()` returns errors,
throws, writes unauthorized targets, or causes final gates to fail, the runner
marks the run failed and leaves the main project worktree unchanged.

Finalization should run after reconciliation because it may need to inspect the
accepted work-unit and reconciliation result. Final gates should run after
finalization because finalization writes durable project artifacts.

Finalization must not be used to repair arbitrary integration conflicts or
rerun agent work. Conflict repair remains part of artifact-aware integration and
reconciliation.

Finalization must also preserve reconciliation and accepted work-unit writes
from the same run. The runner must remember the paths changed before
finalization and fail if `finalize?()` modifies the same path after
reconciliation. If a source needs deterministic maintenance for an artifact
created or edited by a work unit in the same run, that behavior belongs in the
source-specific work-unit tool or in a later run, not in post-reconciliation
finalization.

## Acceptance criteria

The implementation is complete when these conditions are true:

- No production runtime wiring references `deps.postProcessors`.
- `IngestBundlePostProcessorPort` and `HistoricSqlProjectionPostProcessor` are
  removed from source exports and package export tests.
- `SourceAdapter.finalize?()` exists with typed context and result objects.
- The runner invokes `finalize?()` after reconciliation and before final gates.
- Finalization changes are committed in the integration worktree and included
  in target-policy checks, final gates, reports, traces, and provenance inputs.
- Override replay passes explicit override metadata to finalization, including
  `overrideReplay.evictionRawPaths`; leaves `workUnitOutcomes` empty when work
  units are skipped; omits `parseArtifacts` unless a future explicit
  override-safe input is added; and proves historic-SQL finalization does not
  use prior-run `stageIndex` records as current-run evidence or stale/archive
  artifacts from missing current-run evidence.
- Finalization provenance uses current raw paths, current-run
  `stageIndex.evictionsApplied`, or `overrideReplay.evictionRawPaths`, and
  actions without defensible raw-path attribution are reported as excluded from
  provenance.
- The runner derives finalization touched paths, wiki page keys, and
  semantic-layer scope from the integration-worktree git diff, resolves
  aggregate semantic-layer files such as `_schema/*.yaml` to logical touched
  sources with the runner's own semantic-layer parser/loader, cross-checks the
  adapter's touched-artifact declaration, and fails on mismatches or
  unresolvable changed semantic-layer paths.
- The runner fails when finalization modifies a path already changed by accepted
  work-unit or reconciliation writes in the same run.
- `wiki_sl_ref_repair` remains a runner-owned step after finalization and
  before final gates, consumes runner-derived finalization touched sources, and
  has its writes covered by target-policy checks and final gates.
- Finalization `actions` are not re-applied by the runner; they are included
  only in reporting, saved-memory counts, and provenance planning when their
  raw-path attribution is valid.
- Historic SQL uses adapter-owned finalization for whole-run projection
  maintenance.
- Tests cover a successful finalization, a finalization failure, unauthorized
  finalization target rejection, override replay finalization behavior,
  wiki-SL-ref repair placement, and historic-SQL projection behavior without
  runner-level post-processors.
