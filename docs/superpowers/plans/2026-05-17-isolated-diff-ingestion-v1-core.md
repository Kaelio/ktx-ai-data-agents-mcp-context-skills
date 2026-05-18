# Isolated Diff Ingestion V1 Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first production isolated-diff ingestion path, with persistent
postmortem traces, final artifact gates, and Metabase regression coverage.

**Architecture:** Keep the existing shared-worktree runner as the fallback path
while a private runner-owned source allowlist enables isolated diffs for
Metabase and tests. The isolated path creates one integration worktree, runs
optional deterministic projection there, executes each work unit in a child
worktree from the same ingestion base commit, collects binary Git patches, and
applies accepted patches back to the integration worktree in deterministic
order before reconciliation, final gates, and squash. Every ingestion step emits
structured JSONL trace events under `.ktx/ingest-traces/<jobId>/trace.jsonl`
and references that path in reports and CLI status output.

**Tech Stack:** TypeScript ESM/NodeNext, simple-git, Node `fs/promises`, Vitest,
existing `GitService`, `SessionWorktreeService`, `IngestBundleRunner`,
`SemanticLayerService`, `KnowledgeWikiService`, and ingest report schemas.

---

## Audit summary

This audit read
`docs/superpowers/specs/2026-05-17-isolated-diff-ingestion-design.md`, searched
`docs/superpowers/plans/`, and inspected the current ingest runner under
`packages/context/src/ingest/`.

No existing plan or implementation covers isolated-diff ingestion. Searches for
the exact implementation terms from the spec, including `git apply --3way`,
`--binary --no-renames`, `integration worktree`, `global semantic gate`, and
`wiki body reference`, returned no plan or code matches. Existing May 13 unified
ingest plans are implemented public CLI and UX work; May 15 Claude Code plans
cover LLM backend isolation, not ingestion diff isolation.

Implemented foundations that this plan reuses:

- `SessionWorktreeService` can create Git worktrees from a base SHA.
- `GitService` already supports `addWorktree`, `removeWorktree`,
  `resetHardTo`, `diffNameStatus`, `assertWorktreeClean`, and
  `squashMergeIntoMain`.
- `IngestBundleRunner` already stages raw snapshots in a session worktree,
  chunks adapters into `WorkUnit[]`, runs WorkUnit and reconciliation agent
  loops, records tool transcripts, writes reports, inserts provenance, and
  squashes into main.
- `buildWuToolSet()` already withholds `sl_write_source` and `sl_edit_source`
  for `slDisallowed` WorkUnits.

Current gaps that block v1:

- WorkUnits still run against one mutable session worktree. In
  `ingest-bundle.runner.ts`, the runner creates one `sessionWorktree` and each
  WorkUnit uses `sessionWorktree.workdir`, `sessionWorktree.config`, and
  `sessionWorktree.git`.
- WorkUnits do not produce durable Git patch proposal artifacts.
- There is no artifact-aware patch integration layer using
  `git apply --3way --index`.
- There is no integration rollback and structured conflict classification for
  failed patch application or semantic gate failures.
- Deterministic imports run as post-processors after WorkUnits and
  reconciliation, while the spec requires projection before child worktree
  creation.
- Final gates do not validate wiki body inline-code references to semantic
  layer entities or raw tables.
- Provenance insertion accepts unknown raw hashes instead of failing before
  insertion.
- `slDisallowed` is enforced at tool construction only; there is no integration
  patch rejection for `semantic-layer/**`.
- Existing progress events and tool transcripts are useful but not sufficient
  persistent traces. They do not capture the input snapshot, every routing
  decision, patch collection, patch application timing, gate timing, rollback
  context, and final outcome in one inspectable trace file.

Non-blocking gaps for this plan:

- Migrating Notion, LookML, Looker, dbt, MetricFlow, and historic-SQL direct
  durable writes to the isolated path. This plan enables the path privately for
  Metabase and test fixtures.
- Promoting isolated diffs as the default for every connector.
- Removing the old shared-worktree WorkUnit path.
- Interactive, CLI, or agent-driven conflict resolution.
- Auto-merging semantic conflicts that cannot be proven correct.
- Transitive SQL-projection closure for semantic-layer dependency expansion.
- Moving provenance to worktree files.
- Public connector knobs such as `executionMode`, `planningStrategy`, or
  `conflictPolicy`.

## File structure

- Create `packages/context/src/ingest/ingest-trace.ts`.
  Owns persistent JSONL trace writing, trace timing helpers, error
  serialization, and trace path construction.
- Create `packages/context/src/ingest/ingest-trace.test.ts`.
  Covers JSONL trace persistence, timing events, error context, and path layout.
- Modify `packages/context/src/ingest/ports.ts`.
  Adds trace storage and private isolated-diff settings.
- Modify `packages/context/src/ingest/local-bundle-runtime.ts`.
  Stores traces under `.ktx/ingest-traces/<jobId>/trace.jsonl` and enables the
  isolated path for Metabase.
- Modify `packages/context/src/ingest/reports.ts` and
  `packages/context/src/ingest/report-snapshot.ts`.
  Adds `tracePath` and isolated-diff outcome fields to reports.
- Modify `packages/cli/src/ingest.ts`.
  Prints `Trace: <path>` in stored ingest status.
- Modify `packages/context/src/core/git.service.ts` and tests.
  Adds binary patch collection, patch application, staged commit, and path
  inspection helpers needed by patch integration.
- Create `packages/context/src/ingest/isolated-diff/git-patch.ts`.
  Owns patch metadata parsing, path restrictions, mode-change checks, and
  binary/text artifact rejection.
- Create `packages/context/src/ingest/isolated-diff/git-patch.test.ts`.
  Covers path parsing, `slDisallowed`, text-artifact binary rejection, and
  executable-mode rejection.
- Create `packages/context/src/ingest/wiki-body-refs.ts`.
  Parses and validates explicit wiki body references.
- Create `packages/context/src/ingest/wiki-body-refs.test.ts`.
  Covers the `source.entity`, `connectionId/source.entity`,
  `source:source_name`, and `table:qualified_table_name` grammar.
- Create `packages/context/src/ingest/artifact-gates.ts`.
  Runs WorkUnit-local and final global artifact gates for SL, wiki refs,
  wiki `sl_refs`, wiki body refs, and provenance rows.
- Create `packages/context/src/ingest/artifact-gates.test.ts`.
  Covers the stale `total_contract_arr_cents` incident and provenance raw-path
  failure.
- Create `packages/context/src/ingest/isolated-diff/work-unit-executor.ts`.
  Executes a WorkUnit inside a child worktree, records traces, persists
  transcripts, runs local gates, collects its patch, and cleans up the child.
- Create `packages/context/src/ingest/isolated-diff/work-unit-executor.test.ts`.
  Covers child-worktree base SHA usage, patch collection, child cleanup, and
  trace emission on success and failure.
- Create `packages/context/src/ingest/isolated-diff/patch-integrator.ts`.
  Applies accepted WorkUnit patches into the integration worktree, commits each
  accepted patch, rolls back on textual or semantic conflict, and records
  trace events.
- Create `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`.
  Covers clean patch integration, textual conflict rollback, semantic conflict
  rollback, and `slDisallowed` rejection.
- Modify `packages/context/src/ingest/types.ts`.
  Adds the optional `SourceAdapter.project()` hook for deterministic projection.
- Modify `packages/context/src/ingest/ingest-bundle.runner.ts`.
  Adds the isolated-diff execution branch, final gates, trace lifecycle, and
  report integration.
- Create `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`.
  Adds the known Metabase-style stale wiki reference regression, clean
  different-page integration, textual conflict, hybrid projection, Notion-style
  invalid `sl_refs`, and LookML-style `slDisallowed` rejection tests.
- Modify `packages/context/src/ingest/index.ts`.
  Exports new trace, artifact gate, and isolated-diff testing types.

---

### Task 1: Persistent ingestion trace sink

**Files:**
- Create: `packages/context/src/ingest/ingest-trace.ts`
- Create: `packages/context/src/ingest/ingest-trace.test.ts`
- Modify: `packages/context/src/ingest/ports.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Modify: `packages/context/src/ingest/reports.ts`
- Modify: `packages/context/src/ingest/report-snapshot.ts`
- Modify: `packages/cli/src/ingest.ts`

- [ ] **Step 1: Write failing trace sink tests**

Create `packages/context/src/ingest/ingest-trace.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileIngestTraceWriter, ingestTracePathForJob, traceTimed } from './ingest-trace.js';

describe('FileIngestTraceWriter', () => {
  it('persists structured trace events as JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-trace-'));
    const tracePath = ingestTracePathForJob(root, 'job-1');
    const trace = new FileIngestTraceWriter({
      tracePath,
      jobId: 'job-1',
      connectionId: 'metabase-main',
      sourceKey: 'metabase',
      level: 'debug',
    });

    await trace.event('debug', 'snapshot', 'input_snapshot', {
      baseSha: 'abc123',
      rawFileCount: 2,
      diffSummary: { added: 1, modified: 1, deleted: 0, unchanged: 3 },
    });

    const lines = (await readFile(tracePath, 'utf-8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      schemaVersion: 1,
      jobId: 'job-1',
      connectionId: 'metabase-main',
      sourceKey: 'metabase',
      level: 'debug',
      phase: 'snapshot',
      event: 'input_snapshot',
      data: {
        baseSha: 'abc123',
        rawFileCount: 2,
        diffSummary: { added: 1, modified: 1, deleted: 0, unchanged: 3 },
      },
    });
    expect(typeof lines[0].at).toBe('string');
  });

  it('records timing and error context for postmortem inspection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T12:00:00.000Z'));
    const root = await mkdtemp(join(tmpdir(), 'ktx-trace-'));
    const tracePath = ingestTracePathForJob(root, 'job-2');
    const trace = new FileIngestTraceWriter({
      tracePath,
      jobId: 'job-2',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    await expect(
      traceTimed(trace, 'integration', 'apply_patch', { unitKey: 'wu-1' }, async () => {
        vi.advanceTimersByTime(17);
        throw new Error('patch conflict');
      }),
    ).rejects.toThrow('patch conflict');

    const lines = (await readFile(tracePath, 'utf-8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.event)).toEqual(['apply_patch_started', 'apply_patch_failed']);
    expect(lines[1]).toMatchObject({
      level: 'error',
      phase: 'integration',
      data: { unitKey: 'wu-1' },
      error: { name: 'Error', message: 'patch conflict' },
    });
    expect(lines[1].durationMs).toBe(17);
    vi.useRealTimers();
  });

  it('uses the documented trace path layout', () => {
    expect(ingestTracePathForJob('/project/.ktx', 'job-3')).toBe('/project/.ktx/ingest-traces/job-3/trace.jsonl');
  });
});
```

- [ ] **Step 2: Run the failing trace sink tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-trace.test.ts
```

Expected: FAIL because `packages/context/src/ingest/ingest-trace.ts` does not
exist.

- [ ] **Step 3: Add the trace sink implementation**

Create `packages/context/src/ingest/ingest-trace.ts`:

```ts
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

export type IngestTraceLevel = 'info' | 'debug' | 'trace' | 'error';

const TRACE_LEVEL_RANK: Record<IngestTraceLevel, number> = {
  error: 0,
  info: 1,
  debug: 2,
  trace: 3,
};

export interface IngestTraceContext {
  tracePath: string;
  jobId: string;
  connectionId: string;
  sourceKey: string;
  runId?: string;
  syncId?: string;
  level?: IngestTraceLevel;
}

export interface IngestTraceEvent {
  schemaVersion: 1;
  at: string;
  level: IngestTraceLevel;
  jobId: string;
  connectionId: string;
  sourceKey: string;
  runId?: string;
  syncId?: string;
  phase: string;
  event: string;
  durationMs?: number;
  data?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface IngestTraceWriter {
  readonly tracePath: string;
  readonly context: IngestTraceContext;
  withContext(context: Partial<Pick<IngestTraceContext, 'runId' | 'syncId'>>): IngestTraceWriter;
  event(
    level: IngestTraceLevel,
    phase: string,
    event: string,
    data?: Record<string, unknown>,
    error?: unknown,
    durationMs?: number,
  ): Promise<void>;
}

export function ingestTracePathForJob(homeDir: string, jobId: string): string {
  return join(homeDir, 'ingest-traces', jobId, 'trace.jsonl');
}

function serializeError(error: unknown): IngestTraceEvent['error'] | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

function shouldWrite(configured: IngestTraceLevel, incoming: IngestTraceLevel): boolean {
  return TRACE_LEVEL_RANK[incoming] <= TRACE_LEVEL_RANK[configured];
}

export class FileIngestTraceWriter implements IngestTraceWriter {
  readonly tracePath: string;
  readonly context: IngestTraceContext;

  constructor(context: IngestTraceContext) {
    this.context = { ...context, level: context.level ?? 'debug' };
    this.tracePath = context.tracePath;
  }

  withContext(context: Partial<Pick<IngestTraceContext, 'runId' | 'syncId'>>): IngestTraceWriter {
    return new FileIngestTraceWriter({ ...this.context, ...context, tracePath: this.tracePath });
  }

  async event(
    level: IngestTraceLevel,
    phase: string,
    event: string,
    data?: Record<string, unknown>,
    error?: unknown,
    durationMs?: number,
  ): Promise<void> {
    if (!shouldWrite(this.context.level ?? 'debug', level)) {
      return;
    }
    const payload: IngestTraceEvent = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      level,
      jobId: this.context.jobId,
      connectionId: this.context.connectionId,
      sourceKey: this.context.sourceKey,
      ...(this.context.runId ? { runId: this.context.runId } : {}),
      ...(this.context.syncId ? { syncId: this.context.syncId } : {}),
      phase,
      event,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(data ? { data } : {}),
      ...(serializeError(error) ? { error: serializeError(error) } : {}),
    };
    await mkdir(dirname(this.tracePath), { recursive: true });
    await appendFile(this.tracePath, `${JSON.stringify(payload)}\n`, 'utf-8');
  }
}

export class NoopIngestTraceWriter implements IngestTraceWriter {
  readonly tracePath = '';
  readonly context: IngestTraceContext = {
    tracePath: '',
    jobId: '',
    connectionId: '',
    sourceKey: '',
    level: 'error',
  };

  withContext(): IngestTraceWriter {
    return this;
  }

  async event(): Promise<void> {}
}

export async function traceTimed<T>(
  trace: IngestTraceWriter,
  phase: string,
  event: string,
  data: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  await trace.event('debug', phase, `${event}_started`, data);
  const started = performance.now();
  try {
    const result = await fn();
    await trace.event('debug', phase, `${event}_finished`, data, undefined, performance.now() - started);
    return result;
  } catch (error) {
    await trace.event('error', phase, `${event}_failed`, data, error, performance.now() - started);
    throw error;
  }
}
```

- [ ] **Step 4: Add trace storage and report fields**

In `packages/context/src/ingest/ports.ts`, import `IngestTraceLevel`:

```ts
import type { IngestTraceLevel } from './ingest-trace.js';
```

Then extend `IngestSettingsPort` and `IngestStoragePort`:

```ts
export interface IngestSettingsPort {
  memoryIngestionModel: string;
  probeRowCount: number;
  workUnitMaxConcurrency?: number;
  workUnitStepBudget?: number;
  workUnitFailureMode?: 'abort' | 'continue';
  isolatedDiffSourceKeys?: string[];
  ingestTraceLevel?: IngestTraceLevel;
}

export interface IngestStoragePort {
  homeDir: string;
  systemGitAuthor: IngestGitAuthor;
  resolveUploadDir(uploadId: string): string;
  resolvePullDir(jobId: string): string;
  resolveTranscriptDir(jobId: string): string;
  resolveTracePath(jobId: string): string;
}
```

In `packages/context/src/ingest/local-bundle-runtime.ts`, import
`ingestTracePathForJob`:

```ts
import { ingestTracePathForJob } from './ingest-trace.js';
```

Then add the storage method:

```ts
  resolveTracePath(jobId: string): string {
    return ingestTracePathForJob(this.homeDir, jobId);
  }
```

When creating the runner settings in `createLocalBundleIngestRuntime()`, set:

```ts
    settings: {
      memoryIngestionModel: options.memoryModel ?? project.config.llm.memoryIngestionModel,
      probeRowCount: project.config.ai.slValidation.probeRowCount,
      workUnitMaxConcurrency: project.config.ingest.workUnitMaxConcurrency,
      workUnitStepBudget: project.config.ingest.workUnitStepBudget,
      workUnitFailureMode: project.config.ingest.workUnitFailureMode,
      isolatedDiffSourceKeys: ['metabase'],
      ingestTraceLevel: 'debug',
    },
```

In `packages/context/src/ingest/reports.ts`, add report fields:

```ts
export interface IngestReportBody {
  syncId: string;
  diffSummary: IngestDiffSummary;
  fetch?: SourceFetchReport;
  commitSha: string | null;
  tracePath?: string;
  isolatedDiff?: {
    enabled: boolean;
    integrationWorktreePath?: string;
    ingestionBaseSha?: string;
    projectionSha?: string | null;
    acceptedPatches: number;
    textualConflicts: number;
    semanticConflicts: number;
  };
  workUnits: IngestReportWorkUnit[];
  failedWorkUnits: string[];
  reconciliationSkipped: boolean;
  reconciliationActions?: MemoryAction[];
  conflictsResolved: ConflictResolvedRecord[];
  evictionsApplied: EvictionAppliedRecord[];
  unmappedFallbacks: UnmappedFallbackRecord[];
  artifactResolutions?: ArtifactResolutionRecord[];
  evictionInputs: string[];
  unresolvedCards: UnresolvedCardInfo[];
  supersededBy: string | null;
  overrideOf: string | null;
  provenanceRows: IngestReportProvenanceDetail[];
  toolTranscripts: IngestReportToolTranscriptSummary[];
  postProcessor?: IngestReportPostProcessorOutcome;
  wikiSlRefRepairs?: WikiSlRefRepair[];
  wikiSlRefRepairWarnings?: string[];
  memoryFlow?: MemoryFlowReplayInput;
}
```

In `packages/context/src/ingest/report-snapshot.ts`, add this schema inside
`body`:

```ts
        tracePath: z.string().optional(),
        isolatedDiff: z
          .object({
            enabled: z.boolean(),
            integrationWorktreePath: z.string().optional(),
            ingestionBaseSha: z.string().optional(),
            projectionSha: z.string().nullable().optional(),
            acceptedPatches: z.number().int().min(0),
            textualConflicts: z.number().int().min(0),
            semanticConflicts: z.number().int().min(0),
          })
          .optional(),
```

In `packages/cli/src/ingest.ts`, update `writeReportStatus()`:

```ts
  if (report.body.tracePath) {
    io.stdout.write(`Trace: ${report.body.tracePath}\n`);
  }
```

Place it after the `Job:` line so a failed run's trace path is visible near the
run identifiers.

- [ ] **Step 5: Run trace sink tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-trace.test.ts src/ingest/report-snapshot.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/ingest/ingest-trace.ts \
  packages/context/src/ingest/ingest-trace.test.ts \
  packages/context/src/ingest/ports.ts \
  packages/context/src/ingest/local-bundle-runtime.ts \
  packages/context/src/ingest/reports.ts \
  packages/context/src/ingest/report-snapshot.ts \
  packages/cli/src/ingest.ts
git commit -m "feat: persist ingest trace events"
```

---

### Task 2: Git patch contract helpers

**Files:**
- Modify: `packages/context/src/core/git.service.ts`
- Create: `packages/context/src/core/git.service.patch.test.ts`
- Create: `packages/context/src/ingest/isolated-diff/git-patch.ts`
- Create: `packages/context/src/ingest/isolated-diff/git-patch.test.ts`

- [ ] **Step 1: Write failing GitService patch tests**

Create `packages/context/src/core/git.service.patch.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitService } from './git.service.js';

async function makeGit() {
  const homeDir = await mkdtemp(join(tmpdir(), 'ktx-git-patch-'));
  const configDir = join(homeDir, 'config');
  const git = new GitService({
    storage: { configDir, homeDir },
    git: {
      userName: 'System User',
      userEmail: 'system@example.com',
      bootstrapMessage: 'init',
      bootstrapAuthor: 'system',
      bootstrapAuthorEmail: 'system@example.com',
    },
  });
  await git.onModuleInit();
  return { homeDir, configDir, git };
}

describe('GitService patch helpers', () => {
  it('collects binary-safe no-rename patches and applies them with --3way --index', async () => {
    const { homeDir, configDir, git } = await makeGit();
    await mkdir(join(configDir, 'wiki/global'), { recursive: true });
    await writeFile(join(configDir, 'wiki/global/page.md'), 'old\n');
    await git.commitFiles(['wiki/global/page.md'], 'add page', 'System User', 'system@example.com');
    const base = await git.revParseHead();

    await writeFile(join(configDir, 'wiki/global/page.md'), 'new\n');
    await git.commitFiles(['wiki/global/page.md'], 'edit page', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'proposal.patch');
    await git.writeBinaryNoRenamePatch(base, 'HEAD', patchPath);

    const targetDir = join(homeDir, 'target');
    await git.addWorktree(targetDir, 'target', base);
    const targetGit = git.forWorktree(targetDir);
    await targetGit.applyPatchFile3WayIndex(patchPath);
    await targetGit.commitStaged('apply proposal', 'System User', 'system@example.com');

    await expect(readFile(join(targetDir, 'wiki/global/page.md'), 'utf-8')).resolves.toBe('new\n');
  });
});
```

- [ ] **Step 2: Run failing GitService patch tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/core/git.service.patch.test.ts
```

Expected: FAIL because `writeBinaryNoRenamePatch`, `applyPatchFile3WayIndex`,
and `commitStaged` are missing.

- [ ] **Step 3: Add GitService patch helpers**

At the top of `packages/context/src/core/git.service.ts`, change:

```ts
import { join } from 'node:path';
```

to:

```ts
import { dirname, join } from 'node:path';
```

Then add these methods to the `GitService` class:

```ts
  async writeBinaryNoRenamePatch(from: string, to: string, patchPath: string): Promise<void> {
    await this.withMutationQueue(async () => {
      const patch = await this.git.raw(['diff', '--binary', '--no-renames', `${from}..${to}`]);
      await fs.mkdir(dirname(patchPath), { recursive: true });
      await fs.writeFile(patchPath, patch, 'utf-8');
    });
  }

  async applyPatchFile3WayIndex(patchPath: string): Promise<void> {
    await this.withMutationQueue(async () => {
      await this.git.raw(['apply', '--3way', '--index', patchPath]);
    });
  }

  async commitStaged(commitMessage: string, author: string, authorEmail: string): Promise<GitCommitInfo> {
    return this.withMutationQueue(async () => {
      const stagedChanges = await this.git.diff(['--cached', '--name-only']);
      if (!stagedChanges.trim()) {
        const head = (await this.git.revparse(['HEAD'])).trim();
        const log = await this.git.log({ maxCount: 1 });
        const latest = log.latest;
        return {
          commitHash: head,
          shortHash: head.substring(0, 7),
          message: latest?.message ?? '',
          author: latest?.author_name ?? '',
          authorEmail: latest?.author_email ?? '',
          timestamp: latest?.date ?? new Date(0).toISOString(),
          committedDate: latest?.date ? new Date(latest.date).toISOString() : new Date(0).toISOString(),
          created: false,
        };
      }
      await this.git.commit(commitMessage, { '--author': `${author} <${authorEmail}>` });
      const head = (await this.git.revparse(['HEAD'])).trim();
      const log = await this.git.log({ maxCount: 1 });
      const latest = log.latest;
      return {
        commitHash: head,
        shortHash: head.substring(0, 7),
        message: latest?.message ?? commitMessage,
        author: latest?.author_name ?? author,
        authorEmail: latest?.author_email ?? authorEmail,
        timestamp: latest?.date ?? new Date().toISOString(),
        committedDate: latest?.date ? new Date(latest.date).toISOString() : new Date().toISOString(),
        created: true,
      };
    });
  }
```

- [ ] **Step 4: Write failing patch contract tests**

Create `packages/context/src/ingest/isolated-diff/git-patch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  assertPatchAllowedForWorkUnit,
  parsePatchTouchedPaths,
  textArtifactRoots,
} from './git-patch.js';

describe('isolated diff patch contract', () => {
  it('parses touched paths from no-rename git patches', () => {
    const patch = [
      'diff --git a/wiki/global/a.md b/wiki/global/a.md',
      'index 1111111..2222222 100644',
      '--- a/wiki/global/a.md',
      '+++ b/wiki/global/a.md',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/semantic-layer/c1/orders.yaml b/semantic-layer/c1/orders.yaml',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/semantic-layer/c1/orders.yaml',
      '@@ -0,0 +1 @@',
      '+name: orders',
      '',
    ].join('\n');

    expect(parsePatchTouchedPaths(patch)).toEqual([
      { path: 'wiki/global/a.md', oldPath: 'wiki/global/a.md', newPath: 'wiki/global/a.md', mode: '100644', binary: false },
      {
        path: 'semantic-layer/c1/orders.yaml',
        oldPath: 'semantic-layer/c1/orders.yaml',
        newPath: 'semantic-layer/c1/orders.yaml',
        mode: '100644',
        binary: false,
      },
    ]);
  });

  it('rejects semantic-layer paths for slDisallowed work units', () => {
    const patch = 'diff --git a/semantic-layer/c1/orders.yaml b/semantic-layer/c1/orders.yaml\nindex 1..2 100644\n';

    expect(() =>
      assertPatchAllowedForWorkUnit({
        unitKey: 'lookml-mismatch',
        patch,
        slDisallowed: true,
      }),
    ).toThrow(/slDisallowed WorkUnit lookml-mismatch touched semantic-layer\/c1\/orders.yaml/);
  });

  it('rejects executable and binary changes under known text artifact roots', () => {
    expect(textArtifactRoots).toEqual(['wiki/', 'semantic-layer/']);

    const executablePatch =
      'diff --git a/wiki/global/a.md b/wiki/global/a.md\nold mode 100644\nnew mode 100755\nindex 1..2\n';
    expect(() =>
      assertPatchAllowedForWorkUnit({
        unitKey: 'wu-1',
        patch: executablePatch,
        slDisallowed: false,
      }),
    ).toThrow(/unexpected executable mode under wiki\/global\/a.md/);

    const binaryPatch = [
      'diff --git a/semantic-layer/c1/orders.yaml b/semantic-layer/c1/orders.yaml',
      'index 1111111..2222222 100644',
      'GIT binary patch',
      'literal 0',
      '',
    ].join('\n');
    expect(() =>
      assertPatchAllowedForWorkUnit({
        unitKey: 'wu-2',
        patch: binaryPatch,
        slDisallowed: false,
      }),
    ).toThrow(/unexpected binary patch under semantic-layer\/c1\/orders.yaml/);
  });
});
```

- [ ] **Step 5: Add patch contract helpers**

Create `packages/context/src/ingest/isolated-diff/git-patch.ts`:

```ts
export const textArtifactRoots = ['wiki/', 'semantic-layer/'] as const;

export interface PatchTouchedPath {
  path: string;
  oldPath: string;
  newPath: string;
  mode: string | null;
  binary: boolean;
}

export interface PatchPolicyInput {
  unitKey: string;
  patch: string;
  slDisallowed: boolean;
}

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, '');
}

function isTextArtifactPath(path: string): boolean {
  return textArtifactRoots.some((root) => path.startsWith(root));
}

export function parsePatchTouchedPaths(patch: string): PatchTouchedPath[] {
  const lines = patch.split('\n');
  const entries: PatchTouchedPath[] = [];
  let current: PatchTouchedPath | null = null;

  const pushCurrent = () => {
    if (current) {
      entries.push(current);
    }
  };

  for (const line of lines) {
    const diffMatch = /^diff --git (.+) (.+)$/.exec(line);
    if (diffMatch) {
      pushCurrent();
      const oldPath = stripPrefix(diffMatch[1] ?? '');
      const newPath = stripPrefix(diffMatch[2] ?? '');
      current = {
        path: newPath === '/dev/null' ? oldPath : newPath,
        oldPath,
        newPath,
        mode: null,
        binary: false,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    const indexMode = /^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/.exec(line);
    if (indexMode && line.includes(' ')) {
      current.mode = line.split(' ').at(-1) ?? current.mode;
    }
    const newMode = /^new mode ([0-7]{6})$/.exec(line);
    if (newMode) {
      current.mode = newMode[1] ?? current.mode;
    }
    if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
      current.binary = true;
    }
  }

  pushCurrent();
  return entries;
}

export function assertPatchAllowedForWorkUnit(input: PatchPolicyInput): PatchTouchedPath[] {
  const touched = parsePatchTouchedPaths(input.patch);
  for (const entry of touched) {
    if (input.slDisallowed && entry.path.startsWith('semantic-layer/')) {
      throw new Error(`slDisallowed WorkUnit ${input.unitKey} touched ${entry.path}`);
    }
    if (!isTextArtifactPath(entry.path)) {
      continue;
    }
    if (entry.binary) {
      throw new Error(`unexpected binary patch under ${entry.path}`);
    }
    if (entry.mode && entry.mode !== '100644') {
      throw new Error(`unexpected executable mode under ${entry.path}: ${entry.mode}`);
    }
  }
  return touched;
}
```

- [ ] **Step 6: Run patch helper tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/core/git.service.patch.test.ts src/ingest/isolated-diff/git-patch.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/context/src/core/git.service.ts \
  packages/context/src/core/git.service.patch.test.ts \
  packages/context/src/ingest/isolated-diff/git-patch.ts \
  packages/context/src/ingest/isolated-diff/git-patch.test.ts
git commit -m "feat: add isolated ingest patch helpers"
```

---

### Task 3: Wiki body reference parser and validator

**Files:**
- Create: `packages/context/src/ingest/wiki-body-refs.ts`
- Create: `packages/context/src/ingest/wiki-body-refs.test.ts`

- [ ] **Step 1: Write failing wiki body reference tests**

Create `packages/context/src/ingest/wiki-body-refs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { findInvalidWikiBodyRefs, parseWikiBodyRefs } from './wiki-body-refs.js';

const sources = [
  {
    name: 'mart_account_segments',
    grain: ['account_id'],
    columns: [{ name: 'account_id', type: 'string' }, { name: 'segment', type: 'string' }],
    joins: [],
    measures: [{ name: 'total_contract_arr', expr: 'sum(contract_arr)' }],
    segments: [{ name: 'enterprise', expr: "segment = 'enterprise'" }],
    table: 'analytics.mart_account_segments',
  },
];

describe('wiki body refs', () => {
  it('parses only explicit inline-code body references outside fenced blocks', () => {
    const body = [
      'Valid `mart_account_segments.total_contract_arr` and `source:mart_account_segments`.',
      'Also `warehouse/mart_account_segments.segment` and `table:analytics.mart_account_segments`.',
      'Ignore prose mart_account_segments.total_contract_arr_cents.',
      'Ignore `single_token`.',
      '```sql',
      'select `mart_account_segments.total_contract_arr_cents`',
      '```',
    ].join('\n');

    expect(parseWikiBodyRefs(body)).toEqual([
      { kind: 'sl_entity', connectionId: null, sourceName: 'mart_account_segments', entityName: 'total_contract_arr' },
      { kind: 'sl_source', connectionId: null, sourceName: 'mart_account_segments' },
      { kind: 'sl_entity', connectionId: 'warehouse', sourceName: 'mart_account_segments', entityName: 'segment' },
      { kind: 'table', connectionId: null, tableRef: 'analytics.mart_account_segments' },
    ]);
  });

  it('rejects stale inline-code semantic-layer references', async () => {
    const invalid = await findInvalidWikiBodyRefs({
      pageKey: 'account-segments',
      body: 'ARR is documented as `mart_account_segments.total_contract_arr_cents`.',
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => sources,
      tableExists: async () => true,
    });

    expect(invalid).toEqual([
      'account-segments: unknown semantic-layer entity mart_account_segments.total_contract_arr_cents',
    ]);
  });

  it('validates source, dimension, segment, measure, and table references', async () => {
    const invalid = await findInvalidWikiBodyRefs({
      pageKey: 'account-segments',
      body: [
        '`mart_account_segments.total_contract_arr`',
        '`mart_account_segments.segment`',
        '`mart_account_segments.enterprise`',
        '`source:mart_account_segments`',
        '`table:analytics.mart_account_segments`',
      ].join('\n'),
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => sources,
      tableExists: async (_connectionId, tableRef) => tableRef === 'analytics.mart_account_segments',
    });

    expect(invalid).toEqual([]);
  });
});
```

- [ ] **Step 2: Run failing wiki body reference tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/wiki-body-refs.test.ts
```

Expected: FAIL because `wiki-body-refs.ts` does not exist.

- [ ] **Step 3: Add parser and validator**

Create `packages/context/src/ingest/wiki-body-refs.ts`:

```ts
import type { SemanticLayerSource } from '../sl/index.js';

export type WikiBodyRef =
  | { kind: 'sl_entity'; connectionId: string | null; sourceName: string; entityName: string }
  | { kind: 'sl_source'; connectionId: string | null; sourceName: string }
  | { kind: 'table'; connectionId: string | null; tableRef: string };

export interface WikiBodyRefValidationInput {
  pageKey: string;
  body: string;
  visibleConnectionIds: string[];
  loadSources(connectionId: string): Promise<SemanticLayerSource[]>;
  tableExists(connectionId: string, tableRef: string): Promise<boolean>;
}

const inlineCodePattern = /`([^`\n]+)`/g;

function visibleLinesOutsideFences(body: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) {
      lines.push(line);
    }
  }
  return lines;
}

function parseConnectionScoped(value: string): { connectionId: string | null; body: string } {
  const slash = value.indexOf('/');
  if (slash <= 0) {
    return { connectionId: null, body: value };
  }
  return { connectionId: value.slice(0, slash), body: value.slice(slash + 1) };
}

export function parseWikiBodyRefs(body: string): WikiBodyRef[] {
  const refs: WikiBodyRef[] = [];
  for (const line of visibleLinesOutsideFences(body)) {
    for (const match of line.matchAll(inlineCodePattern)) {
      const token = (match[1] ?? '').trim();
      if (!token) {
        continue;
      }
      const scoped = parseConnectionScoped(token);
      if (scoped.body.startsWith('source:')) {
        const sourceName = scoped.body.slice('source:'.length).trim();
        if (sourceName) {
          refs.push({ kind: 'sl_source', connectionId: scoped.connectionId, sourceName });
        }
        continue;
      }
      if (scoped.body.startsWith('table:')) {
        const tableRef = scoped.body.slice('table:'.length).trim();
        if (tableRef) {
          refs.push({ kind: 'table', connectionId: scoped.connectionId, tableRef });
        }
        continue;
      }
      const parts = scoped.body.split('.');
      if (parts.length === 2 && parts[0] && parts[1]) {
        refs.push({
          kind: 'sl_entity',
          connectionId: scoped.connectionId,
          sourceName: parts[0],
          entityName: parts[1],
        });
      }
    }
  }
  return refs;
}

function entityNames(source: SemanticLayerSource): Set<string> {
  return new Set([
    ...(source.measures ?? []).map((measure) => measure.name),
    ...(source.columns ?? []).map((column) => column.name),
    ...(source.segments ?? []).map((segment) => segment.name),
  ]);
}

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

  for (const ref of parseWikiBodyRefs(input.body)) {
    const connectionIds = ref.connectionId ? [ref.connectionId] : input.visibleConnectionIds;
    if (ref.kind === 'table') {
      const found = await Promise.all(connectionIds.map((connectionId) => input.tableExists(connectionId, ref.tableRef)));
      if (!found.some(Boolean)) {
        errors.push(`${input.pageKey}: unknown raw table ${ref.connectionId ? `${ref.connectionId}/` : ''}${ref.tableRef}`);
      }
      continue;
    }

    let source: SemanticLayerSource | undefined;
    for (const connectionId of connectionIds) {
      source = (await loadSources(connectionId)).find((candidate) => candidate.name === ref.sourceName);
      if (source) {
        break;
      }
    }
    if (!source) {
      errors.push(`${input.pageKey}: unknown semantic-layer source ${ref.sourceName}`);
      continue;
    }
    if (ref.kind === 'sl_entity' && !entityNames(source).has(ref.entityName)) {
      errors.push(`${input.pageKey}: unknown semantic-layer entity ${ref.sourceName}.${ref.entityName}`);
    }
  }

  return errors;
}
```

- [ ] **Step 4: Run wiki body reference tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/wiki-body-refs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/context/src/ingest/wiki-body-refs.ts \
  packages/context/src/ingest/wiki-body-refs.test.ts
git commit -m "feat: validate wiki body semantic references"
```

---

### Task 4: Artifact gates and provenance validation

**Files:**
- Create: `packages/context/src/ingest/artifact-gates.ts`
- Create: `packages/context/src/ingest/artifact-gates.test.ts`

- [ ] **Step 1: Write failing artifact gate tests**

Create `packages/context/src/ingest/artifact-gates.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { validateFinalIngestArtifacts, validateProvenanceRawPaths } from './artifact-gates.js';

describe('artifact gates', () => {
  it('fails the final tree when wiki body references a stale semantic-layer measure', async () => {
    const wikiService = {
      readPage: vi.fn().mockResolvedValue({
        pageKey: 'account-segments',
        frontmatter: {
          summary: 'Account segments',
          usage_mode: 'auto',
          sl_refs: ['mart_account_segments'],
        },
        content: 'ARR is `mart_account_segments.total_contract_arr_cents`.',
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
        validateTouchedSources: async () => ({ invalidSources: [], validSources: ['mart_account_segments'] }),
        tableExists: async () => true,
      }),
    ).rejects.toThrow(/unknown semantic-layer entity mart_account_segments\.total_contract_arr_cents/);
  });

  it('fails before provenance insertion when a raw path cannot be tied to the current snapshot or eviction set', () => {
    expect(() =>
      validateProvenanceRawPaths({
        rows: [{ rawPath: 'cards/missing.json' }],
        currentRawPaths: new Set(['cards/present.json']),
        deletedRawPaths: new Set(['cards/deleted.json']),
      }),
    ).toThrow(/provenance row references raw path outside this snapshot: cards\/missing\.json/);
  });
});
```

- [ ] **Step 2: Run failing artifact gate tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/artifact-gates.test.ts
```

Expected: FAIL because `artifact-gates.ts` does not exist.

- [ ] **Step 3: Add artifact gate implementation**

Create `packages/context/src/ingest/artifact-gates.ts`:

```ts
import type { SemanticLayerService } from '../sl/index.js';
import type { TouchedSlSource } from '../tools/index.js';
import type { KnowledgeWikiService } from '../wiki/index.js';
import { findInvalidWikiBodyRefs } from './wiki-body-refs.js';

export interface TouchedValidationResult {
  invalidSources: string[];
  validSources: string[];
}

export interface FinalArtifactGateInput {
  connectionIds: string[];
  changedWikiPageKeys: string[];
  touchedSlSources: TouchedSlSource[];
  wikiService: KnowledgeWikiService;
  semanticLayerService: SemanticLayerService;
  validateTouchedSources(touched: TouchedSlSource[]): Promise<TouchedValidationResult>;
  tableExists(connectionId: string, tableRef: string): Promise<boolean>;
}

export interface ProvenanceRawPathValidationInput {
  rows: Array<{ rawPath: string }>;
  currentRawPaths: Set<string>;
  deletedRawPaths: Set<string>;
}

function bareSlRef(ref: string): string {
  const withoutConnection = ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref;
  return withoutConnection.split('.')[0] ?? withoutConnection;
}

async function validateWikiSlRefs(input: FinalArtifactGateInput): Promise<string[]> {
  const errors: string[] = [];
  const sourcesByConnection = new Map<string, Set<string>>();
  for (const connectionId of input.connectionIds) {
    const { sources } = await input.semanticLayerService.loadAllSources(connectionId);
    sourcesByConnection.set(connectionId, new Set(sources.map((source) => source.name)));
  }

  for (const pageKey of input.changedWikiPageKeys) {
    const page = await input.wikiService.readPage('GLOBAL', null, pageKey);
    if (!page) {
      continue;
    }
    for (const ref of page.frontmatter.sl_refs ?? []) {
      const sourceName = bareSlRef(ref);
      const connectionId = ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : null;
      const sourceSets = connectionId ? [sourcesByConnection.get(connectionId)] : [...sourcesByConnection.values()];
      if (!sourceSets.some((set) => set?.has(sourceName))) {
        errors.push(`${pageKey}: unknown sl_refs entry ${ref}`);
      }
    }
  }
  return errors;
}

export async function validateFinalIngestArtifacts(input: FinalArtifactGateInput): Promise<void> {
  const validation = await input.validateTouchedSources(input.touchedSlSources);
  const errors: string[] = validation.invalidSources.map((source) => `semantic-layer validation failed for ${source}`);
  errors.push(...(await validateWikiSlRefs(input)));

  for (const pageKey of input.changedWikiPageKeys) {
    const page = await input.wikiService.readPage('GLOBAL', null, pageKey);
    if (!page) {
      continue;
    }
    errors.push(
      ...(await findInvalidWikiBodyRefs({
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

  if (errors.length > 0) {
    throw new Error(`final artifact gates failed:\n${errors.join('\n')}`);
  }
}

export function validateProvenanceRawPaths(input: ProvenanceRawPathValidationInput): void {
  for (const row of input.rows) {
    if (!input.currentRawPaths.has(row.rawPath) && !input.deletedRawPaths.has(row.rawPath)) {
      throw new Error(`provenance row references raw path outside this snapshot: ${row.rawPath}`);
    }
  }
}
```

- [ ] **Step 4: Run artifact gate tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/artifact-gates.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/context/src/ingest/artifact-gates.ts \
  packages/context/src/ingest/artifact-gates.test.ts
git commit -m "feat: add final ingest artifact gates"
```

---

### Task 5: Isolated WorkUnit executor

**Files:**
- Create: `packages/context/src/ingest/isolated-diff/work-unit-executor.ts`
- Create: `packages/context/src/ingest/isolated-diff/work-unit-executor.test.ts`
- Modify: `packages/context/src/ingest/stages/stage-3-work-units.ts`

- [ ] **Step 1: Write failing isolated WorkUnit executor tests**

Create `packages/context/src/ingest/isolated-diff/work-unit-executor.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitService } from '../../core/index.js';
import { FileIngestTraceWriter } from '../ingest-trace.js';
import { runIsolatedWorkUnit } from './work-unit-executor.js';

async function makeGit() {
  const homeDir = await mkdtemp(join(tmpdir(), 'ktx-isolated-wu-'));
  const configDir = join(homeDir, 'config');
  const git = new GitService({
    storage: { configDir, homeDir },
    git: {
      userName: 'System User',
      userEmail: 'system@example.com',
      bootstrapMessage: 'init',
      bootstrapAuthor: 'system',
      bootstrapAuthorEmail: 'system@example.com',
    },
  });
  await git.onModuleInit();
  await mkdir(join(configDir, 'raw-sources/c1/fake/s'), { recursive: true });
  await writeFile(join(configDir, 'raw-sources/c1/fake/s/a.json'), '{}\n');
  await git.commitFiles(['raw-sources/c1/fake/s/a.json'], 'raw snapshot', 'System User', 'system@example.com');
  return { homeDir, configDir, git, baseSha: await git.revParseHead() };
}

describe('runIsolatedWorkUnit', () => {
  it('creates a child worktree at the ingestion base and persists a patch proposal', async () => {
    const { homeDir, git, baseSha } = await makeGit();
    const childDir = join(homeDir, '.worktrees/session-job-1-wu-1');
    const childGit = git.forWorktree(childDir);
    const sessionWorktreeService = {
      create: vi.fn(async (_key: string, startSha: string) => {
        await mkdir(join(homeDir, '.worktrees'), { recursive: true });
        await git.addWorktree(childDir, 'session/job-1-wu-1', startSha);
        return { chatId: 'job-1-wu-1', workdir: childDir, branch: 'session/job-1-wu-1', baseSha: startSha, createdAt: new Date(), git: childGit, config: {} };
      }),
      cleanup: vi.fn(async () => undefined),
    };
    const tracePath = join(homeDir, '.ktx/ingest-traces/job-1/trace.jsonl');
    const trace = new FileIngestTraceWriter({
      tracePath,
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
      run: async (child) => {
        await mkdir(join(child.workdir, 'wiki/global'), { recursive: true });
        await writeFile(join(child.workdir, 'wiki/global/a.md'), '---\nsummary: A\nusage_mode: auto\n---\n\nBody\n');
        await child.git.commitFiles(['wiki/global/a.md'], 'test: write wiki', 'KTX Test', 'system@ktx.local');
        return {
          unitKey: 'wu-1',
          status: 'success',
          preSha: baseSha,
          postSha: await child.git.revParseHead(),
          actions: [{ target: 'wiki', type: 'created', key: 'a', detail: 'A' }],
          touchedSlSources: [],
        };
      },
      workUnit: { unitKey: 'wu-1', rawFiles: ['a.json'], peerFileIndex: [], dependencyPaths: [] },
    });

    expect(sessionWorktreeService.create).toHaveBeenCalledWith('job-1-wu-1', baseSha);
    expect(sessionWorktreeService.cleanup).toHaveBeenCalledWith(expect.any(Object), 'success');
    expect(result.status).toBe('success');
    expect(result.patchPath).toContain('0000-wu-1.patch');
    await expect(readFile(result.patchPath, 'utf-8')).resolves.toContain('wiki/global/a.md');
    await expect(readFile(tracePath, 'utf-8')).resolves.toContain('work_unit_child_created');
  });
});
```

- [ ] **Step 2: Run failing isolated WorkUnit executor tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/work-unit-executor.test.ts
```

Expected: FAIL because `work-unit-executor.ts` does not exist.

- [ ] **Step 3: Add patch metadata to WorkUnitOutcome**

In `packages/context/src/ingest/stages/stage-3-work-units.ts`, extend
`WorkUnitOutcome`:

```ts
export interface WorkUnitOutcome {
  unitKey: string;
  status: 'success' | 'failed';
  reason?: string;
  preSha: string;
  postSha: string;
  actions: MemoryAction[];
  touchedSlSources: TouchedSlSource[];
  slDisallowed?: boolean;
  slDisallowedReason?: 'lookml_connection_mismatch';
  patchPath?: string;
  patchTouchedPaths?: string[];
  childWorktreePath?: string;
}
```

- [ ] **Step 4: Add isolated WorkUnit executor**

Create `packages/context/src/ingest/isolated-diff/work-unit-executor.ts`:

```ts
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionOutcome } from '../../core/index.js';
import type { IngestSessionWorktree, IngestSessionWorktreePort } from '../ports.js';
import type { WorkUnit } from '../types.js';
import type { IngestTraceWriter } from '../ingest-trace.js';
import type { WorkUnitOutcome } from '../stages/stage-3-work-units.js';
import { assertPatchAllowedForWorkUnit } from './git-patch.js';

export interface RunIsolatedWorkUnitInput {
  unitIndex: number;
  ingestionBaseSha: string;
  sessionWorktreeService: IngestSessionWorktreePort;
  patchDir: string;
  trace: IngestTraceWriter;
  workUnit: WorkUnit;
  run(child: IngestSessionWorktree): Promise<WorkUnitOutcome>;
}

function patchFileName(unitIndex: number, unitKey: string): string {
  const safeKey = unitKey.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  return `${String(unitIndex).padStart(4, '0')}-${safeKey}.patch`;
}

export async function runIsolatedWorkUnit(input: RunIsolatedWorkUnitInput): Promise<WorkUnitOutcome> {
  const sessionKey = `${input.trace.context.jobId}-${input.workUnit.unitKey}`;
  let cleanupOutcome: SessionOutcome = 'crash';
  const child = await input.sessionWorktreeService.create(sessionKey, input.ingestionBaseSha);
  await input.trace.event('debug', 'work_unit', 'work_unit_child_created', {
    unitKey: input.workUnit.unitKey,
    unitIndex: input.unitIndex,
    worktreePath: child.workdir,
    baseSha: input.ingestionBaseSha,
  });

  try {
    const outcome = await input.run(child);
    if (outcome.status !== 'success') {
      cleanupOutcome = 'crash';
      await input.trace.event('error', 'work_unit', 'work_unit_failed_before_patch', {
        unitKey: input.workUnit.unitKey,
        reason: outcome.reason ?? 'unknown failure',
      });
      return { ...outcome, childWorktreePath: child.workdir };
    }

    await mkdir(input.patchDir, { recursive: true });
    const patchPath = join(input.patchDir, patchFileName(input.unitIndex, input.workUnit.unitKey));
    await child.git.writeBinaryNoRenamePatch(input.ingestionBaseSha, 'HEAD', patchPath);
    const patch = await readFile(patchPath, 'utf-8');
    const touched = assertPatchAllowedForWorkUnit({
      unitKey: input.workUnit.unitKey,
      patch,
      slDisallowed: input.workUnit.slDisallowed === true,
    });
    cleanupOutcome = 'success';
    await input.trace.event('debug', 'work_unit', 'work_unit_patch_collected', {
      unitKey: input.workUnit.unitKey,
      patchPath,
      touchedPaths: touched.map((entry) => entry.path),
      patchBytes: Buffer.byteLength(patch),
    });
    return {
      ...outcome,
      patchPath,
      patchTouchedPaths: touched.map((entry) => entry.path),
      childWorktreePath: child.workdir,
    };
  } catch (error) {
    cleanupOutcome = 'crash';
    await input.trace.event(
      'error',
      'work_unit',
      'work_unit_child_failed',
      { unitKey: input.workUnit.unitKey, worktreePath: child.workdir },
      error,
    );
    throw error;
  } finally {
    await input.sessionWorktreeService.cleanup(child, cleanupOutcome);
    await input.trace.event('trace', 'work_unit', 'work_unit_child_cleanup', {
      unitKey: input.workUnit.unitKey,
      outcome: cleanupOutcome,
      worktreePath: child.workdir,
    });
  }
}
```

- [ ] **Step 5: Run isolated WorkUnit executor tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/work-unit-executor.test.ts src/ingest/stages/stage-3-work-units.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/ingest/isolated-diff/work-unit-executor.ts \
  packages/context/src/ingest/isolated-diff/work-unit-executor.test.ts \
  packages/context/src/ingest/stages/stage-3-work-units.ts
git commit -m "feat: execute ingest work units in child worktrees"
```

---

### Task 6: Patch integration and rollback

**Files:**
- Create: `packages/context/src/ingest/isolated-diff/patch-integrator.ts`
- Create: `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`

- [ ] **Step 1: Write failing patch integrator tests**

Create `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitService } from '../../core/index.js';
import { FileIngestTraceWriter } from '../ingest-trace.js';
import { integrateWorkUnitPatch } from './patch-integrator.js';

async function makeRepo() {
  const homeDir = await mkdtemp(join(tmpdir(), 'ktx-integrate-'));
  const configDir = join(homeDir, 'config');
  const git = new GitService({
    storage: { configDir, homeDir },
    git: {
      userName: 'System User',
      userEmail: 'system@example.com',
      bootstrapMessage: 'init',
      bootstrapAuthor: 'system',
      bootstrapAuthorEmail: 'system@example.com',
    },
  });
  await git.onModuleInit();
  await mkdir(join(configDir, 'wiki/global'), { recursive: true });
  await writeFile(join(configDir, 'wiki/global/a.md'), 'old\n');
  await git.commitFiles(['wiki/global/a.md'], 'base', 'System User', 'system@example.com');
  return { homeDir, configDir, git, baseSha: await git.revParseHead() };
}

describe('integrateWorkUnitPatch', () => {
  it('applies a clean patch, runs semantic gates, and commits accepted changes', async () => {
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    const childDir = join(homeDir, 'child');
    await git.addWorktree(childDir, 'child', baseSha);
    const childGit = git.forWorktree(childDir);
    await writeFile(join(childDir, 'wiki/global/a.md'), 'new\n');
    await childGit.commitFiles(['wiki/global/a.md'], 'edit', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/wu.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-1/trace.jsonl'),
      jobId: 'job-1',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-1',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'KTX Test', email: 'system@ktx.local' },
      validateAppliedTree: vi.fn().mockResolvedValue(undefined),
      slDisallowed: false,
    });

    expect(result.status).toBe('accepted');
    await expect(readFile(join(configDir, 'wiki/global/a.md'), 'utf-8')).resolves.toBe('new\n');
    await expect(readFile(trace.tracePath, 'utf-8')).resolves.toContain('patch_apply_finished');
  });

  it('rolls back and classifies semantic conflicts', async () => {
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    const childDir = join(homeDir, 'child-semantic');
    await git.addWorktree(childDir, 'child-semantic', baseSha);
    const childGit = git.forWorktree(childDir);
    await writeFile(join(childDir, 'wiki/global/a.md'), 'bad\n');
    await childGit.commitFiles(['wiki/global/a.md'], 'bad edit', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/bad.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-2/trace.jsonl'),
      jobId: 'job-2',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-bad',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'KTX Test', email: 'system@ktx.local' },
      validateAppliedTree: vi.fn().mockRejectedValue(new Error('final artifact gates failed')),
      slDisallowed: false,
    });

    expect(result.status).toBe('semantic_conflict');
    await expect(readFile(join(configDir, 'wiki/global/a.md'), 'utf-8')).resolves.toBe('old\n');
  });
});
```

- [ ] **Step 2: Run failing patch integrator tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/patch-integrator.test.ts
```

Expected: FAIL because `patch-integrator.ts` does not exist.

- [ ] **Step 3: Add patch integrator**

Create `packages/context/src/ingest/isolated-diff/patch-integrator.ts`:

```ts
import { readFile } from 'node:fs/promises';
import type { GitService } from '../../core/index.js';
import type { IngestTraceWriter } from '../ingest-trace.js';
import { traceTimed } from '../ingest-trace.js';
import { assertPatchAllowedForWorkUnit } from './git-patch.js';

export type PatchIntegrationResult =
  | { status: 'accepted'; commitSha: string; touchedPaths: string[] }
  | { status: 'textual_conflict'; reason: string; touchedPaths: string[] }
  | { status: 'semantic_conflict'; reason: string; touchedPaths: string[] };

export interface IntegrateWorkUnitPatchInput {
  unitKey: string;
  patchPath: string;
  integrationGit: GitService;
  trace: IngestTraceWriter;
  author: { name: string; email: string };
  slDisallowed: boolean;
  validateAppliedTree(touchedPaths: string[]): Promise<void>;
}

export async function integrateWorkUnitPatch(input: IntegrateWorkUnitPatchInput): Promise<PatchIntegrationResult> {
  const preApplyHead = await input.integrationGit.revParseHead();
  const patch = await readFile(input.patchPath, 'utf-8');
  const touched = assertPatchAllowedForWorkUnit({
    unitKey: input.unitKey,
    patch,
    slDisallowed: input.slDisallowed,
  });
  const touchedPaths = touched.map((entry) => entry.path);

  try {
    await traceTimed(input.trace, 'integration', 'patch_apply', { unitKey: input.unitKey, patchPath: input.patchPath, touchedPaths }, async () => {
      await input.integrationGit.applyPatchFile3WayIndex(input.patchPath);
      await input.integrationGit.assertWorktreeClean();
    });
  } catch (error) {
    if (preApplyHead) {
      await input.integrationGit.resetHardTo(preApplyHead);
    }
    await input.trace.event('error', 'integration', 'patch_textual_conflict', {
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      touchedPaths,
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      status: 'textual_conflict',
      reason: error instanceof Error ? error.message : String(error),
      touchedPaths,
    };
  }

  try {
    await traceTimed(input.trace, 'integration', 'semantic_gate', { unitKey: input.unitKey, touchedPaths }, async () => {
      await input.validateAppliedTree(touchedPaths);
    });
  } catch (error) {
    if (preApplyHead) {
      await input.integrationGit.resetHardTo(preApplyHead);
    }
    await input.trace.event('error', 'integration', 'patch_semantic_conflict', {
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      touchedPaths,
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      status: 'semantic_conflict',
      reason: error instanceof Error ? error.message : String(error),
      touchedPaths,
    };
  }

  const commit = await input.integrationGit.commitStaged(
    `ingest: accept WorkUnit ${input.unitKey}`,
    input.author.name,
    input.author.email,
  );
  await input.trace.event('debug', 'integration', 'patch_accepted', {
    unitKey: input.unitKey,
    commitSha: commit.commitHash,
    touchedPaths,
  });
  return { status: 'accepted', commitSha: commit.commitHash, touchedPaths };
}
```

- [ ] **Step 4: Run patch integrator tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/patch-integrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/context/src/ingest/isolated-diff/patch-integrator.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.test.ts
git commit -m "feat: integrate isolated work unit patches"
```

---

### Task 7: Runner-owned isolated-diff execution path

**Files:**
- Modify: `packages/context/src/ingest/types.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Modify: `packages/context/src/ingest/index.ts`

- [ ] **Step 1: Add deterministic projection hook to SourceAdapter**

In `packages/context/src/ingest/types.ts`, add these interfaces before
`SourceAdapter`:

```ts
export interface DeterministicProjectionContext {
  connectionId: string;
  sourceKey: string;
  syncId: string;
  jobId: string;
  runId: string;
  stagedDir: string;
  workdir: string;
  parseArtifacts?: unknown;
}

export interface ProjectionResult {
  warnings: string[];
  errors: string[];
  touchedSources: Array<{ connectionId: string; sourceName: string }>;
  changedWikiPageKeys: string[];
  result?: unknown;
}
```

Then add the optional adapter method:

```ts
  project?(ctx: DeterministicProjectionContext): Promise<ProjectionResult>;
```

Keep existing adapter fields unchanged.

- [ ] **Step 2: Add isolated-diff exports**

In `packages/context/src/ingest/index.ts`, export the new modules:

```ts
export * from './ingest-trace.js';
export * from './artifact-gates.js';
export * from './wiki-body-refs.js';
export * from './isolated-diff/git-patch.js';
export * from './isolated-diff/work-unit-executor.js';
export * from './isolated-diff/patch-integrator.js';
```

- [ ] **Step 3: Refactor shared runner helpers**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, add imports:

```ts
import { validateFinalIngestArtifacts, validateProvenanceRawPaths } from './artifact-gates.js';
import { FileIngestTraceWriter, type IngestTraceWriter, traceTimed } from './ingest-trace.js';
import { integrateWorkUnitPatch } from './isolated-diff/patch-integrator.js';
import { runIsolatedWorkUnit } from './isolated-diff/work-unit-executor.js';
```

Add these private helpers inside `IngestBundleRunner`:

```ts
  private isIsolatedDiffEnabled(sourceKey: string): boolean {
    return (this.deps.settings.isolatedDiffSourceKeys ?? []).includes(sourceKey);
  }

  private createTrace(job: IngestBundleJob): IngestTraceWriter {
    return new FileIngestTraceWriter({
      tracePath: this.deps.storage.resolveTracePath(job.jobId),
      jobId: job.jobId,
      connectionId: job.connectionId,
      sourceKey: job.sourceKey,
      level: this.deps.settings.ingestTraceLevel ?? 'debug',
    });
  }

  private wikiPageKeysFromPaths(paths: string[]): string[] {
    return [
      ...new Set(
        paths
          .filter((path) => path.startsWith('wiki/global/') && path.endsWith('.md'))
          .map((path) => path.slice('wiki/global/'.length, -'.md'.length)),
      ),
    ].sort();
  }

  private touchedSlSourcesFromPaths(paths: string[]): TouchedSlSource[] {
    return paths
      .filter((path) => path.startsWith('semantic-layer/') && path.endsWith('.yaml') && !path.includes('/_schema/'))
      .map((path) => {
        const [, connectionId, fileName] = path.split('/');
        return { connectionId: connectionId ?? '', sourceName: (fileName ?? '').replace(/\.yaml$/, '') };
      })
      .filter((source) => source.connectionId.length > 0 && source.sourceName.length > 0);
  }
```

- [ ] **Step 4: Add isolated branch after planning**

In `runInner()`, create the trace immediately after `syncId`:

```ts
    const trace = this.createTrace(job);
    await trace.event('info', 'run', 'ingest_started', {
      trigger: job.trigger,
      bundleRefKind: job.bundleRef.kind,
    });
```

After `runs.create()`, bind run and sync context:

```ts
      const runTrace = trace.withContext({ runId: runRow.id, syncId });
      await runTrace.event('debug', 'snapshot', 'input_snapshot', {
        baseSha,
        stagedDir,
        rawFileCount: currentHashes.size,
        rawDirInWorktree,
        diffSummary,
        scopeFingerprint: scopeDescriptor?.fingerprint ?? null,
      });
```

After `workUnits` are planned and `stageIndex` is initialized, branch:

```ts
      const isolatedDiffEnabled = !overrideReport && this.isIsolatedDiffEnabled(job.sourceKey);
      const isolatedDiffSummary = {
        enabled: isolatedDiffEnabled,
        integrationWorktreePath: isolatedDiffEnabled ? sessionWorktree.workdir : undefined,
        ingestionBaseSha: undefined as string | undefined,
        projectionSha: null as string | null,
        acceptedPatches: 0,
        textualConflicts: 0,
        semanticConflicts: 0,
      };
```

Replace only the current `if (!overrideReport) { ...run work units... }` block
with a two-path branch:

```ts
      if (!overrideReport && isolatedDiffEnabled) {
        await runTrace.event('info', 'routing', 'isolated_diff_enabled', {
          sourceKey: job.sourceKey,
          workUnitCount: workUnits.length,
          integrationWorktreePath: sessionWorktree.workdir,
        });

        let projectionTouchedSources: TouchedSlSource[] = [];
        let projectionChangedWikiPageKeys: string[] = [];
        if (adapter.project) {
          const projection = await traceTimed(
            runTrace,
            'projection',
            'deterministic_projection',
            { sourceKey: job.sourceKey },
            () =>
              adapter.project!({
                connectionId: job.connectionId,
                sourceKey: job.sourceKey,
                syncId,
                jobId: job.jobId,
                runId: runRow.id,
                stagedDir,
                workdir: sessionWorktree.workdir,
                parseArtifacts,
              }),
          );
          if (projection.errors.length > 0) {
            await this.deps.runs.markFailed(runRow.id);
            throw new Error(`deterministic projection failed: ${projection.errors.join('; ')}`);
          }
          projectionTouchedSources = projection.touchedSources;
          projectionChangedWikiPageKeys = projection.changedWikiPageKeys;
          const projectionCommit = await sessionWorktree.git.commitStaged(
            `ingest(${job.sourceKey}): deterministic projection syncId=${syncId}`,
            this.deps.storage.systemGitAuthor.name,
            this.deps.storage.systemGitAuthor.email,
          );
          isolatedDiffSummary.projectionSha = projectionCommit.created ? projectionCommit.commitHash : null;
        }

        const ingestionBaseSha = await sessionWorktree.git.revParseHead();
        isolatedDiffSummary.ingestionBaseSha = ingestionBaseSha;
        const patchDir = join(this.deps.storage.homeDir, 'ingest-patches', job.jobId);
        const workUnitSettings = {
          maxConcurrency: this.deps.settings.workUnitMaxConcurrency ?? 1,
          stepBudget: this.deps.settings.workUnitStepBudget ?? 40,
          failureMode: this.deps.settings.workUnitFailureMode ?? 'continue',
        };
        const limitWorkUnit = pLimit(workUnitSettings.maxConcurrency);
        const workUnitOutcomesByIndex: WorkUnitOutcome[] = [];
        let completedWorkUnits = 0;

        await Promise.all(
          workUnits.map((wu, index) =>
            limitWorkUnit(async () => {
              const outcome = await runIsolatedWorkUnit({
                unitIndex: index,
                ingestionBaseSha,
                sessionWorktreeService: this.deps.sessionWorktreeService,
                patchDir,
                trace: runTrace,
                workUnit: wu,
                run: async (child) => {
                  const scopedWikiService = this.deps.wikiService.forWorktree(child.workdir);
                  const scopedSemanticLayerService = this.deps.semanticLayerService.forWorktree(child.workdir);
                  return this.runWorkUnitInWorktree({
                    job,
                    wu,
                    worktree: child,
                    stagedDir,
                    contextReport,
                    ingestToolMetadata,
                    slConnectionIds,
                    wikiIndex,
                    slIndex,
                    priorProvenance: await this.deps.provenance.findLatestArtifactsForRawPaths(
                      job.connectionId,
                      job.sourceKey,
                      wu.rawFiles,
                    ),
                    scopedWikiService,
                    scopedSemanticLayerService,
                    baseFraming,
                    skillsPrompt,
                    canonicalPins,
                    workUnitSettings,
                    transcriptDir,
                    transcriptSummaries,
                    recordTranscriptEntry,
                    stageIndex,
                    currentTableExists: (tableRef) =>
                      this.tableRefExistsInSemanticLayer(scopedSemanticLayerService, slConnectionIds, tableRef),
                    onStepFinish: ({ stepIndex, stepBudget }) => {
                      memoryFlow?.emit({ type: 'work_unit_step', unitKey: wu.unitKey, stepIndex, stepBudget });
                    },
                  });
                },
              });
              workUnitOutcomesByIndex[index] = outcome;
              memoryFlow?.emit({
                type: 'work_unit_finished',
                unitKey: outcome.unitKey,
                status: outcome.status,
                ...(outcome.reason ? { reason: outcome.reason } : {}),
              });
              completedWorkUnits += 1;
              await stage3?.updateProgress(
                completedWorkUnits / workUnits.length,
                `${completedWorkUnits} of ${workUnits.length} work units complete`,
              );
            }),
          ),
        );

        workUnitOutcomes.push(...workUnitOutcomesByIndex.filter((outcome): outcome is WorkUnitOutcome => Boolean(outcome)));
        failedWorkUnits.push(...workUnitOutcomes.filter((outcome) => outcome.status === 'failed').map((outcome) => outcome.unitKey));
        stageIndex.workUnits = workUnitOutcomes.map((o) => ({
          unitKey: o.unitKey,
          rawFiles: workUnits.find((w) => w.unitKey === o.unitKey)?.rawFiles ?? [],
          status: o.status,
          reason: o.reason,
          actions: o.actions,
          touchedSlSources: o.touchedSlSources,
          slDisallowed: o.slDisallowed,
          slDisallowedReason: o.slDisallowedReason,
        }));

        for (const [index, outcome] of workUnitOutcomes.entries()) {
          if (outcome.status !== 'success' || !outcome.patchPath) {
            continue;
          }
          const wu = workUnits[index]!;
          const integration = await integrateWorkUnitPatch({
            unitKey: outcome.unitKey,
            patchPath: outcome.patchPath,
            integrationGit: sessionWorktree.git,
            trace: runTrace,
            author: this.deps.storage.systemGitAuthor,
            slDisallowed: wu.slDisallowed === true,
            validateAppliedTree: async (touchedPaths) => {
              await validateFinalIngestArtifacts({
                connectionIds: slConnectionIds,
                changedWikiPageKeys: this.wikiPageKeysFromPaths(touchedPaths),
                touchedSlSources: this.touchedSlSourcesFromPaths(touchedPaths),
                wikiService: this.deps.wikiService.forWorktree(sessionWorktree.workdir),
                semanticLayerService: this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
                validateTouchedSources: (touched) =>
                  validateWuTouchedSources({
                    semanticLayerService: this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
                    connections: this.deps.connections,
                    configService: sessionWorktree.config,
                    gitService: sessionWorktree.git,
                    slSourcesRepository: this.deps.slSourcesRepository,
                    probeRowCount: this.deps.settings.probeRowCount,
                    slValidator: this.deps.slValidator,
                  }, touched),
                tableExists: (connectionId, tableRef) =>
                  this.tableRefExistsInSemanticLayer(
                    this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
                    [connectionId],
                    tableRef,
                  ),
              });
            },
          });
          if (integration.status === 'textual_conflict') {
            isolatedDiffSummary.textualConflicts += 1;
            await this.deps.runs.markFailed(runRow.id);
            cleanupOutcome = 'conflict';
            throw new Error(`isolated diff textual conflict in ${outcome.unitKey}: ${integration.reason}`);
          }
          if (integration.status === 'semantic_conflict') {
            isolatedDiffSummary.semanticConflicts += 1;
            await this.deps.runs.markFailed(runRow.id);
            cleanupOutcome = 'conflict';
            throw new Error(`isolated diff semantic conflict in ${outcome.unitKey}: ${integration.reason}`);
          }
          isolatedDiffSummary.acceptedPatches += 1;
        }

        await validateFinalIngestArtifacts({
          connectionIds: slConnectionIds,
          changedWikiPageKeys: [
            ...new Set([
              ...projectionChangedWikiPageKeys,
              ...workUnitOutcomes.flatMap((outcome) => outcome.patchTouchedPaths ?? []).flatMap((path) => this.wikiPageKeysFromPaths([path])),
            ]),
          ],
          touchedSlSources: [
            ...projectionTouchedSources,
            ...workUnitOutcomes.flatMap((outcome) => outcome.touchedSlSources),
          ],
          wikiService: this.deps.wikiService.forWorktree(sessionWorktree.workdir),
          semanticLayerService: this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
          validateTouchedSources: (touched) =>
            validateWuTouchedSources({
              semanticLayerService: this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
              connections: this.deps.connections,
              configService: sessionWorktree.config,
              gitService: sessionWorktree.git,
              slSourcesRepository: this.deps.slSourcesRepository,
              probeRowCount: this.deps.settings.probeRowCount,
              slValidator: this.deps.slValidator,
            }, touched),
          tableExists: (connectionId, tableRef) =>
            this.tableRefExistsInSemanticLayer(
              this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
              [connectionId],
              tableRef,
            ),
        });
      } else if (!overrideReport) {
        await runTrace.event('info', 'routing', 'shared_worktree_path_enabled', { sourceKey: job.sourceKey });
        // Keep the existing shared-worktree WorkUnit block here unchanged.
      }
```

Extract the existing inner `runSingleWorkUnit()` implementation into a private
method named `runWorkUnitInWorktree()` before this replacement. Its code is the
current body of `runSingleWorkUnit()` with these explicit parameters:

```ts
  private async runWorkUnitInWorktree(input: {
    job: IngestBundleJob;
    wu: WorkUnit;
    worktree: IngestSessionWorktree;
    stagedDir: string;
    contextReport: ContextEvidenceIndexSummary | null;
    ingestToolMetadata: { runId: string; jobId: string; syncId: string; sourceKey: string };
    slConnectionIds: string[];
    wikiIndex: string;
    slIndex: string;
    priorProvenance: Map<string, IngestProvenanceRow[]>;
    scopedWikiService: ReturnType<KnowledgeWikiService['forWorktree']>;
    scopedSemanticLayerService: ReturnType<SemanticLayerService['forWorktree']>;
    baseFraming: string;
    skillsPrompt: string;
    canonicalPins: CanonicalPin[];
    workUnitSettings: { maxConcurrency: number; stepBudget: number; failureMode: 'abort' | 'continue' };
    transcriptDir: string;
    transcriptSummaries: Map<string, MutableToolTranscriptSummary>;
    recordTranscriptEntry(path: string): (entry: ToolCallLogEntry) => void;
    stageIndex: StageIndex;
    currentTableExists(tableRef: string): Promise<boolean>;
    onStepFinish?: (info: { stepIndex: number; stepBudget: number }) => void;
  }): Promise<WorkUnitOutcome>
```

The method must preserve the current tool sessions, transcript wrapping, skill
loading behavior, unmapped fallback behavior, `validateWikiRefs`, and
`validateTouchedSources`. The only value changes are:

- Use `input.worktree.workdir`, `input.worktree.git`, and
  `input.worktree.config`.
- Use `input.scopedWikiService` and `input.scopedSemanticLayerService`.
- Use `input.priorProvenance` instead of loading it inside the method.
- Use `input.onStepFinish`.

- [ ] **Step 5: Add report trace and isolated summary**

In the final `reportBody`, add:

```ts
        tracePath: runTrace.tracePath,
        isolatedDiff: isolatedDiffEnabled ? isolatedDiffSummary : undefined,
```

Before provenance insertion, replace unknown-hash fallback with validation:

```ts
      validateProvenanceRawPaths({
        rows: provenanceRows,
        currentRawPaths: new Set(currentHashes.keys()),
        deletedRawPaths: new Set(eviction?.deletedRawPaths ?? []),
      });
```

Then change:

```ts
const hash = currentHashes.get(rawPath) ?? 'unknown';
```

to:

```ts
const hash = currentHashes.get(rawPath) ?? '';
```

for action and artifact-resolution provenance. The validation above guarantees
that non-eviction rows from current actions have a current hash.

At the end of a successful run, before `return`, add:

```ts
      await runTrace.event('info', 'run', 'ingest_finished', {
        status: 'completed',
        commitSha,
        failedWorkUnits,
        tracePath: runTrace.tracePath,
      });
```

In the outer `catch` path in `run()`, add a trace event if `runInner()` throws
after trace creation by wrapping `runInner()` errors inside `runInner()`:

```ts
    } catch (error) {
      await trace.event('error', 'run', 'ingest_failed', {
        tracePath: trace.tracePath,
      }, error);
      throw error;
    }
```

Place that catch around the body of `runInner()` after `const trace =
this.createTrace(job);`.

- [ ] **Step 6: Run focused runner tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/ingest-bundle.runner.test.ts \
  src/ingest/ingest-trace.test.ts \
  src/ingest/artifact-gates.test.ts \
  src/ingest/isolated-diff/work-unit-executor.test.ts \
  src/ingest/isolated-diff/patch-integrator.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/context/src/ingest/types.ts \
  packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/index.ts
git commit -m "feat: route selected ingest sources through isolated diffs"
```

---

### Task 8: V1 regression coverage and Metabase rollout

**Files:**
- Create: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.ts`

- [ ] **Step 1: Write isolated-diff regression tests**

Create `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`
with these six tests:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitService, SessionWorktreeService } from '../core/index.js';
import { LocalGitFileStore } from '../project/local-git-file-store.js';
import { addTouchedSlSource } from '../tools/index.js';
import { IngestBundleRunner } from './ingest-bundle.runner.js';
import type { IngestBundleRunnerDeps } from './ports.js';

async function makeRealGitRuntime() {
  const homeDir = await mkdtemp(join(tmpdir(), 'ktx-isolated-runner-'));
  const configDir = join(homeDir, 'config');
  const git = new GitService({
    storage: { configDir, homeDir },
    git: {
      userName: 'System User',
      userEmail: 'system@example.com',
      bootstrapMessage: 'init',
      bootstrapAuthor: 'system',
      bootstrapAuthorEmail: 'system@example.com',
    },
  });
  await git.onModuleInit();
  const configService = new LocalGitFileStore(configDir);
  const sessionWorktreeService = new SessionWorktreeService({
    coreConfig: {
      storage: { configDir, homeDir },
      git: {
        userName: 'System User',
        userEmail: 'system@example.com',
        bootstrapMessage: 'init',
        bootstrapAuthor: 'system',
        bootstrapAuthorEmail: 'system@example.com',
      },
    },
    gitService: git,
    configService,
  });
  return { homeDir, configDir, git, configService, sessionWorktreeService };
}

function makeDeps(runtime: Awaited<ReturnType<typeof makeRealGitRuntime>>) {
  const adapter = {
    source: 'metabase',
    skillNames: [],
    detect: vi.fn().mockResolvedValue(true),
    chunk: vi.fn().mockResolvedValue({
      workUnits: [
        { unitKey: 'card-wiki', rawFiles: ['cards/wiki.json'], peerFileIndex: [], dependencyPaths: [] },
        { unitKey: 'card-source', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] },
      ],
    }),
  };
  const scopedWikiService = {
    readPage: vi.fn(async (_scope: string, _scopeId: string | null, key: string) => {
      const path = join(runtime.configDir, 'wiki/global', `${key}.md`);
      const raw = await readFile(path, 'utf-8').catch(() => null);
      if (!raw) return null;
      const [, yaml = '', content = ''] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw) ?? [];
      const slRefs = /sl_refs:\n((?:  - .+\n?)*)/.exec(yaml)?.[1]?.split('\n').map((line) => line.trim().replace(/^- /, '')).filter(Boolean) ?? [];
      return { pageKey: key, frontmatter: { summary: key, usage_mode: 'auto', sl_refs: slRefs }, content: content.trim() };
    }),
    listPageKeys: vi.fn().mockResolvedValue(['account-segments']),
  };
  const semanticLayerService = {
    forWorktree: vi.fn(() => semanticLayerService),
    loadAllSources: vi.fn(async () => {
      const raw = await readFile(join(runtime.configDir, 'semantic-layer/warehouse/mart_account_segments.yaml'), 'utf-8').catch(() => '');
      const hasCents = raw.includes('total_contract_arr_cents');
      return {
        sources: [
          {
            name: 'mart_account_segments',
            grain: ['account_id'],
            columns: [{ name: 'account_id', type: 'string' }],
            joins: [],
            measures: [{ name: hasCents ? 'total_contract_arr_cents' : 'total_contract_arr', expr: 'sum(contract_arr)' }],
            table: 'analytics.mart_account_segments',
          },
        ],
        loadErrors: [],
      };
    }),
    listFilesForConnection: vi.fn().mockResolvedValue(['mart_account_segments.yaml']),
  };
  const deps: IngestBundleRunnerDeps = {
    runs: { create: vi.fn().mockResolvedValue({ id: 'run-1' }), markCompleted: vi.fn(), markFailed: vi.fn() },
    provenance: { insertMany: vi.fn(), findLatestHashesForCompletedSyncs: vi.fn().mockResolvedValue(new Map()), findLatestArtifactsForRawPaths: vi.fn().mockResolvedValue(new Map()) },
    reports: { create: vi.fn().mockResolvedValue({ id: 'report-1' }), findByJobId: vi.fn().mockResolvedValue(null), markSuperseded: vi.fn() },
    canonicalPins: { listPins: vi.fn().mockResolvedValue([]) },
    registry: { get: vi.fn().mockReturnValue(adapter), register: vi.fn(), has: vi.fn(), list: vi.fn() },
    diffSetService: { compute: vi.fn().mockResolvedValue({ added: ['cards/wiki.json', 'cards/source.json'], modified: [], deleted: [], unchanged: [] }) },
    sessionWorktreeService: runtime.sessionWorktreeService,
    agentRunner: { runLoop: vi.fn() },
    gitService: runtime.git,
    lockingService: { withLock: vi.fn(async (_key, fn) => fn()) },
    storage: {
      homeDir: join(runtime.configDir, '.ktx'),
      systemGitAuthor: { name: 'KTX Test', email: 'system@ktx.local' },
      resolveUploadDir: (id) => join(runtime.homeDir, 'upload', id),
      resolvePullDir: (id) => join(runtime.homeDir, 'pull', id),
      resolveTranscriptDir: (id) => join(runtime.configDir, '.ktx/ingest-transcripts', id),
      resolveTracePath: (id) => join(runtime.configDir, '.ktx/ingest-traces', id, 'trace.jsonl'),
    },
    settings: { memoryIngestionModel: 'test', probeRowCount: 1, isolatedDiffSourceKeys: ['metabase'], ingestTraceLevel: 'trace' },
    skillsRegistry: { listSkills: vi.fn().mockResolvedValue([]), getSkill: vi.fn().mockResolvedValue(null), buildSkillsPrompt: vi.fn().mockReturnValue(''), stripFrontmatter: vi.fn((body) => body) },
    promptService: { loadPrompt: vi.fn().mockResolvedValue('base') },
    wikiService: { forWorktree: vi.fn(() => scopedWikiService), readPage: scopedWikiService.readPage, syncFromCommit: vi.fn() },
    knowledgeIndex: { listPagesForUser: vi.fn().mockResolvedValue([]) },
    knowledgeSlRefs: { syncFromWiki: vi.fn() },
    semanticLayerService: semanticLayerService as never,
    slSearchService: { indexSources: vi.fn() },
    slSourcesRepository: {},
    slValidator: { validateSingleSource: vi.fn().mockResolvedValue({ errors: [], warnings: [] }) },
    connections: { listEnabledConnections: vi.fn().mockResolvedValue([]), getConnectionById: vi.fn() } as never,
    toolsetFactory: { createIngestWuToolset: vi.fn(() => ({ toRuntimeTools: vi.fn(() => ({})) })) },
    commitMessages: { enqueueForExternalCommit: vi.fn() },
  };
  return { deps, adapter };
}

describe('IngestBundleRunner isolated diff path', () => {
  it('rejects the Metabase stale-measure wiki body regression before squash', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps } = makeDeps(runtime);
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags.unitKey === 'card-wiki') {
          await mkdir(join(currentSession.configService.rootDir ?? runtime.configDir, 'semantic-layer/warehouse'), { recursive: true });
          await mkdir(join(currentSession.configService.rootDir ?? runtime.configDir, 'wiki/global'), { recursive: true });
          await writeFile(
            join(currentSession.configService.rootDir ?? runtime.configDir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
            'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr_cents\n    expr: sum(contract_arr)\n',
          );
          await writeFile(
            join(currentSession.configService.rootDir ?? runtime.configDir, 'wiki/global/account-segments.md'),
            '---\nsummary: Account segments\nusage_mode: auto\nsl_refs:\n  - mart_account_segments\n---\n\nARR is `mart_account_segments.total_contract_arr_cents`.\n',
          );
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
          currentSession.actions.push({ target: 'wiki', type: 'created', key: 'account-segments', detail: 'Account segments' });
          currentSession.actions.push({ target: 'sl', type: 'created', key: 'mart_account_segments', detail: 'Cents measure', targetConnectionId: 'warehouse' });
          await currentSession.gitService.commitFiles(['semantic-layer/warehouse/mart_account_segments.yaml', 'wiki/global/account-segments.md'], 'wu wiki', 'KTX Test', 'system@ktx.local');
        }
        if (params.telemetryTags.unitKey === 'card-source') {
          await mkdir(join(currentSession.configService.rootDir ?? runtime.configDir, 'semantic-layer/warehouse'), { recursive: true });
          await writeFile(
            join(currentSession.configService.rootDir ?? runtime.configDir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
            'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
          );
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
          currentSession.actions.push({ target: 'sl', type: 'updated', key: 'mart_account_segments', detail: 'Dollar measure', targetConnectionId: 'warehouse' });
          await currentSession.gitService.commitFiles(['semantic-layer/warehouse/mart_account_segments.yaml'], 'wu source', 'KTX Test', 'system@ktx.local');
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      (runner as any).resolveStagedDir = vi.fn().mockResolvedValue(join(runtime.homeDir, 'stage'));
      (runner as any).stageRawFilesStage1 = vi.fn(async ({ worktreeRoot }: any) => {
        const rawDir = join(worktreeRoot, 'raw-sources/warehouse/metabase/s');
        await mkdir(rawDir, { recursive: true });
        await writeFile(join(rawDir, 'wiki.json'), '{}');
        await writeFile(join(rawDir, 'source.json'), '{}');
        return { currentHashes: new Map([['cards/wiki.json', 'h1'], ['cards/source.json', 'h2']]), rawDirInWorktree: 'raw-sources/warehouse/metabase/s' };
      });

      await expect(
        runner.run({ jobId: 'job-1', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/total_contract_arr_cents/);
      await expect(readFile(join(runtime.configDir, '.ktx/ingest-traces/job-1/trace.jsonl'), 'utf-8')).resolves.toContain('patch_semantic_conflict');
      expect(deps.gitService.squashMergeIntoMain).toBeDefined();
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

});
```

Add these five additional `it()` blocks inside the same `describe()` block.
They use the same `makeRealGitRuntime()` and `makeDeps()` helpers from the
first test:

```ts
  it('accepts two isolated work units that edit different wiki pages', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'page-a', rawFiles: ['pages/a.json'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'page-b', rawFiles: ['pages/b.json'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const unitKey = params.telemetryTags.unitKey;
        await mkdir(join(currentSession.configService.rootDir ?? runtime.configDir, 'wiki/global'), { recursive: true });
        await writeFile(
          join(currentSession.configService.rootDir ?? runtime.configDir, `wiki/global/${unitKey}.md`),
          `---\nsummary: ${unitKey}\nusage_mode: auto\n---\n\n${unitKey}\n`,
        );
        currentSession.actions.push({ target: 'wiki', type: 'created', key: unitKey, detail: unitKey });
        await currentSession.gitService.commitFiles([`wiki/global/${unitKey}.md`], `wu ${unitKey}`, 'KTX Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      (runner as any).resolveStagedDir = vi.fn().mockResolvedValue(join(runtime.homeDir, 'stage'));
      (runner as any).stageRawFilesStage1 = vi.fn(async ({ worktreeRoot }: any) => {
        const rawDir = join(worktreeRoot, 'raw-sources/warehouse/metabase/s');
        await mkdir(rawDir, { recursive: true });
        await writeFile(join(rawDir, 'a.json'), '{}');
        await writeFile(join(rawDir, 'b.json'), '{}');
        return { currentHashes: new Map([['pages/a.json', 'h1'], ['pages/b.json', 'h2']]), rawDirInWorktree: 'raw-sources/warehouse/metabase/s' };
      });

      const result = await runner.run({ jobId: 'job-clean', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } });
      expect(result.failedWorkUnits).toEqual([]);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-clean/trace.jsonl'), 'utf-8');
      expect(trace.match(/patch_accepted/g)).toHaveLength(2);
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('classifies same-source patch application failure as a textual conflict', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'orders-a', rawFiles: ['orders/a.json'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'orders-b', rawFiles: ['orders/b.json'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const suffix = params.telemetryTags.unitKey === 'orders-a' ? 'a' : 'b';
        await mkdir(join(currentSession.configService.rootDir ?? runtime.configDir, 'semantic-layer/warehouse'), { recursive: true });
        await writeFile(
          join(currentSession.configService.rootDir ?? runtime.configDir, 'semantic-layer/warehouse/orders.yaml'),
          `name: orders\ngrain: [id]\ncolumns: [{name: id, type: string}]\njoins: []\nmeasures:\n  - name: order_count_${suffix}\n    expr: count(*)\n`,
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'orders');
        currentSession.actions.push({ target: 'sl', type: 'updated', key: 'orders', detail: suffix, targetConnectionId: 'warehouse' });
        await currentSession.gitService.commitFiles(['semantic-layer/warehouse/orders.yaml'], `wu ${suffix}`, 'KTX Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      (runner as any).resolveStagedDir = vi.fn().mockResolvedValue(join(runtime.homeDir, 'stage'));
      (runner as any).stageRawFilesStage1 = vi.fn(async ({ worktreeRoot }: any) => {
        const rawDir = join(worktreeRoot, 'raw-sources/warehouse/metabase/s');
        await mkdir(rawDir, { recursive: true });
        return { currentHashes: new Map([['orders/a.json', 'h1'], ['orders/b.json', 'h2']]), rawDirInWorktree: 'raw-sources/warehouse/metabase/s' };
      });

      await expect(
        runner.run({ jobId: 'job-text-conflict', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/isolated diff textual conflict/);
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('makes deterministic projection visible to child worktrees before WorkUnit synthesis', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'wiki-projected', rawFiles: ['projected/wiki.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      adapter.project = vi.fn(async ({ workdir }) => {
        await mkdir(join(workdir, 'semantic-layer/warehouse'), { recursive: true });
        await writeFile(
          join(workdir, 'semantic-layer/warehouse/projected_orders.yaml'),
          'name: projected_orders\ngrain: [id]\ncolumns: [{name: id, type: string}]\njoins: []\nmeasures:\n  - name: order_count\n    expr: count(*)\n',
        );
        return { warnings: [], errors: [], touchedSources: [{ connectionId: 'warehouse', sourceName: 'projected_orders' }], changedWikiPageKeys: [], result: { sourcesCreated: 1 } };
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        await expect(
          readFile(join(currentSession.configService.rootDir ?? runtime.configDir, 'semantic-layer/warehouse/projected_orders.yaml'), 'utf-8'),
        ).resolves.toContain('order_count');
        await mkdir(join(currentSession.configService.rootDir ?? runtime.configDir, 'wiki/global'), { recursive: true });
        await writeFile(
          join(currentSession.configService.rootDir ?? runtime.configDir, 'wiki/global/projected-orders.md'),
          '---\nsummary: Projected orders\nusage_mode: auto\nsl_refs:\n  - projected_orders\n---\n\nBad ref `projected_orders.missing_measure`.\n',
        );
        currentSession.actions.push({ target: 'wiki', type: 'created', key: 'projected-orders', detail: 'Projected orders' });
        await currentSession.gitService.commitFiles(['wiki/global/projected-orders.md'], 'wu projected wiki', 'KTX Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      (runner as any).resolveStagedDir = vi.fn().mockResolvedValue(join(runtime.homeDir, 'stage'));
      (runner as any).stageRawFilesStage1 = vi.fn(async ({ worktreeRoot }: any) => {
        const rawDir = join(worktreeRoot, 'raw-sources/warehouse/metabase/s');
        await mkdir(rawDir, { recursive: true });
        return { currentHashes: new Map([['projected/wiki.json', 'h1']]), rawDirInWorktree: 'raw-sources/warehouse/metabase/s' };
      });

      await expect(
        runner.run({ jobId: 'job-projection', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/projected_orders\.missing_measure/);
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('rejects Notion-style changed wiki pages with invalid sl_refs', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'notion-page', rawFiles: ['pages/notion.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        await mkdir(join(currentSession.configService.rootDir ?? runtime.configDir, 'wiki/global'), { recursive: true });
        await writeFile(
          join(currentSession.configService.rootDir ?? runtime.configDir, 'wiki/global/notion-page.md'),
          '---\nsummary: Notion page\nusage_mode: auto\nsl_refs:\n  - missing_source\n---\n\nBody\n',
        );
        currentSession.actions.push({ target: 'wiki', type: 'created', key: 'notion-page', detail: 'Notion page' });
        await currentSession.gitService.commitFiles(['wiki/global/notion-page.md'], 'wu notion', 'KTX Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      (runner as any).resolveStagedDir = vi.fn().mockResolvedValue(join(runtime.homeDir, 'stage'));
      (runner as any).stageRawFilesStage1 = vi.fn(async () => ({ currentHashes: new Map([['pages/notion.json', 'h1']]), rawDirInWorktree: 'raw-sources/warehouse/metabase/s' }));

      await expect(
        runner.run({ jobId: 'job-invalid-slrefs', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/unknown sl_refs entry missing_source/);
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('rejects slDisallowed patches that touch semantic-layer files', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'lookml-mismatch', rawFiles: ['views/orders.lkml'], peerFileIndex: [], dependencyPaths: [], slDisallowed: true, slDisallowedReason: 'lookml_connection_mismatch' }],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        await mkdir(join(currentSession.configService.rootDir ?? runtime.configDir, 'semantic-layer/warehouse'), { recursive: true });
        await writeFile(
          join(currentSession.configService.rootDir ?? runtime.configDir, 'semantic-layer/warehouse/orders.yaml'),
          'name: orders\ngrain: [id]\ncolumns: [{name: id, type: string}]\njoins: []\nmeasures: []\n',
        );
        currentSession.actions.push({ target: 'sl', type: 'created', key: 'orders', detail: 'forbidden', targetConnectionId: 'warehouse' });
        await currentSession.gitService.commitFiles(['semantic-layer/warehouse/orders.yaml'], 'forbidden sl', 'KTX Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      (runner as any).resolveStagedDir = vi.fn().mockResolvedValue(join(runtime.homeDir, 'stage'));
      (runner as any).stageRawFilesStage1 = vi.fn(async () => ({ currentHashes: new Map([['views/orders.lkml', 'h1']]), rawDirInWorktree: 'raw-sources/warehouse/metabase/s' }));

      await expect(
        runner.run({ jobId: 'job-sl-disallowed', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/slDisallowed WorkUnit lookml-mismatch touched semantic-layer\/warehouse\/orders.yaml/);
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run failing isolated regression tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts
```

Expected: FAIL until the runner branch from Task 7 is complete.

- [ ] **Step 3: Confirm Metabase remains privately allowlisted**

In `packages/context/src/ingest/local-bundle-runtime.ts`, verify settings still
include:

```ts
      isolatedDiffSourceKeys: ['metabase'],
```

Do not add a public `executionMode`, `planningStrategy`, or `conflictPolicy`
adapter field. Do not add a CLI flag.

- [ ] **Step 4: Run isolated regression tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts
```

Expected: PASS. The trace file assertions must prove that the run records input
snapshot, routing decision, WorkUnit child creation, patch collection, patch
application, semantic gate result, rollback/conflict events for failing cases,
and final run outcome.

- [ ] **Step 5: Commit**

```bash
git add packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  packages/context/src/ingest/local-bundle-runtime.ts
git commit -m "test: cover isolated diff ingestion regressions"
```

---

### Task 9: Final verification and observability acceptance

**Files:**
- Modify: no source files unless checks identify issues.

- [ ] **Step 1: Run focused context tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/core/git.service.patch.test.ts \
  src/ingest/ingest-trace.test.ts \
  src/ingest/wiki-body-refs.test.ts \
  src/ingest/artifact-gates.test.ts \
  src/ingest/isolated-diff/git-patch.test.ts \
  src/ingest/isolated-diff/work-unit-executor.test.ts \
  src/ingest/isolated-diff/patch-integrator.test.ts \
  src/ingest/ingest-bundle.runner.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Run package tests**

Run:

```bash
pnpm --filter @ktx/context run test
```

Expected: PASS. If this produces too much output, capture it:

```bash
pnpm --filter @ktx/context run test 2>&1 | tee /tmp/ktx-context-isolated-diff-tests.log
```

Then inspect the failing section in `/tmp/ktx-context-isolated-diff-tests.log`.

- [ ] **Step 4: Run dead-code check**

Run:

```bash
pnpm run dead-code
```

Expected: PASS. Investigate any new Knip findings before adding ignores.

- [ ] **Step 5: Run pre-commit for changed TypeScript files**

Run:

```bash
uv run pre-commit run --files \
  packages/context/src/core/git.service.ts \
  packages/context/src/core/git.service.patch.test.ts \
  packages/context/src/ingest/ingest-trace.ts \
  packages/context/src/ingest/ingest-trace.test.ts \
  packages/context/src/ingest/wiki-body-refs.ts \
  packages/context/src/ingest/wiki-body-refs.test.ts \
  packages/context/src/ingest/artifact-gates.ts \
  packages/context/src/ingest/artifact-gates.test.ts \
  packages/context/src/ingest/isolated-diff/git-patch.ts \
  packages/context/src/ingest/isolated-diff/git-patch.test.ts \
  packages/context/src/ingest/isolated-diff/work-unit-executor.ts \
  packages/context/src/ingest/isolated-diff/work-unit-executor.test.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.test.ts \
  packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  packages/context/src/ingest/types.ts \
  packages/context/src/ingest/ports.ts \
  packages/context/src/ingest/local-bundle-runtime.ts \
  packages/context/src/ingest/reports.ts \
  packages/context/src/ingest/report-snapshot.ts \
  packages/context/src/ingest/index.ts \
  packages/cli/src/ingest.ts
```

Expected: PASS. If `pre-commit` is unavailable or the configured hook
environment cannot run, record the exact error and rely on the focused tests,
type-check, dead-code, and `git diff --check`.

- [ ] **Step 6: Verify trace usefulness manually**

Run one isolated regression and inspect the trace:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts -t "rejects the Metabase stale-measure wiki body regression before squash"
```

Expected: PASS. Open the test-created
`.ktx/ingest-traces/job-1/trace.jsonl` path printed by the failed-run assertion
or test output. Confirm it includes these events:

- `ingest_started`
- `input_snapshot`
- `isolated_diff_enabled`
- `work_unit_child_created`
- `work_unit_patch_collected`
- `patch_apply_started`
- `semantic_gate_failed` or `patch_semantic_conflict`
- `ingest_failed`

The trace must include `jobId`, `runId`, `syncId`, `connectionId`,
`sourceKey`, `unitKey` where applicable, worktree paths, patch paths, touched
paths, durations, error messages, and final status.

- [ ] **Step 7: Commit final fixes**

```bash
git status --short
git add packages/context/src packages/cli/src
git commit -m "feat: add isolated diff ingestion v1 core"
```

---

## Self-review

Spec coverage:

- Per-WorkUnit child worktrees, patch proposals, deterministic integration,
  `slDisallowed` integration rejection, and fail-fast textual or semantic
  conflicts are covered by Tasks 2, 5, 6, 7, and 8.
- The Metabase stale `total_contract_arr_cents` regression is covered by
  Task 8.
- Deterministic projection before child worktree creation is covered by Task 7
  and the hybrid projection test in Task 8.
- Final global wiki body, wiki `sl_refs`, semantic-layer, and provenance gates
  are covered by Tasks 3, 4, 7, and 8.
- Persistent postmortem observability is covered by Task 1 and required in every
  ingestion task's acceptance checks. Task 9 explicitly verifies trace
  usefulness from logs alone.

Placeholder scan:

- The implementation tasks contain exact file paths, commands, expected
  results, and concrete code snippets.
- Task 8 contains concrete regression assertions for the Metabase incident,
  clean integration, textual conflict, hybrid projection, invalid `sl_refs`, and
  `slDisallowed` rejection.

Type consistency:

- `IngestTraceWriter`, `IngestTraceLevel`, `ProjectionResult`,
  `DeterministicProjectionContext`, `WorkUnitOutcome.patchPath`,
  `patchTouchedPaths`, and `childWorktreePath` are introduced before later
  tasks consume them.
- Report fields use `tracePath` and `isolatedDiff` consistently across
  `reports.ts`, `report-snapshot.ts`, runner output, and CLI status output.
