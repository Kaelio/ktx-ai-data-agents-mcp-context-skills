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

The adapter contract remains small:

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

## Artifact-aware integration

KTX durable artifacts are structured enough that git-only merge is not a strong
correctness boundary. Artifact-aware integration must parse and validate known
file classes after diffs are applied.

The first implementation must cover these artifact classes:

- semantic-layer source YAML;
- wiki markdown frontmatter;
- wiki body references to semantic-layer sources, measures, dimensions, and raw
  warehouse tables;
- fallback records; and
- provenance records that map raw paths to written artifacts.

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
- provenance validation for raw paths referenced by new or changed artifacts.

The `total_contract_arr_cents` incident is the regression case for this gate:
the integrated tree must fail if a wiki page references
`mart_account_segments.total_contract_arr_cents` while the final semantic-layer
source defines only `total_contract_arr`.

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
   `mart_account_segments.total_contract_arr_cents`.
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
- LookML-style `slDisallowed` work units that cannot write semantic-layer
  files.

## Rollout

The rollout must be incremental because the current runner is shared by all
adapters.

1. Add the per-work-unit worktree executor behind an internal setting.
2. Add diff collection and deterministic integration in the existing runner.
3. Add final global wiki and semantic-layer reference gates.
4. Migrate Metabase to the new execution path first.
5. Migrate Notion, LookML, Looker, dbt, and MetricFlow.
6. Promote the new path to the default after the Metabase regression test and
   at least one non-Metabase connector pass.
7. Remove the old shared-worktree work-unit execution path.

The rollout is complete when every connector that permits agent-authored durable
writes uses isolated diffs and all integrations pass the same final global
gates.
