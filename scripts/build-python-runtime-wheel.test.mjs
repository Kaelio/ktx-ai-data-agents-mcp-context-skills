import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  RUNTIME_WHEEL_DISTRIBUTION_NAME,
  RUNTIME_WHEEL_PACKAGE_VERSION,
  createRuntimeWheelBuildTree,
  runtimeWheelBuildCommand,
  runtimeWheelLayout,
  runtimeWheelPyproject,
} from './build-python-runtime-wheel.mjs';

async function writeRuntimeSourceFixture(root) {
  await mkdir(join(root, 'python', 'ktx-sl', 'semantic_layer'), {
    recursive: true,
  });
  await mkdir(join(root, 'python', 'ktx-daemon', 'src', 'ktx_daemon'), {
    recursive: true,
  });

  await writeFile(
    join(root, 'python', 'ktx-sl', 'semantic_layer', '__init__.py'),
    'SEMANTIC_LAYER_FIXTURE = True\n',
  );
  await writeFile(
    join(root, 'python', 'ktx-daemon', 'src', 'ktx_daemon', '__init__.py'),
    'KTX_DAEMON_FIXTURE = True\n',
  );
  await writeFile(
    join(root, 'python', 'ktx-daemon', 'src', 'ktx_daemon', '__main__.py'),
    'def main():\n    return 0\n',
  );
}

describe('runtimeWheelLayout', () => {
  it('uses stable source, build, and output paths', () => {
    const layout = runtimeWheelLayout('/repo/ktx');

    assert.equal(layout.rootDir, '/repo/ktx');
    assert.equal(layout.semanticLayerSourceDir, '/repo/ktx/python/ktx-sl/semantic_layer');
    assert.equal(layout.daemonSourceDir, '/repo/ktx/python/ktx-daemon/src/ktx_daemon');
    assert.equal(layout.buildRoot, '/repo/ktx/dist/runtime-wheel-src');
    assert.equal(layout.outputDir, '/repo/ktx/dist/artifacts/python');
  });
});

describe('runtimeWheelPyproject', () => {
  it('describes one kaelio-ktx wheel with the release-derived Python version and lazy local embeddings', () => {
    const pyproject = runtimeWheelPyproject();

    assert.match(pyproject, /name = "kaelio-ktx"/);
    assert.match(
      pyproject,
      new RegExp(`version = "${RUNTIME_WHEEL_PACKAGE_VERSION.replace(/[.+]/g, (char) => `\\${char}`)}"`),
    );
    assert.match(pyproject, /ktx-daemon = "ktx_daemon\.__main__:main"/);
    assert.match(pyproject, /packages = \["semantic_layer", "ktx_daemon"\]/);
    assert.match(pyproject, /\[project\.optional-dependencies\]/);
    assert.match(pyproject, /local-embeddings = \[/);
    assert.match(pyproject, /"sentence-transformers>=5\.1\.1"/);
    assert.match(pyproject, /"torch>=2\.2\.0"/);
    assert.doesNotMatch(
      pyproject.match(/dependencies = \[[\s\S]*?\]/)?.[0] ?? '',
      /sentence-transformers|torch/,
    );
  });
});

describe('createRuntimeWheelBuildTree', () => {
  it('copies ktx-owned Python packages into the build tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-runtime-wheel-test-'));
    try {
      await writeRuntimeSourceFixture(root);
      const layout = runtimeWheelLayout(root);

      await createRuntimeWheelBuildTree(layout);

      assert.equal(
        await readFile(join(layout.buildRoot, 'semantic_layer', '__init__.py'), 'utf8'),
        'SEMANTIC_LAYER_FIXTURE = True\n',
      );
      assert.equal(
        await readFile(join(layout.buildRoot, 'ktx_daemon', '__main__.py'), 'utf8'),
        'def main():\n    return 0\n',
      );
      const pyproject = await readFile(join(layout.buildRoot, 'pyproject.toml'), 'utf8');
      assert.match(pyproject, /name = "kaelio-ktx"/);
      assert.match(pyproject, /local-embeddings = \[/);
      const readme = await readFile(join(layout.buildRoot, 'README.md'), 'utf8');
      assert.match(readme, /Bundled Python runtime wheel for ktx/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('runtimeWheelBuildCommand', () => {
  it('runs uv build against the generated build tree', () => {
    const layout = runtimeWheelLayout('/repo/ktx');

    assert.deepEqual(runtimeWheelBuildCommand(layout), {
      command: 'uv',
      args: [
        'build',
        '--wheel',
        '--out-dir',
        '/repo/ktx/dist/artifacts/python',
        '/repo/ktx/dist/runtime-wheel-src',
      ],
      cwd: '/repo/ktx',
    });
    assert.equal(RUNTIME_WHEEL_DISTRIBUTION_NAME, 'kaelio-ktx');
    assert.match(RUNTIME_WHEEL_PACKAGE_VERSION, /^\d+\.\d+\.\d+/);
  });
});
