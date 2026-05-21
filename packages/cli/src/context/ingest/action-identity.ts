import type { MemoryAction } from '../../context/memory/types.js';

export function actionTargetConnectionId(action: MemoryAction, runConnectionId: string): string {
  return action.target === 'sl' ? (action.targetConnectionId ?? runConnectionId) : runConnectionId;
}

export function memoryActionIdentity(action: MemoryAction, runConnectionId: string): string {
  return `${action.target}:${actionTargetConnectionId(action, runConnectionId)}:${action.key}`;
}
