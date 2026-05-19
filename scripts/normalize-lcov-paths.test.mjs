import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeLcovContent } from './normalize-lcov-paths.mjs';

describe('normalizeLcovContent', () => {
  it('prefixes relative LCOV source paths with the package path', () => {
    const input = ['TN:', 'SF:src/index.ts', 'SF:src\\windows.ts', 'DA:1,1', 'end_of_record'].join('\n');

    assert.equal(
      normalizeLcovContent(input, 'packages/context'),
      [
        'TN:',
        'SF:packages/context/src/index.ts',
        'SF:packages/context/src/windows.ts',
        'DA:1,1',
        'end_of_record',
      ].join('\n'),
    );
  });

  it('leaves already-normalized and absolute paths unchanged', () => {
    const input = [
      'SF:packages/cli/src/index.ts',
      'SF:/tmp/repo/packages/cli/src/index.ts',
      'SF:../shared/source.ts',
    ].join('\n');

    assert.equal(normalizeLcovContent(input, 'packages/cli'), input);
  });
});
