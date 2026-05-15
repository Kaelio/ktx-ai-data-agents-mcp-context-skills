import { z } from 'zod';
import { createAgentTool } from '../../agent/index.js';
import type { ArtifactResolutionRecord, StageIndex } from '../stages/stage-index.types.js';

interface EmitArtifactResolutionDeps {
  stageIndex: StageIndex;
  allowedPaths: Set<string>;
}

function sameArtifactResolution(left: ArtifactResolutionRecord, right: ArtifactResolutionRecord): boolean {
  return (
    left.rawPath === right.rawPath &&
    left.artifactKind === right.artifactKind &&
    left.artifactKey === right.artifactKey &&
    left.actionType === right.actionType
  );
}

export function createEmitArtifactResolutionTool(deps: EmitArtifactResolutionDeps) {
  return createAgentTool({
    name: 'emit_artifact_resolution',
    description:
      'Record one explicit artifact resolution for ingest provenance. Use when reconciliation merges or subsumes an artifact without creating a new wiki or SL write action.',
    inputSchema: z.object({
      rawPath: z.string().min(1),
      artifactKind: z.enum(['sl', 'wiki']),
      artifactKey: z.string().min(1),
      actionType: z.enum(['merged', 'subsumed']),
      reason: z.string().min(1),
    }),
    execute: async (input): Promise<string> => {
      if (!deps.allowedPaths.has(input.rawPath)) {
        return `Error: rawPath "${input.rawPath}" is not available to this ingest stage`;
      }

      const record: ArtifactResolutionRecord = {
        rawPath: input.rawPath,
        artifactKind: input.artifactKind,
        artifactKey: input.artifactKey,
        actionType: input.actionType,
        reason: input.reason,
      };
      const existingIndex = deps.stageIndex.artifactResolutions?.findIndex((candidate) =>
        sameArtifactResolution(candidate, record),
      );
      if (existingIndex !== undefined && existingIndex >= 0 && deps.stageIndex.artifactResolutions) {
        deps.stageIndex.artifactResolutions[existingIndex] = record;
      } else {
        deps.stageIndex.artifactResolutions = [...(deps.stageIndex.artifactResolutions ?? []), record];
      }
      return `recorded artifact resolution for ${record.artifactKind}:${record.artifactKey}`;
    },
  });
}
