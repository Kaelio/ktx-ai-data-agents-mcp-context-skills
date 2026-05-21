import { fileURLToPath } from 'node:url';
import { buildKtxProgram } from './cli-program.js';
import type { KtxCliIo, KtxCliPackageInfo } from './cli-runtime.js';
import { formatCommandTree, walkCommandTree } from './command-tree.js';

function silentIo(): KtxCliIo {
  return {
    stdout: { isTTY: false, columns: 80, write: () => {} },
    stderr: { write: () => {} },
  };
}

function stubPackageInfo(): KtxCliPackageInfo {
  return {
    name: '@kaelio/ktx',
    version: '0.0.0-docs',
  };
}

export function renderKtxCommandTree(): string {
  const program = buildKtxProgram({
    io: silentIo(),
    deps: {},
    packageInfo: stubPackageInfo(),
    runInit: async () => 0,
  });
  return formatCommandTree(walkCommandTree(program));
}

export function main(stdout: { write(chunk: string): void }): void {
  stdout.write(renderKtxCommandTree());
}

const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsScript) {
  main(process.stdout);
}
