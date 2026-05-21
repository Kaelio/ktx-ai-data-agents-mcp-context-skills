import { tool } from 'ai';
import { z } from 'zod';
import { memoryActionIdentity } from '../action-identity.js';
import type { StageIndex } from '../stages/stage-index.types.js';

export interface StageDiffDeps {
  stageIndex: StageIndex;
}

export function createStageDiffTool(deps: StageDiffDeps) {
  return tool({
    description:
      'Compare two WorkUnits by their writes. SL writes overlap only when target connection and artifact key both match; same-key SL actions on different target connections are non-overlapping.',
    inputSchema: z.object({
      unitKeyA: z.string(),
      unitKeyB: z.string(),
    }),
    execute: ({ unitKeyA, unitKeyB }) => {
      const a = deps.stageIndex.workUnits.find((wu) => wu.unitKey === unitKeyA);
      const b = deps.stageIndex.workUnits.find((wu) => wu.unitKey === unitKeyB);
      if (!a) {
        return Promise.resolve(`Error: unknown unitKey "${unitKeyA}"`);
      }
      if (!b) {
        return Promise.resolve(`Error: unknown unitKey "${unitKeyB}"`);
      }
      const runConnectionId = deps.stageIndex.connectionId;
      const keysA = new Set(a.actions.map((ac) => memoryActionIdentity(ac, runConnectionId)));
      const keysB = new Set(b.actions.map((ac) => memoryActionIdentity(ac, runConnectionId)));
      const overlap = [...keysA].filter((k) => keysB.has(k));
      if (overlap.length === 0) {
        return Promise.resolve(`No overlap between ${unitKeyA} and ${unitKeyB}.`);
      }
      const overlapDetail = overlap
        .map((k) => {
          const aDetail = a.actions.find((ac) => memoryActionIdentity(ac, runConnectionId) === k);
          const bDetail = b.actions.find((ac) => memoryActionIdentity(ac, runConnectionId) === k);
          return `- ${k}\n  ${unitKeyA}: ${aDetail?.detail ?? ''}\n  ${unitKeyB}: ${bDetail?.detail ?? ''}`;
        })
        .join('\n');
      return Promise.resolve(`Overlap between ${unitKeyA} and ${unitKeyB}:\n${overlapDetail}`);
    },
  });
}
