import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AgentRunnerPort, KtxRuntimeToolSet } from '../../context/llm/runtime-port.js';
import type { TouchedSlSource } from '../../context/tools/touched-sl-sources.js';
import type { IngestTraceWriter } from './ingest-trace.js';
import { traceTimed } from './ingest-trace.js';

type FinalGateRepairKind = 'patch_semantic_gate' | 'final_artifact_gate';

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
