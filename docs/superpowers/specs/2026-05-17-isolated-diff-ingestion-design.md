# Isolated-diff ingestion design

**Date:** 2026-05-17
**Author:** Andrey Avtomonov
**Status:** Design - pending implementation plan

## Background

KTX ingests third-party context sources into durable project memory: raw source
snapshots, wiki pages, semantic-layer sources, evidence documents, candidates,
and fallback records. The current bundle runner stages raw source data in one
ingestion session worktree, then runs work units against that same mutable
worktree.

A Metabase ingestion run exposed the failure mode this design addresses. One
work unit inferred and wrote the semantic-layer measure
`mart_account_segments.total_contract_arr_cents`, a later work unit overwrote
the same source with `total_contract_arr`, and the generated wiki page kept
referencing the stale non-existent measure. The local per-work-unit checks did
not catch the final cross-artifact inconsistency because durable writes were
accepted into shared state before final integration.

The fix is not a Metabase-only validation patch. The same class of risk exists
any time LLM-authored work units mutate durable wiki or semantic-layer files:
Metabase cards, Notion pages and clusters, dbt YAML, MetricFlow YAML, Looker
dashboards and explores, and LookML models and views can all produce overlapping
or contested memory artifacts. KTX needs one ingestion execution model that
isolates agent-authored changes, integrates them deliberately, and validates
the final project state globally.

## Goals

This design creates one opinionated ingestion algorithm for all context sources.
Connector-specific code stays responsible for source-shaped work: fetching raw
data, normalizing raw files, planning work units, and optionally projecting
deterministic facts. The shared runner owns execution correctness.

The design has these goals:

- Run all agent-authored durable writes in isolated per-work-unit worktrees.
- Treat each work unit's git diff as its proposal artifact.
- Integrate accepted diffs through a shared artifact-aware merge path.
- Run final global semantic gates before any changes reach the main project
  worktree.
- Keep connector variance minimal and source-shaped, not pipeline-shaped.
- Avoid proposal manifests, typed candidates, and extra reporting entities for
  the first implementation.
- Preserve deterministic projections for source systems with authoritative
  structured metadata.

## Non-goals

This design does not change the wiki markdown format, the semantic-layer YAML
format, or the raw source snapshot layouts. It also does not remove source
adapters' current fetch and chunk logic in one large rewrite.

This design does not introduce public connector knobs such as
`executionMode`, `planningStrategy`, or `conflictPolicy`. The core runner
becomes more opinionated instead.

This design does not require all connectors to stop using candidates. Candidate
storage remains valid for flows that intentionally defer wiki curation. The
isolation model applies when a work unit writes durable project files.

## Locked design direction

The ingestion runner uses one flow for every source that can produce durable
changes.

```text
fetch raw
  -> optional deterministic project
  -> adapter plans WorkUnit[]
  -> isolated WU diffs
  -> artifact-aware integration
  -> global semantic gates
  -> squash
```

The important invariant is that the core runner does not know why a work unit
exists. A dbt adapter may plan by model, Notion may plan by page or cluster,
MetricFlow may plan by graph component, and Looker may plan by dashboard or
explore. Those differences describe the source system. They are not ingestion
execution modes.

## Architecture

The design splits ingestion into two layers with explicit responsibility
boundaries.

### Source adapter layer

The adapter owns source semantics. It fetches raw evidence, normalizes that
evidence into staged files, and plans work units from the staged snapshot and
diff scope.

The adapter may also provide deterministic projectors. A projector is code that
converts authoritative source facts into KTX artifacts without an agent. Good
examples are live database schema introspection and straightforward MetricFlow
semantic-model import.

The isolation-relevant adapter surface remains small:

```ts
interface SourceAdapter {
  source: string;
  skillNames: string[];

  fetch?(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void>;
  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult>;

  project?(ctx: DeterministicProjectionContext): Promise<ProjectionResult>;
  resolveSlTargets?(ctx: SlTargetResolutionContext): Promise<string[]>;
}
```

This is the subset the isolated-diff runner needs to understand source-shaped
planning and deterministic projection. It is not a proposal to delete existing
`SourceAdapter` fields. Existing lifecycle and source-support fields such as
`detect`, `readFetchReport`, `listTargetConnectionIds`, `clusterWorkUnits`,
`describeScope`, `onPullSucceeded`, `evidenceIndexing`, `triageSupported`,
`getTriageSignals`, and `reconcileSkillNames` stay part of the adapter contract
until a separate cleanup intentionally removes them with migration impact
called out.

`chunk()` returns ordinary `WorkUnit[]`. The runner does not need a
`planningStrategy` enum because the source adapter can plan by any domain shape
that makes sense.

### Ingestion execution layer

The runner owns correctness, isolation, and integration. After `WorkUnit[]`
exists, all connectors follow the same execution path.

The runner is responsible for:

- creating the ingestion integration worktree from the project base commit;
- creating one child worktree per work unit from that same base;
- scoping tools to the work unit's raw files and allowed target connections;
- running the agent loop inside the work unit worktree;
- validating touched artifacts before accepting the work unit diff;
- collecting the work unit git diff;
- applying accepted diffs into the integration worktree;
- resolving textual and artifact-level conflicts;
- running final global gates; and
- squashing the integration worktree back to the project main worktree.

## Worktree model

The design uses three levels of git state.

```text
project main worktree
  ingest integration worktree
    per-work-unit worktree(s)
```

The project main worktree is the durable KTX project state. The ingestion
integration worktree stages raw snapshots, deterministic projections, accepted
work-unit diffs, reconciliation changes, and final gate repairs before one
squash merge back to main.

Each per-work-unit worktree starts from the same ingestion base commit. A work
unit never observes another concurrent work unit's transient edits. This makes
the work unit diff a clean proposal against a stable base.

The runner creates and runs child worktrees under the existing
`workUnitMaxConcurrency` setting. A run may have many planned work units, but no
more than that bound may be active or left on disk at once. The default remains
serial execution. Child worktrees must be cleaned up after the diff, transcript,
and outcome metadata are persisted, including failure paths. Adapters with
large fan-out, such as Notion, may use `clusterWorkUnits` before execution to
keep work-unit count tractable, but clustering remains source-shaped planning
rather than a separate execution mode.

## Work-unit lifecycle

Each work unit follows a fixed lifecycle.

1. Create a child worktree at the ingestion base commit.
2. Build a scoped tool session for the child worktree.
3. Run the source skill and agent loop.
4. Run work-unit-local gates against touched artifacts.
5. If gates pass, record `git diff --binary` from base to child HEAD.
6. If gates fail, mark the work unit failed and discard the child worktree.
7. Clean up the child worktree after the diff and transcript are persisted.

The work unit outcome stores the existing operational metadata KTX already
records: unit key, status, actions, touched semantic-layer sources, failure
reason, raw files, and transcript path. It does not add a proposal manifest.
The diff is the proposal.

For `slDisallowed` work units, isolation is defense in depth. The scoped
work-unit tools must withhold semantic-layer write and edit tools, and the
integration layer must reject any otherwise accepted diff from that work unit
that touches `semantic-layer/**`. This catches buggy or bypassed tool behavior
before an invalid LookML connection-mismatch write can reach the integration
worktree.

### Diff proposal contract

The proposal artifact is a Git patch with binary-safe content, not the existing
hash-based raw-source `DiffSet`.

The first implementation must use one pinned patch contract:

- collect `git diff --binary --no-renames <base>..HEAD`;
- disable rename and copy detection so renames are represented as delete plus
  create in version one;
- preserve mode changes from the patch metadata, but reject unexpected
  executable-mode or binary changes under known text artifact roots such as
  `wiki/**` and `semantic-layer/**`;
- apply each accepted patch to the integration worktree with
  `git apply --3way --index`;
- do not use `git apply --reject`, because partial hunk application is not an
  accepted integration state; and
- if patch application fails, leaves conflicts, or touches a path disallowed for
  that work unit, roll back the integration worktree to its pre-apply HEAD and
  classify the outcome as a textual conflict.

Delete-versus-edit, recreate-versus-edit, and delete-versus-create races are
therefore textual conflicts when Git cannot apply the patch cleanly. If Git
applies the patch but known artifact validators reject the resulting tree, the
outcome is a semantic conflict.

## Integration lifecycle

The integration worktree applies accepted work-unit diffs after local gates
pass. The runner applies diffs in a deterministic order, using the original
work-unit index unless a future implementation introduces explicit dependency
ordering.

Integration has three conflict classes:

- Clean patch application: the diff applies without conflict.
- Textual conflict: git cannot apply the patch cleanly.
- Semantic conflict: the patch applies textually but creates an invalid or
  inconsistent artifact.

Textual conflicts are resolved before semantic gates run. For known artifact
types, the runner uses artifact-aware merge helpers. For unknown file types, the
runner can fall back to agent-assisted conflict resolution in the integration
worktree.

### Reconciliation in the new flow

Reconciliation remains a shared runner stage, but it runs as a serial
integration-stage pass instead of a parallel work unit.

The runner applies all accepted work-unit diffs to the integration worktree,
resolves textual conflicts that can be resolved, and then runs reconciliation in
that integration worktree before final global gates and before squash.
Reconciliation must see the integrated state because its job is to resolve
cross-work-unit duplicates, evictions, fallbacks, and source-specific
reconcile guidance.

Reconciliation is not allowed to mutate project main directly and does not run
inside any child worktree. Its changes are captured as a reconciliation diff
against the pre-reconciliation integration HEAD, recorded in the existing
stage/report metadata, and validated with the same touched-artifact and scoped
connection gates as work-unit writes. The final global gates validate the
combined tree after reconciliation. If reconciliation introduces an invalid
wiki or semantic-layer reference, touches a disallowed target, or records an
unresolvable artifact conflict, the run fails or routes to a resolver before
squash.

## Artifact-aware integration

KTX durable artifacts are structured enough that git-only merge is not a strong
correctness boundary. Artifact-aware integration must parse and validate known
file classes after diffs are applied.

The first implementation must cover these worktree file classes:

- semantic-layer source YAML;
- wiki markdown frontmatter;
- wiki body references to semantic-layer sources, measures, dimensions, and raw
  warehouse tables.

Unmapped fallback records are not worktree files in version one. They remain
typed stage-index and report records emitted by `emit_unmapped_fallback`; the
integration layer validates their raw paths and structured reason codes as
report metadata, not as mergeable artifacts.

Provenance also stays out of the worktree in version one. The source of truth is
the ingest provenance store and report body. Before inserting provenance rows,
the global gate derives the planned rows from accepted work-unit actions,
reconciliation actions, artifact-resolution records, and skipped raw files, then
checks those rows against the integrated worktree and staged raw hashes. Moving
provenance to on-disk files would be a separate schema migration, not part of
this design.

Artifact-aware integration can start with validation-only behavior. It does not
need to auto-merge every semantic conflict in version one. If two diffs contest
the same source YAML or wiki page and the merge cannot prove correctness, the
runner must surface the conflict to a resolver rather than silently accepting
stale references.

## Global semantic gates

Final gates run after every accepted diff, deterministic projection, and
reconciliation change has landed in the integration worktree. These gates are
global because the final failure can emerge only after independent valid diffs
combine.

The final gates must include:

- semantic-layer validation for touched and dependency sources;
- wiki `wiki_refs` validation;
- wiki frontmatter `sl_refs` validation, including source-level and
  measure-level references;
- wiki body validation for explicit semantic-layer source, measure, dimension,
  and table references; and
- provenance validation for raw paths referenced by new or changed artifacts
  before those rows are inserted into SQLite.

The wiki body gate needs a narrow grammar so ordinary prose does not become a
semantic-layer reference. In version one, an explicit body reference is one of
these Markdown forms outside fenced code blocks:

- an inline code token in the form `source.entity`, where `source` matches a
  visible semantic-layer source and `entity` must match one of that source's
  measures, dimensions, or segments;
- an inline code token in the form `connectionId/source.entity`, which validates
  against that specific target connection;
- an inline code token in the form `source:source_name`, which validates a
  source-level semantic-layer reference; or
- an inline code token in the form `table:qualified_table_name`, which validates
  a raw warehouse table reference against the visible raw table/catalog sources.

The parser ignores unformatted prose, fenced SQL examples, and unprefixed
single-token inline code. Two-part inline code that does not name a visible
semantic-layer source is not treated as an SL entity reference; use the
`table:` prefix for raw warehouse table references.

The `total_contract_arr_cents` incident is the regression case for this gate:
the integrated tree must fail if a wiki page references
`mart_account_segments.total_contract_arr_cents` as an inline-code body token
while the final semantic-layer source defines only `total_contract_arr`.

## Deterministic projection

Some connectors have authoritative structured inputs that do not need an LLM to
write KTX artifacts. Those connectors can provide deterministic projectors that
run in the integration worktree.

Projection is different from work-unit execution:

- projectors are code, not agents;
- projectors run against the integration worktree;
- projectors produce ordinary durable file changes; and
- projector outputs still pass final global gates.

The runner infers hybrid behavior from the adapter. If an adapter has both
projectors and work units, it is hybrid. If it has only projectors, it is
deterministic. If it has only work units, it uses isolated diffs. No public
`executionMode` knob is needed.

## Connector migration notes

Each connector keeps its source-shaped planning logic. The migration changes
where durable writes happen and how they are integrated.

### Metabase

Metabase must move first because it produced the observed stale-measure wiki
reference. Collection and card chunking can remain adapter-specific, but direct
wiki and semantic-layer writes must happen in per-work-unit worktrees.

The regression test must reproduce two work units that touch
`mart_account_segments`: one writes a wiki reference to an inferred measure and
another leaves the final source with a different measure name. The final global
gate must reject the integrated tree.

### dbt

dbt uses source-shaped planning by model or schema file. Deterministic
projection is appropriate for straightforward model, source, column, and
description facts when dbt artifacts are authoritative. Agent work units remain
useful for business wiki synthesis, ambiguous relationship interpretation, and
enrichment that is not directly represented in dbt YAML.

### MetricFlow

MetricFlow uses source-shaped planning by graph component. Existing
deterministic semantic-model import code becomes a projector in the ingestion
flow. Agent work units handle unsupported constructs, cross-model explanations,
and wiki synthesis.

### Looker

Looker already defers some dashboard and look knowledge through candidates.
That can continue. Any direct semantic-layer writes from explores or query
translation must run through isolated work-unit diffs.

Looker-specific API and file-adapter collisions remain connector domain logic,
but final correctness still belongs to the shared integration gates.

### LookML

LookML already has useful source-shaped ownership rules: models, views, orphan
views, dashboards, and connection-mismatch guards. Those rules stay in the
adapter. Direct semantic-layer writes move into isolated work-unit diffs.

Connection-mismatch work units can keep their existing write restrictions. The
runner enforces those restrictions through scoped tools and target connection
resolution.

### Notion

Notion pages and clusters can create overlapping durable wiki knowledge and can
write semantic-layer overlays after warehouse verification. Notion therefore
uses the same isolated-diff execution model for direct durable writes.

Large Notion workspaces still need source-shaped clustering to control context
size and cost. Clustering remains adapter logic; correctness comes from isolated
diffs and final global gates.

## Minimal connector variance

New connectors must not choose from a menu of ingestion architectures. They
must provide the small amount of source-specific behavior the shared runner
needs.

Every connector answers these questions:

- How does KTX fetch or receive raw evidence?
- How does KTX normalize that evidence into staged files?
- How does KTX split the staged evidence into `WorkUnit[]`?
- Are any source facts authoritative enough for deterministic projection?
- Which target semantic-layer connections can the connector write to?

Everything else is shared runner behavior.

## Regression tests

The implementation plan must start with narrow tests that prove the new
execution model prevents the known failure class.

The first test creates a fake or Metabase-like adapter with two work units
starting from the same base:

1. Work unit A writes a wiki page that references
   `mart_account_segments.total_contract_arr_cents` as an inline-code body
   token.
2. Work unit B writes or overwrites the final semantic-layer source with only
   `total_contract_arr`.
3. Both work units pass their local gates in isolation.
4. Integration applies both diffs.
5. The final global gate fails the run before squash.

Additional tests cover:

- two work units editing different wiki pages without conflict;
- two work units editing the same semantic-layer source with a textual conflict;
- a deterministic projector change plus a work-unit wiki reference that becomes
  stale after projection;
- Notion-style direct wiki writes with invalid `sl_refs`; and
- LookML-style `slDisallowed` work units where write tools are unavailable and
  integration rejects any diff that still touches `semantic-layer/**`.

## Rollout

The rollout must be incremental because the current runner is shared by all
adapters.

The rollout switch is runner-owned. During migration it may be a private
per-source allowlist, or an internal `IngestSettingsPort` map keyed by
`sourceKey`, but it must not become a `SourceAdapter` field or public connector
configuration knob.

1. Add the per-work-unit worktree executor behind that internal runner setting.
2. Add diff collection and deterministic integration in the existing runner.
3. Add final global wiki and semantic-layer reference gates, including the wiki
   body reference parser defined above.
4. Migrate Metabase to the new execution path first.
5. Migrate Notion, LookML, Looker, dbt, and MetricFlow.
6. Promote the new path to the default after the Metabase regression test and
   at least one non-Metabase connector pass.
7. Remove the old shared-worktree work-unit execution path.

The rollout is complete when every connector that permits agent-authored durable
writes uses isolated diffs and all integrations pass the same final global
gates.
