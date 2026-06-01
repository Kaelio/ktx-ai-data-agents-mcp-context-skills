import type { KtxProgressPort, KtxProgressUpdateOptions } from './context/scan/types.js';
import type { KtxIngestProgressUpdate } from './ingest.js';

export interface AggregateProgressState {
  progress: number;
}

export function createAggregateProgressPort(
  onProgress: (update: KtxIngestProgressUpdate) => void,
  state: AggregateProgressState = { progress: 0 },
  start = 0,
  weight = 1,
): KtxProgressPort {
  return {
    async update(value: number, message?: string, options?: KtxProgressUpdateOptions): Promise<void> {
      const absoluteValue = start + Math.max(0, Math.min(1, value)) * weight;
      state.progress = Math.max(state.progress, Math.min(1, absoluteValue));
      if (!message) return;
      onProgress({
        percent: Math.max(0, Math.min(100, Math.round(state.progress * 100))),
        message,
        ...(options?.transient !== undefined ? { transient: options.transient } : {}),
      });
    },
    startPhase(phaseWeight: number): KtxProgressPort {
      return createAggregateProgressPort(onProgress, state, state.progress, weight * phaseWeight);
    },
  };
}
