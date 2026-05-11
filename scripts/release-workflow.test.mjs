import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('release workflow', () => {
  it('publishes only from manual dispatch with an explicit live input', async () => {
    const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

    assert.match(workflow, /^name: KTX Release$/m);
    assert.match(workflow, /^  workflow_dispatch:$/m);
    assert.match(workflow, /publish_live:/);
    assert.match(workflow, /default: false/);
    assert.match(workflow, /pnpm run artifacts:check/);
    assert.match(workflow, /pnpm run release:readiness/);
    assert.match(workflow, /pnpm run release:npm-publish$/m);
    assert.match(workflow, /pnpm run release:npm-publish -- --publish/);
    assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets.NPM_TOKEN \}\}/);
    assert.doesNotMatch(workflow, /^  push:/m);
    assert.doesNotMatch(workflow, /^  pull_request:/m);
  });
});
