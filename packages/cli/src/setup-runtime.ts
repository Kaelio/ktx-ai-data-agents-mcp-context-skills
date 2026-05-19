import {
  loadKtxProject,
  markKtxSetupStateStepComplete,
  type KtxLocalProject,
} from '@ktx/context/project';
import type { KtxCliIo } from './cli-runtime.js';
import {
  ensureManagedLocalEmbeddingsDaemon,
  type ManagedLocalEmbeddingsDaemon,
} from './managed-local-embeddings.js';
import {
  ensureManagedPythonCommandRuntime,
  type KtxManagedPythonInstallPolicy,
  type ManagedPythonCommandRuntime,
} from './managed-python-command.js';
import type { KtxRuntimeFeature } from './managed-python-runtime.js';
import {
  resolveProjectRuntimeRequirements,
  type KtxRuntimeRequirements,
} from './runtime-requirements.js';

export interface KtxSetupRuntimeArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  cliVersion: string;
  runtimeInstallPolicy: KtxManagedPythonInstallPolicy;
  databaseIntrospectionFallback?: boolean;
}

export type KtxSetupRuntimeResult =
  | { status: 'ready'; projectDir: string; requirements: KtxRuntimeRequirements }
  | { status: 'skipped'; projectDir: string; requirements: KtxRuntimeRequirements }
  | { status: 'failed'; projectDir: string; requirements: KtxRuntimeRequirements };

export interface KtxSetupRuntimeDeps {
  env?: NodeJS.ProcessEnv;
  loadProject?: (options: { projectDir: string }) => Promise<Pick<KtxLocalProject, 'config'>>;
  ensureRuntime?: (options: {
    cliVersion: string;
    installPolicy: KtxManagedPythonInstallPolicy;
    io: KtxCliIo;
    feature: KtxRuntimeFeature;
  }) => Promise<ManagedPythonCommandRuntime>;
  ensureLocalEmbeddings?: (options: {
    cliVersion: string;
    projectDir: string;
    installPolicy: KtxManagedPythonInstallPolicy;
    io: KtxCliIo;
  }) => Promise<ManagedLocalEmbeddingsDaemon>;
}

function formatRuntimeFeature(feature: KtxRuntimeFeature): string {
  return feature === 'local-embeddings' ? 'local embeddings' : 'core';
}

export async function runKtxSetupRuntimeStep(
  args: KtxSetupRuntimeArgs,
  io: KtxCliIo,
  deps: KtxSetupRuntimeDeps = {},
): Promise<KtxSetupRuntimeResult> {
  const loadProjectForRuntime = deps.loadProject ?? loadKtxProject;
  const project = await loadProjectForRuntime({ projectDir: args.projectDir });
  const requirements = resolveProjectRuntimeRequirements(project.config, {
    databaseIntrospectionFallback: args.databaseIntrospectionFallback,
    env: deps.env ?? process.env,
  });

  if (requirements.features.length === 0) {
    io.stdout.write('│  Runtime setup skipped.\n');
    return { status: 'skipped', projectDir: args.projectDir, requirements };
  }

  const ensureRuntime = deps.ensureRuntime ?? ensureManagedPythonCommandRuntime;
  const ensureLocalEmbeddings = deps.ensureLocalEmbeddings ?? ensureManagedLocalEmbeddingsDaemon;
  try {
    for (const feature of requirements.features) {
      if (feature === 'local-embeddings') {
        await ensureLocalEmbeddings({
          cliVersion: args.cliVersion,
          projectDir: args.projectDir,
          installPolicy: args.runtimeInstallPolicy,
          io,
        });
        continue;
      }
      await ensureRuntime({
        cliVersion: args.cliVersion,
        installPolicy: args.runtimeInstallPolicy,
        io,
        feature,
      });
    }
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { status: 'failed', projectDir: args.projectDir, requirements };
  }

  await markKtxSetupStateStepComplete(args.projectDir, 'runtime');
  io.stdout.write(`│  Runtime ready: yes (${requirements.features.map(formatRuntimeFeature).join(', ')})\n`);
  return { status: 'ready', projectDir: args.projectDir, requirements };
}
