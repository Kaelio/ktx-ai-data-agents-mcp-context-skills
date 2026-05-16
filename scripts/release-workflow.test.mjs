import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('release workflow', () => {
  it('runs semantic-release only from manual dispatch with explicit release inputs', async () => {
    const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

    assert.match(workflow, /^name: KTX Release$/m);
    assert.match(workflow, /^  workflow_dispatch:$/m);
    assert.match(workflow, /release_kind:/);
    assert.match(workflow, /options:\n          - rc\n          - stable/);
    assert.match(workflow, /force_release:/);
    assert.match(workflow, /publish_live:/);
    assert.match(workflow, /default: false/);
    assert.match(workflow, /^  contents: write$/m);
    assert.match(workflow, /fetch-depth: 0/);
    assert.match(workflow, /registry-url: "https:\/\/registry\.npmjs\.org"/);
    assert.match(workflow, /pnpm run semantic-release:dry-run/);
    assert.match(workflow, /pnpm run semantic-release$/m);
    assert.match(workflow, /KTX_RELEASE_KIND: \$\{\{ inputs.release_kind \}\}/);
    assert.match(workflow, /FORCE_RELEASE: \$\{\{ inputs.force_release \}\}/);
    assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets.NPM_TOKEN \}\}/);
    assert.doesNotMatch(workflow, /^  push:/m);
    assert.doesNotMatch(workflow, /^  pull_request:/m);
  });
});
