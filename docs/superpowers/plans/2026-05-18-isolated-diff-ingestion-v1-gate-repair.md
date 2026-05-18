# Isolated Diff Ingestion V1 Gate Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded repair-agent handling for isolated-diff artifact gate
failures so cleanly applied integration trees get one scoped repair attempt
before the ingest fails.

**Architecture:** Reuse the existing isolated-diff integration worktree,
trace writer, and `AgentRunnerPort`. A new `final-gate-repair` module exposes
scoped read/write tools over the exact wiki and semantic-layer files involved
in the failed gate. Patch-level semantic conflicts and final composed-tree gate
failures both call this repair module, rerun artifact gates, commit repaired
files only after gates pass, and record repair counters in ingest reports.

**Tech Stack:** TypeScript ESM/NodeNext, Vitest, zod, Node `fs/promises`,
existing `IngestBundleRunner`, `GitService`, `AgentRunnerPort`,
`IngestTraceWriter`, `integrateWorkUnitPatch`, and `validateFinalIngestArtifacts`.

---

## Audit summary

This audit read
`docs/superpowers/specs/2026-05-17-isolated-diff-ingestion-design.md`, searched
`docs/superpowers/plans/`, inspected the current isolated-diff implementation,
and ran the focused isolated-diff verification suite.

Plans already based on the spec:

| Plan | Implementation status | Evidence |
| --- | --- | --- |
| `docs/superpowers/plans/2026-05-17-isolated-diff-ingestion-v1-core.md` | Implemented | `packages/context/src/ingest/isolated-diff/git-patch.ts`, `work-unit-executor.ts`, `patch-integrator.ts`, `ingest-trace.ts`, `wiki-body-refs.ts`, and runner coverage exist. Git history includes `cae5c4b`, `1013bb6`, and `c481f1c`. |
| `docs/superpowers/plans/2026-05-17-isolated-diff-ingestion-v1-gates-and-trace-closure.md` | Implemented | Final gates run after reconciliation and follow-on mutations, child worktrees clean up, failed reports are stored, and trace coverage exists. Git history includes `656e584` and `87f1193`. |
| `docs/superpowers/plans/2026-05-17-isolated-diff-ingestion-v1-provenance-gate-closure.md` | Implemented | `validateProvenanceRawPaths()` runs before squash and has isolated-diff regression coverage. Git history includes `977a610`. |
| `docs/superpowers/plans/2026-05-17-isolated-diff-ingestion-v1-reference-and-target-gate-closure.md` | Implemented | Final wiki reference gates, SL write/edit target checks, patch target checks, and target-policy traces exist. Git history includes `5ec6396` and `c61c50b`. |
| `docs/superpowers/plans/2026-05-17-isolated-diff-ingestion-v1-global-wiki-reference-gate-closure.md` | Implemented | `wikiPageKeysForFinalGates()` expands to all global wiki pages when semantic-layer sources change or wiki pages are removed. Git history includes `ba534fb`. |
| `docs/superpowers/plans/2026-05-18-isolated-diff-ingestion-v1-textual-conflict-resolver.md` | Implemented | `textual-conflict-resolver.ts` exists, `patch-integrator.ts` invokes it after Git textual conflicts, `ingest-bundle.runner.ts` passes the callback, and report snapshots parse resolver counters. Git history includes `9f0abe5`, `529c6da`, `8784a47`, `aa8d59c`, and `3228843`. |

Focused verification passed before writing this plan:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-trace.test.ts src/ingest/wiki-body-refs.test.ts src/ingest/artifact-gates.test.ts src/ingest/semantic-layer-target-policy.test.ts src/ingest/isolated-diff/git-patch.test.ts src/ingest/isolated-diff/work-unit-executor.test.ts src/ingest/isolated-diff/patch-integrator.test.ts src/ingest/isolated-diff/textual-conflict-resolver.test.ts src/ingest/ingest-bundle.runner.isolated-diff.test.ts src/ingest/report-snapshot.test.ts src/sl/tools/sl-write-source.tool.test.ts src/sl/tools/sl-edit-source.tool.test.ts
```

Current result: `12 passed`, `73 passed`.

One v1-essential design gap remains. The spec's gate repair stage says that
cleanly applied trees that fail semantic or wiki gates get a bounded repair
agent before the run fails. Current code still fails immediately in two places:

- `packages/context/src/ingest/isolated-diff/patch-integrator.ts` returns
  `semantic_conflict` as soon as `validateAppliedTree()` rejects after a patch
  applies cleanly.
- `packages/context/src/ingest/ingest-bundle.runner.ts` calls
  `validateFinalIngestArtifacts()` inside `traceTimed()` and lets the error
  abort the run without a repair attempt.

## Scope

This plan implements bounded gate repair for artifact gate failures only:

- semantic gate failures after a patch applies cleanly;
- final artifact gate failures after reconciliation, deterministic
  post-processing, and wiki `sl_refs` repair;
- repair counters and traces for attempts, repairs, and failures.

This plan does not repair patch policy failures, target-policy failures,
textual Git conflicts, provenance validation failures, squash conflicts,
connector rollout gaps, default-path promotion, semantic auto-merge helpers, or
removal of the shared-worktree fallback path.

## File structure

- Create `packages/context/src/ingest/final-gate-repair.ts`.
  Owns bounded repair-agent execution, scoped repair tools, allowed path
  derivation, prompt text, and result types.
- Create `packages/context/src/ingest/final-gate-repair.test.ts`.
  Covers allowed-path derivation, scoped read/write enforcement, successful
  repair, and no-edit failure.
- Modify `packages/context/src/ingest/isolated-diff/patch-integrator.ts`.
  Calls gate repair after clean patch application when artifact gates fail,
  reruns gates, commits repaired files, and returns repair metadata.
- Modify `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`.
  Adds semantic-gate repair success and failure coverage.
- Modify `packages/context/src/ingest/ingest-bundle.runner.ts`.
  Wires final gate repair into the isolated-diff runner, commits repaired final
  gate files before provenance validation, and updates isolated-diff counters.
- Modify `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`.
  Adds end-to-end coverage for repairable final wiki body references and a
  failed no-edit repair.
- Modify `packages/context/src/ingest/reports.ts`.
  Adds gate repair counters to `IngestReportBody.isolatedDiff`.
- Modify `packages/context/src/ingest/report-snapshot.ts`.
  Parses gate repair counters from stored reports.
- Modify `packages/context/src/ingest/report-snapshot.test.ts`.
  Covers stored gate repair counters.

---

### Task 1: Add final gate repair unit tests

**Files:**
- Create: `packages/context/src/ingest/final-gate-repair.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `packages/context/src/ingest/final-gate-repair.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileIngestTraceWriter } from './ingest-trace.js';
import { finalGateRepairPaths, repairFinalGateFailure } from './final-gate-repair.js';

async function makeHarness() {
  const root = await mkdtemp(join(tmpdir(), 'ktx-final-gate-repair-'));
  const workdir = join(root, 'workdir');
  await mkdir(join(workdir, 'wiki/global'), { recursive: true });
  await mkdir(join(workdir, 'semantic-layer/warehouse'), { recursive: true });
  await writeFile(
    join(workdir, 'wiki/global/account-segments.md'),
    '---\nsummary: Account segments\nusage_mode: auto\n---\n\nARR uses `mart_account_segments.total_contract_arr_cents`.\n',
    'utf-8',
  );
  await writeFile(
    join(workdir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
    'name: mart_account_segments\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
    'utf-8',
  );
  const trace = new FileIngestTraceWriter({
    tracePath: join(root, 'trace.jsonl'),
    jobId: 'job-1',
    connectionId: 'warehouse',
    sourceKey: 'metabase',
    runId: 'run-1',
    syncId: 'sync-1',
    level: 'trace',
  });
  return { root, workdir, trace };
}

describe('finalGateRepairPaths', () => {
  it('derives sorted wiki and semantic-layer file paths', () => {
    expect(
      finalGateRepairPaths({
        changedWikiPageKeys: ['account-segments', 'overview', 'account-segments'],
        touchedSlSources: [
          { connectionId: 'warehouse', sourceName: 'mart_account_segments' },
          { connectionId: 'warehouse', sourceName: 'orders' },
          { connectionId: 'warehouse', sourceName: 'orders' },
        ],
      }),
    ).toEqual([
      'semantic-layer/warehouse/mart_account_segments.yaml',
      'semantic-layer/warehouse/orders.yaml',
      'wiki/global/account-segments.md',
      'wiki/global/overview.md',
    ]);
  });
});

describe('repairFinalGateFailure', () => {
  it('lets the repair agent read gate errors and edit only allowed files', async () => {
    const { workdir, trace } = await makeHarness();
    const agentRunner = {
      runLoop: vi.fn(async (params: any) => {
        const error = await params.toolSet.read_gate_error.execute({});
        expect(error.markdown).toContain('total_contract_arr_cents');

        const page = await params.toolSet.read_repair_file.execute({
          path: 'wiki/global/account-segments.md',
        });
        expect(page.markdown).toContain('total_contract_arr_cents');

        await expect(
          params.toolSet.write_repair_file.execute({
            path: 'wiki/global/other.md',
            content: 'not allowed',
          }),
        ).rejects.toThrow(/gate repair path not allowed/);

        await params.toolSet.write_repair_file.execute({
          path: 'wiki/global/account-segments.md',
          content: page.markdown.replace('total_contract_arr_cents', 'total_contract_arr'),
        });
        return { stopReason: 'natural' as const };
      }),
    };

    const result = await repairFinalGateFailure({
      agentRunner,
      workdir,
      gateError:
        'final artifact gates failed:\naccount-segments: unknown semantic-layer entity mart_account_segments.total_contract_arr_cents',
      allowedPaths: ['wiki/global/account-segments.md'],
      trace,
      repairKind: 'final_artifact_gate',
      maxAttempts: 1,
      stepBudget: 8,
    });

    expect(result).toEqual({
      status: 'repaired',
      attempts: 1,
      changedPaths: ['wiki/global/account-segments.md'],
    });
    await expect(readFile(join(workdir, 'wiki/global/account-segments.md'), 'utf-8')).resolves.toContain(
      'total_contract_arr',
    );
    await expect(readFile(trace.tracePath, 'utf-8')).resolves.toContain('gate_repair_repaired');
    expect(agentRunner.runLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRole: 'repair',
        stepBudget: 8,
        telemetryTags: expect.objectContaining({
          operationName: 'ingest-isolated-diff-gate-repair',
          repairKind: 'final_artifact_gate',
        }),
      }),
    );
  });

  it('returns failed when the repair agent edits no allowed file', async () => {
    const { workdir, trace } = await makeHarness();
    const result = await repairFinalGateFailure({
      agentRunner: { runLoop: vi.fn(async () => ({ stopReason: 'natural' as const })) },
      workdir,
      gateError: 'final artifact gates failed:\naccount-segments: unknown semantic-layer entity',
      allowedPaths: ['wiki/global/account-segments.md'],
      trace,
      repairKind: 'final_artifact_gate',
      maxAttempts: 1,
      stepBudget: 8,
    });

    expect(result).toEqual({
      status: 'failed',
      attempts: 1,
      reason: 'gate repair completed without editing an allowed path',
    });
    await expect(readFile(trace.tracePath, 'utf-8')).resolves.toContain('gate_repair_failed');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/final-gate-repair.test.ts
```

Expected: FAIL because `./final-gate-repair.js` does not exist.

- [ ] **Step 3: Commit the failing tests**

Run:

```bash
git add packages/context/src/ingest/final-gate-repair.test.ts
git commit -m "test(ingest): cover isolated diff gate repair"
```

### Task 2: Implement the final gate repair module

**Files:**
- Create: `packages/context/src/ingest/final-gate-repair.ts`
- Test: `packages/context/src/ingest/final-gate-repair.test.ts`

- [ ] **Step 1: Add the repair module**

Create `packages/context/src/ingest/final-gate-repair.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AgentRunnerPort, KtxRuntimeToolSet } from '../llm/index.js';
import type { TouchedSlSource } from '../tools/index.js';
import type { IngestTraceWriter } from './ingest-trace.js';
import { traceTimed } from './ingest-trace.js';

export type FinalGateRepairKind = 'patch_semantic_gate' | 'final_artifact_gate';

export type FinalGateRepairResult =
  | { status: 'repaired'; attempts: number; changedPaths: string[] }
  | { status: 'failed'; attempts: number; reason: string };

export interface RepairFinalGateFailureInput {
  agentRunner: AgentRunnerPort;
  workdir: string;
  gateError: string;
  allowedPaths: string[];
  trace: IngestTraceWriter;
  repairKind: FinalGateRepairKind;
  maxAttempts?: number;
  stepBudget?: number;
}

const readRepairFileSchema = z.object({
  path: z.string().min(1),
});

const writeRepairFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

function normalizeRepoPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`gate repair path must be a repository-relative path: ${path}`);
  }
  return parts.join('/');
}

function assertAllowedPath(path: string, allowedPaths: ReadonlySet<string>): string {
  const normalized = normalizeRepoPath(path);
  if (!allowedPaths.has(normalized)) {
    throw new Error(`gate repair path not allowed: ${normalized}`);
  }
  return normalized;
}

async function readOptionalFile(path: string): Promise<{ exists: boolean; content: string }> {
  try {
    return { exists: true, content: await readFile(path, 'utf-8') };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { exists: false, content: '' };
    }
    throw error;
  }
}

function buildGateRepairSystemPrompt(): string {
  return `<role>
You repair one KTX isolated-diff artifact gate failure inside the integration worktree.
</role>

<rules>
- Use read_gate_error first.
- Read only files exposed by read_repair_file.
- Edit only paths exposed by write_repair_file.
- Prefer the smallest text edit that makes the gate pass.
- Preserve accepted work-unit, reconciliation, and deterministic projection content.
- Do not invent warehouse facts, business definitions, or semantic-layer entities.
- If the gate error requires choosing between conflicting facts without evidence, stop without editing.
</rules>`;
}

function buildGateRepairUserPrompt(input: {
  gateError: string;
  allowedPaths: string[];
  repairKind: FinalGateRepairKind;
  attempt: number;
  maxAttempts: number;
}): string {
  return `Repair isolated-diff artifact gates.

Repair kind: ${input.repairKind}
Attempt: ${input.attempt} of ${input.maxAttempts}

Allowed files:
${input.allowedPaths.map((path) => `- ${path}`).join('\n')}

Gate error:
${input.gateError}

Use read_gate_error first. Then inspect only the allowed files, write the
minimal repaired content, and stop.`;
}

function buildToolSet(input: {
  workdir: string;
  gateError: string;
  allowedPaths: ReadonlySet<string>;
  editedPaths: Set<string>;
}): KtxRuntimeToolSet {
  return {
    read_gate_error: {
      name: 'read_gate_error',
      description: 'Read the artifact gate failure that must be repaired.',
      inputSchema: z.object({}),
      execute: async () => ({
        markdown: input.gateError,
        structured: { gateError: input.gateError },
      }),
    },
    read_repair_file: {
      name: 'read_repair_file',
      description: 'Read one allowed file from the integration worktree.',
      inputSchema: readRepairFileSchema,
      execute: async ({ path }: z.infer<typeof readRepairFileSchema>) => {
        const normalized = assertAllowedPath(path, input.allowedPaths);
        const file = await readOptionalFile(join(input.workdir, normalized));
        return {
          markdown: file.exists ? file.content : `(missing file: ${normalized})`,
          structured: { path: normalized, exists: file.exists },
        };
      },
    },
    write_repair_file: {
      name: 'write_repair_file',
      description: 'Replace one allowed integration worktree file with repaired text content.',
      inputSchema: writeRepairFileSchema,
      execute: async ({ path, content }: z.infer<typeof writeRepairFileSchema>) => {
        const normalized = assertAllowedPath(path, input.allowedPaths);
        const fullPath = join(input.workdir, normalized);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, 'utf-8');
        input.editedPaths.add(normalized);
        return {
          markdown: `Wrote ${normalized}`,
          structured: { path: normalized, bytes: Buffer.byteLength(content) },
        };
      },
    },
  };
}

export function finalGateRepairPaths(input: {
  changedWikiPageKeys: string[];
  touchedSlSources: TouchedSlSource[];
}): string[] {
  return [
    ...new Set([
      ...input.touchedSlSources.map((source) => `semantic-layer/${source.connectionId}/${source.sourceName}.yaml`),
      ...input.changedWikiPageKeys.map((pageKey) => `wiki/global/${pageKey}.md`),
    ]),
  ].sort();
}

export async function repairFinalGateFailure(
  input: RepairFinalGateFailureInput,
): Promise<FinalGateRepairResult> {
  const allowedPaths = new Set(input.allowedPaths.map(normalizeRepoPath));
  const maxAttempts = input.maxAttempts ?? 1;
  const stepBudget = input.stepBudget ?? 16;
  let lastFailure = 'gate repair did not run';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const editedPaths = new Set<string>();
    const sortedAllowedPaths = [...allowedPaths].sort();
    const traceData = {
      repairKind: input.repairKind,
      attempt,
      maxAttempts,
      allowedPaths: sortedAllowedPaths,
      gateError: input.gateError,
    };
    const result = await traceTimed(input.trace, 'gate_repair', 'gate_repair', traceData, async () =>
      input.agentRunner.runLoop({
        modelRole: 'repair',
        systemPrompt: buildGateRepairSystemPrompt(),
        userPrompt: buildGateRepairUserPrompt({
          gateError: input.gateError,
          allowedPaths: sortedAllowedPaths,
          repairKind: input.repairKind,
          attempt,
          maxAttempts,
        }),
        toolSet: buildToolSet({
          workdir: input.workdir,
          gateError: input.gateError,
          allowedPaths,
          editedPaths,
        }),
        stepBudget,
        telemetryTags: {
          operationName: 'ingest-isolated-diff-gate-repair',
          source: input.trace.context.sourceKey,
          jobId: input.trace.context.jobId,
          repairKind: input.repairKind,
        },
      }),
    );

    if (result.stopReason === 'error') {
      lastFailure = result.error?.message ?? 'gate repair agent loop errored';
      await input.trace.event('error', 'gate_repair', 'gate_repair_failed', traceData, result.error);
      continue;
    }

    const changedPaths = [...editedPaths].sort();
    if (changedPaths.length === 0) {
      lastFailure = 'gate repair completed without editing an allowed path';
      await input.trace.event('error', 'gate_repair', 'gate_repair_failed', {
        ...traceData,
        reason: lastFailure,
      });
      continue;
    }

    await input.trace.event('debug', 'gate_repair', 'gate_repair_repaired', {
      ...traceData,
      changedPaths,
    });
    return { status: 'repaired', attempts: attempt, changedPaths };
  }

  return { status: 'failed', attempts: maxAttempts, reason: lastFailure };
}
```

- [ ] **Step 2: Run the repair module tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/final-gate-repair.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit the repair module**

Run:

```bash
git add packages/context/src/ingest/final-gate-repair.ts packages/context/src/ingest/final-gate-repair.test.ts
git commit -m "feat(ingest): add isolated diff gate repair agent"
```

### Task 3: Repair patch-level semantic gate failures

**Files:**
- Modify: `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`
- Modify: `packages/context/src/ingest/isolated-diff/patch-integrator.ts`
- Test: `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`

- [ ] **Step 1: Add patch integrator repair regressions**

Append these tests inside
`describe('integrateWorkUnitPatch', ...)` in
`packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`:

```ts
  it('repairs semantic gate failures after a patch applies cleanly', async () => {
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    const childDir = join(homeDir, 'child-semantic-repair');
    await git.addWorktree(childDir, 'child-semantic-repair', baseSha);
    const childGit = git.forWorktree(childDir);
    await writeFile(join(childDir, 'wiki/global/a.md'), 'bad semantic ref\n');
    await childGit.commitFiles(['wiki/global/a.md'], 'bad semantic edit', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/semantic-repair.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-semantic-repair/trace.jsonl'),
      jobId: 'job-semantic-repair',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });
    const validateAppliedTree = vi
      .fn()
      .mockRejectedValueOnce(new Error('final artifact gates failed:\na: unknown semantic-layer entity'))
      .mockResolvedValueOnce(undefined);

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-repairable',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'KTX Test', email: 'system@ktx.local' },
      validateAppliedTree,
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['c1']),
      repairGateFailure: vi.fn(async (context) => {
        expect(context).toMatchObject({
          unitKey: 'wu-repairable',
          patchPath,
          touchedPaths: ['wiki/global/a.md'],
        });
        await writeFile(join(configDir, 'wiki/global/a.md'), 'repaired semantic ref\n', 'utf-8');
        return {
          status: 'repaired' as const,
          attempts: 1,
          changedPaths: ['wiki/global/a.md'],
        };
      }),
    });

    expect(result).toMatchObject({
      status: 'accepted',
      touchedPaths: ['wiki/global/a.md'],
      gateRepair: {
        status: 'repaired',
        attempts: 1,
        changedPaths: ['wiki/global/a.md'],
      },
    });
    expect(validateAppliedTree).toHaveBeenCalledTimes(2);
    await expect(readFile(join(configDir, 'wiki/global/a.md'), 'utf-8')).resolves.toBe('repaired semantic ref\n');
    await expect(readFile(trace.tracePath, 'utf-8')).resolves.toContain('patch_accepted_after_gate_repair');
  });

  it('keeps the pre-apply tree when semantic gate repair fails', async () => {
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    const childDir = join(homeDir, 'child-semantic-repair-fails');
    await git.addWorktree(childDir, 'child-semantic-repair-fails', baseSha);
    const childGit = git.forWorktree(childDir);
    await writeFile(join(childDir, 'wiki/global/a.md'), 'bad semantic ref\n');
    await childGit.commitFiles(['wiki/global/a.md'], 'bad semantic edit', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/semantic-repair-fails.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-semantic-repair-fails/trace.jsonl'),
      jobId: 'job-semantic-repair-fails',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-not-repaired',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'KTX Test', email: 'system@ktx.local' },
      validateAppliedTree: vi.fn().mockRejectedValue(new Error('final artifact gates failed')),
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['c1']),
      repairGateFailure: vi.fn(async () => ({
        status: 'failed' as const,
        attempts: 1,
        reason: 'gate repair completed without editing an allowed path',
      })),
    });

    expect(result).toMatchObject({
      status: 'semantic_conflict',
      gateRepair: {
        status: 'failed',
        attempts: 1,
        reason: 'gate repair completed without editing an allowed path',
      },
    });
    await expect(readFile(join(configDir, 'wiki/global/a.md'), 'utf-8')).resolves.toBe('old\n');
  });
```

- [ ] **Step 2: Run the patch integrator tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/patch-integrator.test.ts
```

Expected: FAIL because `integrateWorkUnitPatch()` does not accept
`repairGateFailure` and does not return `gateRepair`.

- [ ] **Step 3: Add gate repair metadata to the patch integrator**

Modify `packages/context/src/ingest/isolated-diff/patch-integrator.ts`:

```ts
import type { FinalGateRepairResult } from '../final-gate-repair.js';
```

Replace the `PatchIntegrationResult` type with:

```ts
export type PatchIntegrationResult =
  | {
      status: 'accepted';
      commitSha: string;
      touchedPaths: string[];
      textualResolution?: PatchIntegrationTextualResolution;
      gateRepair?: FinalGateRepairResult;
    }
  | {
      status: 'textual_conflict';
      reason: string;
      touchedPaths: string[];
      textualResolution?: PatchIntegrationTextualResolution;
      gateRepair?: FinalGateRepairResult;
    }
  | {
      status: 'semantic_conflict';
      reason: string;
      touchedPaths: string[];
      textualResolution?: PatchIntegrationTextualResolution;
      gateRepair?: FinalGateRepairResult;
    };
```

Add this optional callback to `IntegrateWorkUnitPatchInput`:

```ts
  repairGateFailure?(input: {
    unitKey: string;
    patchPath: string;
    touchedPaths: string[];
    reason: string;
  }): Promise<FinalGateRepairResult>;
```

Replace the current `catch` block for the non-textual
`semantic_gate` section with this block:

```ts
  } catch (error) {
    const reason = errorMessage(error);
    await input.trace.event('error', 'integration', 'patch_semantic_conflict', {
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      touchedPaths,
      reason,
    });

    if (input.repairGateFailure) {
      const gateRepair = await input.repairGateFailure({
        unitKey: input.unitKey,
        patchPath: input.patchPath,
        touchedPaths,
        reason,
      });

      if (gateRepair.status === 'failed') {
        if (preApplyHead) {
          await input.integrationGit.resetHardTo(preApplyHead);
        }
        return {
          status: 'semantic_conflict',
          reason: gateRepair.reason,
          touchedPaths,
          gateRepair,
        };
      }

      try {
        await traceTimed(
          input.trace,
          'integration',
          'semantic_gate_after_gate_repair',
          { unitKey: input.unitKey, touchedPaths: gateRepair.changedPaths },
          async () => {
            await input.validateAppliedTree(gateRepair.changedPaths);
          },
        );
      } catch (repairValidationError) {
        if (preApplyHead) {
          await input.integrationGit.resetHardTo(preApplyHead);
        }
        return {
          status: 'semantic_conflict',
          reason: errorMessage(repairValidationError),
          touchedPaths: gateRepair.changedPaths,
          gateRepair,
        };
      }

      const commit = await input.integrationGit.commitFiles(
        gateRepair.changedPaths,
        `ingest: repair WorkUnit ${input.unitKey} gates`,
        input.author.name,
        input.author.email,
      );
      if (!commit.created) {
        if (preApplyHead) {
          await input.integrationGit.resetHardTo(preApplyHead);
        }
        return {
          status: 'semantic_conflict',
          reason: 'gate repair produced no committable changes',
          touchedPaths: gateRepair.changedPaths,
          gateRepair,
        };
      }

      await input.trace.event('debug', 'integration', 'patch_accepted_after_gate_repair', {
        unitKey: input.unitKey,
        commitSha: commit.commitHash,
        touchedPaths: gateRepair.changedPaths,
        attempts: gateRepair.attempts,
      });
      return {
        status: 'accepted',
        commitSha: commit.commitHash,
        touchedPaths: gateRepair.changedPaths,
        gateRepair,
      };
    }

    if (preApplyHead) {
      await input.integrationGit.resetHardTo(preApplyHead);
    }
    return {
      status: 'semantic_conflict',
      reason,
      touchedPaths,
    };
  }
```

- [ ] **Step 4: Run the patch integrator tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/patch-integrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit patch-level gate repair**

Run:

```bash
git add packages/context/src/ingest/isolated-diff/patch-integrator.ts packages/context/src/ingest/isolated-diff/patch-integrator.test.ts
git commit -m "feat(ingest): repair isolated diff semantic gate failures"
```

### Task 4: Wire final gate repair into the runner

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Modify: `packages/context/src/ingest/reports.ts`
- Modify: `packages/context/src/ingest/report-snapshot.ts`
- Modify: `packages/context/src/ingest/report-snapshot.test.ts`

- [ ] **Step 1: Add report fields and parser coverage**

In `packages/context/src/ingest/reports.ts`, extend
`IngestReportBody.isolatedDiff`:

```ts
    gateRepairAttempts?: number;
    gateRepairs?: number;
    gateRepairFailures?: number;
```

In `packages/context/src/ingest/report-snapshot.ts`, extend the
`isolatedDiff` schema:

```ts
            gateRepairAttempts: z.number().int().min(0).default(0),
            gateRepairs: z.number().int().min(0).default(0),
            gateRepairFailures: z.number().int().min(0).default(0),
```

Append this test to `packages/context/src/ingest/report-snapshot.test.ts`:

```ts
  it('parses isolated-diff gate repair counters', () => {
    const snapshot = parseIngestReportSnapshot({
      id: 'report-1',
      runId: 'run-1',
      jobId: 'job-1',
      connectionId: 'warehouse',
      sourceKey: 'metabase',
      createdAt: '2026-05-18T00:00:00.000Z',
      body: {
        status: 'completed',
        syncId: 'sync-1',
        diffSummary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
        commitSha: 'abc123',
        isolatedDiff: {
          enabled: true,
          acceptedPatches: 1,
          textualConflicts: 0,
          semanticConflicts: 1,
          gateRepairAttempts: 1,
          gateRepairs: 1,
          gateRepairFailures: 0,
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

    expect(snapshot.body.isolatedDiff).toMatchObject({
      gateRepairAttempts: 1,
      gateRepairs: 1,
      gateRepairFailures: 0,
    });
  });
```

- [ ] **Step 2: Run report snapshot tests to verify they pass**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/report-snapshot.test.ts
```

Expected: PASS.

- [ ] **Step 3: Import the gate repair module in the runner**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, add:

```ts
import { finalGateRepairPaths, repairFinalGateFailure } from './final-gate-repair.js';
```

- [ ] **Step 4: Add gate repair counters to the isolated summary**

In the `isolatedDiffSummary` object, add:

```ts
        gateRepairAttempts: 0,
        gateRepairs: 0,
        gateRepairFailures: 0,
```

- [ ] **Step 5: Pass patch-level gate repair to `integrateWorkUnitPatch()`**

In the `integrateWorkUnitPatch()` call, add this callback next to
`resolveTextualConflict`:

```ts
            repairGateFailure: (context) =>
              repairFinalGateFailure({
                agentRunner: this.deps.agentRunner,
                workdir: sessionWorktree.workdir,
                gateError: context.reason,
                allowedPaths: context.touchedPaths,
                trace: runTrace,
                repairKind: 'patch_semantic_gate',
                maxAttempts: 1,
                stepBudget: 16,
              }),
```

After the existing `integration.textualResolution` counter block, add:

```ts
          if (integration.gateRepair) {
            isolatedDiffSummary.gateRepairAttempts += integration.gateRepair.attempts;
            if (integration.gateRepair.status === 'repaired') {
              isolatedDiffSummary.semanticConflicts += 1;
              isolatedDiffSummary.gateRepairs += 1;
            } else {
              isolatedDiffSummary.gateRepairFailures += 1;
            }
          }
```

- [ ] **Step 6: Replace final artifact gate throw-through with bounded repair**

Replace the current `await traceTimed(... 'final_artifact_gates' ...)` block in
`packages/context/src/ingest/ingest-bundle.runner.ts` with:

```ts
      try {
        await traceTimed(
          runTrace,
          'final_gates',
          'final_artifact_gates',
          finalArtifactGateTraceData,
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
      } catch (error) {
        const gateError = this.errorMessage(error);
        const repairPaths = finalGateRepairPaths({
          changedWikiPageKeys: finalChangedWikiPageKeys,
          touchedSlSources: finalTouchedSlSources,
        });
        const gateRepair = await repairFinalGateFailure({
          agentRunner: this.deps.agentRunner,
          workdir: sessionWorktree.workdir,
          gateError,
          allowedPaths: repairPaths,
          trace: runTrace,
          repairKind: 'final_artifact_gate',
          maxAttempts: 1,
          stepBudget: 16,
        });

        isolatedDiffSummary.gateRepairAttempts += gateRepair.attempts;
        if (gateRepair.status === 'failed') {
          isolatedDiffSummary.gateRepairFailures += 1;
          activeFailureDetails = {
            ...finalArtifactGateTraceData,
            gateRepair,
            gateError,
          };
          throw new Error(`${gateError}\ngate repair failed: ${gateRepair.reason}`);
        }

        isolatedDiffSummary.gateRepairs += 1;
        await traceTimed(
          runTrace,
          'final_gates',
          'final_artifact_gates_after_gate_repair',
          {
            ...finalArtifactGateTraceData,
            repairedPaths: gateRepair.changedPaths,
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

        const repairCommit = await sessionWorktree.git.commitFiles(
          gateRepair.changedPaths,
          `ingest(${job.sourceKey}): repair final gates syncId=${syncId}`,
          this.deps.storage.systemGitAuthor.name,
          this.deps.storage.systemGitAuthor.email,
        );
        if (!repairCommit.created) {
          isolatedDiffSummary.gateRepairFailures += 1;
          throw new Error('final gate repair produced no committable changes');
        }
        await runTrace.event('debug', 'final_gates', 'final_gate_repair_committed', {
          commitSha: repairCommit.commitHash,
          repairedPaths: gateRepair.changedPaths,
        });
      }
```

- [ ] **Step 7: Run the runner and report tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/patch-integrator.test.ts src/ingest/report-snapshot.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit runner wiring and report fields**

Run:

```bash
git add packages/context/src/ingest/ingest-bundle.runner.ts packages/context/src/ingest/reports.ts packages/context/src/ingest/report-snapshot.ts packages/context/src/ingest/report-snapshot.test.ts
git commit -m "feat(ingest): wire isolated diff gate repair"
```

### Task 5: Add isolated runner gate repair regressions

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`
- Test: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`

- [ ] **Step 1: Add a final gate repair success regression**

Append this test inside
`describe('IngestBundleRunner isolated diff path', ...)`:

```ts
  it('repairs final wiki body refs before squash when the repair agent edits the scoped page', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      await mkdir(join(runtime.configDir, 'semantic-layer/warehouse'), { recursive: true });
      await mkdir(join(runtime.configDir, 'wiki/global'), { recursive: true });
      await writeFile(
        join(runtime.configDir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
        'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr_cents\n    expr: sum(contract_arr)\n',
      );
      await writeFile(
        join(runtime.configDir, 'wiki/global/account-segments.md'),
        '---\nsummary: Account segments\nusage_mode: auto\n---\n\nExisting ARR uses `mart_account_segments.total_contract_arr_cents`.\n',
      );
      await runtime.git.commitFiles(
        ['semantic-layer/warehouse/mart_account_segments.yaml', 'wiki/global/account-segments.md'],
        'seed stale wiki body ref',
        'KTX Test',
        'system@ktx.local',
      );

      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'source-only', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags.operationName === 'ingest-isolated-diff-gate-repair') {
          const gateError = await params.toolSet.read_gate_error.execute({});
          expect(gateError.markdown).toContain('total_contract_arr_cents');
          const page = await params.toolSet.read_repair_file.execute({
            path: 'wiki/global/account-segments.md',
          });
          await params.toolSet.write_repair_file.execute({
            path: 'wiki/global/account-segments.md',
            content: page.markdown.replace('total_contract_arr_cents', 'total_contract_arr'),
          });
          return { stopReason: 'natural' as const };
        }
        if (params.modelRole === 'reconcile') {
          return { stopReason: 'natural' as const };
        }

        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await writeFile(
          join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
          'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
        currentSession.actions.push({
          target: 'sl',
          type: 'updated',
          key: 'mart_account_segments',
          detail: 'Rename ARR measure',
          targetConnectionId: 'warehouse',
          rawPaths: ['cards/source.json'],
        });
        await currentSession.gitService.commitFiles(
          ['semantic-layer/warehouse/mart_account_segments.yaml'],
          'wu source rename',
          'KTX Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' as const };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);

      const result = await runner.run({
        jobId: 'job-final-gate-repair',
        connectionId: 'warehouse',
        sourceKey: 'metabase',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });

      expect(result.commitSha).toBeTruthy();
      await expect(readFile(join(runtime.configDir, 'wiki/global/account-segments.md'), 'utf-8')).resolves.toContain(
        'mart_account_segments.total_contract_arr',
      );
      await expect(readFile(join(runtime.configDir, 'wiki/global/account-segments.md'), 'utf-8')).resolves.not.toContain(
        'total_contract_arr_cents',
      );
      const reportCreate = vi.mocked(deps.reports.create).mock.calls.at(-1)?.[0] as any;
      expect(reportCreate.body.isolatedDiff).toMatchObject({
        gateRepairAttempts: 1,
        gateRepairs: 1,
        gateRepairFailures: 0,
      });
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-final-gate-repair/trace.jsonl'), 'utf-8');
      expect(trace).toContain('gate_repair_repaired');
      expect(trace).toContain('final_artifact_gates_after_gate_repair_finished');
      expect(trace).toContain('final_gate_repair_committed');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Add a final gate repair no-edit failure regression**

Append this test inside the same `describe(...)` block:

```ts
  it('fails before squash when final gate repair makes no edit', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      await mkdir(join(runtime.configDir, 'semantic-layer/warehouse'), { recursive: true });
      await mkdir(join(runtime.configDir, 'wiki/global'), { recursive: true });
      await writeFile(
        join(runtime.configDir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
        'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr_cents\n    expr: sum(contract_arr)\n',
      );
      await writeFile(
        join(runtime.configDir, 'wiki/global/account-segments.md'),
        '---\nsummary: Account segments\nusage_mode: auto\n---\n\nExisting ARR uses `mart_account_segments.total_contract_arr_cents`.\n',
      );
      await runtime.git.commitFiles(
        ['semantic-layer/warehouse/mart_account_segments.yaml', 'wiki/global/account-segments.md'],
        'seed stale wiki body ref',
        'KTX Test',
        'system@ktx.local',
      );
      const preRunHead = await runtime.git.revParseHead();

      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'source-only', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags.operationName === 'ingest-isolated-diff-gate-repair') {
          return { stopReason: 'natural' as const };
        }
        if (params.modelRole === 'reconcile') {
          return { stopReason: 'natural' as const };
        }

        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await writeFile(
          join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
          'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
        currentSession.actions.push({
          target: 'sl',
          type: 'updated',
          key: 'mart_account_segments',
          detail: 'Rename ARR measure',
          targetConnectionId: 'warehouse',
          rawPaths: ['cards/source.json'],
        });
        await currentSession.gitService.commitFiles(
          ['semantic-layer/warehouse/mart_account_segments.yaml'],
          'wu source rename',
          'KTX Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' as const };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);

      await expect(
        runner.run({
          jobId: 'job-final-gate-repair-fails',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/gate repair completed without editing an allowed path/);

      expect(await runtime.git.revParseHead()).toBe(preRunHead);
      const reportCreate = vi.mocked(deps.reports.create).mock.calls.at(-1)?.[0] as any;
      expect(reportCreate.body.status).toBe('failed');
      expect(reportCreate.body.isolatedDiff).toMatchObject({
        gateRepairAttempts: 1,
        gateRepairs: 0,
        gateRepairFailures: 1,
      });
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-final-gate-repair-fails/trace.jsonl'), 'utf-8');
      expect(trace).toContain('gate_repair_failed');
      expect(trace).not.toContain('squash_finished');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 3: Run the isolated runner tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit runner regressions**

Run:

```bash
git add packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts
git commit -m "test(ingest): verify isolated diff final gate repair"
```

### Task 6: Final verification

**Files:**
- Verify: `packages/context/src/ingest/final-gate-repair.ts`
- Verify: `packages/context/src/ingest/final-gate-repair.test.ts`
- Verify: `packages/context/src/ingest/isolated-diff/patch-integrator.ts`
- Verify: `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`
- Verify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Verify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`
- Verify: `packages/context/src/ingest/reports.ts`
- Verify: `packages/context/src/ingest/report-snapshot.ts`
- Verify: `packages/context/src/ingest/report-snapshot.test.ts`

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/final-gate-repair.test.ts src/ingest/isolated-diff/patch-integrator.test.ts src/ingest/ingest-bundle.runner.isolated-diff.test.ts src/ingest/report-snapshot.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the existing isolated-diff safety suite**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-trace.test.ts src/ingest/wiki-body-refs.test.ts src/ingest/artifact-gates.test.ts src/ingest/semantic-layer-target-policy.test.ts src/ingest/isolated-diff/git-patch.test.ts src/ingest/isolated-diff/work-unit-executor.test.ts src/ingest/isolated-diff/patch-integrator.test.ts src/ingest/isolated-diff/textual-conflict-resolver.test.ts src/ingest/ingest-bundle.runner.isolated-diff.test.ts src/ingest/report-snapshot.test.ts src/sl/tools/sl-write-source.tool.test.ts src/sl/tools/sl-edit-source.tool.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run package type checks**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 4: Run dead-code checks**

Run:

```bash
pnpm run dead-code
```

Expected: PASS or only pre-existing findings unrelated to these files.

- [ ] **Step 5: Run formatting and diff checks**

Run:

```bash
pnpm exec prettier --check packages/context/src/ingest/final-gate-repair.ts packages/context/src/ingest/final-gate-repair.test.ts packages/context/src/ingest/isolated-diff/patch-integrator.ts packages/context/src/ingest/isolated-diff/patch-integrator.test.ts packages/context/src/ingest/ingest-bundle.runner.ts packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts packages/context/src/ingest/reports.ts packages/context/src/ingest/report-snapshot.ts packages/context/src/ingest/report-snapshot.test.ts docs/superpowers/plans/2026-05-18-isolated-diff-ingestion-v1-gate-repair.md
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit final verification adjustments**

If verification required formatting or type-only adjustments, run:

```bash
git add packages/context/src/ingest/final-gate-repair.ts packages/context/src/ingest/final-gate-repair.test.ts packages/context/src/ingest/isolated-diff/patch-integrator.ts packages/context/src/ingest/isolated-diff/patch-integrator.test.ts packages/context/src/ingest/ingest-bundle.runner.ts packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts packages/context/src/ingest/reports.ts packages/context/src/ingest/report-snapshot.ts packages/context/src/ingest/report-snapshot.test.ts docs/superpowers/plans/2026-05-18-isolated-diff-ingestion-v1-gate-repair.md
git commit -m "chore(ingest): verify isolated diff gate repair"
```

Expected: commit is created only when Step 1 through Step 5 produced tracked
source changes after the previous task commits.

## Self-review

Spec coverage:

- The plan implements the remaining gate repair stage from the spec.
- Patch-level semantic gate failures get one bounded repair attempt after the
  patch applies cleanly.
- Final composed-tree artifact gate failures get one bounded repair attempt
  before provenance validation and squash.
- Repair tools are scoped to touched wiki and semantic-layer files.
- Target-policy, patch-policy, textual conflict, provenance, and squash
  failures remain non-repairable in this plan.
- Connector rollout, default promotion, old-path removal, and deterministic
  semantic merge helpers remain non-v1 follow-up work.

Placeholder scan:

- No deferred implementation markers remain.
- Every code-changing step includes concrete code or exact insertion snippets.

Type consistency:

- The report field names are `gateRepairAttempts`, `gateRepairs`, and
  `gateRepairFailures` in `reports.ts`, `report-snapshot.ts`, runner code, and
  tests.
- The repair result type is `FinalGateRepairResult`.
- The repair function is `repairFinalGateFailure()`.
- The path helper is `finalGateRepairPaths()`.
