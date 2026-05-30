import { describe, expect, it } from 'vitest';
import { renderKtxCommandTree } from '../src/print-command-tree.js';

describe('renderKtxCommandTree', () => {
  it('renders an indented tree rooted at "ktx" with known top-level commands', () => {
    const output = renderKtxCommandTree();

    const lines = output.split('\n');
    expect(lines[0]).toMatch(/^ktx( |$)/);

    const topLevel = lines
      .filter((line) => /^ {2}[├└]── \S/.test(line))
      .map((line) => line.replace(/^ {2}[├└]── /, '').trim().split(' ')[0]);

    for (const expected of ['setup', 'connection', 'ingest', 'sl', 'mcp', 'admin', 'completion']) {
      expect(topLevel).toContain(expected);
    }

    // The internal completion helper is hidden and must not appear in the tree.
    expect(topLevel).not.toContain('__complete');
    expect(output).not.toContain('__complete');

    expect(output).toContain('│   └── test [connectionId]');
    expect(output).toContain('│   ├── status                          Show KTX MCP daemon status');
    expect(output).not.toContain('│   ├── add');
    expect(output).not.toContain('│   ├── remove');
    expect(output).not.toContain('│   ├── map');
    expect(output).not.toContain('│   ├── mapping');
    expect(output).not.toContain('│   ├── metabase');
    expect(output).not.toContain('│   ├── notion');
    expect(output).not.toContain('scan <connectionId>');
    expect(output).not.toContain('│   ├── replay');
    expect(output).not.toContain('│   └── replay');
    // Match `run` as a whole command name, not the `run` prefix of `runtime`.
    expect(output).not.toMatch(/[├└]── run(\s|$)/m);
    expect(output).not.toContain('│   ├── watch');
    expect(output).not.toContain('│   └── watch');
    expect(output).toContain('│   └── read <key>                      Read a wiki page file by key');
    expect(output).toContain(
      '│   ├── read <sourceName>               Read a semantic-layer source YAML file',
    );
    expect(output).not.toContain('│   ├── write');
    expect(output).not.toContain('│   └── write');
  });

  it('ends with a single trailing newline', () => {
    const output = renderKtxCommandTree();
    expect(output.endsWith('\n')).toBe(true);
    expect(output.endsWith('\n\n')).toBe(false);
  });
});
