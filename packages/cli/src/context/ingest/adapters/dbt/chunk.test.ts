import { describe, expect, it } from 'vitest';
import { chunkDbtProject } from './chunk.js';

describe('chunkDbtProject', () => {
  const diffSet = (modified: string[]) => ({ added: [], modified, deleted: [], unchanged: [] });

  it('caps peerFileIndex when the project has very many yaml files', () => {
    const modelPaths = Array.from({ length: 201 }, (_, i) => `models/m${i}.yml`);
    const allPaths = ['dbt_project.yml', ...modelPaths].sort();
    const { workUnits } = chunkDbtProject({ allPaths });
    const [first] = workUnits;
    expect(first).toBeDefined();
    expect(first?.peerFileIndex).toHaveLength(200);
    expect(first?.notes).toMatch(/capped at 200/);
  });

  it('keeps large-project model work units when dbt_project.yml changes', () => {
    const modelPaths = Array.from({ length: 30 }, (_, i) => `models/m${i}.yml`);
    const allPaths = ['dbt_project.yml', ...modelPaths].sort();
    const { workUnits } = chunkDbtProject({ allPaths }, { diffSet: diffSet(['dbt_project.yml']) });

    expect(workUnits).toHaveLength(30);
    expect(workUnits[0]?.rawFiles).toEqual(['models/m0.yml']);
    expect(workUnits[0]?.dependencyPaths).toContain('dbt_project.yml');
  });

  it('keeps large-project model work units when non-model yaml peers change', () => {
    const modelPaths = Array.from({ length: 30 }, (_, i) => `models/m${i}.yml`);
    const allPaths = ['dbt_project.yml', 'seeds/seed_properties.yml', ...modelPaths].sort();
    const { workUnits } = chunkDbtProject({ allPaths }, { diffSet: diffSet(['seeds/seed_properties.yml']) });

    expect(workUnits).toHaveLength(30);
    expect(workUnits[0]?.rawFiles).toEqual(['models/m0.yml']);
    expect(workUnits[0]?.dependencyPaths).toContain('seeds/seed_properties.yml');
  });
});
