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
