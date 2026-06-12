import { describe, expect, it } from 'vitest';
import { type KtxCliSpinner, runWithCliSpinner } from '../src/clack.js';

function makeSpinner() {
  const events: string[] = [];
  const spinner: KtxCliSpinner = {
    start: (msg) => events.push(`start:${msg}`),
    message: (msg) => events.push(`message:${msg}`),
    stop: (msg) => events.push(`stop:${msg}`),
    error: (msg) => events.push(`error:${msg}`),
  };
  return { events, spinner };
}

describe('runWithCliSpinner', () => {
  it('starts then stops with the success text and returns the value', async () => {
    const { events, spinner } = makeSpinner();

    const value = await runWithCliSpinner(spinner, { start: 'Working…', success: 'Done', failure: 'Failed' }, async () => 42);

    expect(value).toBe(42);
    expect(events).toEqual(['start:Working…', 'stop:Done']);
  });

  it('errors with the failure text and rethrows when the work throws', async () => {
    const { events, spinner } = makeSpinner();
    const boom = new Error('boom');

    await expect(
      runWithCliSpinner(spinner, { start: 'Working…', success: 'Done', failure: 'Failed' }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(events).toEqual(['start:Working…', 'error:Failed']);
  });
});
