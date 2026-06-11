import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, loadKtxProject } from '../../../src/context/project/project.js';

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

  it('loads a ktx.yaml carrying fields removed in a newer ktx without mutating it on disk', async () => {
    const projectDir = join(tempDir, 'warehouse');
    await initKtxProject({ projectDir });

    // Simulate a project written by a different ktx: inject unknown fields into
    // the existing storage.git block and as a top-level memory block.
    const configPath = join(projectDir, 'ktx.yaml');
    const original = await readFile(configPath, 'utf-8');
    const withStaleKeys = `${original.replace(
      'author: ktx <ktx@example.com>',
      'auto_commit: true\n    author: ktx <ktx@example.com>',
    )}memory:\n  auto_commit: true\n`;
    await writeFile(configPath, withStaleKeys, 'utf-8');

    const loaded = await loadKtxProject({ projectDir });

    // Loading tolerates the unknown fields instead of throwing: they are stripped
    // from the in-memory config so every command still runs.
    expect(loaded.config).not.toHaveProperty('memory');
    expect(loaded.config.storage.git).toEqual({ author: 'ktx <ktx@example.com>' });

    // The file on disk stays exactly as the user wrote it.
    await expect(readFile(configPath, 'utf-8')).resolves.toBe(withStaleKeys);
  });

  it('initializes a dedicated git repo at the project dir even when nested inside an enclosing repo', async () => {
    // A ktx project dir living below an existing git working tree (e.g. an analytics
    // subfolder of an app repo). ktx must own its own repo rooted at the project dir,
    // not silently adopt the enclosing repo — otherwise worktree writes resolve against
    // the enclosing root and land outside the project dir.
    const enclosing = join(tempDir, 'enclosing');
    await mkdir(enclosing, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: enclosing });

    const projectDir = join(enclosing, 'analytics');
    await initKtxProject({ projectDir, authorName: 'Agent', authorEmail: 'agent@example.com' });

    await expect(stat(join(projectDir, '.git'))).resolves.toBeDefined();
    const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: projectDir,
      encoding: 'utf-8',
    }).trim();
    expect(await realpath(toplevel)).toBe(await realpath(projectDir));

    // ktx must not write its scaffold commits into the user's enclosing repo.
    const enclosingTracked = execFileSync('git', ['ls-files'], { cwd: enclosing, encoding: 'utf-8' });
    expect(enclosingTracked).not.toContain('ktx.yaml');
  });

  it('rejects reinitializing an existing project unless force is set', async () => {
    const projectDir = join(tempDir, 'warehouse');
    await initKtxProject({ projectDir });

    await expect(initKtxProject({ projectDir })).rejects.toThrow('Project already contains ktx.yaml');

    await expect(initKtxProject({ projectDir, force: true })).resolves.toMatchObject({
      configPath: join(projectDir, 'ktx.yaml'),
    });
  });

  it('refuses to initialize inside a foreign git repo and writes nothing into it', async () => {
    // A user's own repo: has history, no root ktx.yaml. The guard must reject
    // before writing ktx.yaml — that file would make the repo classify as ktx's.
    const projectDir = join(tempDir, 'app-repo');
    await mkdir(projectDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: projectDir });
    await writeFile(join(projectDir, 'README.md'), '# App\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: projectDir });
    execFileSync(
      'git',
      ['-c', 'user.name=App', '-c', 'user.email=app@example.com', 'commit', '-q', '-m', 'baseline'],
      { cwd: projectDir },
    );

    await expect(initKtxProject({ projectDir })).rejects.toThrow(
      /already a git repository that ktx did not create/,
    );

    await expect(stat(join(projectDir, 'ktx.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    const tracked = execFileSync('git', ['ls-files'], { cwd: projectDir, encoding: 'utf-8' });
    expect(tracked).not.toContain('ktx.yaml');
  });

  it('recovers an init interrupted after ktx.yaml was written but before git finished', async () => {
    // ktx.yaml is written before git init, so the only crash residue is a valid
    // ktx.yaml with no `.git` — the next load must re-init, not reject as foreign.
    const projectDir = join(tempDir, 'half-init');
    await initKtxProject({ projectDir });
    await rm(join(projectDir, '.git'), { recursive: true, force: true });

    const loaded = await loadKtxProject({ projectDir });

    await expect(stat(join(projectDir, '.git'))).resolves.toBeDefined();
    expect(await loaded.git.revParseHead()).toMatch(/^[0-9a-f]{40}$/);
  });
});
