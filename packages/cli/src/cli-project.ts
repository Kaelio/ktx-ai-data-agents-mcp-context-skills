import { loadKtxProject, type KtxLocalProject } from '@ktx/context/project';

export interface LoadKtxCliProjectOptions {
  projectDir: string;
}

export interface LoadKtxCliProjectDeps {
  loadProject?: typeof loadKtxProject;
}

/**
 * Thin wrapper around `loadKtxProject`. Kept as a single entrypoint so the CLI can grow shared
 * pre-load behavior later (telemetry, project lock, etc.). Today it does no extra work.
 */
export async function loadKtxCliProject(
  options: LoadKtxCliProjectOptions,
  deps: LoadKtxCliProjectDeps = {},
): Promise<KtxLocalProject> {
  return (deps.loadProject ?? loadKtxProject)({ projectDir: options.projectDir });
}
