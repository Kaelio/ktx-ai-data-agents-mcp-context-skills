# Public Kaelio KTX npm Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one installable public npm package, `@kaelio/ktx`, whose
`ktx` binary includes the bundled Python runtime wheel and does not require
users to install any `@ktx/*` workspace packages directly.

**Architecture:** Keep the internal pnpm workspace package names unchanged for
development, then assemble a release package under `dist/public-npm-package`.
The release package copies the CLI `dist/` and assets, vendors built internal
`@ktx/*` packages as bundled dependencies, writes a public `@kaelio/ktx`
`package.json`, and packs exactly one npm tarball. Release and smoke scripts
then treat `@kaelio/ktx` as the only npm artifact while preserving internal
workspace builds.

**Tech Stack:** Node 22 ESM scripts, pnpm, TypeScript, Vitest, `node:test`,
npm bundled dependencies, KTX managed Python runtime assets.

---

## Existing status

This plan is based on
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.

Existing plans based on the spec:

- `docs/superpowers/plans/2026-05-11-bundled-python-runtime-wheel.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-installer.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-command-integration.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-daemon-lifecycle.md`
- `docs/superpowers/plans/2026-05-11-managed-local-embeddings-runtime.md`

All five are implemented in this worktree. Evidence found before writing this
plan includes:

- `scripts/build-python-runtime-wheel.mjs` and
  `scripts/build-python-runtime-wheel.test.mjs`.
- `packages/cli/assets/python/kaelio_ktx-0.1.0-py3-none-any.whl` and
  `packages/cli/assets/python/manifest.json`.
- `packages/cli/src/managed-python-runtime.ts`,
  `packages/cli/src/runtime.ts`, and
  `packages/cli/src/commands/runtime-commands.ts`.
- `packages/cli/src/managed-python-command.ts` and `ktx sl query` runtime
  install policy flags.
- `packages/cli/src/managed-python-daemon.ts`, daemon state paths, and
  `ktx runtime start` / `ktx runtime stop`.
- `packages/cli/src/managed-local-embeddings.ts`,
  `packages/context/src/llm/local-config.ts` managed marker constants, and
  setup wiring in `packages/cli/src/setup-embeddings.ts`.

Spec requirements still outside those plans:

- The visible npm package is still `@ktx/cli`, not `@kaelio/ktx`.
- Release artifacts still model multiple npm workspace packages instead of one
  public npm package.
- Installed-package smoke coverage still relies on installing internal
  `@ktx/*` tarballs.
- Published-package smoke coverage does not yet exercise the required
  `@kaelio/ktx` invocation modes:
  `npx @kaelio/ktx setup demo`, `npx @kaelio/ktx sl query ...`, local
  `npm install @kaelio/ktx` plus `npx ktx ...`, and global
  `npm install -g @kaelio/ktx` plus `ktx ...`.

This plan implements the public npm package surface and local tarball smoke
coverage. It intentionally keeps internal package imports such as
`@ktx/context` in source code so development stays compatible with the existing
workspace.

## File structure

- Modify `packages/cli/src/cli-runtime.ts`: read the package name and version
  from the installed package root so the same `dist/` reports `@ktx/cli` in the
  workspace and `@kaelio/ktx` in the assembled public package.
- Modify `packages/cli/src/index.test.ts`: cover dynamic package metadata.
- Create `scripts/build-public-npm-package.mjs`: assemble and pack the
  `@kaelio/ktx` release package with bundled internal `@ktx/*` packages.
- Create `scripts/build-public-npm-package.test.mjs`: test dependency union,
  bundled package copying, public `package.json` generation, and pack command
  shape.
- Modify `scripts/package-artifacts.mjs`: build internal packages, build Python
  artifacts, build the public package, and write a manifest with exactly one
  npm artifact named `@kaelio/ktx`.
- Modify `scripts/package-artifacts.test.mjs`: update artifact layout,
  release metadata, npm smoke package, and manifest expectations for the
  single public npm artifact.
- Modify `scripts/published-package-smoke-config.mjs`: add the public-package
  invocation commands needed by the runtime spec.
- Modify `scripts/published-package-smoke.mjs`: validate the new command list.
- Modify `scripts/published-package-smoke.test.mjs`: expect `@kaelio/ktx` and
  the supported `npx`, local install, and global install invocation modes.
- Modify `scripts/release-readiness.mjs`: allow the one public npm artifact
  while `release-policy.json` still disables publishing.
- Modify `scripts/release-readiness.test.mjs`: expect only `@kaelio/ktx` in
  npm release metadata and policy checks.
- Modify `release-policy.json`: list `@kaelio/ktx` as the only npm package and
  set the published smoke package to `@kaelio/ktx`.
- Modify `scripts/precommit-check.test.mjs` only if package filter assertions
  expect the public package name after artifact-script changes. Keep
  `scripts/precommit-check.mjs` using internal workspace package names.

### Task 1: Read CLI package metadata from the installed package root

**Files:**

- Modify: `packages/cli/src/cli-runtime.ts`
- Modify: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Add a failing dynamic metadata test**

In `packages/cli/src/index.test.ts`, extend the import from `./index.js` so it
includes `packageInfoFromJson`:

```typescript
import {
  getKtxCliPackageInfo,
  packageInfoFromJson,
  rendererUnavailableVizFallback,
  renderMemoryFlowTui,
  resolveVizFallback,
  runKtxCli,
  sanitizeMemoryFlowTuiError,
  startLiveMemoryFlowTui,
  warnVizFallbackOnce,
} from './index.js';
```

Add this test inside `describe('getKtxCliPackageInfo', () => { ... })` after the
existing metadata tests:

```typescript
  it('normalizes public package metadata from package.json contents', () => {
    expect(
      packageInfoFromJson({
        name: '@kaelio/ktx',
        version: '0.1.0',
      }),
    ).toEqual({
      name: '@kaelio/ktx',
      version: '0.1.0',
      contextPackageName: '@ktx/context',
    });
  });
```

- [ ] **Step 2: Run the failing metadata test**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/index.test.ts
```

Expected: FAIL with a missing export for `packageInfoFromJson`.

- [ ] **Step 3: Implement dynamic package metadata**

In `packages/cli/src/cli-runtime.ts`, add this import at the top of the file:

```typescript
import { createRequire } from 'node:module';
```

Replace the `KtxCliPackageInfo` interface and `getKtxCliPackageInfo()` with
this code:

```typescript
const requirePackageJson = createRequire(import.meta.url);

export interface KtxCliPackageInfo {
  name: string;
  version: string;
  contextPackageName: '@ktx/context';
}

export function packageInfoFromJson(packageJson: unknown): KtxCliPackageInfo {
  if (
    typeof packageJson !== 'object' ||
    packageJson === null ||
    !('name' in packageJson) ||
    !('version' in packageJson) ||
    typeof packageJson.name !== 'string' ||
    typeof packageJson.version !== 'string'
  ) {
    throw new Error('Invalid KTX CLI package metadata');
  }

  return {
    name: packageJson.name,
    version: packageJson.version,
    contextPackageName: '@ktx/context',
  };
}

export function getKtxCliPackageInfo(): KtxCliPackageInfo {
  return packageInfoFromJson(requirePackageJson('../package.json'));
}
```

In `packages/cli/src/index.ts`, add `packageInfoFromJson` to the export from
`./cli-runtime.js`:

```typescript
export {
  getKtxCliPackageInfo,
  packageInfoFromJson,
  runInitForCommander,
  runKtxCli,
  type KtxCliDeps,
  type KtxCliIo,
  type KtxCliPackageInfo,
} from './cli-runtime.js';
```

- [ ] **Step 4: Verify CLI metadata tests pass**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/cli/src/cli-runtime.ts packages/cli/src/index.ts packages/cli/src/index.test.ts
git commit -m "feat: read CLI package metadata dynamically"
```

### Task 2: Add the public npm package assembly script

**Files:**

- Create: `scripts/build-public-npm-package.test.mjs`
- Create: `scripts/build-public-npm-package.mjs`

- [ ] **Step 1: Write failing tests for the public package builder**

Create `scripts/build-public-npm-package.test.mjs` with this content:

```javascript
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  PUBLIC_BUNDLED_WORKSPACE_PACKAGES,
  PUBLIC_NPM_PACKAGE_NAME,
  collectPublicDependencies,
  createPublicNpmPackageTree,
  publicNpmPackageJson,
  publicNpmPackageLayout,
  publicNpmPackCommand,
} from './build-public-npm-package.mjs';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePackage(root, packageRoot, packageJson, files = {}) {
  const absoluteRoot = join(root, packageRoot);
  await mkdir(absoluteRoot, { recursive: true });
  await writeJson(join(absoluteRoot, 'package.json'), packageJson);

  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(absoluteRoot, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents);
  }
}

async function writeWorkspaceFixture(root) {
  await writePackage(
    root,
    'packages/cli',
    {
      name: '@ktx/cli',
      version: '0.0.0-private',
      description: 'CLI wrapper for KTX',
      type: 'module',
      engines: { node: '>=22.0.0' },
      bin: { ktx: './dist/bin.js' },
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
          default: './dist/index.js',
        },
        './package.json': './package.json',
      },
      files: ['dist', 'assets'],
      dependencies: {
        '@clack/prompts': '1.3.0',
        '@ktx/context': 'workspace:*',
        commander: '14.0.3',
      },
      license: 'Apache-2.0',
      repository: {
        type: 'git',
        url: 'git+https://github.com/kaelio/ktx.git',
        directory: 'packages/cli',
      },
    },
    {
      'dist/bin.js': '#!/usr/bin/env node\n',
      'dist/index.js': 'export const cli = true;\n',
      'dist/index.d.ts': 'export declare const cli: true;\n',
      'assets/python/manifest.json': '{"schemaVersion":1}\n',
    },
  );

  await writePackage(
    root,
    'packages/context',
    {
      name: '@ktx/context',
      version: '0.0.0-private',
      type: 'module',
      main: 'dist/index.js',
      exports: { '.': './dist/index.js' },
      files: ['dist', 'prompts', 'skills'],
      dependencies: {
        '@ktx/llm': 'workspace:*',
        yaml: '^2.8.2',
      },
    },
    {
      'dist/index.js': 'export const context = true;\n',
      'prompts/system.md': 'prompt\n',
      'skills/sl/SKILL.md': 'skill\n',
    },
  );

  await writePackage(
    root,
    'packages/llm',
    {
      name: '@ktx/llm',
      version: '0.0.0-private',
      type: 'module',
      main: 'dist/index.js',
      exports: { '.': './dist/index.js' },
      files: ['dist'],
      dependencies: {
        ai: '^6.0.168',
      },
    },
    {
      'dist/index.js': 'export const llm = true;\n',
    },
  );

  for (const packageName of PUBLIC_BUNDLED_WORKSPACE_PACKAGES.filter(
    (name) => name.startsWith('@ktx/connector-'),
  )) {
    const directory = packageName.replace('@ktx/', '');
    await writePackage(
      root,
      `packages/${directory}`,
      {
        name: packageName,
        version: '0.0.0-private',
        type: 'module',
        main: 'dist/index.js',
        exports: { '.': './dist/index.js' },
        files: ['dist'],
        dependencies: {
          '@ktx/context': 'workspace:*',
        },
      },
      {
        'dist/index.js': `export const name = ${JSON.stringify(packageName)};\n`,
      },
    );
  }
}

describe('publicNpmPackageLayout', () => {
  it('uses stable public package build and tarball paths', () => {
    const layout = publicNpmPackageLayout('/repo/ktx');

    assert.equal(layout.rootDir, '/repo/ktx');
    assert.equal(layout.packRoot, '/repo/ktx/dist/public-npm-package');
    assert.equal(layout.npmDir, '/repo/ktx/dist/artifacts/npm');
    assert.equal(layout.tarballPath, '/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.0.0-private.tgz');
  });
});

describe('collectPublicDependencies', () => {
  it('unions external runtime dependencies and omits workspace packages', () => {
    assert.deepEqual(
      collectPublicDependencies([
        {
          name: '@ktx/cli',
          dependencies: {
            '@ktx/context': 'workspace:*',
            commander: '14.0.3',
            zod: '^4.4.3',
          },
        },
        {
          name: '@ktx/context',
          dependencies: {
            '@ktx/llm': 'workspace:*',
            commander: '14.0.3',
            yaml: '^2.8.2',
            zod: '^4.1.13',
          },
        },
      ]),
      {
        commander: '14.0.3',
        yaml: '^2.8.2',
        zod: '^4.4.3',
      },
    );
  });

  it('fails on incompatible external dependency ranges', () => {
    assert.throws(
      () =>
        collectPublicDependencies([
          { name: '@ktx/cli', dependencies: { zod: '^4.4.3' } },
          { name: '@ktx/context', dependencies: { zod: '^3.25.0' } },
        ]),
      /Incompatible dependency versions for zod/,
    );
  });
});

describe('publicNpmPackageJson', () => {
  it('describes the public @kaelio/ktx binary package', () => {
    const packageJson = publicNpmPackageJson(
      {
        name: '@ktx/cli',
        version: '0.0.0-private',
        engines: { node: '>=22.0.0' },
        bin: { ktx: './dist/bin.js' },
        main: 'dist/index.js',
        types: 'dist/index.d.ts',
        exports: { '.': './dist/index.js', './package.json': './package.json' },
        license: 'Apache-2.0',
      },
      { commander: '14.0.3' },
    );

    assert.equal(packageJson.name, PUBLIC_NPM_PACKAGE_NAME);
    assert.equal(packageJson.private, false);
    assert.deepEqual(packageJson.bin, { ktx: './dist/bin.js' });
    assert.deepEqual(packageJson.dependencies, { commander: '14.0.3' });
    assert.deepEqual(packageJson.bundledDependencies, PUBLIC_BUNDLED_WORKSPACE_PACKAGES);
    assert.deepEqual(packageJson.files, ['dist', 'assets']);
  });
});

describe('createPublicNpmPackageTree', () => {
  it('copies CLI files, assets, and bundled internal workspace packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-public-npm-test-'));
    try {
      await writeWorkspaceFixture(root);
      const layout = publicNpmPackageLayout(root);

      const result = await createPublicNpmPackageTree(layout);

      assert.equal(result.packageJson.name, '@kaelio/ktx');
      assert.equal(result.packageJson.dependencies.commander, '14.0.3');
      assert.equal(result.packageJson.dependencies.yaml, '^2.8.2');
      assert.equal(result.packageJson.dependencies.ai, '^6.0.168');
      assert.equal(
        await readFile(join(layout.packRoot, 'assets', 'python', 'manifest.json'), 'utf8'),
        '{"schemaVersion":1}\n',
      );
      assert.equal(
        await readFile(join(layout.packRoot, 'node_modules', '@ktx', 'context', 'dist', 'index.js'), 'utf8'),
        'export const context = true;\n',
      );
      assert.equal(
        await readFile(join(layout.packRoot, 'node_modules', '@ktx', 'context', 'prompts', 'system.md'), 'utf8'),
        'prompt\n',
      );

      const bundledContextJson = JSON.parse(
        await readFile(join(layout.packRoot, 'node_modules', '@ktx', 'context', 'package.json'), 'utf8'),
      );
      assert.equal(bundledContextJson.private, true);
      assert.deepEqual(bundledContextJson.dependencies, { yaml: '^2.8.2' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('publicNpmPackCommand', () => {
  it('packs the assembled public package with pnpm', () => {
    const layout = publicNpmPackageLayout('/repo/ktx');

    assert.deepEqual(publicNpmPackCommand(layout), {
      command: 'pnpm',
      args: ['pack', '--out', '/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.0.0-private.tgz'],
      cwd: '/repo/ktx/dist/public-npm-package',
    });
  });
});
```

- [ ] **Step 2: Run the failing builder tests**

Run:

```bash
node --test scripts/build-public-npm-package.test.mjs
```

Expected: FAIL with an import error for
`./build-public-npm-package.mjs`.

- [ ] **Step 3: Implement the public package builder**

Create `scripts/build-public-npm-package.mjs` with this content:

```javascript
#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PUBLIC_NPM_PACKAGE_NAME = '@kaelio/ktx';
export const PUBLIC_NPM_PACKAGE_VERSION = '0.0.0-private';
export const PUBLIC_NPM_PACKAGE_TARBALL = 'kaelio-ktx-0.0.0-private.tgz';

export const PUBLIC_BUNDLED_WORKSPACE_PACKAGES = [
  '@ktx/llm',
  '@ktx/context',
  '@ktx/connector-bigquery',
  '@ktx/connector-clickhouse',
  '@ktx/connector-mysql',
  '@ktx/connector-postgres',
  '@ktx/connector-posthog',
  '@ktx/connector-snowflake',
  '@ktx/connector-sqlite',
  '@ktx/connector-sqlserver',
];

export const PUBLIC_BUNDLED_WORKSPACE_PACKAGE_ROOTS = {
  '@ktx/llm': 'packages/llm',
  '@ktx/context': 'packages/context',
  '@ktx/connector-bigquery': 'packages/connector-bigquery',
  '@ktx/connector-clickhouse': 'packages/connector-clickhouse',
  '@ktx/connector-mysql': 'packages/connector-mysql',
  '@ktx/connector-postgres': 'packages/connector-postgres',
  '@ktx/connector-posthog': 'packages/connector-posthog',
  '@ktx/connector-snowflake': 'packages/connector-snowflake',
  '@ktx/connector-sqlite': 'packages/connector-sqlite',
  '@ktx/connector-sqlserver': 'packages/connector-sqlserver',
};

function scriptRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function publicNpmPackageLayout(rootDir = scriptRootDir()) {
  return {
    rootDir,
    cliPackageRoot: join(rootDir, 'packages', 'cli'),
    packRoot: join(rootDir, 'dist', 'public-npm-package'),
    npmDir: join(rootDir, 'dist', 'artifacts', 'npm'),
    tarballPath: join(rootDir, 'dist', 'artifacts', 'npm', PUBLIC_NPM_PACKAGE_TARBALL),
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function isWorkspacePackageName(name) {
  return name.startsWith('@ktx/');
}

function parseCaretVersion(value) {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareParsedVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function mergeDependencyVersion(name, previous, next) {
  if (previous === next) {
    return previous;
  }

  const previousCaret = parseCaretVersion(previous);
  const nextCaret = parseCaretVersion(next);
  if (previousCaret && nextCaret && previousCaret.major === nextCaret.major) {
    return compareParsedVersions(previousCaret, nextCaret) >= 0 ? previous : next;
  }

  throw new Error(`Incompatible dependency versions for ${name}: ${previous} and ${next}`);
}

export function collectPublicDependencies(packageJsons) {
  const dependencies = new Map();

  for (const packageJson of packageJsons) {
    for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
      if (isWorkspacePackageName(name)) {
        continue;
      }
      const previous = dependencies.get(name);
      dependencies.set(name, previous ? mergeDependencyVersion(name, previous, version) : version);
    }
  }

  return sortedObject(dependencies);
}

export function publicNpmPackageJson(cliPackageJson, dependencies) {
  return {
    name: PUBLIC_NPM_PACKAGE_NAME,
    version: cliPackageJson.version ?? PUBLIC_NPM_PACKAGE_VERSION,
    description: 'Standalone KTX context layer for database agents',
    private: false,
    type: 'module',
    engines: cliPackageJson.engines ?? { node: '>=22.0.0' },
    bin: { ktx: './dist/bin.js' },
    main: cliPackageJson.main ?? 'dist/index.js',
    types: cliPackageJson.types ?? 'dist/index.d.ts',
    exports: cliPackageJson.exports ?? {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
      './package.json': './package.json',
    },
    files: ['dist', 'assets'],
    dependencies,
    bundledDependencies: PUBLIC_BUNDLED_WORKSPACE_PACKAGES,
    license: cliPackageJson.license ?? 'Apache-2.0',
    repository: {
      type: 'git',
      url: 'git+https://github.com/kaelio/ktx.git',
    },
    bugs: {
      url: 'https://github.com/kaelio/ktx/issues',
    },
    homepage: 'https://github.com/kaelio/ktx#readme',
  };
}

function bundledWorkspacePackageJson(packageJson) {
  const dependencies = Object.fromEntries(
    Object.entries(packageJson.dependencies ?? {}).filter(([name]) => !isWorkspacePackageName(name)),
  );

  return {
    name: packageJson.name,
    version: packageJson.version ?? PUBLIC_NPM_PACKAGE_VERSION,
    private: true,
    type: packageJson.type ?? 'module',
    main: packageJson.main,
    types: packageJson.types,
    exports: packageJson.exports,
    files: packageJson.files,
    dependencies: sortedObject(Object.entries(dependencies)),
    license: packageJson.license ?? 'Apache-2.0',
  };
}

async function copyPackageFileEntries(sourceRoot, targetRoot, packageJson) {
  for (const entry of packageJson.files ?? ['dist']) {
    await cp(join(sourceRoot, entry), join(targetRoot, entry), {
      recursive: true,
      force: true,
    });
  }
}

async function copyCliPackage(layout, cliPackageJson, dependencies) {
  await copyPackageFileEntries(layout.cliPackageRoot, layout.packRoot, cliPackageJson);
  await writeJson(join(layout.packRoot, 'package.json'), publicNpmPackageJson(cliPackageJson, dependencies));
}

async function copyBundledWorkspacePackage(rootDir, packageName, packageJson) {
  const packageRoot = PUBLIC_BUNDLED_WORKSPACE_PACKAGE_ROOTS[packageName];
  if (!packageRoot) {
    throw new Error(`Missing bundled workspace package root for ${packageName}`);
  }

  const sourceRoot = join(rootDir, packageRoot);
  const targetRoot = join(rootDir, 'dist', 'public-npm-package', 'node_modules', ...packageName.split('/'));
  await mkdir(targetRoot, { recursive: true });
  await copyPackageFileEntries(sourceRoot, targetRoot, packageJson);
  await writeJson(join(targetRoot, 'package.json'), bundledWorkspacePackageJson(packageJson));
}

export async function createPublicNpmPackageTree(layout = publicNpmPackageLayout()) {
  const cliPackageJson = await readJson(join(layout.cliPackageRoot, 'package.json'));
  const bundledPackageJsons = await Promise.all(
    PUBLIC_BUNDLED_WORKSPACE_PACKAGES.map(async (packageName) => {
      const packageRoot = PUBLIC_BUNDLED_WORKSPACE_PACKAGE_ROOTS[packageName];
      const packageJson = await readJson(join(layout.rootDir, packageRoot, 'package.json'));
      if (packageJson.name !== packageName) {
        throw new Error(`Unexpected package name in ${packageRoot}/package.json: ${packageJson.name}`);
      }
      return packageJson;
    }),
  );
  const dependencies = collectPublicDependencies([cliPackageJson, ...bundledPackageJsons]);

  await rm(layout.packRoot, { recursive: true, force: true });
  await mkdir(layout.packRoot, { recursive: true });
  await mkdir(layout.npmDir, { recursive: true });
  await copyCliPackage(layout, cliPackageJson, dependencies);

  for (const packageJson of bundledPackageJsons) {
    await copyBundledWorkspacePackage(layout.rootDir, packageJson.name, packageJson);
  }

  return {
    layout,
    packageJson: publicNpmPackageJson(cliPackageJson, dependencies),
    bundledPackages: PUBLIC_BUNDLED_WORKSPACE_PACKAGES,
  };
}

export function publicNpmPackCommand(layout = publicNpmPackageLayout()) {
  return {
    command: 'pnpm',
    args: ['pack', '--out', layout.tarballPath],
    cwd: layout.packRoot,
  };
}

export async function buildPublicNpmPackage(layout = publicNpmPackageLayout()) {
  await createPublicNpmPackageTree(layout);
  const pack = publicNpmPackCommand(layout);
  await execFileAsync(pack.command, pack.args, {
    cwd: pack.cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return layout.tarballPath;
}

async function main() {
  const tarball = await buildPublicNpmPackage();
  process.stdout.write(`Built ${PUBLIC_NPM_PACKAGE_NAME} package: ${tarball}\n`);
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

- [ ] **Step 4: Verify builder tests pass**

Run:

```bash
node --test scripts/build-public-npm-package.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add scripts/build-public-npm-package.mjs scripts/build-public-npm-package.test.mjs
git commit -m "feat: assemble public kaelio ktx npm package"
```

### Task 3: Make release artifacts use only `@kaelio/ktx` as the npm artifact

**Files:**

- Modify: `scripts/package-artifacts.mjs`
- Modify: `scripts/package-artifacts.test.mjs`
- Modify: `scripts/release-readiness.mjs`
- Modify: `scripts/release-readiness.test.mjs`
- Modify: `release-policy.json`

- [ ] **Step 1: Add failing artifact expectations for the public package**

In `scripts/package-artifacts.test.mjs`, update the import from
`./package-artifacts.mjs` so it also imports
`INTERNAL_NPM_WORKSPACE_PACKAGES`:

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
  npmSmokePythonEnv,
  npmVerifySource,
  packageArtifactLayout,
  packageReleaseMetadata,
  pythonArtifactInstallArgs,
  pythonVerifySource,
  verifyArtifactManifest,
  writeArtifactManifest,
} from './package-artifacts.mjs';
```

Replace the top-level `NPM_BUILD_PACKAGE_ORDER` declaration with:

```javascript
const INTERNAL_BUILD_PACKAGE_NAMES = INTERNAL_NPM_WORKSPACE_PACKAGES.map((packageInfo) => packageInfo.name);
const CONNECTOR_PACKAGE_NAMES = INTERNAL_BUILD_PACKAGE_NAMES.filter((packageName) =>
  packageName.startsWith('@ktx/connector-'),
);
const NPM_BUILD_PACKAGE_ORDER = ['@ktx/llm', '@ktx/context', ...CONNECTOR_PACKAGE_NAMES, '@ktx/cli'];
```

Replace `expectedNpmArtifactPath` with:

```javascript
function expectedNpmArtifactPath(packageName) {
  if (packageName === '@kaelio/ktx') {
    return 'npm/kaelio-ktx-0.0.0-private.tgz';
  }
  return `npm/${packageName.replace('@ktx/', 'ktx-')}-0.0.0-private.tgz`;
}
```

Replace `writeReleaseMetadataInputs` with:

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

  await mkdir(join(root, 'python', 'ktx-sl'), { recursive: true });
  await mkdir(join(root, 'python', 'ktx-daemon'), { recursive: true });
  await writeFile(
    join(root, 'python', 'ktx-sl', 'pyproject.toml'),
    ['[project]', 'name = "ktx-sl"', 'version = "0.1.0"', ''].join('\n'),
  );
  await writeFile(
    join(root, 'python', 'ktx-daemon', 'pyproject.toml'),
    ['[project]', 'name = "ktx-daemon"', 'version = "0.1.0"', ''].join('\n'),
  );
}
```

Update the `packageArtifactLayout` test so the npm assertions are:

```javascript
    assert.equal(layout.cliTarball, '/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.0.0-private.tgz');
    assert.deepEqual(Object.keys(layout.npmTarballs), ['@kaelio/ktx']);
```

Update the `buildArtifactCommands` test so it expects one public package build
command instead of per-package `pnpm pack` commands:

```javascript
    assert.deepEqual(
      commands.slice(0, NPM_BUILD_PACKAGE_ORDER.length).map((command) => [command.command, command.args]),
      NPM_BUILD_PACKAGE_ORDER.map((packageName) => ['pnpm', ['--filter', packageName, 'run', 'build']]),
    );
    assert.deepEqual(
      commands.slice(NPM_BUILD_PACKAGE_ORDER.length, NPM_BUILD_PACKAGE_ORDER.length + 3).map((command) => [
        command.command,
        command.args,
      ]),
      [
        [process.execPath, ['scripts/build-python-runtime-wheel.mjs']],
        ['uv', ['build', '--package', 'ktx-sl', '--out-dir', '/repo/ktx/dist/artifacts/python']],
        ['uv', ['build', '--package', 'ktx-daemon', '--out-dir', '/repo/ktx/dist/artifacts/python']],
      ],
    );
    assert.deepEqual(commands.slice(NPM_BUILD_PACKAGE_ORDER.length + 3).map((command) => [command.command, command.args]), [
      [process.execPath, ['scripts/build-public-npm-package.mjs']],
    ]);
```

In the `packageReleaseMetadata` test, replace the expected npm metadata entries
with:

```javascript
        {
          ecosystem: 'npm',
          packageName: '@kaelio/ktx',
          packageRoot: 'packages/cli',
          packageVersion: '0.0.0-private',
          private: false,
          releaseMode: 'ci-artifact-only',
        },
```

In the artifact manifest test, replace the npm package expectations with:

```javascript
        [
          {
            ecosystem: 'npm',
            packageName: '@kaelio/ktx',
            packageRoot: 'packages/cli',
            packageVersion: '0.0.0-private',
            private: false,
            releaseMode: 'ci-artifact-only',
          },
        ],
```

Also replace the expected npm file entries with:

```javascript
        [
          {
            artifactKind: 'tarball',
            ecosystem: 'npm',
            packageName: '@kaelio/ktx',
            packageVersion: '0.0.0-private',
            path: 'npm/kaelio-ktx-0.0.0-private.tgz',
          },
        ],
```

- [ ] **Step 2: Run failing artifact tests**

Run:

```bash
node --test scripts/package-artifacts.test.mjs
```

Expected: FAIL because `INTERNAL_NPM_WORKSPACE_PACKAGES` is missing and the
artifact layout still points at `@ktx/cli`.

- [ ] **Step 3: Wire `scripts/package-artifacts.mjs` to the public builder**

In `scripts/package-artifacts.mjs`, add this import after the runtime wheel
import:

```javascript
import {
  PUBLIC_NPM_PACKAGE_NAME,
  PUBLIC_NPM_PACKAGE_TARBALL,
} from './build-public-npm-package.mjs';
```

Replace the `NPM_ARTIFACT_PACKAGES` declaration with:

```javascript
export const INTERNAL_NPM_WORKSPACE_PACKAGES = [
  { name: '@ktx/context', packageRoot: 'packages/context' },
  { name: '@ktx/llm', packageRoot: 'packages/llm' },
  { name: '@ktx/connector-bigquery', packageRoot: 'packages/connector-bigquery' },
  { name: '@ktx/connector-clickhouse', packageRoot: 'packages/connector-clickhouse' },
  { name: '@ktx/connector-mysql', packageRoot: 'packages/connector-mysql' },
  { name: '@ktx/connector-postgres', packageRoot: 'packages/connector-postgres' },
  { name: '@ktx/connector-posthog', packageRoot: 'packages/connector-posthog' },
  { name: '@ktx/connector-snowflake', packageRoot: 'packages/connector-snowflake' },
  { name: '@ktx/connector-sqlite', packageRoot: 'packages/connector-sqlite' },
  { name: '@ktx/connector-sqlserver', packageRoot: 'packages/connector-sqlserver' },
  { name: '@ktx/cli', packageRoot: 'packages/cli' },
];

export const NPM_ARTIFACT_PACKAGES = [{ name: PUBLIC_NPM_PACKAGE_NAME, packageRoot: 'packages/cli' }];
```

Replace the `CONNECTOR_PACKAGE_NAMES` calculation with:

```javascript
const CONNECTOR_PACKAGE_NAMES = INTERNAL_NPM_WORKSPACE_PACKAGES
  .map((packageInfo) => packageInfo.name)
  .filter((packageName) => packageName.startsWith('@ktx/connector-'));
```

Replace `npmPackageTarballName` with:

```javascript
function npmPackageTarballName(packageName) {
  if (packageName === PUBLIC_NPM_PACKAGE_NAME) {
    return PUBLIC_NPM_PACKAGE_TARBALL;
  }
  return `${packageName.replace('@ktx/', 'ktx-')}-${PACKAGE_VERSION}.tgz`;
}
```

In `packageArtifactLayout`, keep `contextTarball` for compatibility but make
`cliTarball` point at the public package:

```javascript
    contextTarball: npmTarballs[PUBLIC_NPM_PACKAGE_NAME],
    cliTarball: npmTarballs[PUBLIC_NPM_PACKAGE_NAME],
```

In `buildArtifactCommands`, replace `packagesByName` and `npmBuildCommands`
with:

```javascript
  const packagesByName = new Map(INTERNAL_NPM_WORKSPACE_PACKAGES.map((packageInfo) => [packageInfo.name, packageInfo]));
  const npmBuildCommands = NPM_ARTIFACT_BUILD_ORDER.map((packageName) => {
```

Replace `npmPackCommands` and the final returned pack commands with the public
builder command:

```javascript
  const publicPackageCommand = {
    command: process.execPath,
    args: ['scripts/build-public-npm-package.mjs'],
    cwd: layout.rootDir,
  };
```

Return:

```javascript
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
    publicPackageCommand,
  ];
```

Replace `readNpmPackageMetadata` with:

```javascript
async function readNpmPackageMetadata(rootDir, packageInfo) {
  const packageJson = await readJson(join(rootDir, packageInfo.packageRoot, 'package.json'));
  const expectedSourceName = packageInfo.name === PUBLIC_NPM_PACKAGE_NAME ? '@ktx/cli' : packageInfo.name;
  if (packageJson.name !== expectedSourceName) {
    throw new Error(
      `Unexpected package name in ${packageInfo.packageRoot}/package.json: expected ${expectedSourceName}, got ${packageJson.name}`,
    );
  }
  return releaseMetadataEntry({
    ecosystem: 'npm',
    packageName: packageInfo.name,
    packageRoot: packageInfo.packageRoot,
    packageVersion: packageJson.version,
    privatePackage: packageInfo.name === PUBLIC_NPM_PACKAGE_NAME ? false : packageJson.private === true,
  });
}
```

In `buildArtifacts`, replace the command-slicing counters with:

```javascript
  const npmBuildCount = NPM_ARTIFACT_BUILD_ORDER.length;
  const npmPackStart = commands.length - 1;
```

Keep the existing three loops after those counters. This makes the first loop
build all internal workspace packages, the second loop build and copy Python
runtime artifacts, and the final loop run only
`scripts/build-public-npm-package.mjs`.

- [ ] **Step 4: Update release policy for one npm package**

Replace the `release-policy.json` `npm.packages` value with:

```json
["@kaelio/ktx"]
```

Replace `publishedPackageSmoke.packageName` with:

```json
"@kaelio/ktx"
```

Replace `requiredBeforePublishing` with:

```json
[
  "Choose public release version.",
  "Configure registry credentials outside source control.",
  "Choose release tag and provenance policy."
]
```

- [ ] **Step 5: Allow one public npm artifact while publishing remains disabled**

In `scripts/release-readiness.mjs`, replace the npm portion of
`assertNonPublishingArtifactPolicy` with:

```javascript
    if (entry.ecosystem === 'npm') {
      const isPublicKtxPackage = entry.packageName === '@kaelio/ktx';
      if (isPublicKtxPackage) {
        if (entry.private !== false) {
          throw new Error(`${policyLabel} npm package @kaelio/ktx must be publishable when npm.publish is false`);
        }
      } else if (entry.private !== true) {
        throw new Error(`${policyLabel} npm package ${entry.packageName} must remain private`);
      }
      if (!entry.packageVersion.endsWith('-private')) {
        throw new Error(`${policyLabel} npm package ${entry.packageName} must use a private version suffix`);
      }
    }
```

In `scripts/release-readiness.test.mjs`, update the import from
`./package-artifacts.mjs` so it includes `INTERNAL_NPM_WORKSPACE_PACKAGES`:

```javascript
import {
  INTERNAL_NPM_WORKSPACE_PACKAGES,
  NPM_ARTIFACT_PACKAGES,
  packageArtifactLayout,
  writeArtifactManifest,
} from './package-artifacts.mjs';
```

Replace `writeReleaseMetadataInputs` with:

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

  await mkdir(join(root, 'python', 'ktx-sl'), { recursive: true });
  await mkdir(join(root, 'python', 'ktx-daemon'), { recursive: true });

  await writeFile(
    join(root, 'python', 'ktx-sl', 'pyproject.toml'),
    ['[project]', 'name = "ktx-sl"', 'version = "0.1.0"', ''].join('\n'),
  );
  await writeFile(
    join(root, 'python', 'ktx-daemon', 'pyproject.toml'),
    ['[project]', 'name = "ktx-daemon"', 'version = "0.1.0"', ''].join('\n'),
  );
}
```

Update `releasePolicy()` so `npm.packages` defaults to:

```javascript
packages: ['@kaelio/ktx'],
```

Update expected `packageNames` arrays so the npm section is only:

```javascript
'@kaelio/ktx',
```

Update published smoke fixture package names from `@ktx/cli-public` to
`@kaelio/ktx`.

Replace the stale public-npm rejection test with this policy mismatch test:

```javascript
  it('rejects release policy that still lists internal npm packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-stale-internal-npm-policy-test-'));
    try {
      await writeReadyFixture(root, {
        policy: releasePolicy({
          npm: {
            packages: ['@kaelio/ktx', '@ktx/context'],
          },
        }),
      });

      await assert.rejects(
        () => releaseReadinessReport(root),
        /Release policy npm\.packages mismatch/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 6: Verify artifact and release readiness tests**

Run:

```bash
node --test scripts/build-public-npm-package.test.mjs scripts/package-artifacts.test.mjs scripts/release-readiness.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs scripts/release-readiness.mjs scripts/release-readiness.test.mjs release-policy.json
git commit -m "feat: release one public kaelio ktx npm artifact"
```

### Task 4: Add public package invocation smoke coverage

**Files:**

- Modify: `scripts/published-package-smoke-config.mjs`
- Modify: `scripts/published-package-smoke.mjs`
- Modify: `scripts/published-package-smoke.test.mjs`
- Modify: `scripts/package-artifacts.mjs`
- Modify: `scripts/package-artifacts.test.mjs`

- [ ] **Step 1: Add failing published smoke command expectations**

In `scripts/published-package-smoke.test.mjs`, change all fixture package names
from `@ktx/cli-public`, `@ktx/cli-from-env`, and `@ktx/cli-from-policy` to
`@kaelio/ktx`.

In the `builds the full hybrid-search smoke command list` test, replace the
expected command list with:

```javascript
    assert.deepEqual(buildPublishedPackageSmokeCommands(config, '/tmp/ktx-smoke/demo', '/tmp/ktx-smoke/empty'), [
      {
        label: 'published package version',
        command: 'npx',
        args: ['--yes', '@kaelio/ktx@latest', '--version'],
        env: { npm_config_registry: 'https://registry.npmjs.org/' },
      },
      {
        label: 'published package setup demo',
        command: 'npx',
        args: [
          '--yes',
          '@kaelio/ktx@latest',
          'setup',
          'demo',
          '--project-dir',
          '/tmp/ktx-smoke/demo',
          '--no-input',
          '--plain',
        ],
        env: { npm_config_registry: 'https://registry.npmjs.org/' },
      },
      {
        label: 'published package sl query',
        command: 'npx',
        args: [
          '--yes',
          '@kaelio/ktx@latest',
          'sl',
          'query',
          '--project-dir',
          '/tmp/ktx-smoke/demo',
          '--connection-id',
          'orbit_demo',
          '--measure',
          'contracts.contract_count',
          '--format',
          'sql',
          '--yes',
        ],
        env: { npm_config_registry: 'https://registry.npmjs.org/' },
      },
      {
        label: 'published package local install',
        command: 'pnpm',
        args: ['add', '@kaelio/ktx@latest'],
        env: { npm_config_registry: 'https://registry.npmjs.org/' },
      },
      {
        label: 'published package local binary',
        command: 'pnpm',
        args: ['exec', 'ktx', '--version'],
        env: { npm_config_registry: 'https://registry.npmjs.org/' },
      },
      {
        label: 'published package global install',
        command: 'pnpm',
        args: ['add', '--global', '@kaelio/ktx@latest'],
        env: { npm_config_registry: 'https://registry.npmjs.org/' },
      },
      {
        label: 'published package global binary',
        command: 'ktx',
        args: ['--version'],
        env: { npm_config_registry: 'https://registry.npmjs.org/' },
      },
    ]);
```

- [ ] **Step 2: Run failing published smoke tests**

Run:

```bash
node --test scripts/published-package-smoke.test.mjs
```

Expected: FAIL because the command list still contains the old hybrid-search
commands and package names.

- [ ] **Step 3: Update published package smoke commands**

In `scripts/published-package-smoke-config.mjs`, replace
`buildPublishedPackageSmokeCommands` with:

```javascript
export function buildPublishedPackageSmokeCommands(config, projectDir) {
  return [
    buildPublishedPackageNpxCommand(config, ['--version'], 'published package version'),
    buildPublishedPackageNpxCommand(
      config,
      ['setup', 'demo', '--project-dir', projectDir, '--no-input', '--plain'],
      'published package setup demo',
    ),
    buildPublishedPackageNpxCommand(
      config,
      [
        'sl',
        'query',
        '--project-dir',
        projectDir,
        '--connection-id',
        'orbit_demo',
        '--measure',
        'contracts.contract_count',
        '--format',
        'sql',
        '--yes',
      ],
      'published package sl query',
    ),
    {
      label: 'published package local install',
      command: 'pnpm',
      args: ['add', publishedPackageSpec(config)],
      env: config.registry ? { npm_config_registry: config.registry } : {},
    },
    {
      label: 'published package local binary',
      command: 'pnpm',
      args: ['exec', 'ktx', '--version'],
      env: config.registry ? { npm_config_registry: config.registry } : {},
    },
    {
      label: 'published package global install',
      command: 'pnpm',
      args: ['add', '--global', publishedPackageSpec(config)],
      env: config.registry ? { npm_config_registry: config.registry } : {},
    },
    {
      label: 'published package global binary',
      command: 'ktx',
      args: ['--version'],
      env: config.registry ? { npm_config_registry: config.registry } : {},
    },
  ];
}
```

In `scripts/published-package-smoke.mjs`, replace the command execution loop in
`runPublishedPackageSmoke` with:

```javascript
    const commands = buildPublishedPackageSmokeCommands(config, projectDir, emptyProjectDir);
    const pnpmHome = join(root, 'pnpm-home');
    const globalEnv = {
      PNPM_HOME: pnpmHome,
      PATH: `${pnpmHome}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    };
    for (const command of commands) {
      const isGlobalCommand = command.label.includes('global');
      const result = await runCommand(command.command, command.args, {
        cwd: command.label.includes('local') || isGlobalCommand ? root : undefined,
        env: isGlobalCommand ? { ...globalEnv, ...command.env } : command.env,
      });
      requireSuccess(command.label, result);
      if (
        command.label === 'published package version' ||
        command.label === 'published package local binary' ||
        command.label === 'published package global binary'
      ) {
        assert.match(result.stdout, /@kaelio\/ktx /);
      }
      if (command.label === 'published package sl query') {
        assert.match(result.stdout, /SELECT/i);
        assert.match(result.stdout, /contracts/i);
      }
    }

    process.stdout.write('published package invocation smoke verified\n');
```

Remove `assertHybridWikiSearch`, `assertHybridSlSearch`, and
`assertMissingProjectReadiness` if they are no longer used.

- [ ] **Step 4: Add local tarball public package smoke to artifact verification**

In `scripts/package-artifacts.mjs`, replace `npmSmokePackageJson(layout)` with:

```javascript
export function npmSmokePackageJson(layout) {
  return {
    name: 'ktx-artifact-npm-smoke',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      '@kaelio/ktx': `file:${layout.cliTarball}`,
    },
    pnpm: {
      onlyBuiltDependencies: ['better-sqlite3'],
    },
  };
}
```

Replace the top of `npmVerifySource()` with this smaller public-package check:

```javascript
export function npmVerifySource() {
  return `
const cli = await import('@kaelio/ktx');

if (cli.getKtxCliPackageInfo().name !== '@kaelio/ktx') {
  throw new Error('Unexpected @kaelio/ktx package info');
}
if (typeof cli.runKtxCli !== 'function') {
  throw new Error('Missing runKtxCli export');
}
`;
}
```

In `npmRuntimeSmokeSource()`, add this assertion after `const root = ...`:

```javascript
const version = await run('pnpm', ['exec', 'ktx', '--version']);
requireSuccess('ktx public package version', version);
requireOutput('ktx public package version', version, /@kaelio\\/ktx 0\\.0\\.0-private/);
```

In `npmRuntimeSmokeSource()`, remove these direct imports because the smoke
project no longer installs internal workspace packages directly:

```javascript
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  createDaemonLookerTableIdentifierParser,
  LocalLookerRuntimeStore,
} from '@ktx/context/ingest';
```

Replace them with:

```javascript
import { execFile } from 'node:child_process';
```

Still inside `npmRuntimeSmokeSource()`, delete these helper functions because
the public tarball smoke must exercise the CLI-managed runtime instead of
manually wiring an internal daemon:

```javascript
function requireToolNames(tools, expectedNames) {
  const names = tools.tools.map((tool) => tool.name).sort();
  for (const expectedName of expectedNames) {
    assert.ok(names.includes(expectedName), 'MCP tool list did not include ' + expectedName + ': ' + names.join(', '));
  }
}

function structuredContent(result) {
  assert.ok(result.structuredContent, 'MCP result did not include structuredContent');
  return result.structuredContent;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAvailablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('expected TCP server address for daemon smoke');
  }
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

function httpGetOk(url) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'GET' }, (response) => {
      response.resume();
      response.on('end', () => resolve((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300));
    });
    request.on('error', reject);
    request.end();
  });
}

function spawnLogged(command, args, options = {}) {
  const stdout = [];
  const stderr = [];
  let spawnError;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('error', (error) => {
    spawnError = error;
  });
  return {
    child,
    error() {
      return spawnError;
    },
    output() {
      return {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
    },
  };
}

async function waitForHttpHealth(url, daemon) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (daemon.error()) {
      const output = daemon.output();
      throw new Error(
        'Failed to start ktx-daemon serve-http: ' +
          daemon.error().message +
          '\nstdout:\n' +
          output.stdout +
          '\nstderr:\n' +
          output.stderr,
      );
    }
    if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
      const output = daemon.output();
      throw new Error(
        'ktx-daemon serve-http exited before health check passed\nstdout:\n' +
          output.stdout +
          '\nstderr:\n' +
          output.stderr,
      );
    }
    try {
      if (await httpGetOk(url)) {
        return;
      }
    } catch {
      await sleep(100);
      continue;
    }
    await sleep(100);
  }
  const output = daemon.output();
  throw new Error('Timed out waiting for ' + url + '\nstdout:\n' + output.stdout + '\nstderr:\n' + output.stderr);
}

async function startSemanticDaemon(port) {
  const daemon = spawnLogged('ktx-daemon', [
    'serve-http',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--log-level',
    'warning',
  ]);
  await waitForHttpHealth('http://127.0.0.1:' + port + '/health', daemon);
  return daemon;
}

async function stopSemanticDaemon(daemon) {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
    return;
  }
  daemon.child.kill('SIGTERM');
  const closed = once(daemon.child, 'close').then(() => true);
  const timedOut = sleep(5_000).then(() => false);
  if (!(await Promise.race([closed, timedOut]))) {
    daemon.child.kill('SIGKILL');
    await once(daemon.child, 'close');
  }
}
```

Replace both `ktx agent sl query` smoke commands with top-level `ktx sl query`
commands so the installed public tarball verifies the managed Python runtime
path:

```javascript
  const slQuery = await run('pnpm', ['exec', 'ktx', 'sl', 'query',
    '--connection-id',
    'warehouse',
    '--measure',
    'orders.order_count',
    '--format',
    'json',
    '--yes',
    '--project-dir',
    projectDir,
  ]);
  requireSuccess('ktx sl query', slQuery);
  requireOutput('ktx sl query', slQuery, /"mode": "compile_only"/);
  requireOutput('ktx sl query', slQuery, /orders/);

  const sqliteSlQuery = await run('pnpm', ['exec', 'ktx', 'sl', 'query',
    '--connection-id',
    'warehouse',
    '--measure',
    'orders.order_count',
    '--format',
    'json',
    '--execute',
    '--max-rows',
    '100',
    '--yes',
    '--project-dir',
    projectDir,
  ]);
  requireSuccess('ktx sl query sqlite execute', sqliteSlQuery);
  requireOutput('ktx sl query sqlite execute', sqliteSlQuery, /"dialect": "sqlite"/);
  requireOutput('ktx sl query sqlite execute', sqliteSlQuery, /"mode": "executed"/);
  requireOutput('ktx sl query sqlite execute', sqliteSlQuery, /"driver": "sqlite"/);
  requireOutput('ktx sl query sqlite execute', sqliteSlQuery, /"rows": \\[\\s*\\[\\s*3\\s*\\]\\s*\\]/);
  process.stdout.write('ktx sl query sqlite execute verified\n');
```

In `npmRuntimeSmokeSource()`, delete the MCP smoke block that starts with:

```javascript
  const daemonPort = await getAvailablePort();
```

and ends after this cleanup block:

```javascript
  } finally {
    await client.close();
    await stopSemanticDaemon(daemon);
  }
```

In `npmDemoSmokeSource()`, keep the existing `pnpm exec ktx` flow. Add an
assertion that the public package is the only direct dependency:

```javascript
      assert.deepEqual(Object.keys(packageJson.dependencies), ['@kaelio/ktx']);
```

- [ ] **Step 5: Update artifact smoke tests**

In `scripts/package-artifacts.test.mjs`, update the
`npmSmokePackageJson` expectations so they assert:

```javascript
    assert.deepEqual(npmSmokePackageJson(layout).dependencies, {
      '@kaelio/ktx': `file:${layout.cliTarball}`,
    });
```

Replace installed export assertions that import `@ktx/context`, `@ktx/llm`, or
connector packages with these assertions:

```javascript
    assert.match(verifySource, /const cli = await import\('@kaelio\/ktx'\);/);
    assert.match(verifySource, /getKtxCliPackageInfo/);
    assert.match(verifySource, /runKtxCli/);
    assert.doesNotMatch(verifySource, /@ktx\/context/);
    assert.doesNotMatch(verifySource, /@ktx\/llm/);
    assert.doesNotMatch(verifySource, /@ktx\/connector-/);
```

Add runtime smoke assertions:

```javascript
    assert.match(runtimeSource, /ktx public package version/);
    assert.match(runtimeSource, /@kaelio\\\\\/ktx 0\\\\.0\\\\.0-private/);
    assert.match(runtimeSource, /'ktx', 'sl', 'query'/);
    assert.doesNotMatch(runtimeSource, /@ktx\/context/);
    assert.doesNotMatch(runtimeSource, /@modelcontextprotocol/);
    assert.doesNotMatch(runtimeSource, /startSemanticDaemon/);
```

- [ ] **Step 6: Verify smoke command tests**

Run:

```bash
node --test scripts/published-package-smoke.test.mjs scripts/package-artifacts.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add scripts/published-package-smoke-config.mjs scripts/published-package-smoke.mjs scripts/published-package-smoke.test.mjs scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs
git commit -m "test: cover public kaelio ktx package invocations"
```

### Task 5: Run focused verification and artifact smoke

**Files:**

- Verify: `scripts/build-public-npm-package.mjs`
- Verify: `scripts/package-artifacts.mjs`
- Verify: `scripts/published-package-smoke.mjs`
- Verify: `scripts/release-readiness.mjs`
- Verify: `packages/cli/src/cli-runtime.ts`

- [ ] **Step 1: Run script unit tests**

Run:

```bash
node --test scripts/build-public-npm-package.test.mjs scripts/package-artifacts.test.mjs scripts/published-package-smoke.test.mjs scripts/release-readiness.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run CLI package tests touched by metadata changes**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/index.test.ts
```

Expected: PASS.

- [ ] **Step 3: Build artifacts from source**

Run:

```bash
pnpm run artifacts:build
```

Expected: PASS and create:

```text
dist/artifacts/npm/kaelio-ktx-0.0.0-private.tgz
dist/artifacts/python/kaelio_ktx-0.1.0-py3-none-any.whl
dist/artifacts/manifest.json
```

- [ ] **Step 4: Verify artifact manifest**

Run:

```bash
pnpm run artifacts:verify-manifest
```

Expected: PASS.

- [ ] **Step 5: Verify installed public tarball smoke**

Run:

```bash
pnpm run artifacts:verify
```

Expected: PASS. The installed npm smoke must install only
`@kaelio/ktx` directly and must not require direct `@ktx/*` dependencies in the
smoke project.

- [ ] **Step 6: Run release readiness**

Run:

```bash
pnpm run release:readiness
```

Expected: PASS. The report must list `@kaelio/ktx` as the only npm package and
must still state that registry publishing remains disabled by
`release-policy.json`.

- [ ] **Step 7: Run pre-commit for changed files**

Run:

```bash
source .venv/bin/activate && uv run pre-commit run --files packages/cli/src/cli-runtime.ts packages/cli/src/index.ts packages/cli/src/index.test.ts scripts/build-public-npm-package.mjs scripts/build-public-npm-package.test.mjs scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs scripts/published-package-smoke-config.mjs scripts/published-package-smoke.mjs scripts/published-package-smoke.test.mjs scripts/release-readiness.mjs scripts/release-readiness.test.mjs release-policy.json
```

Expected: PASS. If pre-commit is unavailable because hook tooling is missing,
run these fallback checks:

```bash
node --test scripts/build-public-npm-package.test.mjs scripts/package-artifacts.test.mjs scripts/published-package-smoke.test.mjs scripts/release-readiness.test.mjs
pnpm --filter @ktx/cli run type-check
pnpm --filter @ktx/cli run test -- src/index.test.ts
```

- [ ] **Step 8: Commit verification fixes**

If verification required fixes, commit only the changed files from this plan:

```bash
git status --short
git add packages/cli/src/cli-runtime.ts packages/cli/src/index.ts packages/cli/src/index.test.ts scripts/build-public-npm-package.mjs scripts/build-public-npm-package.test.mjs scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs scripts/published-package-smoke-config.mjs scripts/published-package-smoke.mjs scripts/published-package-smoke.test.mjs scripts/release-readiness.mjs scripts/release-readiness.test.mjs release-policy.json
git commit -m "chore: verify public kaelio ktx package artifacts"
```

## Self-review notes

- Spec coverage: this plan implements the `@kaelio/ktx` npm package name, one
  visible `ktx` binary, bundled JavaScript CLI output, packaged demo assets,
  bundled Python runtime wheel assets, and smoke coverage for the required
  public invocation modes.
- Remaining after this plan: managed runtime use in deeper Python-backed
  paths, such as MCP `serve` defaults and Looker table identifier parsing,
  still needs a separate plan if those paths must stop accepting externally
  supplied daemon URLs.
- Placeholder scan: this plan uses exact paths, exact commands, concrete code
  blocks, and no deferred implementation markers.
- Type consistency: public npm package names are consistently `@kaelio/ktx`;
  internal workspace package names remain `@ktx/*`.
