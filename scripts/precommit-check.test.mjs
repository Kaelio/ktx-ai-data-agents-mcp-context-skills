import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planChecks } from './precommit-check.mjs';

function commandKeys(files) {
  return planChecks(files).map((command) => command.key);
}

describe('precommit-check', () => {
  it('skips files outside ktx', () => {
    assert.deepEqual(commandKeys(['outside-workspace/src/app.ts']), []);
  });

  it('runs only the touched package checks for standalone package paths', () => {
    assert.deepEqual(commandKeys(['packages/cli/src/index.ts']), [
      'boundary-check',
      'type-check:@ktx/cli',
      'build:@ktx/cli',
      'test:@ktx/cli',
    ]);
  });

  it('accepts legacy subtree-prefixed package paths', () => {
    assert.deepEqual(commandKeys(['ktx/packages/cli/src/index.ts']), [
      'boundary-check',
      'type-check:@ktx/cli',
      'build:@ktx/cli',
      'test:@ktx/cli',
    ]);
  });

  it('runs the matching script test when a script changes', () => {
    assert.deepEqual(commandKeys(['scripts/check-boundaries.mjs']), [
      'script-test:scripts/check-boundaries.test.mjs',
    ]);
  });

  it('runs the touched python package tests', () => {
    assert.deepEqual(commandKeys(['python/ktx-sl/semantic_layer/parser.py']), ['pytest:ktx-sl']);
  });
});
