import { createPythonSemanticLayerComputePort, type KtxSemanticLayerComputePort } from '@ktx/context/daemon';
import type { KtxCliIo } from './cli-runtime.js';
import { createClackPromptAdapter } from './clack.js';
import {
  installManagedPythonRuntime,
  readManagedPythonRuntimeStatus,
  type InstalledKtxRuntimeManifest,
  type KtxRuntimeFeature,
  type ManagedPythonRuntimeInstallOptions,
  type ManagedPythonRuntimeInstallResult,
  type ManagedPythonRuntimeLayout,
  type ManagedPythonRuntimeLayoutOptions,
  type ManagedPythonRuntimeStatus,
} from './managed-python-runtime.js';

export type KtxManagedPythonInstallPolicy = 'prompt' | 'auto' | 'never';

export function runtimeInstallPolicyFromFlags(options: {
  yes?: boolean;
  input?: boolean;
}): KtxManagedPythonInstallPolicy {
  if (options.yes === true && options.input === false) {
    throw new Error('Choose only one runtime install mode: --yes or --no-input');
  }
  if (options.yes === true) {
    return 'auto';
  }
  return options.input === false ? 'never' : 'prompt';
}

export interface ManagedPythonCommandRuntime {
  layout: ManagedPythonRuntimeLayout;
  manifest: InstalledKtxRuntimeManifest;
}

export interface ManagedPythonCommandDeps {
  readStatus?: (options: ManagedPythonRuntimeLayoutOptions) => Promise<ManagedPythonRuntimeStatus>;
  installRuntime?: (options: ManagedPythonRuntimeInstallOptions) => Promise<ManagedPythonRuntimeInstallResult>;
  confirmInstall?: (message: string, io: KtxCliIo) => Promise<boolean>;
}

export interface ManagedPythonCommandOptions extends ManagedPythonCommandDeps {
  cliVersion: string;
  installPolicy: KtxManagedPythonInstallPolicy;
  io: KtxCliIo;
  feature?: KtxRuntimeFeature;
}

export interface ManagedPythonSemanticLayerComputeOptions extends ManagedPythonCommandOptions {
  createPythonCompute?: typeof createPythonSemanticLayerComputePort;
}

export function managedRuntimeInstallCommand(feature: KtxRuntimeFeature): string {
  return feature === 'local-embeddings'
    ? 'ktx runtime install --feature local-embeddings --yes'
    : 'ktx runtime install --yes';
}

function installPrompt(feature: KtxRuntimeFeature): string {
  const label = feature === 'local-embeddings' ? 'local embeddings Python runtime' : 'core Python runtime';
  return `KTX needs to install the ${label}. This downloads Python dependencies with uv. Continue?`;
}

function runtimeRequiredMessage(feature: KtxRuntimeFeature): string {
  return `KTX Python runtime is required for this command. Run: ${managedRuntimeInstallCommand(feature)}`;
}

function hasFeature(manifest: InstalledKtxRuntimeManifest, feature: KtxRuntimeFeature): boolean {
  return manifest.features.includes(feature);
}

async function defaultConfirmInstall(message: string, io: KtxCliIo): Promise<boolean> {
  if (io.stdout.isTTY !== true) {
    return false;
  }
  const prompts = createClackPromptAdapter();
  return await prompts.confirm({ message, initialValue: true });
}

export async function ensureManagedPythonCommandRuntime(
  options: ManagedPythonCommandOptions,
): Promise<ManagedPythonCommandRuntime> {
  const feature = options.feature ?? 'core';
  const readStatus = options.readStatus ?? readManagedPythonRuntimeStatus;
  const installRuntime = options.installRuntime ?? installManagedPythonRuntime;
  const status = await readStatus({ cliVersion: options.cliVersion });

  if (status.kind === 'ready' && status.manifest && hasFeature(status.manifest, feature)) {
    return { layout: status.layout, manifest: status.manifest };
  }

  if (options.installPolicy === 'never') {
    throw new Error(runtimeRequiredMessage(feature));
  }

  if (options.installPolicy === 'prompt') {
    const confirmInstall = options.confirmInstall ?? defaultConfirmInstall;
    const confirmed = await confirmInstall(installPrompt(feature), options.io);
    if (!confirmed) {
      throw new Error(`KTX Python runtime installation was cancelled. Run: ${managedRuntimeInstallCommand(feature)}`);
    }
  }

  options.io.stderr.write(`Installing KTX Python runtime (${feature}) with uv...\n`);
  const installed = await installRuntime({
    cliVersion: options.cliVersion,
    features: [feature],
    force: false,
  });
  options.io.stderr.write(`KTX Python runtime ready: ${installed.layout.versionDir}\n`);
  return { layout: installed.layout, manifest: installed.manifest };
}

export async function createManagedPythonSemanticLayerComputePort(
  options: ManagedPythonSemanticLayerComputeOptions,
): Promise<KtxSemanticLayerComputePort> {
  const runtime = await ensureManagedPythonCommandRuntime({
    cliVersion: options.cliVersion,
    installPolicy: options.installPolicy,
    io: options.io,
    feature: 'core',
    ...(options.readStatus ? { readStatus: options.readStatus } : {}),
    ...(options.installRuntime ? { installRuntime: options.installRuntime } : {}),
    ...(options.confirmInstall ? { confirmInstall: options.confirmInstall } : {}),
  });
  const createPythonCompute = options.createPythonCompute ?? createPythonSemanticLayerComputePort;
  return createPythonCompute({
    command: runtime.manifest.python.daemonExecutable,
    args: [],
  });
}
