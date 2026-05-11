import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  PUBLIC_BUNDLED_WORKSPACE_PACKAGES,
  PUBLIC_NPM_PACKAGE_NAME,
  PUBLIC_NPM_PACKAGE_VERSION,
  collectPublicDependencies,
  createPublicNpmPackageTree,
  publicNpmPackageJson,
  publicNpmPackageLayout,
  publicNpmPackageTarballName,
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

  for (const packageName of PUBLIC_BUNDLED_WORKSPACE_PACKAGES.filter((name) => name.startsWith('@ktx/connector-'))) {
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
  it('uses the first public npm release version for the tarball name', () => {
    const layout = publicNpmPackageLayout('/repo/ktx');

    assert.equal(PUBLIC_NPM_PACKAGE_VERSION, '0.1.0-rc.0');
    assert.equal(publicNpmPackageTarballName(), 'kaelio-ktx-0.1.0-rc.0.tgz');
    assert.equal(layout.tarballPath, '/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0-rc.0.tgz');
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
  it('does not bundle the removed PostHog connector package', () => {
    assert.equal(PUBLIC_BUNDLED_WORKSPACE_PACKAGES.includes('@ktx/connector-posthog'), false);
  });

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
    assert.equal(packageJson.version, '0.1.0-rc.0');
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
      args: [
        '--config.node-linker=hoisted',
        'pack',
        '--out',
        '/repo/ktx/dist/artifacts/npm/kaelio-ktx-0.1.0-rc.0.tgz',
      ],
      cwd: '/repo/ktx/dist/public-npm-package',
    });
  });
});
