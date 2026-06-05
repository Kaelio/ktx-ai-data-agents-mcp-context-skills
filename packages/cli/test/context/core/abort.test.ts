import { describe, expect, it, vi } from 'vitest';
import { createAbortError, isAbortError, linkAbortSignal, throwIfAborted } from '../../../src/context/core/abort.js';

describe('abort helpers', () => {
  it('recognizes DOMException abort errors and common abort-shaped errors', () => {
    expect(isAbortError(createAbortError())).toBe(true);
    expect(isAbortError(Object.assign(new Error('cancelled'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(Object.assign(new Error('operation aborted'), { code: 'ABORT_ERR' }))).toBe(true);
    expect(isAbortError(new Error('ordinary failure'))).toBe(false);
  });

  it('throws when the provided signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => throwIfAborted(controller.signal)).toThrow(/Aborted/);
  });

  it('links a child controller to a parent signal and removes the listener on dispose', () => {
    const parent = new AbortController();
    const child = linkAbortSignal(parent.signal);

    expect(child.controller.signal.aborted).toBe(false);
    parent.abort();
    expect(child.controller.signal.aborted).toBe(true);

    const removeSpy = vi.spyOn(parent.signal, 'removeEventListener');
    child.dispose();
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
