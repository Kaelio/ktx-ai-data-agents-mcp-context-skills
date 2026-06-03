# How ktx ingests your data stack

## The hard problem

**ktx** is a context layer for data agents. It gives an agent the reviewed
surface it needs to query a warehouse accurately: executable semantic-layer
YAML for tables, metrics, and joins, plus wiki Markdown for the business
meaning around those definitions. Ingestion is how the context engine builds
and refreshes that layer from primary sources and context sources: databases,
modeling projects, BI tools, query history, and docs.

That sounds like an extraction problem. It is really a concurrency problem.
Good ingestion has to let many fallible LLM work units inspect different pieces
of evidence and write to the same file tree. Those work units may discover the
same metric, touch the same semantic source, rewrite the same wiki page, or
reach contradictory conclusions from evidence that looked clean in isolation.

The requirements are unforgiving. The result must be deterministic where
**ktx** controls the process. It must be atomic, so a run either lands as one
reviewable change or leaves the committed context layer alone. And it must
never be silently wrong: when the system cannot prove a conflict is safe, it
has to create a decision point instead of blending facts together.

This post follows one ingest run end to end. The interesting part is not just
that **ktx** can read PostgreSQL, Snowflake, BigQuery, ClickHouse, MySQL, SQL
Server, SQLite, dbt, MetricFlow, LookML, Looker, Metabase, and Notion. The
interesting part is how it lets LLM agents write files safely.

[[image: Hero pipeline showing primary sources and context sources flowing into ktx ingest, then raw snapshot and diff, a parallel work-unit band, serial patch integration, reconciliation, finalization and gates, one atomic commit, and the two outputs: semantic-layer YAML and wiki Markdown. Add three badges: deterministic, atomic, never silently wrong.]]

## What ingestion produces

Ingestion produces two durable surfaces.

Semantic-layer YAML holds the structured, executable part: semantic sources,
tables, columns, measures, joins, filters, segments, and enough metadata for the
compiler to turn a semantic query into SQL. Wiki Markdown holds the explanatory
part: definitions, caveats, ownership, reporting policies, anomalies, and
decisions that help an agent know when a metric is appropriate.

The split is deliberate. Structured data lives where it can be compiled. Prose
lives where it can be searched. Wiki pages can point back to semantic sources
through `sl_refs`, so the statement "net revenue excludes refunds" can remain a
human-readable note while still anchoring itself to the executable revenue
measure.

That is the difference between the context layer and the semantic layer. The
context layer is the whole reviewed surface agents use. The context engine is
the active machinery that builds, reconciles, validates, indexes, and serves
that surface. The semantic layer is the compiler pillar inside it.

[[image: Two pillars of the ktx context layer: semantic-layer YAML on the left labeled compiled to SQL, wiki Markdown on the right labeled searched for meaning, with sl_refs linking wiki pages back to semantic sources.]]

## Sources, connectors, and bundles

The public command is one command: `ktx ingest`. When more than one configured
connection is selected, the planner runs database ingest targets first and then
context-source connection targets. Database ingest builds enriched warehouse
context. Context-source connection ingest imports evidence from tools and
documents that already carry business or modeling knowledge.

In public prose, these plugins are connectors. Internally, the extension point
is the `SourceAdapter` interface: every connector must be able to detect whether
it recognizes staged files and split those files into chunks. Other hooks are
optional. A connector can fetch its own snapshot, project deterministic output,
finalize after reconciliation, describe the scope of a partial snapshot, or
cluster work units before agents run.

A bundle is one snapshot's payload. It may come from an upload, a scheduled
pull, or an override that replays a prior snapshot through the current
reconciliation path. Once the bundle exists on disk, the rest of the pipeline
is intentionally uniform.

| Input kind | What it contributes |
|---|---|
| Live database | Tables, columns, types, keys, comments, samples, and relationship evidence |
| Query history | SQL usage patterns and common table relationships |
| dbt | Model and source definitions, descriptions, tests, and lineage |
| MetricFlow | Semantic models, measures, metrics, entities, and relationships |
| LookML | Views, explores, fields, joins, and warehouse mappings |
| Looker | Explores, looks, dashboards, field metadata, and folder context |
| Metabase | Dashboards, questions, SQL, and database-to-warehouse mappings |
| Notion | Knowledge pages, hierarchy, and document evidence for wiki capture |

Primary sources: PostgreSQL, Snowflake, BigQuery, ClickHouse, MySQL, SQL Server, SQLite.
Context sources: dbt, MetricFlow, LookML, Looker, Metabase, Notion. Different
connectors group raw files differently, but they all hand the orchestrator a
bundle with the same shape: evidence in, work units out, provenance recorded.

[[image: Sources to connector to bundle: live database, historic SQL, dbt, MetricFlow, LookML, Looker, Metabase, and Notion entering a uniform SourceAdapter-shaped connector boundary, then producing a bundle with provenance kinds upload, scheduled pull, and override.]]

## From a warehouse: scan and enrichment

Database ingest delegates to an enriched scan. The scan connector reads a
structural catalog from the primary source: tables or views, columns, native
types, normalized types, nullability, primary keys, foreign keys, comments, and
row-count estimates when the database exposes them. If constraint metadata
cannot be read because of permissions, the snapshot keeps going and records a
warning instead of pretending the metadata was complete.

Then enrichment starts. For descriptions, **ktx** asks for a table description
and all column descriptions in one batched table call, using existing comments
and sampled data as evidence. For embeddings, it builds column-level embedding
text from names, types, table context, descriptions, sample values, and foreign
key hints. Embedding calls are batched, and when the provider does not expose a
positive maximum batch size, the default batch size is `100`.

Relationship discovery is the densest part of the scan. It starts with formal
metadata, then generates deterministic candidates from name similarity,
table-name normalization, suffixes such as `_id`, `_key`, `_code`, and `_uuid`,
profile overlap, embedding locality, and optional LLM proposals. Candidates are
scored with seven signals: name similarity, type compatibility, value overlap,
embedding similarity, target uniqueness, null-rate evidence, and a structural
prior.

Scoring is not the end. When the connector can run read-only SQL, **ktx**
profiles table and column values and validates candidate joins against sampled
real data. The validation budget defaults to `min(2 * tableCount, 1000)`, so
large schemas do not turn relationship discovery into an unbounded database
load. Candidates outside the validation budget remain review candidates instead
of being overclaimed.

After validation, graph resolution chooses accepted, review, and rejected
relationships. It reasons about primary-key-like targets, resolves conflicts
where one candidate source column points to multiple parents, and can detect
multi-column relationships. Accepted formal, inferred, and composite
relationships are written into `_schema` manifest shards.

Those manifest shards are not a blind overwrite. When a warehouse is scanned
again, scan-managed descriptions and usage fields are refreshed, while
non-scan descriptions, existing usage fields, and joins that still point to
present tables are preserved. That gives later reconciliation a stable on-disk
surface instead of forcing every run to rediscover the user's accepted edits.

[[image: Relationship discovery funnel: candidate generation from name similarity, embeddings, suffix stripping, profiles, and LLM proposals; seven-signal scoring; validation on sampled real data with a min(2 x tables, 1000) budget badge; graph resolution; accepted joins.]]

## The core problem, stated precisely

At this point the context engine has raw evidence. The hard part is turning
that evidence into reviewed artifacts without letting nondeterminism leak into
the committed context layer.

Three requirements drive the rest of the design.

First, ordering must be deterministic wherever **ktx** controls ordering:
target selection, file sorting, work-unit collection, patch names, integration
order, and tiebreaks. Second, landing must be atomic: the context layer should
not contain half of a bundle because one late gate failed. Third, uncertainty
must be visible. The system can accept identical content, deterministic
replacements, and clearly elected canonical artifacts. It cannot hide
unresolved textual or semantic conflict in a polished-looking file.

The mechanism that makes this possible is a combination of raw snapshots,
stable identity, isolated git worktrees, serial patch integration,
reconciliation, final gates, and provenance.

## Raw snapshot and diff: stable identity

Stage 1 copies every raw bundle file into the session worktree under
`raw-sources/<connection>/<source>/<syncId>/`. Each raw file is hashed with
SHA-256 before it is written. The raw path is the identity; the hash is the
change detector.

Diffing compares the current hashes with the latest completed sync for the same
connection and context source. The buckets are simple and sorted: added,
modified, deleted, and unchanged. That matters because connectors can use those
buckets to skip unchanged work and because deletions become first-class
evidence for later evictions.

Artifact identity is stable too. A write is identified as
`target:connectionId:key`, so two domains can both have `revenue` without
colliding. `finance.revenue` and `marketing.revenue` can coexist because their
target connection and key are part of the identity.

Every durable outcome becomes provenance. Action types include
`source_created`, `measure_added`, `join_added`, `merged`, `subsumed`,
`wiki_written`, and `skipped`. If a current raw file did not produce a semantic
source or wiki action, the fallback provenance row records it as skipped. That
keeps future syncs honest: **ktx** can detect changes, know what artifacts came
from deleted raw files, and avoid treating "no output" as "never processed."

[[image: Raw snapshot diff and provenance ledger: raw-sources path tree with added, modified, deleted, and unchanged buckets, plus a ledger table showing raw path, hash, artifact identity, action, and sync id.]]

## Work units: the unit of parallel work

A work unit is a connector-chosen grouping of raw files. It is not necessarily
one table, one dashboard, or one LLM call. For one connector, a work unit might
be a dashboard and its cards. For another, it might be a connected component of
MetricFlow metrics and semantic models. For Notion, it might be a page, or a
span of an oversized page.

Each work unit has three file sets. `rawFiles` are the files the work unit owns
and can use as direct evidence. `dependencyPaths` are read-only context files
that help interpret the owned evidence. `peerFileIndex` is a sorted index of
nearby files so the agent can understand the neighborhood without receiving
the whole bundle in its prompt.

On re-sync, connector chunkers can run only work units that contain added or
modified files. Unchanged peers can be demoted to dependencies. That is how a
large context-source connection ingest avoids rerunning all agent work when
only one dashboard or page changed.

Some connectors add more routing before the model runs. Notion and Looker can
use triage lanes to skip, lightly process, or fully process content. Notion can
also cluster work units using embedding similarity so related knowledge is
handled together. Bounds are explicit: a prompt larger than `240000`
characters fails before the model runs, and the default work-unit step budget
is `40`.

## Isolated git worktrees

The central trick is isolation. Every work unit runs in its own throwaway git
worktree created from the same ingestion base SHA. That means two agents can
write files with the same initial view of the context layer without seeing each
other's partial edits.

Inside that worktree, the agent gets a constrained toolset: read raw files or
spans, read and write semantic-layer YAML and wiki Markdown, validate touched
semantic sources, inspect context evidence when available, and load the ingest
skills. The run is bounded by the work-unit step budget. If the agent loop
errors, calls a tool that fails, creates dangling wiki references, or writes a
semantic source that fails validation, the work unit fails and its worktree is
reset before any patch is collected.

Successful work units emit numbered, index-prefixed git patches from the
shared base to the child worktree head. The patches are binary-safe and
generated with rename detection disabled. Failed work units keep their failure
record, but their file changes vanish with the throwaway worktree.

This gives **ktx** the pattern it needs: parallel produce, serial integrate.
Work units can run through a concurrency limiter, but
`ingest.workUnits.maxConcurrency` defaults to `1`. The machinery is there so a
project can raise concurrency without changing correctness rules. Results are
collected by work-unit index, patch filenames start with that index, and
successful patches are integrated one at a time in index order.

[[image: Parallel produce, serial integrate: several work-unit lanes each in a throwaway git worktree branched from the same base SHA; one lane fails and is discarded; successful lanes emit numbered patches that are applied one at a time to the shared integration worktree.]]

## Per-work-unit gates

Bad work-unit output should not enter the shared integration tree. **ktx**
checks that before a patch exists.

The first gate is prompt size. If the system prompt plus user prompt is over
`240000` characters, the work unit fails before the model runs. The second gate
is the agent loop itself: model-loop errors and fatal tool-call failures fail
the work unit. The third gate checks wiki references created by the work unit
and rejects dangling links. The fourth gate validates the semantic sources the
work unit touched.

Local semantic-layer validation is intentionally shape-only during local ingest:
the local runtime uses `probeRowCount: 0`, so validation checks YAML structure,
composition, and semantic-layer shape rather than probing live warehouse rows
for every write. Later gates repeat validation over the integrated tree and
include direct join neighbors, but local ingest still remains a local file and
compiler check rather than a full warehouse proof.

## Integration and conflict resolution

Patch integration is the first merge layer. For each successful work unit,
**ktx** checks that the patch touches only allowed artifact paths, obeys target
connection policy, and does not write semantic-layer files when that work unit
was restricted from doing so. Then it applies the patch with 3-way git
application against the shared integration worktree.

If the patch applies cleanly, **ktx** runs semantic gates on the touched paths.
If git cannot apply the patch because another accepted patch changed the same
text, **ktx** makes one constrained repair attempt. The repair agent can read
the failed patch and only the touched integration files. It can edit only those
allowed paths. Its instructions are conservative: preserve unrelated accepted
content, incorporate patch evidence only when compatible, and do not create
facts absent from the current file or failed patch.

Semantic gate failures get the same bounded treatment: one constrained repair
attempt against only the affected files. A repair that completes without
changing an allowed file fails. A repair that changes files but still fails the
gate fails. Unresolved textual or semantic conflict marks the run failed and
the session worktree is discarded.

The second merge layer is semantic reconciliation, described in the next
section. It is where **ktx** handles the question readers usually ask: what
wins when multiple pieces of evidence point at the same concept?

| Case | Resolution |
|---|---|
| Identical content | Keep the existing artifact; do not rewrite just to churn the diff. |
| Expression-only re-ingest change | Replace silently when the name, grain, columns, and structure stay the same. |
| Structural re-ingest change with prior provenance | Replace and flag for human review because the new bundle is a signal, but the semantic break matters. |
| Same-bundle contradiction | Capture all variants and flag; there is no prior user signal that one variant wins. |
| Canonical pin | Keep the pinned artifact name when it is valid; disambiguate competitors and do not re-flag a decision the user already made. |

Definitional contradictions get special handling. If two variants use the same
bare concept name but compute substantively different things, **ktx** renames
all variants with domain suffixes, keeps the contested bare name out of the
semantic layer, and writes a unified `<concept>-definitions.md` wiki page that
records the competing definitions and their evidence. Numeric suffixes are not
enough; names need to say why the variant exists.

[[image: Conflict resolution decision tree showing identical content, expression-only re-ingest changes, structural re-ingest breaks, same-bundle contradictions, and canonical pins, with green accepted, amber flagged, and red fail-closed terminal nodes.]]

## Reconciliation: the cross-work-unit sweep

Reconciliation is Stage 4: a fresh sweep over the whole job after individual
work units and serial patch integration finish. Its input is the Stage Index,
the eviction set for deleted raw files, source-specific reconciliation notes,
and, for document context sources, deduped context candidates.

The Stage Index lists each work unit, its status, owned raw files, write
actions, touched semantic sources, conflict records, evictions, artifact
resolutions, and unmapped fallback decisions. The reconciliation agent can
inspect the index, diff specific work units, read raw spans, list artifacts
connected to deleted raw files, and emit structured decisions through tools:
conflict-resolution records, eviction decisions, artifact-resolution records,
and unmapped-fallback records.

Reconciliation skips when there are no writes, no evictions, no document
candidates, and no forced override. Otherwise it can run in a single pass or,
for document evidence with pagination and create/update budgets, curator mode.
Canonical pins are injected only when they are relevant to the Stage Index, and
the reconciliation prompt tells the agent to apply those pins before flagging a
same-name or near-duplicate conflict.

The deterministic election rules matter. For structural duplicates and
near-duplicates, **ktx** elects a canonical artifact by inbound reference count,
then by lexicographic unit key, then by lexicographic source name. The outcome
does not depend on which model call happened to finish first. Same-content
duplicates can be subsumed. Definitional contradictions are renamed, captured
in a unified definitions page, and flagged. Evictions remove artifacts whose
raw files disappeared, with a recorded raw-path reason.

[[image: Reconciliation sweep: Stage Index, eviction set, and context candidates flow into a reconciliation agent, which emits conflict-resolution, eviction-decision, artifact-resolution, and unmapped-fallback decision cards; include deterministic election by inbound refs 5/2/2 where 5 becomes canonical.]]

## Finalization, gates, and the atomic commit

After reconciliation, a connector may run deterministic finalization. Query-
history ingest, for example, can project structured usage results after the
agent-written artifacts have settled. Finalization has its own safety checks:
it cannot modify a path that earlier projection, work units, or reconciliation
already changed, and the paths it declares as touched must match the paths
**ktx** derives from the actual file diff.

Then **ktx** repairs wiki `sl_refs` and builds the final gate scope. Changed
wiki pages, touched semantic sources, reconciliation actions, finalization
changes, and repaired references are folded into one validation set. Semantic
sources are expanded to include direct join neighbors. Wiki `sl_refs`, wiki
refs, body references, semantic-layer validation, direct join neighbors, and
target path policy are checked before anything lands.

If a final artifact gate fails, **ktx** allows one conservative repair attempt
over the affected semantic-layer and wiki files. The repair prompt is explicit:
read the gate error first, inspect only allowed files, make the smallest edit,
preserve accepted work, and stop without editing if the problem requires
choosing between conflicting facts without evidence. A repair that changes
nothing fails.

Provenance rows are validated before landing. Every row must reference a raw
path from the current snapshot or from the deletion set. Only after those gates
pass does the session worktree squash-merge into the main project as one
commit. If the squash has no touched paths, there may be no commit. If it has
changes, the whole run lands together.

After the squash commit, **ktx** updates search indexes. Wiki search syncs from
the squashed diff, wiki-to-semantic references are synced, and touched semantic
sources are re-indexed for semantic-layer search.

[[image: All-or-nothing landing: final gates pass and the session worktree squash-merges as one commit; any final gate or conflict failure discards the worktree; outputs are re-indexed semantic-layer search and wiki search after the commit.]]

## Caveats and honest boundaries

The determinism is bounded. **ktx** controls result collection, sorting,
patch-file naming, integration order, and deterministic tiebreaks. Model
content and transcript timing are not deterministic in the same way. The design
contains nondeterminism by making outputs pass gates and by integrating in a
stable order.

Work units are serial by default:
`ingest.workUnits.maxConcurrency` defaults to `1`. Raising concurrency is a
performance choice, not a different correctness model, because every work unit
still starts from the same base SHA and integration remains serial.

Local validation is shape-only for semantic-layer writes during local ingest,
because local validation uses `probeRowCount: 0`. That catches malformed YAML,
composition failures, broken references, and compiler-shape problems. It does
not prove every table or column exists in the live warehouse at write time.

Work units are not automatically retried. Repairs are bounded to one attempt
for textual conflicts, one attempt for semantic gate failures during patch
integration, and one attempt for final artifact gates. If the repair cannot
make a defensible change, the conflict remains a failure.

Partial failure is first-class. Failed work units are recorded in the report,
and a run can complete with failed work units if other work units succeeded and
the final gates pass. That is separate from partial fetch status, which means a
connector could not fetch the full snapshot and recorded that fetch boundary.

Query-history ingest has source limits. Postgres query-history ingest requires
PostgreSQL 14 or newer, `pg_stat_statements`, and `pg_read_all_stats`. BigQuery
and Snowflake read from their account or job history surfaces and are the
query-history paths that honor the query-history window flag; Postgres reads
the current aggregate in `pg_stat_statements`.

Context sources have limits too. MetricFlow conversion metrics are not yet
supported, and cumulative metrics are carried with limited semantics. LookML
derived tables are unsupported as semantic-layer sources. Notion is
knowledge-only: it writes wiki knowledge, uses warehouse or dbt mappings before
touching semantic-layer YAML, and enforces per-run create and update caps.

Observability is built into the local run. Traces live at
`.ktx/ingest-traces/<jobId>/trace.jsonl`, work-unit and reconciliation
transcripts live under `.ktx/ingest-transcripts/<jobId>/`, and ingest profiling
is displayed when `KTX_PROFILE_INGEST` is enabled.

## Why it is built this way

The shape follows from the risk. A data agent needs a context layer it can act
on, not a pile of plausible notes. That means evidence must be traceable,
semantic definitions must compile, wiki references must stay live, and
conflicts must either resolve by rule or stop at a decision point.

Worktree isolation lets fallible agents produce candidate edits without
colliding. Deterministic tiebreaks make cross-work-unit decisions independent
of timing. Fail-closed gates keep unresolved conflicts out of the committed
context layer. Provenance makes future syncs compare against what actually
happened, not what the system hoped happened.

That is why **ktx** ingestion looks less like a scraper and more like a compiler
with a conscience: it translates messy data-stack evidence into files agents
can use, while refusing to silently turn ambiguity into authority.
