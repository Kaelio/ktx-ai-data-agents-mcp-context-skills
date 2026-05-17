import { readFile } from 'node:fs/promises';
import type { GitService } from '../../core/index.js';
import type { IngestTraceWriter } from '../ingest-trace.js';
import { traceTimed } from '../ingest-trace.js';
import { assertPatchAllowedForWorkUnit, parsePatchTouchedPaths } from './git-patch.js';
import type { TextualConflictResolutionResult } from './textual-conflict-resolver.js';

export type PatchIntegrationTextualResolution =
  | { status: 'repaired'; attempts: number; changedPaths: string[] }
  | { status: 'failed'; attempts: number; reason: string };

export type PatchIntegrationResult =
  | { status: 'accepted'; commitSha: string; touchedPaths: string[]; textualResolution?: PatchIntegrationTextualResolution }
  | {
      status: 'textual_conflict';
      reason: string;
      touchedPaths: string[];
      textualResolution?: PatchIntegrationTextualResolution;
    }
  | {
      status: 'semantic_conflict';
      reason: string;
      touchedPaths: string[];
      textualResolution?: PatchIntegrationTextualResolution;
    };

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function integrateWorkUnitPatch(input: IntegrateWorkUnitPatchInput): Promise<PatchIntegrationResult> {
  const preApplyHead = await input.integrationGit.revParseHead();
  const patch = await readFile(input.patchPath, 'utf-8');
  const touchedPaths = parsePatchTouchedPaths(patch).map((entry) => entry.path);
  if (touchedPaths.length === 0) {
    await input.trace.event('debug', 'integration', 'patch_noop_accepted', {
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      patchBytes: Buffer.byteLength(patch),
    });
    return { status: 'accepted', commitSha: preApplyHead ?? '', touchedPaths };
  }
  try {
    assertPatchAllowedForWorkUnit({
      unitKey: input.unitKey,
      patch,
      slDisallowed: input.slDisallowed,
      allowedTargetConnectionIds: input.allowedTargetConnectionIds,
    });
  } catch (error) {
    await input.trace.event('error', 'integration', 'patch_policy_rejected', {
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      touchedPaths,
      allowedTargetConnectionIds: [...input.allowedTargetConnectionIds].sort(),
      reason: errorMessage(error),
    });
    return {
      status: 'textual_conflict',
      reason: errorMessage(error),
      touchedPaths,
    };
  }

  try {
    await traceTimed(
      input.trace,
      'integration',
      'patch_apply',
      { unitKey: input.unitKey, patchPath: input.patchPath, touchedPaths },
      async () => {
        await input.integrationGit.applyPatchFile3WayIndex(input.patchPath);
        await input.integrationGit.assertWorktreeClean();
      },
    );
  } catch (error) {
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
      reason: errorMessage(error),
    });
    return {
      status: 'semantic_conflict',
      reason: errorMessage(error),
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
