import type { MemoryAction } from '../memory/index.js';

export function actionTargetConnectionId(action: MemoryAction, runConnectionId: string): string {
  return action.target === 'sl' ? (action.targetConnectionId ?? runConnectionId) : runConnectionId;
}

export function memoryActionIdentity(action: MemoryAction, runConnectionId: string): string {
  return `${action.target}:${actionTargetConnectionId(action, runConnectionId)}:${action.key}`;
}
