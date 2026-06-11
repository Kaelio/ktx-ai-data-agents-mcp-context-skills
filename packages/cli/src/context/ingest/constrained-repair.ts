import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AgentRunnerPort, KtxRuntimeToolSet } from '../../context/llm/runtime-port.js';
import type { IngestTraceWriter } from './ingest-trace.js';
import { traceTimed } from './ingest-trace.js';

/**
 * Shared loop for the two integration-time repair agents (semantic gate
 * repair, textual conflict resolution). Success is decided by re-running the
 * failed check — `verify` — never by whether the agent edited files: an
 * ineffective edit fails, and an explicit no-change declaration that verifies
 * succeeds.
 */

export type RepairVerification = { ok: true } | { ok: false; reason: string };

export type ConstrainedRepairResult =
  | { status: 'repaired'; attempts: number; changedPaths: string[] }
  | { status: 'failed'; attempts: number; reason: string };

export interface ConstrainedRepairToolContext {
  workdir: string;
  allowedPaths: ReadonlySet<string>;
  editedPaths: Set<string>;
  declareNoChange(reason: string): void;
}

export interface ConstrainedRepairLoopInput {
  agentRunner: AgentRunnerPort;
  workdir: string;
  allowedPaths: string[];
  trace: IngestTraceWriter;
  tracePhase: string;
  traceEventName: string;
  traceData: Record<string, unknown>;
  systemPrompt: string;
  buildUserPrompt(input: { attempt: number; maxAttempts: number; previousFailure: string | null }): string;
  buildExtraTools?(context: ConstrainedRepairToolContext): KtxRuntimeToolSet;
  verify(changedPaths: string[]): Promise<RepairVerification>;
  /** Failure reason when an attempt neither edits nor declares no-change. */
  noChangeFailureReason: string;
  telemetryTags: Record<string, string>;
  maxAttempts?: number;
  stepBudget?: number;
  abortSignal?: AbortSignal;
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
    throw new Error(`repair path must be a repository-relative path: ${path}`);
  }
  return parts.join('/');
}

function assertAllowedPath(path: string, allowedPaths: ReadonlySet<string>): string {
  const normalized = normalizeRepoPath(path);
  if (!allowedPaths.has(normalized)) {
    throw new Error(`repair path not allowed: ${normalized}`);
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

function buildRepairFileTools(context: ConstrainedRepairToolContext): KtxRuntimeToolSet {
  return {
    read_repair_file: {
      name: 'read_repair_file',
      description: 'Read one allowed file from the integration worktree.',
      inputSchema: readRepairFileSchema,
      execute: async ({ path }: z.infer<typeof readRepairFileSchema>) => {
        const normalized = assertAllowedPath(path, context.allowedPaths);
        const file = await readOptionalFile(join(context.workdir, normalized));
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
        const normalized = assertAllowedPath(path, context.allowedPaths);
        const fullPath = join(context.workdir, normalized);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, 'utf-8');
        context.editedPaths.add(normalized);
        return {
          markdown: `Wrote ${normalized}`,
          structured: { path: normalized, bytes: Buffer.byteLength(content) },
        };
      },
    },
  };
}

export function buildDeleteRepairFileTool(context: ConstrainedRepairToolContext): KtxRuntimeToolSet {
  const deleteRepairFileSchema = z.object({
    path: z.string().min(1),
  });
  return {
    delete_repair_file: {
      name: 'delete_repair_file',
      description: 'Delete one allowed integration worktree file when the failed patch proves the deletion is correct.',
      inputSchema: deleteRepairFileSchema,
      execute: async ({ path }: z.infer<typeof deleteRepairFileSchema>) => {
        const normalized = assertAllowedPath(path, context.allowedPaths);
        await rm(join(context.workdir, normalized), { force: true });
        context.editedPaths.add(normalized);
        return {
          markdown: `Deleted ${normalized}`,
          structured: { path: normalized },
        };
      },
    },
  };
}

export async function runConstrainedRepairLoop(input: ConstrainedRepairLoopInput): Promise<ConstrainedRepairResult> {
  const allowedPaths = new Set(input.allowedPaths.map(normalizeRepoPath));
  const sortedAllowedPaths = [...allowedPaths].sort();
  const maxAttempts = input.maxAttempts ?? 2;
  const stepBudget = input.stepBudget ?? 16;
  // Edits persist in the worktree across attempts, so the verified set and the
  // reported changedPaths accumulate over the whole loop.
  const editedPaths = new Set<string>();
  let lastFailure = 'repair did not run';
  let previousFailure: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let noChangeDeclaration: string | null = null;
    const toolContext: ConstrainedRepairToolContext = {
      workdir: input.workdir,
      allowedPaths,
      editedPaths,
      declareNoChange: (reason: string) => {
        noChangeDeclaration = reason;
      },
    };
    const traceData = {
      ...input.traceData,
      attempt,
      maxAttempts,
      allowedPaths: sortedAllowedPaths,
    };
    const result = await traceTimed(input.trace, input.tracePhase, input.traceEventName, traceData, async () =>
      input.agentRunner.runLoop({
        modelRole: 'repair',
        systemPrompt: input.systemPrompt,
        userPrompt: input.buildUserPrompt({ attempt, maxAttempts, previousFailure }),
        toolSet: {
          ...buildRepairFileTools(toolContext),
          ...(input.buildExtraTools?.(toolContext) ?? {}),
        },
        stepBudget,
        telemetryTags: input.telemetryTags,
        abortSignal: input.abortSignal,
      }),
    );

    if (result.stopReason === 'error') {
      lastFailure = result.error?.message ?? 'repair agent loop errored';
      previousFailure = lastFailure;
      await input.trace.event('error', input.tracePhase, `${input.traceEventName}_failed`, traceData, result.error);
      continue;
    }

    const changedPaths = [...editedPaths].sort();
    if (changedPaths.length === 0 && noChangeDeclaration === null) {
      // Nothing changed and nothing was claimed: the failed check would fail
      // identically, so skip verification and retry.
      lastFailure = input.noChangeFailureReason;
      previousFailure = lastFailure;
      await input.trace.event('error', input.tracePhase, `${input.traceEventName}_failed`, {
        ...traceData,
        reason: lastFailure,
      });
      continue;
    }

    const verification = await input.verify(changedPaths);
    if (!verification.ok) {
      lastFailure = verification.reason;
      previousFailure = lastFailure;
      await input.trace.event('error', input.tracePhase, `${input.traceEventName}_failed`, {
        ...traceData,
        changedPaths,
        reason: lastFailure,
      });
      continue;
    }

    await input.trace.event('debug', input.tracePhase, `${input.traceEventName}_repaired`, {
      ...traceData,
      changedPaths,
      ...(noChangeDeclaration !== null ? { noChangeDeclaration } : {}),
    });
    return { status: 'repaired', attempts: attempt, changedPaths };
  }

  return { status: 'failed', attempts: maxAttempts, reason: lastFailure };
}
