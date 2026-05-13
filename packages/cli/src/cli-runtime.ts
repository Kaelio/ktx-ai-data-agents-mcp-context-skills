import { createRequire } from 'node:module';

import type { KtxConnectionArgs } from './connection.js';
import type { KtxDoctorArgs } from './doctor.js';
import type { KtxKnowledgeArgs } from './knowledge.js';
import type { KtxPublicIngestArgs } from './public-ingest.js';
import type { KtxRuntimeArgs } from './runtime.js';
import type { KtxSetupArgs } from './setup.js';
import type { KtxSlArgs } from './sl.js';
import { profileMark, profileSpan } from './startup-profile.js';
import type { KtxTextIngestArgs } from './text-ingest.js';

profileMark('module:cli-runtime');

const requirePackageJson = createRequire(import.meta.url);

export interface KtxCliPackageInfo {
  name: string;
  version: string;
  contextPackageName: '@ktx/context';
}

export interface KtxCliIo {
  stdout: { isTTY?: boolean; columns?: number; write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

export interface KtxCliDeps {
  setup?: (args: KtxSetupArgs, io: KtxCliIo) => Promise<number>;
  connection?: (args: KtxConnectionArgs, io: KtxCliIo) => Promise<number>;
  doctor?: (args: KtxDoctorArgs, io: KtxCliIo) => Promise<number>;
  publicIngest?: (args: KtxPublicIngestArgs, io: KtxCliIo) => Promise<number>;
  textIngest?: (args: KtxTextIngestArgs, io: KtxCliIo) => Promise<number>;
  runtime?: (args: KtxRuntimeArgs, io: KtxCliIo) => Promise<number>;
  knowledge?: (args: KtxKnowledgeArgs, io: KtxCliIo) => Promise<number>;
  sl?: (args: KtxSlArgs, io: KtxCliIo) => Promise<number>;
}

export function getKtxCliPackageInfo(): KtxCliPackageInfo {
  return packageInfoFromJson(requirePackageJson('../package.json'));
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

async function runInit(
  args: { projectDir: string; projectName?: string; force: boolean },
  io: KtxCliIo,
): Promise<number> {
  const { initKtxProject } = await import('@ktx/context/project');
  const result = await initKtxProject({
    projectDir: args.projectDir,
    projectName: args.projectName,
    force: args.force,
  });

  io.stdout.write(`Initialized KTX project at ${result.projectDir}\n`);
  io.stdout.write(`Config: ${result.configPath}\n`);
  io.stdout.write(`Commit: ${result.commitHash ?? 'none'}\n`);
  return 0;
}

export async function runInitForCommander(
  args: { projectDir: string; projectName?: string; force: boolean },
  io: KtxCliIo,
): Promise<number> {
  return await runInit(args, io);
}

export async function runKtxCli(
  argv = process.argv.slice(2),
  io: KtxCliIo = process,
  deps: KtxCliDeps = {},
): Promise<number> {
  const info = getKtxCliPackageInfo();
  profileMark('runtime:runKtxCli');
  const { runCommanderKtxCli } = await profileSpan('import ./cli-program.js', () => import('./cli-program.js'));

  return await runCommanderKtxCli(argv, io, deps, info, {
    runInit: runInitForCommander,
  });
}
