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
  it('runs the package checks from a filtered repository root', async () => {
    const workflow = await readText('.github/workflows/ci.yml');

    assert.match(workflow, /^name: KTX CI/m);
    assertIncludesAll(workflow, [
      'permissions:',
      'contents: read',
      'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
      'pnpm/action-setup@41ff72655975bd51cab0327fa583b6e92b6d3061',
      'actions/setup-node@6044e13b5dc448c55e2357c09f80417699197238',
      'node-version: "24"',
      'cache-dependency-path: "pnpm-lock.yaml"',
      'pnpm install --frozen-lockfile',
      'pnpm run check',
      'pnpm run test:slow',
      'pnpm run smoke',
      'actions/setup-python@a309ff8b426b58ec0e2a45f0f869d46889d02405',
      'python-version: "3.13"',
      'astral-sh/setup-uv@eac588ad8def6316056a12d4907a9d4d84ff7a3b',
      'cache-dependency-glob: "uv.lock"',
      'uv sync --all-packages',
      'uv run pytest',
      'pnpm run artifacts:check',
    ]);

    assert.doesNotMatch(workflow, /sparse-checkout/);
    assert.doesNotMatch(workflow, /cd ktx/);
    assert.doesNotMatch(workflow, /ktx\/pnpm-lock\.yaml/);
    assert.doesNotMatch(workflow, /ktx\/uv\.lock/);
  });

  it('uploads verified artifacts from root-relative paths', async () => {
    const workflow = await readText('.github/workflows/ci.yml');

    assertIncludesAll(workflow, [
      'actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f',
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
