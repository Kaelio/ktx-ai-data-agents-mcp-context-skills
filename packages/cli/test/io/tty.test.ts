import { describe, expect, it } from 'vitest';

import { isWritableTtyOutput } from '../../src/io/tty.js';

describe('isWritableTtyOutput', () => {
  it('accepts writable TTY-like output', () => {
    const output = {
      isTTY: true,
      columns: 80,
      on: () => undefined,
      write: () => undefined,
    };

    expect(isWritableTtyOutput(output)).toBe(true);
  });

  it('rejects non-TTY output', () => {
    expect(isWritableTtyOutput({ write: () => undefined })).toBe(false);
  });

  it('rejects output missing stream event support', () => {
    expect(
      isWritableTtyOutput({
        isTTY: true,
        columns: 80,
        write: () => undefined,
      }),
    ).toBe(false);
  });

  it('rejects output missing column metadata', () => {
    const output = {
      isTTY: true,
      on: () => undefined,
      write: () => undefined,
    };

    expect(isWritableTtyOutput(output)).toBe(false);
  });
});
