import { describe, expect, it } from 'vitest';
import { createAggregateProgressPort } from '../src/progress-port-adapter.js';

describe('createAggregateProgressPort', () => {
  it('flattens nested weighted progress into absolute percent updates', async () => {
    const updates: Array<{ percent: number; message: string; transient?: boolean }> = [];
    const progress = createAggregateProgressPort((update) => updates.push(update));

    await progress.update(0.1, 'Preparing scan');
    const nested = progress.startPhase(0.5);
    await nested.update(0.5, 'Generating descriptions 2/4 tables', { transient: true });
    await progress.update(0.95, 'Writing schema artifacts');

    expect(updates).toEqual([
      { percent: 10, message: 'Preparing scan' },
      { percent: 35, message: 'Generating descriptions 2/4 tables', transient: true },
      { percent: 95, message: 'Writing schema artifacts' },
    ]);
  });

  it('clamps updates and never moves the shared progress state backward', async () => {
    const updates: Array<{ percent: number; message: string }> = [];
    const progress = createAggregateProgressPort((update) => updates.push(update));

    await progress.update(0.8, 'Building enriched schema context');
    await progress.update(0.2, 'Older scan callback');
    await progress.update(1.4, 'Scan completed');

    expect(updates).toEqual([
      { percent: 80, message: 'Building enriched schema context' },
      { percent: 80, message: 'Older scan callback' },
      { percent: 100, message: 'Scan completed' },
    ]);
  });
});
