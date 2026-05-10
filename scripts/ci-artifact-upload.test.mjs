import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ciWorkflowPath = resolve(repoRoot, '.github', 'workflows', 'ci.yml');

async function readCiWorkflowOrSkip(testContext) {
  try {
    await access(ciWorkflowPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      testContext.skip('root CI workflow is absent from sparse ktx checkout');
      return null;
    }
    throw error;
  }
  return readFile(ciWorkflowPath, 'utf-8');
}

describe('KTX CI artifact upload contract', () => {
  it('uploads verified KTX package artifacts from the standalone check job', async (testContext) => {
    const workflow = await readCiWorkflowOrSkip(testContext);
    if (workflow === null) {
      return;
    }

    assert.match(
      workflow,
      /name: Build and verify package artifacts\s+run: pnpm run artifacts:check\s+- name: Upload package artifacts/s,
    );
    assert.match(workflow, /uses: actions\/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f/);
    assert.match(workflow, /name: ktx-package-artifacts-\$\{\{ github\.sha \}\}/);
    assert.match(workflow, /dist\/artifacts\/manifest\.json/);
    assert.match(workflow, /dist\/artifacts\/npm\/\*\.tgz/);
    assert.match(workflow, /dist\/artifacts\/python\/\*\.whl/);
    assert.match(workflow, /dist\/artifacts\/python\/\*\.tar\.gz/);
    assert.match(workflow, /if-no-files-found: error/);
    assert.match(workflow, /retention-days: 7/);
  });

  it('runs TypeScript and Python checks in the standalone workflow', async (testContext) => {
    const workflow = await readCiWorkflowOrSkip(testContext);
    if (workflow === null) {
      return;
    }

    assert.match(workflow, /run: pnpm run check/);
    assert.match(workflow, /run: uv sync --all-packages/);
    assert.match(workflow, /run: uv run pytest/);
  });

  it('does not depend on host application CI jobs', async (testContext) => {
    const workflow = await readCiWorkflowOrSkip(testContext);
    if (workflow === null) {
      return;
    }

    assert.doesNotMatch(workflow, /build-python-service|test-server|build-frontend|build-docker-images/);
  });
});
