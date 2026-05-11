# Bundled Python Runtime Wheel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and package one bundled `kaelio-ktx` Python wheel that contains
KTX-owned Python runtime code and keeps local embedding dependencies optional.

**Architecture:** Add a deterministic Node assembly script that copies the
existing `semantic_layer` and `ktx_daemon` source trees into a temporary wheel
source tree, writes a runtime-only `pyproject.toml`, and builds one wheel with
`uv build`. Wire package artifacts so the CLI npm tarball includes the bundled
wheel plus a checksum manifest under `assets/python/`.

**Tech Stack:** Node 22 ESM scripts, `node:test`, `uv`, Hatchling, Python 3.13,
pnpm, TypeScript package artifacts.

---

## Existing status

This plan is based on
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.
There are no committed plan files under `docs/superpowers/plans/` in this
worktree or in git history for this spec. The spec itself is the only tracked
Superpowers document.

The following pieces are already implemented:

- `packages/context/src/daemon/semantic-layer-compute.ts` can invoke
  `python -m ktx_daemon` for one-shot semantic-layer operations.
- `python/ktx-daemon` exposes `ktx-daemon` one-shot commands and an HTTP
  `serve-http` daemon with `/health`.
- `scripts/package-artifacts.mjs` builds npm package tarballs and separate
  `ktx-sl` and `ktx-daemon` Python artifacts.
- `scripts/package-artifacts.mjs` writes a checksummed artifact manifest.

The following spec requirements are not implemented yet:

- A single public `@kaelio/ktx` npm surface.
- One KTX-owned bundled Python wheel inside the npm package.
- A managed runtime root, installer, runtime manifest, and runtime command
  family.
- Lazy `local-embeddings` installation that keeps `sentence-transformers` and
  `torch` out of the default Python dependency set.

This plan implements the bundled wheel prerequisite. Runtime install commands
must be planned after this lands because they need a real wheel payload and
checksum manifest to install.

## File structure

- Create `scripts/build-python-runtime-wheel.mjs`: assembles the temporary
  runtime wheel source tree and runs `uv build`.
- Create `scripts/build-python-runtime-wheel.test.mjs`: tests source copying,
  generated `pyproject.toml`, and the `uv build` command shape.
- Modify `scripts/package-artifacts.mjs`: builds the runtime wheel before npm
  packing, copies it into `packages/cli/assets/python/`, includes it in the
  artifact manifest, and installs it in artifact smoke tests.
- Modify `scripts/package-artifacts.test.mjs`: covers runtime wheel metadata,
  manifest entries, install arguments, and CLI asset copy behavior.
- Modify `scripts/release-readiness.test.mjs`: expects `kaelio-ktx` in Python
  release metadata and policy fixtures.
- Modify `release-policy.json`: lists `kaelio-ktx` as a CI-only Python
  artifact.
- Modify `python/ktx-daemon/pyproject.toml`: moves
  `sentence-transformers` and `torch` to a `local-embeddings` optional
  dependency group.
- Modify `uv.lock`: records the dependency metadata change.
- Modify `.gitignore`: ignores generated `packages/cli/assets/python/`
  contents.

## Plan status

No earlier plans were found for this spec. This is plan 1 for the spec.

### Task 1: Add failing tests for the runtime wheel builder

**Files:**

- Create: `scripts/build-python-runtime-wheel.test.mjs`
- Test: `scripts/build-python-runtime-wheel.test.mjs`

- [ ] **Step 1: Write the failing test file**

Create `scripts/build-python-runtime-wheel.test.mjs` with this content:

```javascript
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
  it('describes one kaelio-ktx wheel with lazy local embeddings', () => {
    const pyproject = runtimeWheelPyproject();

    assert.match(pyproject, /name = "kaelio-ktx"/);
    assert.match(pyproject, /version = "0\.1\.0"/);
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
  it('copies KTX-owned Python packages into the build tree', async () => {
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
      assert.match(readme, /Bundled Python runtime wheel for KTX/);
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
    assert.equal(RUNTIME_WHEEL_PACKAGE_VERSION, '0.1.0');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --test scripts/build-python-runtime-wheel.test.mjs
```

Expected: FAIL with an import error for
`./build-python-runtime-wheel.mjs`.

### Task 2: Implement the runtime wheel builder

**Files:**

- Create: `scripts/build-python-runtime-wheel.mjs`
- Test: `scripts/build-python-runtime-wheel.test.mjs`

- [ ] **Step 1: Create the builder script**

Create `scripts/build-python-runtime-wheel.mjs` with this content:

```javascript
#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const RUNTIME_WHEEL_DISTRIBUTION_NAME = 'kaelio-ktx';
export const RUNTIME_WHEEL_NORMALIZED_NAME = 'kaelio_ktx';
export const RUNTIME_WHEEL_PACKAGE_VERSION = '0.1.0';

function scriptRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function runtimeWheelLayout(rootDir = scriptRootDir()) {
  return {
    rootDir,
    semanticLayerSourceDir: join(rootDir, 'python', 'ktx-sl', 'semantic_layer'),
    daemonSourceDir: join(rootDir, 'python', 'ktx-daemon', 'src', 'ktx_daemon'),
    buildRoot: join(rootDir, 'dist', 'runtime-wheel-src'),
    outputDir: join(rootDir, 'dist', 'artifacts', 'python'),
  };
}

export function runtimeWheelPyproject() {
  return `[project]
name = "${RUNTIME_WHEEL_DISTRIBUTION_NAME}"
version = "${RUNTIME_WHEEL_PACKAGE_VERSION}"
description = "Bundled Python runtime payload for the KTX npm package"
readme = "README.md"
requires-python = ">=3.13"
license = "Apache-2.0"
dependencies = [
    "fastapi>=0.115.0",
    "lkml>=1.3.7",
    "numpy>=2.2.6",
    "orjson>=3.11.4",
    "pandas>=2.2.3",
    "psycopg[binary]>=3.2.0",
    "pydantic>=2.9.0",
    "pyyaml>=6",
    "requests>=2.32.0",
    "sqlglot>=26",
    "uvicorn[standard]>=0.32.0",
]

[project.optional-dependencies]
local-embeddings = [
    "sentence-transformers>=5.1.1",
    "torch>=2.2.0",
]

[project.scripts]
ktx-daemon = "ktx_daemon.__main__:main"

[project.urls]
Homepage = "https://github.com/kaelio/ktx"
Repository = "https://github.com/kaelio/ktx"
Issues = "https://github.com/kaelio/ktx/issues"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["semantic_layer", "ktx_daemon"]
`;
}

export function runtimeWheelReadme() {
  return `# kaelio-ktx Python runtime

Bundled Python runtime wheel for KTX.

This wheel is built from the repository's \`semantic_layer\` and
\`ktx_daemon\` source trees for inclusion in the npm package. It is not a
separate public PyPI release artifact.
`;
}

export async function createRuntimeWheelBuildTree(layout = runtimeWheelLayout()) {
  await rm(layout.buildRoot, { recursive: true, force: true });
  await mkdir(layout.buildRoot, { recursive: true });
  await cp(layout.semanticLayerSourceDir, join(layout.buildRoot, 'semantic_layer'), {
    recursive: true,
  });
  await cp(layout.daemonSourceDir, join(layout.buildRoot, 'ktx_daemon'), {
    recursive: true,
  });
  await writeFile(join(layout.buildRoot, 'pyproject.toml'), runtimeWheelPyproject());
  await writeFile(join(layout.buildRoot, 'README.md'), runtimeWheelReadme());
}

export function runtimeWheelBuildCommand(layout = runtimeWheelLayout()) {
  return {
    command: 'uv',
    args: ['build', '--wheel', '--out-dir', layout.outputDir, layout.buildRoot],
    cwd: layout.rootDir,
  };
}

async function runCommand(command, args, options) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

export async function buildRuntimeWheel(layout = runtimeWheelLayout()) {
  await mkdir(layout.outputDir, { recursive: true });
  await createRuntimeWheelBuildTree(layout);
  const command = runtimeWheelBuildCommand(layout);
  await runCommand(command.command, command.args, { cwd: command.cwd });
  const pyproject = await readFile(join(layout.buildRoot, 'pyproject.toml'), 'utf8');
  return {
    buildRoot: layout.buildRoot,
    outputDir: layout.outputDir,
    pyproject,
  };
}

async function main() {
  await buildRuntimeWheel(runtimeWheelLayout());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 2: Run the builder test**

Run:

```bash
node --test scripts/build-python-runtime-wheel.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Commit the builder**

Run:

```bash
git add scripts/build-python-runtime-wheel.mjs scripts/build-python-runtime-wheel.test.mjs
git commit -m "build: add bundled python runtime wheel builder"
```

### Task 3: Move heavy local embedding dependencies behind an extra

**Files:**

- Modify: `python/ktx-daemon/pyproject.toml`
- Modify: `uv.lock`
- Test: `python/ktx-daemon/tests/test_embeddings.py`
- Test: `scripts/build-python-runtime-wheel.test.mjs`

- [ ] **Step 1: Update daemon dependencies**

In `python/ktx-daemon/pyproject.toml`, remove these two lines from
`[project].dependencies`:

```toml
    "sentence-transformers>=5.1.1",
    "torch>=2.2.0",
```

Add this block immediately after `[project.scripts]`:

```toml
[project.optional-dependencies]
local-embeddings = [
    "sentence-transformers>=5.1.1",
    "torch>=2.2.0",
]
```

The relevant section must read:

```toml
[project]
name = "ktx-daemon"
version = "0.1.0"
description = "Portable compute package for KTX semantic-layer operations"
readme = "README.md"
requires-python = ">=3.13"
license = "Apache-2.0"
dependencies = [
    "fastapi>=0.115.0",
    "ktx-sl",
    "lkml>=1.3.7",
    "numpy>=2.2.6",
    "orjson>=3.11.4",
    "pandas>=2.2.3",
    "psycopg[binary]>=3.2.0",
    "pydantic>=2.9.0",
    "requests>=2.32.0",
    "sqlglot>=26",
    "uvicorn[standard]>=0.32.0",
]

[project.scripts]
ktx-daemon = "ktx_daemon.__main__:main"

[project.optional-dependencies]
local-embeddings = [
    "sentence-transformers>=5.1.1",
    "torch>=2.2.0",
]
```

- [ ] **Step 2: Refresh the uv lockfile**

Run:

```bash
uv lock
```

Expected: PASS and `uv.lock` records the `ktx-daemon` optional dependency
metadata. If the local `uv` version is older than `tool.uv.required-version`,
record the version mismatch and do not edit `pyproject.toml` to lower the pin.

- [ ] **Step 3: Run Python tests that cover lazy embedding imports**

Run:

```bash
uv run pytest python/ktx-daemon/tests/test_embeddings.py -q
```

Expected: PASS. The tests use injected fake providers and do not require
`sentence-transformers` or `torch`.

- [ ] **Step 4: Run the runtime wheel metadata test**

Run:

```bash
node --test scripts/build-python-runtime-wheel.test.mjs
```

Expected: PASS and the generated runtime `pyproject.toml` keeps
`sentence-transformers` and `torch` under `local-embeddings`.

- [ ] **Step 5: Commit the dependency split**

Run:

```bash
git add python/ktx-daemon/pyproject.toml uv.lock
git commit -m "build: make local embedding dependencies optional"
```

### Task 4: Add artifact tests for the bundled runtime wheel

**Files:**

- Modify: `scripts/package-artifacts.test.mjs`
- Test: `scripts/package-artifacts.test.mjs`

- [ ] **Step 1: Extend imports**

In `scripts/package-artifacts.test.mjs`, extend the import from
`./package-artifacts.mjs` with these names:

```javascript
  CLI_PYTHON_ASSET_MANIFEST,
  RUNTIME_WHEEL_DISTRIBUTION_NAME,
  RUNTIME_WHEEL_NORMALIZED_NAME,
  RUNTIME_WHEEL_PACKAGE_VERSION,
  copyRuntimeWheelAssets,
```

- [ ] **Step 2: Update Python metadata fixtures**

In `writeReleaseMetadataInputs`, keep the existing `ktx-sl` and `ktx-daemon`
fixture files and add no new on-disk Python package. The runtime wheel metadata
will come from constants exported by `package-artifacts.mjs`.

- [ ] **Step 3: Update uploadable artifact fixtures**

In `writeUploadableArtifactFixtures`, add this runtime wheel entry to
`fileContents`:

```javascript
    [
      join(layout.pythonDir, 'kaelio_ktx-0.1.0-py3-none-any.whl'),
      'kaelio-ktx-runtime-wheel',
    ],
```

- [ ] **Step 4: Update build command expectations**

Replace the `buildArtifactCommands` expectations with these three assertions:

```javascript
    assert.deepEqual(
      commands.slice(0, NPM_ARTIFACT_PACKAGES.length).map((command) => [command.command, command.args]),
      NPM_ARTIFACT_PACKAGES.map((packageInfo) => ['pnpm', ['--filter', packageInfo.name, 'run', 'build']]),
    );
    assert.deepEqual(
      commands
        .slice(NPM_ARTIFACT_PACKAGES.length, NPM_ARTIFACT_PACKAGES.length + 3)
        .map((command) => [command.command, command.args]),
      [
        [
          process.execPath,
          ['scripts/build-python-runtime-wheel.mjs'],
        ],
        [
          'uv',
          ['build', '--package', 'ktx-sl', '--out-dir', '/repo/ktx/dist/artifacts/python'],
        ],
        [
          'uv',
          ['build', '--package', 'ktx-daemon', '--out-dir', '/repo/ktx/dist/artifacts/python'],
        ],
      ],
    );
    assert.deepEqual(
      commands.slice(NPM_ARTIFACT_PACKAGES.length + 3).map((command) => [command.command, command.args]),
      NPM_ARTIFACT_PACKAGES.map((packageInfo) => [
        'pnpm',
        ['--filter', packageInfo.name, 'pack', '--out', layout.npmTarballs[packageInfo.name]],
      ]),
    );
```

- [ ] **Step 5: Update release metadata expectations**

In the `packageReleaseMetadata` test, add this Python metadata entry after
`ktx-daemon`:

```javascript
        {
          ecosystem: 'python',
          packageName: 'kaelio-ktx',
          packageRoot: 'python/runtime-wheel',
          packageVersion: '0.1.0',
          private: false,
          releaseMode: 'ci-artifact-only',
        },
```

- [ ] **Step 6: Update Python artifact discovery expectations**

In the `findPythonArtifacts` test, create the runtime wheel fixture:

```javascript
      await writeFile(join(root, 'kaelio_ktx-0.1.0-py3-none-any.whl'), '');
```

Then update the expected object:

```javascript
      assert.deepEqual(await findPythonArtifacts(root), {
        runtimeWheel: join(root, 'kaelio_ktx-0.1.0-py3-none-any.whl'),
        ktxSlWheel: join(root, 'ktx_sl-0.1.0-py3-none-any.whl'),
        ktxSlSdist: join(root, 'ktx_sl-0.1.0.tar.gz'),
        ktxDaemonWheel: join(root, 'ktx_daemon-0.1.0-py3-none-any.whl'),
        ktxDaemonSdist: join(root, 'ktx_daemon-0.1.0.tar.gz'),
      });
```

- [ ] **Step 7: Update manifest file count expectations**

In the `verifyArtifactManifest` test, replace:

```javascript
      assert.equal(manifest.files.length, NPM_ARTIFACT_PACKAGES.length + 4);
```

with:

```javascript
      assert.equal(manifest.files.length, NPM_ARTIFACT_PACKAGES.length + 5);
```

- [ ] **Step 8: Add CLI asset copy test**

Add this test near the other artifact helper tests:

```javascript
describe('copyRuntimeWheelAssets', () => {
  it('copies the runtime wheel and checksum manifest into CLI assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-runtime-assets-test-'));
    const layout = packageArtifactLayout(root);
    try {
      await mkdir(layout.pythonDir, { recursive: true });
      await writeFile(
        join(layout.pythonDir, 'kaelio_ktx-0.1.0-py3-none-any.whl'),
        'kaelio-ktx-runtime-wheel',
      );

      const assets = await copyRuntimeWheelAssets(layout, {
        runtimeWheel: join(layout.pythonDir, 'kaelio_ktx-0.1.0-py3-none-any.whl'),
      });

      assert.equal(
        assets.wheelPath,
        join(root, 'packages', 'cli', 'assets', 'python', 'kaelio_ktx-0.1.0-py3-none-any.whl'),
      );
      assert.equal(
        assets.manifestPath,
        join(root, 'packages', 'cli', 'assets', 'python', CLI_PYTHON_ASSET_MANIFEST),
      );
      const manifest = JSON.parse(await readFile(assets.manifestPath, 'utf8'));
      assert.deepEqual(manifest, {
        schemaVersion: 1,
        distributionName: RUNTIME_WHEEL_DISTRIBUTION_NAME,
        normalizedName: RUNTIME_WHEEL_NORMALIZED_NAME,
        version: RUNTIME_WHEEL_PACKAGE_VERSION,
        wheel: {
          file: 'kaelio_ktx-0.1.0-py3-none-any.whl',
          sha256: createHash('sha256')
            .update('kaelio-ktx-runtime-wheel')
            .digest('hex'),
          bytes: Buffer.byteLength('kaelio-ktx-runtime-wheel'),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 9: Update install argument test**

Replace the `pythonArtifactInstallArgs` expectation with one runtime wheel:

```javascript
    assert.deepEqual(args, [
      'pip',
      'install',
      '--python',
      '/tmp/smoke/.venv/bin/python',
      '/repo/ktx/dist/artifacts/python/kaelio_ktx-0.1.0-py3-none-any.whl',
    ]);
    assert.equal(args.includes('ktx-daemon'), false);
    assert.equal(args.includes('ktx-sl'), false);
    assert.equal(args.includes('--find-links'), false);
```

- [ ] **Step 10: Run the failing package artifact tests**

Run:

```bash
node --test scripts/package-artifacts.test.mjs
```

Expected: FAIL with missing exports from `scripts/package-artifacts.mjs`.

### Task 5: Wire the runtime wheel into artifact packaging

**Files:**

- Modify: `scripts/package-artifacts.mjs`
- Modify: `scripts/package-artifacts.test.mjs`
- Test: `scripts/package-artifacts.test.mjs`

- [ ] **Step 1: Import runtime wheel builder constants**

Add this import near the top of `scripts/package-artifacts.mjs`:

```javascript
import {
  RUNTIME_WHEEL_DISTRIBUTION_NAME,
  RUNTIME_WHEEL_NORMALIZED_NAME,
  RUNTIME_WHEEL_PACKAGE_VERSION,
} from './build-python-runtime-wheel.mjs';
```

Then re-export those constants after the existing constants:

```javascript
export {
  RUNTIME_WHEEL_DISTRIBUTION_NAME,
  RUNTIME_WHEEL_NORMALIZED_NAME,
  RUNTIME_WHEEL_PACKAGE_VERSION,
};
```

- [ ] **Step 2: Add CLI asset manifest constant**

Add this constant after `PYTHON_PACKAGE_VERSION`:

```javascript
export const CLI_PYTHON_ASSET_MANIFEST = 'manifest.json';
```

- [ ] **Step 3: Change build command order**

Replace `buildArtifactCommands(layout)` with this implementation:

```javascript
export function buildArtifactCommands(layout) {
  const npmBuildCommands = NPM_ARTIFACT_PACKAGES.map((packageInfo) => ({
    command: 'pnpm',
    args: ['--filter', packageInfo.name, 'run', 'build'],
    cwd: layout.rootDir,
  }));
  const npmPackCommands = NPM_ARTIFACT_PACKAGES.map((packageInfo) => ({
    command: 'pnpm',
    args: ['--filter', packageInfo.name, 'pack', '--out', layout.npmTarballs[packageInfo.name]],
    cwd: layout.rootDir,
  }));

  return [
    ...npmBuildCommands,
    {
      command: process.execPath,
      args: ['scripts/build-python-runtime-wheel.mjs'],
      cwd: layout.rootDir,
    },
    {
      command: 'uv',
      args: ['build', '--package', 'ktx-sl', '--out-dir', layout.pythonDir],
      cwd: layout.rootDir,
    },
    {
      command: 'uv',
      args: ['build', '--package', 'ktx-daemon', '--out-dir', layout.pythonDir],
      cwd: layout.rootDir,
    },
    ...npmPackCommands,
  ];
}
```

- [ ] **Step 4: Discover the runtime wheel**

Update `findPythonArtifacts(pythonDir)` to return `runtimeWheel`:

```javascript
export async function findPythonArtifacts(pythonDir) {
  const files = await readdir(pythonDir);

  return {
    runtimeWheel: findOne(
      files,
      RUNTIME_WHEEL_DISTRIBUTION_NAME,
      '.whl',
      'kaelio-ktx runtime wheel',
      pythonDir,
      RUNTIME_WHEEL_PACKAGE_VERSION,
    ),
    ktxSlWheel: findOne(files, 'ktx-sl', '.whl', 'ktx-sl wheel', pythonDir),
    ktxSlSdist: findOne(files, 'ktx-sl', '.tar.gz', 'ktx-sl source distribution', pythonDir),
    ktxDaemonWheel: findOne(files, 'ktx-daemon', '.whl', 'ktx-daemon wheel', pythonDir),
    ktxDaemonSdist: findOne(files, 'ktx-daemon', '.tar.gz', 'ktx-daemon source distribution', pythonDir),
  };
}
```

Change `findOne` to accept an optional version:

```javascript
function findOne(files, distributionName, suffix, label, pythonDir, version = PYTHON_PACKAGE_VERSION) {
  const normalized = normalizePythonDistributionName(distributionName);
  const found = files.find((file) => file.startsWith(`${normalized}-${version}`) && file.endsWith(suffix));
  if (!found) {
    throw new Error(`Missing Python artifact: ${label}`);
  }
  return join(pythonDir, found);
}
```

- [ ] **Step 5: Add runtime wheel release metadata**

In `packageReleaseMetadata`, append this entry after `ktxDaemonPackage`:

```javascript
    releaseMetadataEntry({
      ecosystem: 'python',
      packageName: RUNTIME_WHEEL_DISTRIBUTION_NAME,
      packageRoot: 'python/runtime-wheel',
      packageVersion: RUNTIME_WHEEL_PACKAGE_VERSION,
      privatePackage: false,
    }),
```

- [ ] **Step 6: Add runtime wheel to artifact manifest records**

In `artifactPackageRecords`, add this record after npm records:

```javascript
    {
      artifactKind: 'wheel',
      artifactPath: pythonArtifacts.runtimeWheel,
      metadata: requirePackageMetadata(packagesByName, RUNTIME_WHEEL_DISTRIBUTION_NAME),
    },
```

- [ ] **Step 7: Add CLI Python asset copy helper**

Add this function before `pythonArtifactInstallArgs`:

```javascript
function runtimeWheelAssetName(runtimeWheelPath) {
  return runtimeWheelPath.split(sep).at(-1);
}

export async function copyRuntimeWheelAssets(layout, pythonArtifacts) {
  const assetDir = join(layout.rootDir, 'packages', 'cli', 'assets', 'python');
  const wheelFile = runtimeWheelAssetName(pythonArtifacts.runtimeWheel);
  if (!wheelFile) {
    throw new Error(`Unable to determine runtime wheel filename: ${pythonArtifacts.runtimeWheel}`);
  }
  const wheelContents = await readFile(pythonArtifacts.runtimeWheel);
  await rm(assetDir, { recursive: true, force: true });
  await mkdir(assetDir, { recursive: true });
  const wheelPath = join(assetDir, wheelFile);
  const manifestPath = join(assetDir, CLI_PYTHON_ASSET_MANIFEST);
  await writeFile(wheelPath, wheelContents);
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        distributionName: RUNTIME_WHEEL_DISTRIBUTION_NAME,
        normalizedName: RUNTIME_WHEEL_NORMALIZED_NAME,
        version: RUNTIME_WHEEL_PACKAGE_VERSION,
        wheel: {
          file: wheelFile,
          sha256: createHash('sha256').update(wheelContents).digest('hex'),
          bytes: wheelContents.byteLength,
        },
      },
      null,
      2,
    )}\n`,
  );
  return { assetDir, wheelPath, manifestPath };
}
```

- [ ] **Step 8: Install the runtime wheel in artifact smokes**

Replace `pythonArtifactInstallArgs` with:

```javascript
export function pythonArtifactInstallArgs(python, pythonArtifacts) {
  return ['pip', 'install', '--python', python, pythonArtifacts.runtimeWheel];
}
```

Update `pythonVerifySource()` to assert `kaelio-ktx` metadata and keep module
imports:

```javascript
export function pythonVerifySource() {
  return `
import importlib.metadata

import semantic_layer
import ktx_daemon

assert importlib.metadata.version("kaelio-ktx") == "0.1.0"
assert semantic_layer is not None
assert ktx_daemon.PACKAGE_NAME == "ktx-daemon"
`;
}
```

- [ ] **Step 9: Copy runtime assets before npm packing**

Replace the loop in `buildArtifacts(layout)` with these explicit phases:

```javascript
  const commands = buildArtifactCommands(layout);
  const npmBuildCount = NPM_ARTIFACT_PACKAGES.length;
  const npmPackStart = commands.length - NPM_ARTIFACT_PACKAGES.length;

  for (const command of commands.slice(0, npmBuildCount)) {
    await runCommand(command.command, command.args, { cwd: command.cwd });
  }
  for (const command of commands.slice(npmBuildCount, npmPackStart)) {
    await runCommand(command.command, command.args, { cwd: command.cwd });
  }
  const pythonArtifacts = await findPythonArtifacts(layout.pythonDir);
  await copyRuntimeWheelAssets(layout, pythonArtifacts);
  for (const command of commands.slice(npmPackStart)) {
    await runCommand(command.command, command.args, { cwd: command.cwd });
  }
```

- [ ] **Step 10: Run package artifact tests**

Run:

```bash
node --test scripts/package-artifacts.test.mjs
```

Expected: PASS.

- [ ] **Step 11: Commit artifact wiring**

Run:

```bash
git add scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs
git commit -m "build: bundle python runtime wheel in cli artifacts"
```

### Task 6: Update release policy and generated asset ignores

**Files:**

- Modify: `release-policy.json`
- Modify: `.gitignore`
- Modify: `scripts/release-readiness.test.mjs`
- Test: `scripts/release-readiness.test.mjs`

- [ ] **Step 1: Ignore generated CLI Python assets**

Add this block to `.gitignore` after the `dist/` ignore:

```gitignore
packages/cli/assets/python/
```

- [ ] **Step 2: Add runtime wheel to release policy**

Update `release-policy.json` so the Python packages list is:

```json
  "python": {
    "publish": false,
    "repository": null,
    "packages": ["ktx-sl", "ktx-daemon", "kaelio-ktx"]
  },
```

- [ ] **Step 3: Update release readiness fixtures**

In `scripts/release-readiness.test.mjs`, update fixture policy objects that
list Python packages from:

```javascript
packages: ['ktx-sl', 'ktx-daemon'],
```

to:

```javascript
packages: ['ktx-sl', 'ktx-daemon', 'kaelio-ktx'],
```

Update expected package name arrays to include `kaelio-ktx`:

```javascript
packageNames: [
  ...NPM_ARTIFACT_PACKAGES.map((packageInfo) => packageInfo.name),
  'ktx-sl',
  'ktx-daemon',
  'kaelio-ktx',
],
```

- [ ] **Step 4: Run release readiness tests**

Run:

```bash
node --test scripts/release-readiness.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit policy updates**

Run:

```bash
git add .gitignore release-policy.json scripts/release-readiness.test.mjs
git commit -m "build: track bundled python runtime release artifact"
```

### Task 7: Verify the built runtime wheel end to end

**Files:**

- Build output: `dist/artifacts/python/kaelio_ktx-0.1.0-py3-none-any.whl`
- Build output: `packages/cli/assets/python/manifest.json`
- Build output:
  `packages/cli/assets/python/kaelio_ktx-0.1.0-py3-none-any.whl`

- [ ] **Step 1: Run focused script tests**

Run:

```bash
node --test scripts/build-python-runtime-wheel.test.mjs scripts/package-artifacts.test.mjs scripts/release-readiness.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run Python package tests affected by dependency split**

Run:

```bash
uv run pytest python/ktx-daemon/tests -q
```

Expected: PASS.

- [ ] **Step 3: Run package artifact check**

Run:

```bash
pnpm run artifacts:check
```

Expected: PASS. This command builds the runtime wheel, copies it into CLI
assets before npm packing, installs the packed npm packages in a clean smoke
project, installs the bundled runtime wheel with `uv pip install`, and verifies
`semantic_layer` plus `ktx_daemon` imports from the one `kaelio-ktx` wheel.

- [ ] **Step 4: Inspect the generated CLI asset manifest**

Run:

```bash
node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync('packages/cli/assets/python/manifest.json','utf8')); console.log(m.distributionName, m.version, m.wheel.file, m.wheel.sha256.length)"
```

Expected output:

```text
kaelio-ktx 0.1.0 kaelio_ktx-0.1.0-py3-none-any.whl 64
```

- [ ] **Step 5: Run pre-commit when configured**

Run this only if `.pre-commit-config.yaml` exists:

```bash
uv run pre-commit run --files python/ktx-daemon/pyproject.toml uv.lock pyproject.toml scripts/build-python-runtime-wheel.mjs scripts/build-python-runtime-wheel.test.mjs scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs scripts/release-readiness.test.mjs release-policy.json .gitignore
```

Expected: PASS. If no pre-commit config exists, record that no pre-commit
configuration exists in this repository and skip this command.

- [ ] **Step 6: Commit verification-only updates if any**

If verification required small code or test fixes, commit them:

```bash
git add scripts/build-python-runtime-wheel.mjs scripts/build-python-runtime-wheel.test.mjs scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs scripts/release-readiness.test.mjs python/ktx-daemon/pyproject.toml uv.lock release-policy.json .gitignore
git commit -m "test: verify bundled python runtime wheel"
```

If no files changed after verification, do not create an empty commit.

## Acceptance criteria

- `dist/artifacts/python/kaelio_ktx-0.1.0-py3-none-any.whl` is built by
  `pnpm run artifacts:check`.
- The built CLI npm tarball includes
  `assets/python/kaelio_ktx-0.1.0-py3-none-any.whl` and
  `assets/python/manifest.json`.
- The asset manifest records the wheel filename, byte count, and SHA-256.
- Installing only the bundled runtime wheel exposes `semantic_layer`,
  `ktx_daemon`, and the `ktx-daemon` console script.
- `sentence-transformers` and `torch` are absent from default dependencies and
  present under the `local-embeddings` extra.
- Existing separate `ktx-sl` and `ktx-daemon` artifacts can remain CI artifacts
  in this plan; the npm runtime payload uses `kaelio-ktx`.

## Self-review

Spec coverage:

- Covers the package-model requirement for one bundled KTX-owned Python wheel.
- Covers the wheel checksum or runtime manifest requirement by adding the npm
  asset manifest.
- Covers lazy local embedding dependencies by moving heavy packages into the
  `local-embeddings` extra.
- Leaves managed runtime directories, install commands, daemon reuse, and
  `@kaelio/ktx` npm renaming for later plans.

Placeholder scan:

- The plan contains no placeholder markers and no unspecified implementation
  steps.

Type and name consistency:

- Runtime distribution name is consistently `kaelio-ktx`.
- Wheel filename prefix is consistently `kaelio_ktx`.
- Runtime version is consistently `0.1.0`.
