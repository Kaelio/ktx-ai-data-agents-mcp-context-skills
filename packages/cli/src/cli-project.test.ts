import { describe, expect, it, vi } from 'vitest';
import { buildDefaultKtxProjectConfig, type KtxLocalProject, type KtxProjectConfig } from '@ktx/context/project';
import { loadKtxCliProject } from './cli-project.js';

function projectWithConfig(config: KtxProjectConfig): KtxLocalProject {
  return {
    projectDir: '/work/proj',
    configPath: '/work/proj/ktx.yaml',
    config,
    coreConfig: {} as KtxLocalProject['coreConfig'],
    git: {} as KtxLocalProject['git'],
    fileStore: {} as KtxLocalProject['fileStore'],
  };
}

describe('loadKtxCliProject', () => {
  it('delegates to loadKtxProject and returns the project unchanged', async () => {
    const project = projectWithConfig(buildDefaultKtxProjectConfig());
    const loadProject = vi.fn(async () => project);

    const result = await loadKtxCliProject({ projectDir: '/work/proj' }, { loadProject });

    expect(result).toBe(project);
    expect(loadProject).toHaveBeenCalledWith({ projectDir: '/work/proj' });
  });
});
