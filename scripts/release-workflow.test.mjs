import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('release workflow', () => {
  it('runs semantic-release only from manual dispatch with explicit release inputs', async () => {
    const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

    assert.match(workflow, /^name: KTX Release$/m);
    assert.match(workflow, /^  workflow_dispatch:$/m);
    assert.match(workflow, /release_kind:/);
    assert.match(workflow, /Branch rc releases publish to branch-specific npm tags/);
    assert.match(workflow, /release_kind:[\s\S]*?default: "stable"/);
    assert.match(workflow, /options:\n          - stable\n          - rc/);
    assert.match(workflow, /force_release:/);
    assert.match(workflow, /publish_live:/);
    assert.match(workflow, /publish_live:[\s\S]*?default: true/);
    assert.match(workflow, /^  contents: write$/m);
    assert.match(workflow, /^  id-token: write$/m);
    assert.match(workflow, /fetch-depth: 0/);
    assert.match(workflow, /registry-url: "https:\/\/registry\.npmjs\.org"/);
    assert.doesNotMatch(workflow, /Prepare first stable release floor/);
    assert.doesNotMatch(workflow, /git tag v0\.0\.0/);
    assert.doesNotMatch(workflow, /KTX_STABLE_RELEASE_FLOOR_TAG/);
    assert.doesNotMatch(workflow, /Prepare next prerelease branch/);
    assert.doesNotMatch(workflow, /KTX_PRERELEASE_BRANCH/);
    assert.doesNotMatch(workflow, /GITHUB_REF="refs\/heads\//);
    assert.match(workflow, /Prepare npm package root for release verification/);
    assert.match(workflow, /dist\/public-npm-package\/package\.json/);
    assert.match(workflow, /pnpm run semantic-release:dry-run/);
    assert.match(workflow, /pnpm run semantic-release$/m);
    assert.match(workflow, /KTX_RELEASE_KIND: \$\{\{ inputs.release_kind \}\}/);
    assert.match(workflow, /FORCE_RELEASE: \$\{\{ inputs.force_release \}\}/);
    assert.match(workflow, /token: \$\{\{ secrets.RELEASE_PAT \}\}/);
    assert.match(workflow, /GITHUB_TOKEN: \$\{\{ secrets.RELEASE_PAT \}\}/);
    assert.doesNotMatch(workflow, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
    assert.doesNotMatch(workflow, /^  push:/m);
    assert.doesNotMatch(workflow, /^  pull_request:/m);
  });
});
