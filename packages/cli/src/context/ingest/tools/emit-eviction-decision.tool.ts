import { tool } from 'ai';
import { z } from 'zod';
import type { EvictionAppliedRecord, StageIndex } from '../stages/stage-index.types.js';

interface EmitEvictionDecisionDeps {
  stageIndex: StageIndex;
  deletedRawPaths: string[];
}

function sameEvictionArtifact(left: EvictionAppliedRecord, right: EvictionAppliedRecord): boolean {
  return (
    left.rawPath === right.rawPath && left.artifactKind === right.artifactKind && left.artifactKey === right.artifactKey
  );
}

export function createEmitEvictionDecisionTool(deps: EmitEvictionDecisionDeps) {
  const allowedPaths = new Set(deps.deletedRawPaths);
  return tool({
    description:
      'Record one eviction decision for the final IngestReport. The rawPath must come from the current Eviction Set.',
    inputSchema: z.object({
      rawPath: z.string().min(1),
      artifactKind: z.enum(['sl', 'wiki']),
      artifactKey: z.string().min(1),
      action: z.literal('removed'),
      reason: z.string().min(1),
    }),
    execute: async (input): Promise<string> => {
      if (!allowedPaths.has(input.rawPath)) {
        return `Error: rawPath "${input.rawPath}" is not in the current eviction set`;
      }

      const record: EvictionAppliedRecord = {
        rawPath: input.rawPath,
        artifactKind: input.artifactKind,
        artifactKey: input.artifactKey,
        action: input.action,
        reason: input.reason,
      };
      const existingIndex = deps.stageIndex.evictionsApplied.findIndex((candidate) =>
        sameEvictionArtifact(candidate, record),
      );
      if (existingIndex >= 0) {
        deps.stageIndex.evictionsApplied[existingIndex] = record;
      } else {
        deps.stageIndex.evictionsApplied.push(record);
      }
      return `recorded eviction decision for ${record.rawPath} -> ${record.artifactKind}:${record.artifactKey}`;
    },
  });
}
