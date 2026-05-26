import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  rendererUnavailableVizFallback,
  resetVizFallbackWarningsForTest,
  resolveVizFallback,
  warnVizFallbackOnce,
} from '../src/viz-fallback.js';

function io(options: { stdoutTty?: boolean; stdinTty?: boolean; rawMode?: boolean }) {
  return {
    stdin: {
      isTTY: options.stdinTty,
      ...(options.rawMode === false ? {} : { setRawMode: vi.fn() }),
    },
    stdout: { isTTY: options.stdoutTty },
    stderr: { write: vi.fn() },
  };
}

describe('resolveVizFallback', () => {
  beforeEach(() => {
    resetVizFallbackWarningsForTest();
  });

  it('degrades when stdout is not an interactive terminal', () => {
    expect(resolveVizFallback(io({ stdoutTty: false }), { TERM: 'xterm-256color' })).toEqual({
      shouldDegrade: true,
      reason: 'stdout-not-tty',
      message: 'stdout is not an interactive terminal',
    });
  });

  it('degrades when TERM is dumb even if stdout is a TTY', () => {
    expect(resolveVizFallback(io({ stdoutTty: true }), { TERM: 'dumb' })).toEqual({
      shouldDegrade: true,
      reason: 'term-dumb',
      message: 'TERM=dumb does not support the visual renderer',
    });
  });

  it('allows visualization for a normal TTY', () => {
    expect(resolveVizFallback(io({ stdoutTty: true }), { TERM: 'xterm-256color' })).toEqual({
      shouldDegrade: false,
    });
  });

  it('allows snapshot visualization when interactive input is not required', () => {
    expect(
      resolveVizFallback(
        io({ stdoutTty: true, stdinTty: false, rawMode: false }),
        { TERM: 'xterm-256color' },
        { requireInput: false },
      ),
    ).toEqual({
      shouldDegrade: false,
    });
  });

  it('degrades when interactive input is required but stdin is not a TTY', () => {
    expect(
      resolveVizFallback(
        io({ stdoutTty: true, stdinTty: false }),
        { TERM: 'xterm-256color' },
        { requireInput: true },
      ),
    ).toEqual({
      shouldDegrade: true,
      reason: 'stdin-not-tty',
      message: 'stdin is not an interactive terminal',
    });
  });

  it('degrades when interactive input is required but stdin raw mode is unavailable', () => {
    expect(
      resolveVizFallback(
        io({ stdoutTty: true, stdinTty: true, rawMode: false }),
        { TERM: 'xterm-256color' },
        { requireInput: true },
      ),
    ).toEqual({
      shouldDegrade: true,
      reason: 'stdin-raw-mode-unavailable',
      message: 'stdin raw mode is unavailable',
    });
  });

  it('warns only once per fallback reason', () => {
    const testIo = io({ stdoutTty: false });
    const decision = resolveVizFallback(testIo, { TERM: 'xterm-256color' });

    warnVizFallbackOnce(testIo, decision);
    warnVizFallbackOnce(testIo, decision);
    warnVizFallbackOnce(testIo, rendererUnavailableVizFallback());
    warnVizFallbackOnce(testIo, rendererUnavailableVizFallback());
    warnVizFallbackOnce(testIo, {
      shouldDegrade: true,
      reason: 'stdin-raw-mode-unavailable',
      message: 'stdin raw mode is unavailable',
    });
    warnVizFallbackOnce(testIo, {
      shouldDegrade: true,
      reason: 'stdin-raw-mode-unavailable',
      message: 'stdin raw mode is unavailable',
    });

    expect(testIo.stderr.write).toHaveBeenCalledTimes(3);
    expect(testIo.stderr.write).toHaveBeenNthCalledWith(
      1,
      'Visualization requested but stdout is not an interactive terminal; printing plain output.\n',
    );
    expect(testIo.stderr.write).toHaveBeenNthCalledWith(
      2,
      'Visualization requested but the terminal renderer is unavailable; printing plain output.\n',
    );
    expect(testIo.stderr.write).toHaveBeenNthCalledWith(
      3,
      'Visualization requested but stdin raw mode is unavailable; printing plain output.\n',
    );
  });
});
