import { describe, expect, it } from 'vitest';
import { renderKtxCommandTree } from './print-command-tree.js';

describe('renderKtxCommandTree', () => {
  it('renders an indented tree rooted at "ktx" with known top-level commands', () => {
    const output = renderKtxCommandTree();

    const lines = output.split('\n');
    expect(lines[0]).toMatch(/^ktx( |$)/);

    const topLevel = lines
      .filter((line) => /^ {2}[├└]── \S/.test(line))
      .map((line) => line.replace(/^ {2}[├└]── /, '').trim().split(' ')[0]);

    for (const expected of ['setup', 'connection', 'ingest', 'sl', 'dev']) {
      expect(topLevel).toContain(expected);
    }

    expect(output).toContain('│   ├── test <connectionId>');
  });

  it('ends with a single trailing newline', () => {
    const output = renderKtxCommandTree();
    expect(output.endsWith('\n')).toBe(true);
    expect(output.endsWith('\n\n')).toBe(false);
  });
});
