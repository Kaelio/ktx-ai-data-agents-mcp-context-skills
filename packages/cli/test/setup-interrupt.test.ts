import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  KtxSetupExitError,
  withSetupInterruptConfirmation,
  type SetupInterruptTracker,
} from '../src/setup-interrupt.js';

const CANCEL = Symbol('cancel');

function makeTracker(ctrlCValues: boolean[]): SetupInterruptTracker {
  return {
    track: vi.fn((run) => run()),
    wasCtrlC: vi.fn(() => ctrlCValues.shift() ?? false),
  };
}

describe('setup interrupt confirmation', () => {
  const originalIsTTY = process.stdin.isTTY;
  const originalRef = process.stdin.ref;

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalIsTTY });
    Object.defineProperty(process.stdin, 'ref', { configurable: true, value: originalRef });
  });

  it('fails before opening a prompt when interactive setup has no tty', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    const prompt = vi.fn(async () => 'continued');

    await expect(withSetupInterruptConfirmation(prompt)).rejects.toThrow(
      'Interactive setup requires a terminal. Re-run this command in a TTY, or pass --no-input with the required options.',
    );

    expect(prompt).not.toHaveBeenCalled();
  });

  it('refs stdin before opening a real interactive prompt', async () => {
    const calls: string[] = [];
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'ref', {
      configurable: true,
      value: vi.fn(() => {
        calls.push('ref');
        return process.stdin;
      }),
    });
    const prompt = vi.fn(async () => {
      calls.push('prompt');
      return 'continued';
    });

    await expect(withSetupInterruptConfirmation(prompt)).resolves.toBe('continued');

    expect(calls).toEqual(['ref', 'prompt']);
  });

  it('asks before exiting on Ctrl+C and reruns the active prompt when declined', async () => {
    const prompt = vi.fn(async () => (prompt.mock.calls.length === 1 ? CANCEL : 'continued'));
    const confirmExit = vi.fn(async () => false);

    await expect(
      withSetupInterruptConfirmation(prompt, {
        confirmExit,
        isCancel: (value): value is symbol => value === CANCEL,
        tracker: makeTracker([true]),
      }),
    ).resolves.toBe('continued');

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(confirmExit).toHaveBeenCalledTimes(1);
  });

  it('exits immediately when the confirmation is accepted', async () => {
    const prompt = vi.fn(async () => CANCEL);

    await expect(
      withSetupInterruptConfirmation(prompt, {
        confirmExit: vi.fn(async () => true),
        isCancel: (value): value is symbol => value === CANCEL,
        tracker: makeTracker([true]),
      }),
    ).rejects.toBeInstanceOf(KtxSetupExitError);
  });

  it('keeps non-Ctrl+C cancellation available for Back and Escape flows', async () => {
    const prompt = vi.fn(async () => CANCEL);
    const confirmExit = vi.fn(async () => true);

    await expect(
      withSetupInterruptConfirmation(prompt, {
        confirmExit,
        isCancel: (value): value is symbol => value === CANCEL,
        tracker: makeTracker([false]),
      }),
    ).resolves.toBe(CANCEL);

    expect(confirmExit).not.toHaveBeenCalled();
  });

  it('exits immediately when Ctrl+C is pressed again at the confirmation prompt', async () => {
    const prompt = vi.fn(async () => CANCEL);

    await expect(
      withSetupInterruptConfirmation(prompt, {
        confirmExit: vi.fn(async () => CANCEL),
        isCancel: (value): value is symbol => value === CANCEL,
        tracker: makeTracker([true]),
      }),
    ).rejects.toBeInstanceOf(KtxSetupExitError);
  });
});
