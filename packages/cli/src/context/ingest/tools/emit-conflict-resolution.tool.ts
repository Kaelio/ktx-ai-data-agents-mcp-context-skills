import { tool } from 'ai';
import { z } from 'zod';
import type { ConflictResolvedRecord, StageIndex } from '../stages/stage-index.types.js';

interface EmitConflictResolutionDeps {
  stageIndex: StageIndex;
}

export function createEmitConflictResolutionTool(deps: EmitConflictResolutionDeps) {
  return tool({
    description:
      'Record one conflict resolution decision for the final IngestReport. Call after resolving or flagging a cross-WorkUnit conflict.',
    inputSchema: z.object({
      unitKey: z.string().min(1).optional(),
      kind: z.enum(['structural_duplicate', 'near_duplicate', 'definitional_contradiction', 're_ingest_change']),
      contestedKey: z.string().min(1).optional(),
      artifactKey: z.string().min(1),
      detail: z.string().min(1),
      flaggedForHuman: z.boolean().default(false),
    }),
    execute: async (input): Promise<string> => {
      const record: ConflictResolvedRecord = {
        kind: input.kind,
        artifactKey: input.artifactKey,
        detail: input.detail,
        flaggedForHuman: input.flaggedForHuman,
      };
      if (input.unitKey) {
        record.unitKey = input.unitKey;
      }
      if (input.contestedKey) {
        record.contestedKey = input.contestedKey;
      }
      deps.stageIndex.conflictsResolved.push(record);
      return `recorded conflict resolution for ${record.artifactKey}`;
    },
  });
}
