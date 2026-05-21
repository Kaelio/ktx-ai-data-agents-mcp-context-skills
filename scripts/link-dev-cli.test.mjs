import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkDevCli } from './link-dev-cli.mjs';

test('linkDevCli writes a ktx-dev launcher by default', async () => {
  const writes = [];
  const chmods = [];

  const result = await linkDevCli({
    rootDir: '/workspace/ktx',
    globalBin: '/pnpm/bin',
    binPath: '/workspace/ktx/packages/cli/dist/bin.js',
    execText: async (command, args) => {
      assert.equal(command, 'ktx-dev');
      assert.deepEqual(args, ['--version']);
      return '@kaelio/ktx 0.0.0-private';
    },
    writeFile: async (path, content) => writes.push({ path, content }),
    chmod: async (path, mode) => chmods.push({ path, mode }),
    access: async () => undefined,
  });

  assert.equal(result.binaryName, 'ktx-dev');
  assert.equal(writes[0].path, '/pnpm/bin/ktx-dev');
  assert.match(writes[0].content, /packages\/cli\/dist\/bin.js/);
  assert.deepEqual(chmods, [{ path: '/pnpm/bin/ktx-dev', mode: 0o755 }]);
});

test('linkDevCli can explicitly write ktx when requested', async () => {
  const writes = [];

  const result = await linkDevCli({
    rootDir: '/workspace/ktx',
    binaryName: 'ktx',
    globalBin: '/pnpm/bin',
    binPath: '/workspace/ktx/packages/cli/dist/bin.js',
    execText: async () => '@kaelio/ktx 0.0.0-private',
    writeFile: async (path, content) => writes.push({ path, content }),
    chmod: async () => undefined,
    access: async () => undefined,
  });

  assert.equal(result.binaryName, 'ktx');
  assert.equal(writes[0].path, '/pnpm/bin/ktx');
});
