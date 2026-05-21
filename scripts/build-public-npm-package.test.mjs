import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
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
        ai: '^6.0.168',
        commander: '14.0.3',
        yaml: '^2.8.2',
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

}

describe('publicNpmPackageLayout', () => {
  it('uses the public npm release version for the tarball name', () => {
    const layout = publicNpmPackageLayout('/repo/ktx');

    assert.match(PUBLIC_NPM_PACKAGE_VERSION, /^\d+\.\d+\.\d+/);
    assert.equal(publicNpmPackageTarballName(), `kaelio-ktx-${PUBLIC_NPM_PACKAGE_VERSION}.tgz`);
    assert.equal(
      layout.tarballPath,
      `/repo/ktx/dist/artifacts/npm/kaelio-ktx-${PUBLIC_NPM_PACKAGE_VERSION}.tgz`,
    );
  });
});

describe('collectPublicDependencies', () => {
  it('returns CLI external runtime dependencies and omits workspace packages', () => {
    assert.deepEqual(
      collectPublicDependencies({
        name: '@ktx/cli',
        dependencies: {
          '@ktx/internal-only': 'workspace:*',
          commander: '14.0.3',
          zod: '^4.4.3',
        },
      }),
      {
        commander: '14.0.3',
        zod: '^4.4.3',
      },
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
    assert.equal(packageJson.version, PUBLIC_NPM_PACKAGE_VERSION);
    assert.equal(packageJson.private, false);
    assert.deepEqual(packageJson.bin, { ktx: './dist/bin.js' });
    assert.deepEqual(packageJson.dependencies, { commander: '14.0.3' });
    assert.deepEqual(packageJson.files, ['dist', 'assets']);
    assert.deepEqual(packageJson.repository, {
      type: 'git',
      url: 'https://github.com/Kaelio/ktx',
    });
    assert.deepEqual(packageJson.bugs, {
      url: 'https://github.com/Kaelio/ktx/issues',
    });
    assert.equal(packageJson.homepage, 'https://github.com/Kaelio/ktx#readme');
  });
});

describe('createPublicNpmPackageTree', () => {
  it('copies CLI files and assets without bundled internal workspace packages', async () => {
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
      await assert.rejects(
        () => readFile(join(layout.packRoot, 'node_modules', '@ktx', 'context', 'package.json'), 'utf8'),
        /ENOENT/,
      );
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
        `/repo/ktx/dist/artifacts/npm/kaelio-ktx-${PUBLIC_NPM_PACKAGE_VERSION}.tgz`,
      ],
      cwd: '/repo/ktx/dist/public-npm-package',
    });
  });
});
