# Isolated Diff Ingestion V1 Textual Conflict Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded resolver-agent handling for textual isolated-diff patch
conflicts so overlapping WorkUnit edits can be repaired, globally gated, and
committed before the runner fails the ingest.

**Architecture:** Keep patch policy failures and semantic gate failures
fail-fast. When an allowed patch fails `git apply --3way --index`, the
integration worktree resets to the pre-apply `HEAD`, one repair agent runs with
tools limited to the failed patch's touched paths, the existing artifact gates
validate the repaired files, and the runner records resolver attempts, repairs,
and failures in traces and reports. Gate repair for cleanly applied but
semantically invalid trees remains a separate plan.

**Tech Stack:** TypeScript ESM/NodeNext, Vitest, zod, Node `fs/promises`,
existing `AgentRunnerPort`, `GitService`, `IngestTraceWriter`,
`integrateWorkUnitPatch`, and `IngestBundleRunner`.

---

## Audit Summary

The source spec is
`docs/superpowers/specs/2026-05-17-isolated-diff-ingestion-design.md`.

Plans already based on this spec:

| Plan | Implementation status | Evidence |
| --- | --- | --- |
| `docs/superpowers/plans/2026-05-17-isolated-diff-ingestion-v1-core.md` | Implemented | `packages/context/src/ingest/isolated-diff/*`, `ingest-trace.ts`, `wiki-body-refs.ts`, `artifact-gates.ts`, and `ingest-bundle.runner.isolated-diff.test.ts` exist. Git history includes `cae5c4b feat: add isolated diff ingestion v1 core`, `1013bb6 test: cover isolated diff ingestion regressions`, and `c481f1c feat: route selected ingest sources through isolated diffs`. |
| `docs/superpowers/plans/2026-05-17-isolated-diff-ingestion-v1-gates-and-trace-closure.md` | Implemented | Final gates run after reconciliation, traces and failed reports are stored, and child worktree cleanup is covered. Git history includes `656e584 test(ingest): verify isolated diff postmortem coverage` and `87f1193 chore(ingest): verify isolated diff gate closure`. |
| `docs/superpowers/plans/2026-05-17-isolated-diff-ingestion-v1-provenance-gate-closure.md` | Implemented | `validateProvenanceRawPaths()` runs before squash, and the isolated runner has a pre-squash provenance regression. Git history includes `977a610 fix(ingest): gate provenance before isolated diff squash`. |
| `docs/superpowers/plans/2026-05-17-isolated-diff-ingestion-v1-reference-and-target-gate-closure.md` | Implemented | `semantic-layer-target-policy.ts`, SL write/edit target checks, patch target checks, and final wiki ref checks exist. Git history includes `5ec6396 fix(ingest): gate final wiki references` and `c61c50b test(ingest): cover isolated diff reference and target gates`. |
| `docs/superpowers/plans/2026-05-17-isolated-diff-ingestion-v1-global-wiki-reference-gate-closure.md` | Implemented | `wikiPageKeysForFinalGates()` expands to all global pages when semantic-layer sources change or wiki pages are removed. Git history includes `ba534fb fix(ingest): gate global wiki references`. |

Focused verification passed before writing this plan:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-trace.test.ts src/ingest/wiki-body-refs.test.ts src/ingest/artifact-gates.test.ts src/ingest/semantic-layer-target-policy.test.ts src/ingest/isolated-diff/git-patch.test.ts src/ingest/isolated-diff/work-unit-executor.test.ts src/ingest/isolated-diff/patch-integrator.test.ts src/ingest/ingest-bundle.runner.isolated-diff.test.ts src/sl/tools/sl-write-source.tool.test.ts src/sl/tools/sl-edit-source.tool.test.ts
```

Current result: `10 passed`, `61 passed`.

The next spec gap is bounded textual conflict resolution. Today
`packages/context/src/ingest/isolated-diff/patch-integrator.ts` rolls back and
returns `textual_conflict` as soon as `git apply --3way --index` fails. The
spec requires expected cross-WorkUnit overlap to get one bounded repair attempt
before the run fails.

## Scope

This plan implements only textual conflict repair for allowed patches that fail
Git application. It does not repair:

- patch policy failures such as `slDisallowed`, unauthorized target connection
  paths, executable modes, or binary changes under text artifact roots;
- semantic conflicts where the patch applies but artifact gates fail;
- final gate failures after reconciliation or post-processing;
- broad connector rollout beyond the existing runner-owned Metabase allowlist;
- isolated-diff default promotion; or
- removal of the shared-worktree fallback path.

## File Structure

- Create `packages/context/src/ingest/isolated-diff/textual-conflict-resolver.ts`.
  Owns the bounded repair-agent loop and its read/write/delete tools.
- Create `packages/context/src/ingest/isolated-diff/textual-conflict-resolver.test.ts`.
  Covers allowed-path scoping, failed-patch visibility, successful repair, and
  no-edit failure.
- Modify `packages/context/src/ingest/isolated-diff/patch-integrator.ts`.
  Calls the resolver after Git textual conflicts, validates repaired files, and
  commits the repair.
- Modify `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`.
  Covers repair success and repair failure while preserving pre-apply state.
- Modify `packages/context/src/ingest/ingest-bundle.runner.ts`.
  Wires the resolver into the isolated-diff integration loop and increments
  resolver counters.
- Modify `packages/context/src/ingest/report-snapshot.ts`.
  Parses resolver counters from stored report bodies.
- Modify `packages/context/src/ingest/reports.ts`.
  Adds resolver counters to the `isolatedDiff` report body type.
- Modify `packages/context/src/ingest/report-snapshot.test.ts`.
  Covers the new report fields.
- Modify `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`.
  Adds an end-to-end same-source conflict regression.

---

### Task 1: Add Resolver Unit Tests

**Files:**
- Create: `packages/context/src/ingest/isolated-diff/textual-conflict-resolver.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

Create `packages/context/src/ingest/isolated-diff/textual-conflict-resolver.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileIngestTraceWriter } from '../ingest-trace.js';
import { resolveTextualConflict } from './textual-conflict-resolver.js';

async function makeHarness() {
  const root = await mkdtemp(join(tmpdir(), 'ktx-textual-resolver-'));
  const workdir = join(root, 'workdir');
  const patchPath = join(root, 'failed.patch');
  const trace = new FileIngestTraceWriter({
    tracePath: join(root, 'trace.jsonl'),
    jobId: 'job-1',
    connectionId: 'warehouse',
    sourceKey: 'metabase',
    runId: 'run-1',
    syncId: 'sync-1',
    level: 'trace',
  });
  await mkdir(join(workdir, 'wiki/global'), { recursive: true });
  await writeFile(join(workdir, 'wiki/global/account.md'), 'accepted line\n', 'utf-8');
  await writeFile(
    patchPath,
    [
      'diff --git a/wiki/global/account.md b/wiki/global/account.md',
      'index 8877391..6f63f4d 100644',
      '--- a/wiki/global/account.md',
      '+++ b/wiki/global/account.md',
      '@@ -1 +1 @@',
      '-base line',
      '+proposal line',
      '',
    ].join('\n'),
    'utf-8',
  );
  return { root, workdir, patchPath, trace };
}

describe('resolveTextualConflict', () => {
  it('lets the repair agent read the failed patch and write only touched paths', async () => {
    const { workdir, patchPath, trace } = await makeHarness();
    const agentRunner = {
      runLoop: vi.fn(async (params: any) => {
        const current = await params.toolSet.read_integration_file.execute({ path: 'wiki/global/account.md' });
        expect(current.structured).toEqual({ path: 'wiki/global/account.md', exists: true });
        expect(current.markdown).toContain('accepted line');

        const patch = await params.toolSet.read_failed_patch.execute({});
        expect(patch.markdown).toContain('proposal line');

        await expect(
          params.toolSet.write_integration_file.execute({
            path: 'wiki/global/not-allowed.md',
            content: 'bad\n',
          }),
        ).rejects.toThrow(/resolver path not allowed/);

        await params.toolSet.write_integration_file.execute({
          path: 'wiki/global/account.md',
          content: 'accepted line\nproposal line\n',
        });
        return { stopReason: 'natural' };
      }),
    };

    const result = await resolveTextualConflict({
      agentRunner,
      workdir,
      unitKey: 'wu-a',
      patchPath,
      touchedPaths: ['wiki/global/account.md'],
      trace,
      reason: 'patch failed: wiki/global/account.md',
      maxAttempts: 1,
      stepBudget: 8,
    });

    expect(result).toEqual({
      status: 'repaired',
      attempts: 1,
      changedPaths: ['wiki/global/account.md'],
    });
    await expect(readFile(join(workdir, 'wiki/global/account.md'), 'utf-8')).resolves.toBe(
      'accepted line\nproposal line\n',
    );
    expect(agentRunner.runLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRole: 'repair',
        stepBudget: 8,
        telemetryTags: expect.objectContaining({
          operationName: 'ingest-isolated-diff-textual-resolver',
          jobId: 'job-1',
          unitKey: 'wu-a',
        }),
      }),
    );
  });

  it('fails when the repair agent completes without editing any touched path', async () => {
    const { workdir, patchPath, trace } = await makeHarness();
    const result = await resolveTextualConflict({
      agentRunner: { runLoop: vi.fn(async () => ({ stopReason: 'natural' })) },
      workdir,
      unitKey: 'wu-a',
      patchPath,
      touchedPaths: ['wiki/global/account.md'],
      trace,
      reason: 'patch failed: wiki/global/account.md',
      maxAttempts: 1,
      stepBudget: 8,
    });

    expect(result).toEqual({
      status: 'failed',
      attempts: 1,
      reason: 'resolver completed without editing an allowed path',
    });
  });
});
```

- [ ] **Step 2: Run the resolver tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/textual-conflict-resolver.test.ts
```

Expected: FAIL with a module resolution error for
`./textual-conflict-resolver.js`.

- [ ] **Step 3: Commit the failing tests**

```bash
git add packages/context/src/ingest/isolated-diff/textual-conflict-resolver.test.ts
git commit -m "test(ingest): cover isolated diff textual conflict resolver"
```

---

### Task 2: Add Patch Integrator Resolver Contract Tests

**Files:**
- Modify: `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`

- [ ] **Step 1: Add resolver contract regressions**

Append these tests inside `describe('integrateWorkUnitPatch', ...)` in
`packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`:

```ts
  it('repairs a textual conflict through the bounded resolver and commits repaired files', async () => {
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    await mkdir(join(configDir, 'wiki/global'), { recursive: true });
    await writeFile(join(configDir, 'wiki/global/a.md'), 'base\n', 'utf-8');
    await git.commitFiles(['wiki/global/a.md'], 'base page', 'System User', 'system@example.com');
    const conflictBase = await git.revParseHead();

    await writeFile(join(configDir, 'wiki/global/a.md'), 'accepted\n', 'utf-8');
    await git.commitFiles(['wiki/global/a.md'], 'accepted edit', 'System User', 'system@example.com');

    const childDir = join(homeDir, 'child-conflict');
    await git.addWorktree(childDir, 'child-conflict', conflictBase);
    const childGit = git.forWorktree(childDir);
    await writeFile(join(childDir, 'wiki/global/a.md'), 'proposal\n', 'utf-8');
    await childGit.commitFiles(['wiki/global/a.md'], 'proposal edit', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'proposal.patch');
    await childGit.writeBinaryNoRenamePatch(conflictBase, 'HEAD', patchPath);

    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-resolver/trace.jsonl'),
      jobId: 'job-resolver',
      connectionId: 'warehouse',
      sourceKey: 'metabase',
      level: 'trace',
    });

    const validateAppliedTree = vi.fn(async (paths: string[]) => {
      expect(paths).toEqual(['wiki/global/a.md']);
      await expect(readFile(join(configDir, 'wiki/global/a.md'), 'utf-8')).resolves.toBe(
        'accepted\nproposal\n',
      );
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-conflict',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'System User', email: 'system@example.com' },
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['warehouse']),
      validateAppliedTree,
      resolveTextualConflict: vi.fn(async (context) => {
        expect(context).toMatchObject({
          unitKey: 'wu-conflict',
          patchPath,
          touchedPaths: ['wiki/global/a.md'],
        });
        await writeFile(join(configDir, 'wiki/global/a.md'), 'accepted\nproposal\n', 'utf-8');
        return {
          status: 'repaired',
          attempts: 1,
          changedPaths: ['wiki/global/a.md'],
        };
      }),
    });

    expect(result).toMatchObject({
      status: 'accepted',
      touchedPaths: ['wiki/global/a.md'],
      textualResolution: {
        status: 'repaired',
        attempts: 1,
        changedPaths: ['wiki/global/a.md'],
      },
    });
    expect(validateAppliedTree).toHaveBeenCalledOnce();
    await expect(readFile(join(configDir, 'wiki/global/a.md'), 'utf-8')).resolves.toBe(
      'accepted\nproposal\n',
    );
    await expect(readFile(trace.tracePath, 'utf-8')).resolves.toContain('patch_accepted_after_textual_resolution');
    expect(await git.revParseHead()).not.toBe(baseSha);
  });

  it('keeps the pre-apply integration tree when the resolver cannot repair a textual conflict', async () => {
    const { homeDir, configDir, git } = await makeRepo();
    await mkdir(join(configDir, 'wiki/global'), { recursive: true });
    await writeFile(join(configDir, 'wiki/global/a.md'), 'base\n', 'utf-8');
    await git.commitFiles(['wiki/global/a.md'], 'base page', 'System User', 'system@example.com');
    const conflictBase = await git.revParseHead();

    await writeFile(join(configDir, 'wiki/global/a.md'), 'accepted\n', 'utf-8');
    await git.commitFiles(['wiki/global/a.md'], 'accepted edit', 'System User', 'system@example.com');
    const acceptedHead = await git.revParseHead();

    const childDir = join(homeDir, 'child-conflict-fails');
    await git.addWorktree(childDir, 'child-conflict-fails', conflictBase);
    const childGit = git.forWorktree(childDir);
    await writeFile(join(childDir, 'wiki/global/a.md'), 'proposal\n', 'utf-8');
    await childGit.commitFiles(['wiki/global/a.md'], 'proposal edit', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'proposal-fails.patch');
    await childGit.writeBinaryNoRenamePatch(conflictBase, 'HEAD', patchPath);

    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-resolver-fails/trace.jsonl'),
      jobId: 'job-resolver-fails',
      connectionId: 'warehouse',
      sourceKey: 'metabase',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-conflict',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'System User', email: 'system@example.com' },
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['warehouse']),
      validateAppliedTree: vi.fn(async () => {}),
      resolveTextualConflict: vi.fn(async () => ({
        status: 'failed',
        attempts: 1,
        reason: 'resolver completed without editing an allowed path',
      })),
    });

    expect(result).toMatchObject({
      status: 'textual_conflict',
      textualResolution: {
        status: 'failed',
        attempts: 1,
        reason: 'resolver completed without editing an allowed path',
      },
    });
    expect(await git.revParseHead()).toBe(acceptedHead);
    await expect(readFile(join(configDir, 'wiki/global/a.md'), 'utf-8')).resolves.toBe('accepted\n');
  });
```

- [ ] **Step 2: Run the patch integrator tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/patch-integrator.test.ts
```

Expected: FAIL because `integrateWorkUnitPatch()` does not accept
`resolveTextualConflict` and does not return `textualResolution`.

- [ ] **Step 3: Commit the failing integrator tests**

```bash
git add packages/context/src/ingest/isolated-diff/patch-integrator.test.ts
git commit -m "test(ingest): cover isolated diff resolver integration"
```

---

### Task 3: Implement the Textual Conflict Resolver

**Files:**
- Create: `packages/context/src/ingest/isolated-diff/textual-conflict-resolver.ts`
- Modify: `packages/context/src/ingest/isolated-diff/patch-integrator.ts`

- [ ] **Step 1: Add the resolver module**

Create `packages/context/src/ingest/isolated-diff/textual-conflict-resolver.ts`:

```ts
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AgentRunnerPort, KtxRuntimeToolSet } from '../../llm/index.js';
import type { IngestTraceWriter } from '../ingest-trace.js';
import { traceTimed } from '../ingest-trace.js';

export type TextualConflictResolutionResult =
  | { status: 'repaired'; attempts: number; changedPaths: string[] }
  | { status: 'failed'; attempts: number; reason: string };

export interface ResolveTextualConflictInput {
  agentRunner: AgentRunnerPort;
  workdir: string;
  unitKey: string;
  patchPath: string;
  touchedPaths: string[];
  trace: IngestTraceWriter;
  reason: string;
  maxAttempts?: number;
  stepBudget?: number;
}

const readIntegrationFileSchema = z.object({
  path: z.string().min(1),
});

const writeIntegrationFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const deleteIntegrationFileSchema = z.object({
  path: z.string().min(1),
});

function normalizeRepoPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`resolver path must be a repository-relative path: ${path}`);
  }
  return parts.join('/');
}

function assertAllowedPath(path: string, allowedPaths: ReadonlySet<string>): string {
  const normalized = normalizeRepoPath(path);
  if (!allowedPaths.has(normalized)) {
    throw new Error(`resolver path not allowed: ${normalized}`);
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

function buildResolverSystemPrompt(): string {
  return `<role>
You repair one failed KTX isolated-diff patch inside the integration worktree.
</role>

<rules>
- Preserve accepted integration content that is unrelated to the failed patch.
- Incorporate the failed patch only when the patch evidence is compatible with the current file.
- Edit only paths exposed by the resolver tools.
- Prefer the smallest text edit that makes the composed artifact coherent.
- Do not create new facts that are absent from the current file or failed patch.
- Stop after writing the repaired file content.
</rules>`;
}

function buildResolverUserPrompt(input: {
  unitKey: string;
  patchPath: string;
  touchedPaths: string[];
  reason: string;
  attempt: number;
  maxAttempts: number;
}): string {
  return `Repair isolated-diff textual conflict.

WorkUnit: ${input.unitKey}
Attempt: ${input.attempt} of ${input.maxAttempts}
Patch path: ${input.patchPath}
Touched paths:
${input.touchedPaths.map((path) => `- ${path}`).join('\n')}

Git apply failure:
${input.reason}

Use read_failed_patch first. Then read the touched integration files, write the
repaired content, and stop.`;
}

function buildToolSet(input: {
  workdir: string;
  patchPath: string;
  allowedPaths: ReadonlySet<string>;
  editedPaths: Set<string>;
}): KtxRuntimeToolSet {
  return {
    read_failed_patch: {
      name: 'read_failed_patch',
      description: 'Read the failed Git patch that could not be applied to the integration worktree.',
      inputSchema: z.object({}),
      execute: async () => {
        const patch = await readFile(input.patchPath, 'utf-8');
        return {
          markdown: patch,
          structured: { patchPath: input.patchPath, bytes: Buffer.byteLength(patch) },
        };
      },
    },
    read_integration_file: {
      name: 'read_integration_file',
      description: 'Read one allowed file from the current integration worktree.',
      inputSchema: readIntegrationFileSchema,
      execute: async ({ path }: z.infer<typeof readIntegrationFileSchema>) => {
        const normalized = assertAllowedPath(path, input.allowedPaths);
        const file = await readOptionalFile(join(input.workdir, normalized));
        return {
          markdown: file.exists ? file.content : `(missing file: ${normalized})`,
          structured: { path: normalized, exists: file.exists },
        };
      },
    },
    write_integration_file: {
      name: 'write_integration_file',
      description: 'Replace one allowed integration worktree file with repaired text content.',
      inputSchema: writeIntegrationFileSchema,
      execute: async ({ path, content }: z.infer<typeof writeIntegrationFileSchema>) => {
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
    delete_integration_file: {
      name: 'delete_integration_file',
      description: 'Delete one allowed integration worktree file when the failed patch proves the deletion is correct.',
      inputSchema: deleteIntegrationFileSchema,
      execute: async ({ path }: z.infer<typeof deleteIntegrationFileSchema>) => {
        const normalized = assertAllowedPath(path, input.allowedPaths);
        await rm(join(input.workdir, normalized), { force: true });
        input.editedPaths.add(normalized);
        return {
          markdown: `Deleted ${normalized}`,
          structured: { path: normalized },
        };
      },
    },
  };
}

export async function resolveTextualConflict(
  input: ResolveTextualConflictInput,
): Promise<TextualConflictResolutionResult> {
  const allowedPaths = new Set(input.touchedPaths.map(normalizeRepoPath));
  const maxAttempts = input.maxAttempts ?? 1;
  const stepBudget = input.stepBudget ?? 12;
  let lastFailure = 'resolver did not run';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const editedPaths = new Set<string>();
    const traceData = {
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      touchedPaths: [...allowedPaths].sort(),
      attempt,
      maxAttempts,
      reason: input.reason,
    };
    const result = await traceTimed(input.trace, 'resolver', 'textual_conflict_resolver', traceData, async () =>
      input.agentRunner.runLoop({
        modelRole: 'repair',
        systemPrompt: buildResolverSystemPrompt(),
        userPrompt: buildResolverUserPrompt({
          unitKey: input.unitKey,
          patchPath: input.patchPath,
          touchedPaths: [...allowedPaths].sort(),
          reason: input.reason,
          attempt,
          maxAttempts,
        }),
        toolSet: buildToolSet({
          workdir: input.workdir,
          patchPath: input.patchPath,
          allowedPaths,
          editedPaths,
        }),
        stepBudget,
        telemetryTags: {
          operationName: 'ingest-isolated-diff-textual-resolver',
          source: input.trace.context.sourceKey,
          jobId: input.trace.context.jobId,
          unitKey: input.unitKey,
        },
      }),
    );

    if (result.stopReason === 'error') {
      lastFailure = result.error?.message ?? 'resolver agent loop errored';
      await input.trace.event('error', 'resolver', 'textual_conflict_resolver_failed', traceData, result.error);
      continue;
    }

    const changedPaths = [...editedPaths].sort();
    if (changedPaths.length === 0) {
      lastFailure = 'resolver completed without editing an allowed path';
      await input.trace.event('error', 'resolver', 'textual_conflict_resolver_failed', {
        ...traceData,
        reason: lastFailure,
      });
      continue;
    }

    await input.trace.event('debug', 'resolver', 'textual_conflict_resolver_repaired', {
      ...traceData,
      changedPaths,
    });
    return { status: 'repaired', attempts: attempt, changedPaths };
  }

  return { status: 'failed', attempts: maxAttempts, reason: lastFailure };
}
```

- [ ] **Step 2: Run resolver tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/textual-conflict-resolver.test.ts
```

Expected: PASS.

- [ ] **Step 3: Update the patch integrator types and conflict path**

In `packages/context/src/ingest/isolated-diff/patch-integrator.ts`, add the
import:

```ts
import type { TextualConflictResolutionResult } from './textual-conflict-resolver.js';
```

Replace the result type and input interface with:

```ts
export type PatchIntegrationTextualResolution =
  | { status: 'repaired'; attempts: number; changedPaths: string[] }
  | { status: 'failed'; attempts: number; reason: string };

export type PatchIntegrationResult =
  | { status: 'accepted'; commitSha: string; touchedPaths: string[]; textualResolution?: PatchIntegrationTextualResolution }
  | { status: 'textual_conflict'; reason: string; touchedPaths: string[]; textualResolution?: PatchIntegrationTextualResolution }
  | { status: 'semantic_conflict'; reason: string; touchedPaths: string[]; textualResolution?: PatchIntegrationTextualResolution };

export interface IntegrateWorkUnitPatchInput {
  unitKey: string;
  patchPath: string;
  integrationGit: GitService;
  trace: IngestTraceWriter;
  author: { name: string; email: string };
  slDisallowed: boolean;
  allowedTargetConnectionIds: ReadonlySet<string>;
  validateAppliedTree(touchedPaths: string[]): Promise<void>;
  resolveTextualConflict?(input: {
    unitKey: string;
    patchPath: string;
    touchedPaths: string[];
    reason: string;
  }): Promise<TextualConflictResolutionResult>;
}
```

Inside the `catch` block that currently handles `patch_apply` errors, replace
the existing return with:

```ts
    if (preApplyHead) {
      await input.integrationGit.resetHardTo(preApplyHead);
    }
    const reason = errorMessage(error);
    await input.trace.event('error', 'integration', 'patch_textual_conflict', {
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      touchedPaths,
      reason,
    });

    if (!input.resolveTextualConflict) {
      return {
        status: 'textual_conflict',
        reason,
        touchedPaths,
      };
    }

    const textualResolution = await input.resolveTextualConflict({
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      touchedPaths,
      reason,
    });

    if (textualResolution.status === 'failed') {
      if (preApplyHead) {
        await input.integrationGit.resetHardTo(preApplyHead);
      }
      return {
        status: 'textual_conflict',
        reason: textualResolution.reason,
        touchedPaths,
        textualResolution,
      };
    }

    try {
      await traceTimed(
        input.trace,
        'integration',
        'semantic_gate_after_textual_resolution',
        { unitKey: input.unitKey, touchedPaths: textualResolution.changedPaths },
        async () => {
          await input.validateAppliedTree(textualResolution.changedPaths);
        },
      );
    } catch (semanticError) {
      if (preApplyHead) {
        await input.integrationGit.resetHardTo(preApplyHead);
      }
      await input.trace.event('error', 'integration', 'patch_semantic_conflict_after_textual_resolution', {
        unitKey: input.unitKey,
        patchPath: input.patchPath,
        touchedPaths: textualResolution.changedPaths,
        reason: errorMessage(semanticError),
      });
      return {
        status: 'semantic_conflict',
        reason: errorMessage(semanticError),
        touchedPaths: textualResolution.changedPaths,
        textualResolution,
      };
    }

    const commit = await input.integrationGit.commitFiles(
      textualResolution.changedPaths,
      `ingest: resolve WorkUnit ${input.unitKey} conflict`,
      input.author.name,
      input.author.email,
    );
    if (!commit.created) {
      if (preApplyHead) {
        await input.integrationGit.resetHardTo(preApplyHead);
      }
      const noChangeReason = 'textual resolver produced no committable changes';
      await input.trace.event('error', 'integration', 'textual_conflict_resolver_noop', {
        unitKey: input.unitKey,
        patchPath: input.patchPath,
        touchedPaths: textualResolution.changedPaths,
      });
      return {
        status: 'textual_conflict',
        reason: noChangeReason,
        touchedPaths: textualResolution.changedPaths,
        textualResolution,
      };
    }

    await input.trace.event('debug', 'integration', 'patch_accepted_after_textual_resolution', {
      unitKey: input.unitKey,
      commitSha: commit.commitHash,
      touchedPaths: textualResolution.changedPaths,
      attempts: textualResolution.attempts,
    });
    return {
      status: 'accepted',
      commitSha: commit.commitHash,
      touchedPaths: textualResolution.changedPaths,
      textualResolution,
    };
```

Leave the earlier patch policy rejection branch unchanged so policy failures
cannot invoke the resolver.

- [ ] **Step 4: Run patch integrator tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/patch-integrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit resolver implementation**

```bash
git add packages/context/src/ingest/isolated-diff/textual-conflict-resolver.ts packages/context/src/ingest/isolated-diff/patch-integrator.ts
git commit -m "feat(ingest): repair isolated diff textual conflicts"
```

---

### Task 4: Wire the Resolver into the Runner and Reports

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Modify: `packages/context/src/ingest/reports.ts`
- Modify: `packages/context/src/ingest/report-snapshot.ts`
- Modify: `packages/context/src/ingest/report-snapshot.test.ts`

- [ ] **Step 1: Import the resolver in the runner**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, add:

```ts
import { resolveTextualConflict } from './isolated-diff/textual-conflict-resolver.js';
```

- [ ] **Step 2: Add resolver counters to the isolated-diff summary**

In the `isolatedDiffSummary` initializer in
`packages/context/src/ingest/ingest-bundle.runner.ts`, add:

```ts
        resolverAttempts: 0,
        resolverRepairs: 0,
        resolverFailures: 0,
```

- [ ] **Step 3: Pass the resolver callback to `integrateWorkUnitPatch()`**

Inside the isolated-diff integration loop, add this property to the
`integrateWorkUnitPatch({ ... })` call:

```ts
            resolveTextualConflict: (context) =>
              resolveTextualConflict({
                agentRunner: this.deps.agentRunner,
                workdir: sessionWorktree.workdir,
                unitKey: context.unitKey,
                patchPath: context.patchPath,
                touchedPaths: context.touchedPaths,
                trace: runTrace,
                reason: context.reason,
                maxAttempts: 1,
                stepBudget: 12,
              }),
```

- [ ] **Step 4: Record resolver outcomes after each integration attempt**

Immediately after `const integration = await integrateWorkUnitPatch({ ... });`,
add:

```ts
          if (integration.textualResolution) {
            isolatedDiffSummary.resolverAttempts += integration.textualResolution.attempts;
            if (integration.textualResolution.status === 'repaired') {
              isolatedDiffSummary.textualConflicts += 1;
              isolatedDiffSummary.resolverRepairs += 1;
            } else {
              isolatedDiffSummary.resolverFailures += 1;
            }
          }
```

Keep the existing textual-conflict and semantic-conflict branches after this
counter update.

- [ ] **Step 5: Add report body fields**

In `packages/context/src/ingest/reports.ts`, extend
`IngestReportBody['isolatedDiff']` with:

```ts
    resolverAttempts?: number;
    resolverRepairs?: number;
    resolverFailures?: number;
```

In `packages/context/src/ingest/report-snapshot.ts`, extend the
`isolatedDiff` object schema with:

```ts
            resolverAttempts: z.number().int().min(0).default(0),
            resolverRepairs: z.number().int().min(0).default(0),
            resolverFailures: z.number().int().min(0).default(0),
```

- [ ] **Step 6: Add the report parser regression**

Append this test to `packages/context/src/ingest/report-snapshot.test.ts`:

```ts
  it('parses isolated-diff textual resolver counters', () => {
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
        diffSummary: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
        commitSha: 'abc123',
        isolatedDiff: {
          enabled: true,
          acceptedPatches: 2,
          textualConflicts: 1,
          semanticConflicts: 0,
          resolverAttempts: 1,
          resolverRepairs: 1,
          resolverFailures: 0,
        },
        workUnits: [],
        failedWorkUnits: [],
        reconciliationSkipped: true,
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
        artifactResolutions: [],
        evictionInputs: [],
        unresolvedCards: [],
        supersededBy: null,
        overrideOf: null,
        provenanceRows: [],
        toolTranscripts: [],
      },
    });

    expect(snapshot.body.isolatedDiff).toMatchObject({
      resolverAttempts: 1,
      resolverRepairs: 1,
      resolverFailures: 0,
    });
  });
```

- [ ] **Step 7: Run report tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/report-snapshot.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit runner and report wiring**

```bash
git add packages/context/src/ingest/ingest-bundle.runner.ts packages/context/src/ingest/reports.ts packages/context/src/ingest/report-snapshot.ts packages/context/src/ingest/report-snapshot.test.ts
git commit -m "feat(ingest): report isolated diff resolver outcomes"
```

---

### Task 5: Add End-to-End Resolver Regression

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`

- [ ] **Step 1: Add the end-to-end test**

Append this test inside `describe('IngestBundleRunner isolated diff path', ...)`
in `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`:

```ts
  it('repairs additive same-source textual conflicts before final gates and squash', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps } = makeDeps(runtime);
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags.operationName === 'ingest-isolated-diff-textual-resolver') {
          const current = await params.toolSet.read_integration_file.execute({
            path: 'semantic-layer/warehouse/mart_account_segments.yaml',
          });
          expect(current.markdown).toContain('total_contract_arr_cents');
          const patch = await params.toolSet.read_failed_patch.execute({});
          expect(patch.markdown).toContain('account_count');
          await params.toolSet.write_integration_file.execute({
            path: 'semantic-layer/warehouse/mart_account_segments.yaml',
            content:
              'name: mart_account_segments\n' +
              'grain: [account_id]\n' +
              'columns: [{name: account_id, type: string}]\n' +
              'joins: []\n' +
              'measures:\n' +
              '  - name: total_contract_arr_cents\n' +
              '    expr: sum(contract_arr)\n' +
              '  - name: account_count\n' +
              '    expr: count_distinct(account_id)\n',
          });
          return { stopReason: 'natural' };
        }

        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
        if (params.telemetryTags.unitKey === 'card-wiki') {
          await writeFile(
            join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
            'name: mart_account_segments\n' +
              'grain: [account_id]\n' +
              'columns: [{name: account_id, type: string}]\n' +
              'joins: []\n' +
              'measures:\n' +
              '  - name: total_contract_arr_cents\n' +
              '    expr: sum(contract_arr)\n',
          );
        } else if (params.telemetryTags.unitKey === 'card-source') {
          await writeFile(
            join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
            'name: mart_account_segments\n' +
              'grain: [account_id]\n' +
              'columns: [{name: account_id, type: string}]\n' +
              'joins: []\n' +
              'measures:\n' +
              '  - name: account_count\n' +
              '    expr: count_distinct(account_id)\n',
          );
        }
        addTouchedSlSource(currentSession.touchedSlSources, {
          connectionId: 'warehouse',
          sourceName: 'mart_account_segments',
        });
        return { stopReason: 'natural' };
      });

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['cards/wiki.json', 'hash-a'],
        ['cards/source.json', 'hash-b'],
      ]);

      const result = await runner.run({
        jobId: 'job-resolver-e2e',
        connectionId: 'warehouse',
        sourceKey: 'metabase',
        trigger: 'manual_resync',
        bundleRef: { kind: 'upload', uploadId: 'upload-1' },
      });

      expect(result.commitSha).toBeTruthy();
      const source = await readFile(
        join(runtime.configDir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
        'utf-8',
      );
      expect(source).toContain('total_contract_arr_cents');
      expect(source).toContain('account_count');
      expect(deps.agentRunner.runLoop).toHaveBeenCalledWith(
        expect.objectContaining({
          modelRole: 'repair',
          telemetryTags: expect.objectContaining({
            operationName: 'ingest-isolated-diff-textual-resolver',
            unitKey: 'card-source',
          }),
        }),
      );
      const successReport = (deps.reports.create as any).mock.calls.at(-1)?.[0]?.body;
      expect(successReport.isolatedDiff).toMatchObject({
        acceptedPatches: 2,
        textualConflicts: 1,
        semanticConflicts: 0,
        resolverAttempts: 1,
        resolverRepairs: 1,
        resolverFailures: 0,
      });
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-resolver-e2e/trace.jsonl'), 'utf-8');
      expect(trace).toContain('textual_conflict_resolver_repaired');
      expect(trace).toContain('patch_accepted_after_textual_resolution');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the isolated-diff runner regression**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts -t "repairs additive same-source textual conflicts"
```

Expected: PASS.

- [ ] **Step 3: Commit the end-to-end regression**

```bash
git add packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts
git commit -m "test(ingest): verify isolated diff textual conflict repair"
```

---

### Task 6: Final Verification

**Files:**
- Verify: `packages/context/src/ingest/isolated-diff/textual-conflict-resolver.test.ts`
- Verify: `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`
- Verify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`
- Verify: `packages/context/src/ingest/report-snapshot.test.ts`

- [ ] **Step 1: Run the focused resolver and isolated-diff tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/textual-conflict-resolver.test.ts src/ingest/isolated-diff/patch-integrator.test.ts src/ingest/ingest-bundle.runner.isolated-diff.test.ts src/ingest/report-snapshot.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the existing isolated-diff safety suite**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-trace.test.ts src/ingest/wiki-body-refs.test.ts src/ingest/artifact-gates.test.ts src/ingest/semantic-layer-target-policy.test.ts src/ingest/isolated-diff/git-patch.test.ts src/ingest/isolated-diff/work-unit-executor.test.ts src/ingest/isolated-diff/patch-integrator.test.ts src/ingest/ingest-bundle.runner.isolated-diff.test.ts src/sl/tools/sl-write-source.tool.test.ts src/sl/tools/sl-edit-source.tool.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run package type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 4: Run dead-code analysis**

Run:

```bash
pnpm run dead-code
```

Expected: PASS, or only pre-existing findings unrelated to the files changed
by this plan.

- [ ] **Step 5: Decide docs-site impact**

No `docs-site/content/docs/` update is required for this plan because the
change is an internal ingest correctness behavior and report diagnostics
extension. If execution changes public CLI output while implementing this
plan, add a follow-up docs-site plan for the affected CLI/status page.

- [ ] **Step 6: Commit verification notes only if files changed**

If verification updates snapshots or checked-in fixtures, commit only those
intended files:

```bash
git add packages/context/src/ingest
git commit -m "chore(ingest): verify isolated diff textual conflict repair"
```

If no files changed during verification, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Bounded resolver-agent handling for textual conflicts is covered by Tasks 1
  through 5.
- The resolver receives the failed patch, current integration files, touched
  path scope, and trace context.
- Patch policy failures remain non-repairable, preserving the existing
  `slDisallowed`, target-connection, binary, and executable-mode gates.
- Repaired files run through the existing artifact gates before commit and
  before squash.
- Resolver attempts, repaired files, failures, and trace events are reported.

Remaining spec gaps after this plan:

- Gate repair for cleanly applied trees that fail final gates.
- Resolver context that includes work-unit transcript excerpts and all
  previously applied overlapping patches.
- Broader connector rollout for Notion, LookML, Looker, dbt, and MetricFlow.
- Isolated-diff default promotion after at least one non-Metabase connector
  passes.
- Shared-worktree WorkUnit path removal.

Placeholder scan:

- The plan contains exact file paths, commands, expected outcomes, and concrete
  code blocks for every code-changing step.
- The plan does not contain deferred implementation markers.

Type consistency:

- `TextualConflictResolutionResult`, `PatchIntegrationTextualResolution`, and
  `textualResolution` use the same `status`, `attempts`, `changedPaths`, and
  `reason` fields across resolver, integrator, runner, and tests.
- Report fields use `resolverAttempts`, `resolverRepairs`, and
  `resolverFailures` consistently in `reports.ts`, `report-snapshot.ts`, and
  runner report bodies.
