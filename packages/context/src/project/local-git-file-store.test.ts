import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService, type KtxCoreConfig } from '../core/index.js';
import { LocalGitFileStore } from './local-git-file-store.js';

describe('LocalGitFileStore', () => {
  let tempDir: string;
  let store: LocalGitFileStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-store-'));
    const coreConfig: KtxCoreConfig = {
      storage: { configDir: tempDir, homeDir: tempDir },
      git: {
        userName: 'ktx',
        userEmail: 'ktx@example.com',
        bootstrapMessage: 'Initialize test project',
        bootstrapAuthor: 'ktx',
        bootstrapAuthorEmail: 'ktx@example.com',
      },
    };
    const git = new GitService(coreConfig);
    await git.onModuleInit();
    store = new LocalGitFileStore({ rootDir: tempDir, git });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes, commits, and reads a project file', async () => {
    const write = await store.writeFile(
      'wiki/global/revenue.md',
      '# Revenue\n',
      'Agent',
      'agent@example.com',
      'Add revenue page',
    );

    expect(write.commitHash).toMatch(/^[0-9a-f]{40}$/);
    await expect(readFile(join(tempDir, 'wiki/global/revenue.md'), 'utf-8')).resolves.toBe('# Revenue\n');
    await expect(store.readFile('wiki/global/revenue.md')).resolves.toMatchObject({
      content: '# Revenue\n',
    });
  });

  it('lists files recursively and can strip the requested prefix', async () => {
    await store.writeFile('wiki/global/a.md', 'a', 'Agent', 'agent@example.com', 'Add a');
    await store.writeFile('wiki/global/nested/b.md', 'b', 'Agent', 'agent@example.com', 'Add b');

    await expect(store.listFiles('wiki')).resolves.toEqual({
      files: ['wiki/global/a.md', 'wiki/global/nested/b.md'],
    });
    await expect(store.listFiles('wiki/global', true)).resolves.toEqual({
      files: ['a.md', 'nested/b.md'],
    });
  });

  it('deletes and commits an existing file', async () => {
    await store.writeFile('semantic-layer/conn/orders.yaml', 'name: orders\n', 'Agent', 'agent@example.com', 'Add SL');

    const deleted = await store.deleteFile(
      'semantic-layer/conn/orders.yaml',
      'Agent',
      'agent@example.com',
      'Delete SL',
    );

    expect(deleted?.commitHash).toMatch(/^[0-9a-f]{40}$/);
    await expect(stat(join(tempDir, 'semantic-layer/conn/orders.yaml'))).rejects.toThrow();
  });

  it('returns null when deleting a missing file', async () => {
    await expect(store.deleteFile('missing.md', 'Agent', 'agent@example.com', 'Delete missing')).resolves.toBeNull();
  });

  it('exposes Git history for a file', async () => {
    await store.writeFile('wiki/global/history.md', 'v1', 'Agent', 'agent@example.com', 'Add history');
    await store.writeFile('wiki/global/history.md', 'v2', 'Agent', 'agent@example.com', 'Update history');

    const history = await store.getFileHistory('wiki/global/history.md');

    expect(Array.isArray(history)).toBe(true);
    expect(history[0]).toMatchObject({ message: 'Update history' });
    expect(history[1]).toMatchObject({ message: 'Add history' });
  });

  it('rejects absolute paths and parent-directory traversal', async () => {
    await expect(store.writeFile('/tmp/outside.md', 'bad', 'Agent', 'agent@example.com', 'Bad write')).rejects.toThrow(
      'Path must be relative',
    );

    await expect(store.readFile('../outside.md')).rejects.toThrow('Path escapes the project directory');
  });

  it('rejects direct .git access', async () => {
    await expect(store.readFile('.git/config')).rejects.toThrow('Path cannot access .git');
  });
});
