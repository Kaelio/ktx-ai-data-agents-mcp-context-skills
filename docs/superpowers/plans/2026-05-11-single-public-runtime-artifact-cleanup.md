# Single Public Runtime Artifact Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make release artifacts match the npm-managed Python runtime design:
one public `@kaelio/ktx` npm tarball plus one bundled `kaelio-ktx` runtime
wheel, with no standalone `ktx-sl` or `ktx-daemon` release artifacts.

**Architecture:** Keep `python/ktx-sl` and `python/ktx-daemon` as source
packages used to assemble the bundled runtime wheel. Remove direct standalone
Python wheel and source-distribution builds from the release artifact path,
manifest, readiness policy, and artifact smoke docs. The packed npm package
remains the only user-visible package; Python-backed verification continues
through the managed runtime installed from the bundled wheel.

**Tech Stack:** Node 22 ESM scripts, `node:test`, pnpm, uv-built bundled
runtime wheel, JSON release policy, Markdown.

---

## Current state

This plan follows
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.

The following plan files are based on that spec and are implemented in the
current tree:

- `docs/superpowers/plans/2026-05-11-bundled-python-runtime-wheel.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-installer.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-command-integration.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-daemon-lifecycle.md`
- `docs/superpowers/plans/2026-05-11-managed-local-embeddings-runtime.md`
- `docs/superpowers/plans/2026-05-11-public-kaelio-ktx-npm-package.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-release-smoke.md`
- `docs/superpowers/plans/2026-05-11-managed-local-embeddings-release-smoke.md`
- `docs/superpowers/plans/2026-05-11-managed-agent-mcp-semantic-runtime.md`
- `docs/superpowers/plans/2026-05-11-managed-local-ingest-daemon-runtime.md`
- `docs/superpowers/plans/2026-05-11-managed-runtime-docs-and-postgres-smoke-cleanup.md`
- `docs/superpowers/plans/2026-05-11-published-package-managed-runtime-smoke.md`
- `docs/superpowers/plans/2026-05-11-public-npm-release-handoff.md`
- `docs/superpowers/plans/2026-05-11-managed-runtime-prune-smoke-and-docs.md`
- `docs/superpowers/plans/2026-05-11-managed-runtime-uv-prerequisite-contract.md`

Implementation evidence found before writing this plan includes:

- `packages/cli/assets/python/manifest.json` and
  `packages/cli/assets/python/kaelio_ktx-0.1.0-py3-none-any.whl`.
- `packages/cli/src/managed-python-runtime.ts`,
  `packages/cli/src/managed-python-command.ts`,
  `packages/cli/src/managed-python-daemon.ts`,
  `packages/cli/src/managed-local-embeddings.ts`,
  `packages/cli/src/managed-python-http.ts`, and `packages/cli/src/runtime.ts`.
- `scripts/build-public-npm-package.mjs`, `scripts/package-artifacts.mjs`,
  `scripts/published-package-smoke.mjs`,
  `scripts/local-embeddings-runtime-smoke.mjs`,
  `scripts/publish-public-npm-package.mjs`, and
  `.github/workflows/release.yml`.
- `release-policy.json` is in `npm-public-release-ready` mode, publishes
  `@kaelio/ktx`, disables Python package publishing, and encodes the hard
  `uv` prerequisite.
- `README.md` and `examples/package-artifacts/README.md` document public npm
  usage, managed runtime commands, `runtime prune`, and the `uv` prerequisite.

The remaining mismatch is in the artifact release surface:

- `scripts/package-artifacts.mjs` still runs `uv build --package ktx-sl` and
  `uv build --package ktx-daemon`.
- `scripts/package-artifacts.mjs` still adds `ktx-sl` and `ktx-daemon` wheel
  and source-distribution files to the artifact manifest.
- `scripts/package-artifacts.mjs` still runs a direct Python clean-install
  smoke, even though the npm artifact smoke already proves Python-backed
  commands through the managed runtime.
- `release-policy.json` still lists `ktx-sl` and `ktx-daemon` under
  `python.packages`.
- `examples/package-artifacts/README.md` says the Python smoke installs
  standalone Python artifacts directly.

This plan removes those release artifacts. It does not delete the Python source
packages because the bundled runtime wheel builder still copies from
`python/ktx-sl/semantic_layer` and `python/ktx-daemon/src/ktx_daemon`.

## File structure

- Modify `scripts/package-artifacts.test.mjs`: make artifact tests expect only
  `@kaelio/ktx` plus the `kaelio-ktx` bundled runtime wheel, and add a guard
  that direct standalone Python artifact smoke code is gone.
- Modify `scripts/package-artifacts.mjs`: stop building standalone Python
  artifacts, stop looking for their wheel and source-distribution files, remove
  their release metadata, and remove the direct Python artifact verification
  path.
- Modify `scripts/release-readiness.test.mjs`: update release policy fixtures
  and readiness reports so the only Python release metadata is `kaelio-ktx`.
- Modify `release-policy.json`: set `python.packages` to `["kaelio-ktx"]`.
- Modify `scripts/examples-docs.test.mjs`: require docs to describe the single
  npm tarball plus runtime wheel artifact shape and reject the old direct
  Python-artifact smoke wording.
- Modify `README.md`: clarify that `python/ktx-sl` and `python/ktx-daemon` are
  source packages, not release artifacts for the first npm release.
- Modify `examples/package-artifacts/README.md`: replace the stale standalone
  Python smoke paragraph with the managed-runtime artifact contract.

### Task 1: Make package artifact tests expect one runtime wheel

**Files:**

- Modify: `scripts/package-artifacts.test.mjs`
- Test: `scripts/package-artifacts.test.mjs`

- [ ] **Step 1: Update package artifact imports**

In `scripts/package-artifacts.test.mjs`, replace the import from
`./package-artifacts.mjs` with this import:

```javascript
import {
  CLI_PYTHON_ASSET_MANIFEST,
  INTERNAL_NPM_WORKSPACE_PACKAGES,
  RUNTIME_WHEEL_DISTRIBUTION_NAME,
  RUNTIME_WHEEL_NORMALIZED_NAME,
  RUNTIME_WHEEL_PACKAGE_VERSION,
  artifactManifestPath,
  buildArtifactCommands,
  copyRuntimeWheelAssets,
  findPythonArtifacts,
  NPM_ARTIFACT_PACKAGES,
  npmDemoSmokeSource,
  npmRuntimeSmokeSource,
  npmSmokePackageJson,
  npmVerifySource,
  packageArtifactLayout,
  packageReleaseMetadata,
  verifyArtifactManifest,
  writeArtifactManifest,
} from './package-artifacts.mjs';
```

- [ ] **Step 2: Remove standalone Python fixture setup**

In `scripts/package-artifacts.test.mjs`, replace `writeReleaseMetadataInputs`
with this function:

```javascript
async function writeReleaseMetadataInputs(root) {
  for (const packageInfo of INTERNAL_NPM_WORKSPACE_PACKAGES) {
    await mkdir(join(root, packageInfo.packageRoot), { recursive: true });
    await writeJson(join(root, packageInfo.packageRoot, 'package.json'), {
      name: packageInfo.name,
      version: '0.0.0-private',
      private: true,
    });
  }
}
```

Replace `writeUploadableArtifactFixtures` with this function:

```javascript
async function writeUploadableArtifactFixtures(layout) {
  await mkdir(layout.npmDir, { recursive: true });
  await mkdir(layout.pythonDir, { recursive: true });

  const fileContents = new Map([
    ...NPM_ARTIFACT_PACKAGES.map((packageInfo) => [
      layout.npmTarballs[packageInfo.name],
      `${packageInfo.name}-tarball`,
    ]),
    [
      join(layout.pythonDir, 'kaelio_ktx-0.1.0-py3-none-any.whl'),
      'kaelio-ktx-runtime-wheel',
    ],
  ]);

  for (const [path, contents] of fileContents) {
    await writeFile(path, contents);
  }
}
```

- [ ] **Step 3: Change build command expectations**

In the `buildArtifactCommands` test, replace the body with this code:

```javascript
  it('builds TypeScript packages and the runtime wheel before packing npm artifacts', () => {
    const layout = packageArtifactLayout('/repo/ktx');
    const commands = buildArtifactCommands(layout);

    assert.deepEqual(
      commands.slice(0, NPM_BUILD_PACKAGE_ORDER.length).map((command) => [command.command, command.args]),
      NPM_BUILD_PACKAGE_ORDER.map((packageName) => ['pnpm', ['--filter', packageName, 'run', 'build']]),
    );
    assert.deepEqual(
      commands.slice(NPM_BUILD_PACKAGE_ORDER.length, NPM_BUILD_PACKAGE_ORDER.length + 1).map((command) => [
        command.command,
        command.args,
      ]),
      [[process.execPath, ['scripts/build-python-runtime-wheel.mjs']]],
    );
    assert.deepEqual(
      commands.slice(NPM_BUILD_PACKAGE_ORDER.length + 1).map((command) => [command.command, command.args]),
      [[process.execPath, ['scripts/build-public-npm-package.mjs']]],
    );
  });
```

- [ ] **Step 4: Change release metadata expectations**

In the `packageReleaseMetadata` test, replace the expected array with this
array:

```javascript
      assert.deepEqual(await packageReleaseMetadata(root), [
        {
          ecosystem: 'npm',
          packageName: '@kaelio/ktx',
          packageRoot: 'packages/cli',
          packageVersion: '0.1.0',
          private: false,
          releaseMode: 'ci-artifact-only',
        },
        {
          ecosystem: 'python',
          packageName: 'kaelio-ktx',
          packageRoot: 'python/runtime-wheel',
          packageVersion: '0.1.0',
          private: false,
          releaseMode: 'ci-artifact-only',
        },
      ]);
```

- [ ] **Step 5: Change Python artifact discovery expectations**

Replace the `findPythonArtifacts` success test with this test:

```javascript
  it('finds the bundled runtime wheel only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-test-'));
    try {
      await writeFile(join(root, 'kaelio_ktx-0.1.0-py3-none-any.whl'), '');

      assert.deepEqual(await findPythonArtifacts(root), {
        runtimeWheel: join(root, 'kaelio_ktx-0.1.0-py3-none-any.whl'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 6: Change artifact manifest expectations**

Inside the artifact manifest test, replace the Python package assertion with:

```javascript
      assert.deepEqual(
        manifest.packages.filter((entry) => entry.ecosystem === 'python'),
        [
          {
            ecosystem: 'python',
            packageName: 'kaelio-ktx',
            packageRoot: 'python/runtime-wheel',
            packageVersion: '0.1.0',
            private: false,
            releaseMode: 'ci-artifact-only',
          },
        ],
      );
```

Replace the Python file assertion with:

```javascript
      assert.deepEqual(
        manifest.files
          .filter((file) => file.ecosystem === 'python')
          .map((file) => ({
            artifactKind: file.artifactKind,
            ecosystem: file.ecosystem,
            packageName: file.packageName,
            packageVersion: file.packageVersion,
            path: file.path,
          })),
        [
          {
            artifactKind: 'wheel',
            ecosystem: 'python',
            packageName: 'kaelio-ktx',
            packageVersion: '0.1.0',
            path: 'python/kaelio_ktx-0.1.0-py3-none-any.whl',
          },
        ],
      );
```

In the `verifyArtifactManifest` success test, replace the file-count assertion
with:

```javascript
      assert.equal(manifest.files.length, NPM_ARTIFACT_PACKAGES.length + 1);
```

- [ ] **Step 7: Replace direct Python smoke tests with a dead-code guard**

Remove the whole `describe('pythonArtifactInstallArgs', ...)` block.

In `describe('verification snippets', ...)`, remove the test named
`asserts the Python modules that clean installs must expose`.

Add this test after the `verifyNpmArtifacts` test:

```javascript
describe('standalone Python artifact cleanup', () => {
  it('does not build or verify standalone Python package artifacts', async () => {
    const source = await readFile(new URL('./package-artifacts.mjs', import.meta.url), 'utf8');

    assert.doesNotMatch(source, /uv', \['build', '--package', 'ktx-sl'/);
    assert.doesNotMatch(source, /uv', \['build', '--package', 'ktx-daemon'/);
    assert.doesNotMatch(source, /async function verifyPythonArtifacts/);
    assert.doesNotMatch(source, /pythonArtifactInstallArgs/);
    assert.doesNotMatch(source, /pythonVerifySource/);
    assert.doesNotMatch(source, /ktx_sl-0\.1\.0/);
    assert.doesNotMatch(source, /ktx_daemon-0\.1\.0/);
  });
});
```

- [ ] **Step 8: Run package artifact tests and verify failure**

Run:

```bash
node --test scripts/package-artifacts.test.mjs
```

Expected: FAIL. The failures mention the extra `ktx-sl` and `ktx-daemon`
artifact commands, metadata entries, manifest files, or direct Python smoke
helpers.

### Task 2: Remove standalone Python artifacts from package artifacts

**Files:**

- Modify: `scripts/package-artifacts.mjs`
- Test: `scripts/package-artifacts.test.mjs`

- [ ] **Step 1: Remove dead constants and imports**

In `scripts/package-artifacts.mjs`, replace the `node:path` import with this
import:

```javascript
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
```

Remove these constants:

```javascript
const PACKAGE_VERSION = '0.0.0-private';
const PYTHON_PACKAGE_VERSION = '0.1.0';
```

Remove the whole `ordersSource` constant block.

- [ ] **Step 2: Make npm artifact names public-package only**

Replace `npmPackageTarballName` with this function:

```javascript
function npmPackageTarballName(packageName) {
  if (packageName !== PUBLIC_NPM_PACKAGE_NAME) {
    throw new Error(`Unsupported npm artifact package: ${packageName}`);
  }
  return publicNpmPackageTarballName(PUBLIC_NPM_PACKAGE_VERSION);
}
```

- [ ] **Step 3: Remove standalone Python build commands**

Replace `buildArtifactCommands` with this function:

```javascript
export function buildArtifactCommands(layout) {
  const packagesByName = new Map(INTERNAL_NPM_WORKSPACE_PACKAGES.map((packageInfo) => [packageInfo.name, packageInfo]));
  const npmBuildCommands = NPM_ARTIFACT_BUILD_ORDER.map((packageName) => {
    const packageInfo = packagesByName.get(packageName);
    if (!packageInfo) {
      throw new Error(`Unknown npm artifact build package: ${packageName}`);
    }
    return {
      command: 'pnpm',
      args: ['--filter', packageInfo.name, 'run', 'build'],
      cwd: layout.rootDir,
    };
  });
  const publicPackageCommand = {
    command: process.execPath,
    args: ['scripts/build-public-npm-package.mjs'],
    cwd: layout.rootDir,
  };

  return [
    ...npmBuildCommands,
    {
      command: process.execPath,
      args: ['scripts/build-python-runtime-wheel.mjs'],
      cwd: layout.rootDir,
    },
    publicPackageCommand,
  ];
}
```

- [ ] **Step 4: Discover only the bundled runtime wheel**

Replace `findOne` and `findPythonArtifacts` with these functions:

```javascript
function findOne(files, distributionName, suffix, label, pythonDir, version) {
  const normalized = normalizePythonDistributionName(distributionName);
  const found = files.find((file) => file.startsWith(`${normalized}-${version}`) && file.endsWith(suffix));
  if (!found) {
    throw new Error(`Missing Python artifact: ${label}`);
  }
  return join(pythonDir, found);
}

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
  };
}
```

- [ ] **Step 5: Emit release metadata only for npm and runtime wheel**

Replace `packageReleaseMetadata` with this function:

```javascript
export async function packageReleaseMetadata(rootDir = scriptRootDir()) {
  const npmPackages = await Promise.all(
    NPM_ARTIFACT_PACKAGES.map((packageInfo) => readNpmPackageMetadata(rootDir, packageInfo)),
  );

  return [
    ...npmPackages,
    releaseMetadataEntry({
      ecosystem: 'python',
      packageName: RUNTIME_WHEEL_DISTRIBUTION_NAME,
      packageRoot: 'python/runtime-wheel',
      packageVersion: RUNTIME_WHEEL_PACKAGE_VERSION,
      privatePackage: false,
    }),
  ];
}
```

- [ ] **Step 6: Remove dead TOML metadata helpers**

Delete these helper functions from `scripts/package-artifacts.mjs` because
release metadata no longer reads standalone Python `pyproject.toml` files:

```javascript
function readProjectBlock(toml, sourcePath) {
  const lines = toml.split(/\r?\n/);
  const block = [];
  let inProject = false;

  for (const line of lines) {
    if (/^\[project\]\s*$/.test(line)) {
      inProject = true;
      continue;
    }
    if (inProject && /^\[.*\]\s*$/.test(line)) {
      break;
    }
    if (inProject) {
      block.push(line);
    }
  }

  if (!inProject) {
    throw new Error(`Missing [project] table in ${sourcePath}`);
  }
  return block.join('\n');
}
```

```javascript
function readTomlStringField(projectBlock, fieldName, sourcePath) {
  const match = projectBlock.match(new RegExp(`^${fieldName}\\s*=\\s*"([^"]+)"\\s*$`, 'm'));
  if (!match) {
    throw new Error(`Missing project.${fieldName} in ${sourcePath}`);
  }
  return match[1];
}
```

```javascript
async function readPyprojectMetadata(path) {
  const toml = await readFile(path, 'utf-8');
  const projectBlock = readProjectBlock(toml, path);
  return {
    name: readTomlStringField(projectBlock, 'name', path),
    version: readTomlStringField(projectBlock, 'version', path),
  };
}
```

- [ ] **Step 7: Emit manifest records only for npm and runtime wheel**

Replace `artifactPackageRecords` with this function:

```javascript
function artifactPackageRecords(layout, pythonArtifacts, packages) {
  const packagesByName = packageMetadataByName(packages);
  const npmRecords = NPM_ARTIFACT_PACKAGES.map((packageInfo) => ({
    artifactKind: 'tarball',
    artifactPath: layout.npmTarballs[packageInfo.name],
    metadata: requirePackageMetadata(packagesByName, packageInfo.name),
  }));

  return [
    ...npmRecords,
    {
      artifactKind: 'wheel',
      artifactPath: pythonArtifacts.runtimeWheel,
      metadata: requirePackageMetadata(packagesByName, RUNTIME_WHEEL_DISTRIBUTION_NAME),
    },
  ];
}
```

- [ ] **Step 8: Remove direct Python artifact verification helpers**

Delete these exports and functions from `scripts/package-artifacts.mjs`:

```javascript
export function pythonArtifactInstallArgs(python, pythonArtifacts) {
  return ['pip', 'install', '--python', python, pythonArtifacts.runtimeWheel];
}
```

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

```javascript
function pythonExecutable(projectDir) {
  if (process.platform === 'win32') {
    return join(projectDir, '.venv', 'Scripts', 'python.exe');
  }
  return join(projectDir, '.venv', 'bin', 'python');
}
```

```javascript
export function npmSmokePythonEnv(projectDir, baseEnv = process.env) {
  const binDir = process.platform === 'win32' ? join(projectDir, '.venv', 'Scripts') : join(projectDir, '.venv', 'bin');
  const existingPath = baseEnv.PATH ?? '';

  return {
    ...baseEnv,
    PATH: existingPath ? `${binDir}${delimiter}${existingPath}` : binDir,
  };
}
```

```javascript
async function verifyPythonArtifacts(layout, tmpRoot) {
  const pythonArtifacts = await findPythonArtifacts(layout.pythonDir);

  const projectDir = join(tmpRoot, 'python-clean-install');
  await mkdir(projectDir, { recursive: true });
  const python = pythonExecutable(projectDir);
  await writeFile(join(projectDir, 'verify_python.py'), pythonVerifySource());

  await runCommand('uv', ['venv', '.venv'], { cwd: projectDir });
  await runCommand('uv', pythonArtifactInstallArgs(python, pythonArtifacts), {
    cwd: projectDir,
  });
  await runCommand(python, ['verify_python.py'], { cwd: projectDir });
  await runCommand(python, ['-m', 'ktx_daemon', 'semantic-validate'], {
    cwd: projectDir,
    input: `${JSON.stringify({ sources: [ordersSource], dialect: 'postgres' })}\n`,
  });
}
```

- [ ] **Step 9: Verify artifacts through npm only**

Replace `verifyArtifacts` with this function:

```javascript
async function verifyArtifacts(layout) {
  await verifyArtifactManifest(layout);

  const tmpRoot = await mkdtemp(join(tmpdir(), 'ktx-artifacts-'));
  try {
    await verifyNpmArtifacts(layout, tmpRoot);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 10: Run package artifact tests and verify pass**

Run:

```bash
node --test scripts/package-artifacts.test.mjs
```

Expected: PASS. The output includes `# fail 0`.

- [ ] **Step 11: Commit package artifact cleanup**

Run:

```bash
git add scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs
git commit -m "refactor: limit release artifacts to public package runtime"
```

### Task 3: Align release policy and readiness reports

**Files:**

- Modify: `release-policy.json`
- Modify: `scripts/release-readiness.test.mjs`
- Test: `scripts/release-readiness.test.mjs`

- [ ] **Step 1: Update release readiness fixtures**

In `scripts/release-readiness.test.mjs`, replace
`writeReleaseMetadataInputs` with:

```javascript
async function writeReleaseMetadataInputs(root) {
  for (const packageInfo of INTERNAL_NPM_WORKSPACE_PACKAGES) {
    await mkdir(join(root, packageInfo.packageRoot), { recursive: true });
    await writeJson(join(root, packageInfo.packageRoot, 'package.json'), {
      name: packageInfo.name,
      version: '0.0.0-private',
      private: true,
    });
  }
}
```

Replace `writeUploadableArtifactFixtures` with:

```javascript
async function writeUploadableArtifactFixtures(layout) {
  await mkdir(layout.npmDir, { recursive: true });
  await mkdir(layout.pythonDir, { recursive: true });

  const fileContents = new Map([
    ...NPM_ARTIFACT_PACKAGES.map((packageInfo) => [
      layout.npmTarballs[packageInfo.name],
      `${packageInfo.name}-tarball`,
    ]),
    [join(layout.pythonDir, 'kaelio_ktx-0.1.0-py3-none-any.whl'), 'kaelio-ktx-runtime-wheel'],
  ]);

  for (const [path, contents] of fileContents) {
    await writeFile(path, contents);
  }
}
```

In `releasePolicy`, replace the `python` object with:

```javascript
    python: {
      publish: false,
      repository: null,
      packages: ['kaelio-ktx'],
      ...pythonOverrides,
    },
```

- [ ] **Step 2: Update readiness report expectations**

In `scripts/release-readiness.test.mjs`, replace every expected
`packageNames` array with:

```javascript
        packageNames: ['@kaelio/ktx', 'kaelio-ktx'],
```

There are three report assertions to update:

- `accepts the current ci-artifact-only policy, package metadata, and artifact manifest`
- `reports required published package smoke when release mode requires it`
- `accepts the npm public release ready policy`

- [ ] **Step 3: Update checked release policy**

In `release-policy.json`, replace the `python.packages` value with:

```json
    "packages": ["kaelio-ktx"]
```

- [ ] **Step 4: Run readiness tests and verify pass**

Run:

```bash
node --test scripts/release-readiness.test.mjs
```

Expected: PASS. The output includes `# fail 0`.

- [ ] **Step 5: Commit release policy cleanup**

Run:

```bash
git add release-policy.json scripts/release-readiness.test.mjs
git commit -m "chore: align release policy with bundled runtime wheel"
```

### Task 4: Document the single release artifact surface

**Files:**

- Modify: `scripts/examples-docs.test.mjs`
- Modify: `README.md`
- Modify: `examples/package-artifacts/README.md`
- Test: `scripts/examples-docs.test.mjs`

- [ ] **Step 1: Add failing docs assertions**

In `scripts/examples-docs.test.mjs`, inside
`it('documents the public package artifact smoke shape', ...)`, add these
assertions after the existing `assert.match(readme, /managed Python runtime/);`
line:

```javascript
    assert.match(readme, /public `@kaelio\/ktx` npm tarball and the bundled `kaelio-ktx` runtime wheel/);
    assert.match(readme, /does not install standalone Python packages directly/);
    assert.doesNotMatch(readme, /standalone Python distributions/);
    assert.doesNotMatch(readme, /installs the Python artifacts directly/);
```

In `it('documents public npm and managed runtime usage in the README', ...)`,
add these assertions after the existing `uv` assertions:

```javascript
    assert.match(rootReadme, /release artifact manifest contains the public npm tarball and the bundled `kaelio-ktx` runtime wheel/);
    assert.match(rootReadme, /source packages for development, not public release artifacts/);
```

- [ ] **Step 2: Run docs tests and verify failure**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL. The failure mentions the missing single-artifact wording in
`README.md` or `examples/package-artifacts/README.md`.

- [ ] **Step 3: Update the package artifact example README**

In `examples/package-artifacts/README.md`, replace:

```markdown
The Python smoke project still installs the Python artifacts directly because
it verifies the standalone Python distributions that feed the bundled runtime
wheel.
```

with:

```markdown
The artifact manifest contains the public `@kaelio/ktx` npm tarball and the
bundled `kaelio-ktx` runtime wheel. The smoke does not install standalone
Python packages directly; Python-backed behavior is verified through the
managed runtime installed from the npm package.
```

- [ ] **Step 4: Update the root README release status**

In `README.md`, in the `## Release status` section, replace this paragraph:

```markdown
This repository builds one public npm artifact named `@kaelio/ktx`. The first
public npm handoff is policy-gated through `release-policy.json`, which keeps
Python package publishing disabled because KTX-owned Python code ships inside
the npm package as a bundled wheel.
```

with:

```markdown
This repository builds one public npm artifact named `@kaelio/ktx`. The release
artifact manifest contains the public npm tarball and the bundled `kaelio-ktx`
runtime wheel. The first public npm handoff is policy-gated through
`release-policy.json`, which keeps Python package publishing disabled because
KTX-owned Python code ships inside the npm package as a bundled wheel. The
`python/ktx-sl` and `python/ktx-daemon` directories remain source packages for
development, not public release artifacts.
```

- [ ] **Step 5: Run docs tests and verify pass**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: PASS. The output includes `# fail 0`.

- [ ] **Step 6: Commit docs cleanup**

Run:

```bash
git add README.md examples/package-artifacts/README.md scripts/examples-docs.test.mjs
git commit -m "docs: describe single public runtime artifact surface"
```

### Task 5: Verify the cleaned release artifact contract

**Files:**

- Verify: `scripts/package-artifacts.mjs`
- Verify: `scripts/package-artifacts.test.mjs`
- Verify: `scripts/release-readiness.test.mjs`
- Verify: `scripts/examples-docs.test.mjs`
- Verify: `release-policy.json`
- Verify: `README.md`
- Verify: `examples/package-artifacts/README.md`

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --test scripts/package-artifacts.test.mjs scripts/release-readiness.test.mjs scripts/examples-docs.test.mjs
```

Expected: PASS. The output includes `# fail 0`.

- [ ] **Step 2: Verify stale artifact strings are gone from production/docs files**

Run (scans only production and docs files, not test files — test files keep guard assertions that reference the removed strings):

```bash
rg -n "uv', \\['build', '--package', 'ktx-sl'|uv', \\['build', '--package', 'ktx-daemon'|ktx_sl-0\\.1\\.0|ktx_daemon-0\\.1\\.0|pythonArtifactInstallArgs|pythonVerifySource|verifyPythonArtifacts|standalone Python distributions|installs the Python artifacts directly" scripts/package-artifacts.mjs scripts/release-readiness.mjs README.md examples/package-artifacts/README.md release-policy.json
```

Expected: no matches.

- [ ] **Step 3: Verify release readiness against the current artifact manifest**

Run:

```bash
pnpm run release:readiness -- --json
```

Expected: PASS when `dist/artifacts/manifest.json` has been rebuilt after this
change. The JSON output contains:

```json
{
  "releaseMode": "npm-public-release-ready",
  "packageNames": ["@kaelio/ktx", "kaelio-ktx"],
  "pythonPublishEnabled": false
}
```

If this command fails because the local artifact manifest was generated before
the cleanup, run:

```bash
pnpm run artifacts:check
pnpm run release:readiness -- --json
```

Expected: both commands pass. The rebuilt manifest contains only
`npm/kaelio-ktx-0.1.0.tgz` and
`python/kaelio_ktx-0.1.0-py3-none-any.whl` under `files`.

- [ ] **Step 4: Run pre-commit on changed files when configured**

Run:

```bash
uv run pre-commit run --files scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs scripts/release-readiness.test.mjs scripts/examples-docs.test.mjs release-policy.json README.md examples/package-artifacts/README.md
```

Expected: PASS. If pre-commit is not installed or no pre-commit config exists,
record the exact error and keep the focused Node test output from Step 1.

- [ ] **Step 5: Commit final verification fixes if needed**

If Step 1, Step 2, Step 3, or Step 4 required code or docs fixes, commit them:

```bash
git add scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs scripts/release-readiness.test.mjs scripts/examples-docs.test.mjs release-policy.json README.md examples/package-artifacts/README.md
git commit -m "test: verify single public runtime artifact contract"
```

If no fixes were required after the previous commits, do not create an empty
commit.

## Acceptance criteria

- `scripts/package-artifacts.mjs` builds TypeScript packages, builds the
  bundled `kaelio-ktx` runtime wheel, copies it into CLI assets, and packs the
  public `@kaelio/ktx` npm tarball.
- `scripts/package-artifacts.mjs` no longer builds `ktx-sl` or `ktx-daemon`
  standalone wheel or source-distribution artifacts.
- Artifact manifests contain release metadata for `@kaelio/ktx` and
  `kaelio-ktx` only.
- `release-policy.json` lists only `@kaelio/ktx` under `npm.packages` and only
  `kaelio-ktx` under `python.packages`.
- The artifact smoke verifies Python-backed behavior through the installed
  public npm package and managed runtime, not by installing standalone Python
  artifacts directly.
- Public docs state that `python/ktx-sl` and `python/ktx-daemon` remain source
  packages for development, not public release artifacts.

## Self-review

Spec coverage:

- The plan preserves the single public npm package requirement.
- The plan preserves the bundled KTX-owned Python wheel requirement.
- The plan keeps Python package publishing disabled.
- The plan removes the only remaining artifact path that treated KTX-owned
  Python source packages as standalone release artifacts.

Placeholder scan:

- No steps contain placeholder implementation text.
- Every code-changing step names exact files and provides concrete replacement
  snippets.

Type and name consistency:

- Public npm package name remains `@kaelio/ktx`.
- Bundled runtime distribution name remains `kaelio-ktx`.
- Runtime wheel filename remains `kaelio_ktx-0.1.0-py3-none-any.whl`.
- Removed standalone Python artifact names are consistently `ktx-sl` and
  `ktx-daemon`.
