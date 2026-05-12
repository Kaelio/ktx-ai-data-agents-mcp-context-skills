import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function readText(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function assertIncludesAll(text, values) {
  for (const value of values) {
    assert.match(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
}

describe('standalone KTX CI workflow', () => {
  it('runs package checks in parallel jobs from the repository root', async () => {
    const workflow = await readText('.github/workflows/ci.yml');

    assert.match(workflow, /^name: KTX CI/m);
    assertIncludesAll(workflow, [
      'permissions:',
      'contents: read',
      'typescript-checks:',
      'name: TypeScript checks',
      'slow-context-tests:',
      'name: Slow context tests',
      'slow-cli-tests:',
      'name: Slow CLI tests',
      'cli-smoke-tests:',
      'name: CLI smoke tests',
      'python-checks:',
      'name: Python checks',
      'artifact-checks:',
      'name: Artifact checks',
      'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
      'pnpm/action-setup@739bfe42ca9233c5e6aca07c1a25a9d34aca49b0',
      'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e',
      'node-version: "24"',
      'cache-dependency-path: "pnpm-lock.yaml"',
      'pnpm install --frozen-lockfile',
      'pnpm run check',
      'pnpm run build',
      'pnpm --filter @ktx/context run test:slow',
      'pnpm --filter @ktx/cli run test:slow',
      'pnpm run smoke',
      'actions/setup-python@a309ff8b426b58ec0e2a45f0f869d46889d02405',
      'python-version: "3.13"',
      'astral-sh/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b',
      'cache-dependency-glob: "uv.lock"',
      'uv sync --all-packages',
      'uv run pytest',
      'pnpm run artifacts:check',
    ]);

    assert.doesNotMatch(workflow, /sparse-checkout/);
    assert.doesNotMatch(workflow, /cd ktx/);
    assert.doesNotMatch(workflow, /ktx\/pnpm-lock\.yaml/);
    assert.doesNotMatch(workflow, /ktx\/uv\.lock/);
    assert.doesNotMatch(workflow, /run: pnpm run test:slow/);
  });

  it('uploads verified artifacts from root-relative paths', async () => {
    const workflow = await readText('.github/workflows/ci.yml');

    assertIncludesAll(workflow, [
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'name: ktx-package-artifacts-${{ github.sha }}',
      'dist/artifacts/manifest.json',
      'dist/artifacts/npm/*.tgz',
      'dist/artifacts/python/*.whl',
      'dist/artifacts/python/*.tar.gz',
      'if-no-files-found: error',
      'retention-days: 7',
    ]);

    assert.doesNotMatch(workflow, /ktx\/dist\/artifacts/);
  });

  it('syncs injected workspace packages after package builds', async () => {
    const workspace = await readText('pnpm-workspace.yaml');

    assert.match(workspace, /syncInjectedDepsAfterScripts:\n\s+- build/);
  });
});
