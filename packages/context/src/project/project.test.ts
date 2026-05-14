import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, loadKtxProject } from './project.js';

describe('KTX local project runtime', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-project-runtime-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('initializes the standalone project layout and commits it', async () => {
    const projectDir = join(tempDir, 'warehouse');

    const result = await initKtxProject({
      projectDir,
      authorName: 'Agent',
      authorEmail: 'agent@example.com',
    });

    expect(result.projectDir).toBe(projectDir);
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
    await expect(readFile(join(projectDir, 'ktx.yaml'), 'utf-8')).resolves.not.toContain('project:');
    const gitignore = await readFile(join(projectDir, '.ktx/.gitignore'), 'utf-8');
    expect(gitignore).toContain('cache/');
    expect(gitignore).toContain('db.sqlite');
    expect(gitignore).toContain('db.sqlite-*');
    expect(gitignore).toContain('ingest-transcripts/');
    expect(gitignore).toContain('secrets/');
    expect(gitignore).toContain('setup/');
    expect(gitignore).toContain('agents/');
    await expect(stat(join(projectDir, 'wiki/global/.gitkeep'))).resolves.toBeDefined();
    await expect(stat(join(projectDir, 'semantic-layer/.gitkeep'))).resolves.toBeDefined();
    await expect(stat(join(projectDir, '_schema/.gitkeep'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(projectDir, 'raw-sources/.gitkeep'))).resolves.toBeDefined();
    await expect(stat(join(projectDir, '.git'))).resolves.toBeDefined();
  });

  it('loads an initialized project with a working file store', async () => {
    const projectDir = join(tempDir, 'warehouse');
    await initKtxProject({ projectDir });

    const loaded = await loadKtxProject({ projectDir });
    await loaded.fileStore.writeFile(
      'wiki/global/revenue.md',
      '# Revenue\n',
      'Agent',
      'agent@example.com',
      'Add revenue page',
    );

    await expect(loaded.fileStore.readFile('wiki/global/revenue.md')).resolves.toMatchObject({
      content: '# Revenue\n',
    });
  });

  it('rejects reinitializing an existing project unless force is set', async () => {
    const projectDir = join(tempDir, 'warehouse');
    await initKtxProject({ projectDir });

    await expect(initKtxProject({ projectDir })).rejects.toThrow('Project already contains ktx.yaml');

    await expect(initKtxProject({ projectDir, force: true })).resolves.toMatchObject({
      configPath: join(projectDir, 'ktx.yaml'),
    });
  });
});
