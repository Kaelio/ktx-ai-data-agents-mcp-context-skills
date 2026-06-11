import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KtxCoreConfig } from '../../../src/context/core/config.js';
import { GitService } from '../../../src/context/core/git.service.js';

// These tests drive a real git repo inside a temp directory — simple-git shells out to the
// system `git` binary. They are fast enough to run as unit tests and catch real issues that
// would be invisible with mocked git.
describe('GitService', () => {
  let service: GitService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'git-service-spec-'));

    const coreConfig: KtxCoreConfig = {
      storage: { configDir: tempDir, homeDir: tempDir },
      git: {
        userName: 'Test User',
        userEmail: 'test@example.com',
        bootstrapMessage: 'Initialize test config repo',
        bootstrapAuthor: 'test-system',
        bootstrapAuthorEmail: 'system@example.com',
      },
    };

    // Mirror production: initKtxProject writes ktx.yaml before the git repo is
    // initialized (the root ktx.yaml is the ownership signal) and commits it.
    await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
    service = new GitService(coreConfig);
    await service.onModuleInit();
    await service.commitFile('ktx.yaml', 'Initialize KTX project', 'Test', 'test@example.com');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const writeAndCommit = async (filePath: string, content: string, message = 'msg') => {
    await mkdir(dirname(join(tempDir, filePath)), { recursive: true });
    await writeFile(join(tempDir, filePath), content, 'utf-8');
    return service.commitFile(filePath, message, 'Test', 'test@example.com');
  };

  describe('listFilesAtCommit', () => {
    it('lists matching paths at a commit and recovers files deleted since', async () => {
      await writeAndCommit('semantic-layer/warehouse/custom.yaml', 'name: orders\n');
      const atSeed = await service.revParseHead();
      await service.deleteFile('semantic-layer/warehouse/custom.yaml', 'drop', 'Test', 'test@example.com');

      // HEAD no longer has the file; the seed commit still does.
      await expect(service.listFilesAtCommit('semantic-layer/warehouse', 'HEAD')).resolves.toEqual([]);
      await expect(service.listFilesAtCommit('semantic-layer/warehouse', atSeed)).resolves.toEqual([
        'semantic-layer/warehouse/custom.yaml',
      ]);
    });

    it('returns [] for a pathspec that matches nothing', async () => {
      await expect(service.listFilesAtCommit('does/not/exist', 'HEAD')).resolves.toEqual([]);
    });
  });

  describe('cold-start bootstrap commit', () => {
    it('writes an empty commit on init so HEAD always resolves', async () => {
      // beforeEach already ran onModuleInit() against a fresh temp dir.
      const head = await service.revParseHead();
      expect(head).toMatch(/^[0-9a-f]{40}$/);
    });

    it('does not double-commit when re-initialized', async () => {
      const before = await service.revParseHead();
      await service.onModuleInit();
      const after = await service.revParseHead();
      expect(after).toBe(before);
    });

    it('keeps git auto-maintenance attached for deterministic cleanup', async () => {
      const config = await readFile(join(tempDir, '.git', 'config'), 'utf-8');

      expect(config).toMatch(/\[gc]\n\s+autoDetach = false/);
      expect(config).toMatch(/\[maintenance]\n\s+autoDetach = false/);
    });

    it('initializes when release automation sets GIT_ASKPASS', async () => {
      const releaseEnvDir = await mkdtemp(join(tmpdir(), 'git-service-release-env-'));
      const previousAskPass = process.env.GIT_ASKPASS;
      process.env.GIT_ASKPASS = 'echo';

      try {
        const releaseEnvService = new GitService({
          storage: { configDir: releaseEnvDir, homeDir: releaseEnvDir },
          git: {
            userName: 'Test User',
            userEmail: 'test@example.com',
            bootstrapMessage: 'Initialize test config repo',
            bootstrapAuthor: 'test-system',
            bootstrapAuthorEmail: 'system@example.com',
          },
        });

        await expect(releaseEnvService.onModuleInit()).resolves.toBeUndefined();
      } finally {
        if (previousAskPass === undefined) {
          delete process.env.GIT_ASKPASS;
        } else {
          process.env.GIT_ASKPASS = previousAskPass;
        }
        await rm(releaseEnvDir, { recursive: true, force: true });
      }
    });
  });

  describe('commitFile `created` flag', () => {
    it('is true for a real commit', async () => {
      const info = await writeAndCommit('a.md', '# Hello');
      expect(info.created).toBe(true);
    });

    it('is false on a no-op write (content unchanged)', async () => {
      await writeAndCommit('a.md', '# Hello');
      const second = await writeAndCommit('a.md', '# Hello', 'unused');
      expect(second.created).toBe(false);
    });
  });

  describe('addNote / getNote', () => {
    it('attaches a note and reads it back', async () => {
      const info = await writeAndCommit('a.md', '# Hello');
      await service.addNote(info.commitHash, 'Rich message from LLM');
      expect(await service.getNote(info.commitHash)).toBe('Rich message from LLM');
    });

    it('returns undefined when no note exists', async () => {
      const info = await writeAndCommit('a.md', '# Hello');
      expect(await service.getNote(info.commitHash)).toBeUndefined();
    });

    it('overwrites an existing note (idempotent retries)', async () => {
      const info = await writeAndCommit('a.md', '# Hello');
      await service.addNote(info.commitHash, 'First');
      await service.addNote(info.commitHash, 'Second');
      expect(await service.getNote(info.commitHash)).toBe('Second');
    });

    it('skips empty/whitespace messages silently', async () => {
      const info = await writeAndCommit('a.md', '# Hello');
      await service.addNote(info.commitHash, '   ');
      expect(await service.getNote(info.commitHash)).toBeUndefined();
    });
  });

  describe('getFileHistory', () => {
    it('surfaces enhancedMessage when a note is present', async () => {
      const info = await writeAndCommit('a.md', '# Hello');
      await service.addNote(info.commitHash, 'Note body');

      const history = await service.getFileHistory('a.md');
      expect(history[0]?.enhancedMessage).toBe('Note body');
    });

    it('leaves enhancedMessage undefined when no note is attached', async () => {
      await writeAndCommit('a.md', '# Hello');
      const history = await service.getFileHistory('a.md');
      expect(history[0]?.enhancedMessage).toBeUndefined();
    });
  });

  describe('getCommitDiff', () => {
    it('returns the patch scoped to the requested path', async () => {
      const info = await writeAndCommit('a.md', '# Hello');
      const diff = await service.getCommitDiff(info.commitHash, 'a.md');
      expect(diff).toContain('diff --git');
      expect(diff).toContain('Hello');
    });

    it('handles the repository initial commit without throwing', async () => {
      const info = await writeAndCommit('first.md', 'first');
      await expect(service.getCommitDiff(info.commitHash, 'first.md')).resolves.toBeDefined();
    });
  });

  describe('squashTo', () => {
    const writeAsSystem = async (filePath: string, content: string, message = 'msg') => {
      await writeFile(join(tempDir, filePath), content, 'utf-8');
      return service.commitFile(filePath, message, 'System User', 'system@example.com');
    };

    it('collapses 3 commits after preHead into a single commit', async () => {
      const pre = await writeAsSystem('a.md', 'v1');
      const preHead = pre.commitHash;

      await writeAsSystem('b.md', 'b', 'add b');
      await writeAsSystem('c.md', 'c', 'add c');
      await writeAsSystem('a.md', 'v2', 'update a');

      const result = await service.squashTo(preHead, {
        message: 'Ingest: bundle 3 writes',
        author: 'System User',
        authorEmail: 'system@example.com',
      });

      expect(result.squashed).toBe(true);
      expect(result.squashedCount).toBe(3);
      expect(result.commitHash).toBeTruthy();
      expect(result.commitHash).not.toBe(preHead);
      const commitHash = result.commitHash;
      if (!commitHash) {
        throw new Error('Expected squash commit hash');
      }

      // The squashed commit should preserve the final tree state.
      const fileAtSquash = await service.getFileAtCommit('a.md', commitHash);
      expect(fileAtSquash).toBe('v2');
      const bAtSquash = await service.getFileAtCommit('b.md', commitHash);
      expect(bAtSquash).toBe('b');
    });

    it('is a no-op when preHead equals HEAD', async () => {
      const pre = await writeAsSystem('a.md', 'v1');

      const result = await service.squashTo(pre.commitHash, {
        message: 'nothing to squash',
        author: 'System User',
        authorEmail: 'system@example.com',
      });

      expect(result.squashed).toBe(false);
      expect(result.commitHash).toBe(pre.commitHash);
    });

    it('skips squash when a foreign-author commit sits between preHead and HEAD', async () => {
      const pre = await writeAsSystem('a.md', 'v1');
      const preHead = pre.commitHash;

      await writeAsSystem('b.md', 'from us', 'ours');
      // Foreign commit
      await writeAndCommit('c.md', 'from someone else', 'foreign');
      await writeAsSystem('d.md', 'ours again', 'ours 2');

      const result = await service.squashTo(preHead, {
        message: 'should be skipped',
        author: 'System User',
        authorEmail: 'system@example.com',
      });

      expect(result.squashed).toBe(false);
      expect(result.reason).toContain('foreign');
      expect(result.squashedCount).toBe(3);
    });

    it('returns cleanly when preHead is empty (no starting commit)', async () => {
      const result = await service.squashTo('', {
        message: 'would have squashed',
        author: 'System User',
        authorEmail: 'system@example.com',
      });

      expect(result.squashed).toBe(false);
      expect(result.commitHash).toBeNull();
    });
  });

  describe('worktree lifecycle', () => {
    // macOS canonicalizes tmp paths (/var/folders → /private/var/folders) when git
    // returns them from `worktree list`. Resolve through realpath() before comparing.
    const canonicalSiblingPath = async (suffix: string): Promise<string> => {
      const parent = await realpath(join(tempDir, '..'));
      return join(parent, `wt-${Date.now()}-${suffix}`);
    };

    it('addWorktree creates a branch + directory at the given startSha', async () => {
      const { commitHash } = await writeAndCommit('seed.md', 'seed');
      const wtDir = await canonicalSiblingPath('add');
      await service.addWorktree(wtDir, 'session/alpha', commitHash);
      const list = await service.listWorktrees();
      expect(list.find((e) => e.path === wtDir && e.branch === 'refs/heads/session/alpha')).toBeTruthy();
      await service.removeWorktree(wtDir).catch(() => undefined);
      await rm(wtDir, { recursive: true, force: true }).catch(() => undefined);
    });

    it('removeWorktree detaches the worktree entry', async () => {
      const { commitHash } = await writeAndCommit('seed.md', 'seed');
      const wtDir = await canonicalSiblingPath('rm');
      await service.addWorktree(wtDir, 'session/beta', commitHash);
      await service.removeWorktree(wtDir);
      const list = await service.listWorktrees();
      expect(list.find((e) => e.path === wtDir)).toBeFalsy();
    });

    it('deleteBranch removes a branch ref', async () => {
      const { commitHash } = await writeAndCommit('seed.md', 'seed');
      const wtDir = await canonicalSiblingPath('br');
      await service.addWorktree(wtDir, 'session/gamma', commitHash);
      await service.removeWorktree(wtDir);
      await service.deleteBranch('session/gamma', true);
      const branches = await (service as unknown as { git: import('simple-git').SimpleGit }).git.branchLocal();
      expect(branches.all).not.toContain('session/gamma');
      await rm(wtDir, { recursive: true, force: true }).catch(() => undefined);
    });
  });

  describe('forWorktree', () => {
    it('returns a GitService whose operations run inside the given worktree', async () => {
      const { commitHash } = await writeAndCommit('seed.md', 'seed');
      const parent = await realpath(join(tempDir, '..'));
      const wtDir = join(parent, `wt-${Date.now()}-fw`);
      await service.addWorktree(wtDir, 'session/delta', commitHash);

      const scoped = service.forWorktree(wtDir);
      expect(await scoped.revParseHead()).toBe(commitHash);

      await service.removeWorktree(wtDir).catch(() => undefined);
      await rm(wtDir, { recursive: true, force: true }).catch(() => undefined);
    });

    it('serializes concurrent commits from scoped services targeting the same worktree', async () => {
      const { commitHash } = await writeAndCommit('seed.md', 'seed');
      const parent = await realpath(join(tempDir, '..'));
      const wtDir = join(parent, `wt-${Date.now()}-fw-concurrent`);
      await service.addWorktree(wtDir, 'session/concurrent', commitHash);

      const first = service.forWorktree(wtDir);
      const second = service.forWorktree(wtDir);
      await writeFile(join(wtDir, 'a.md'), 'a\n', 'utf-8');
      await writeFile(join(wtDir, 'b.md'), 'b\n', 'utf-8');

      const [a, b] = await Promise.all([
        first.commitFile('a.md', 'add a', 'System User', 'system@example.com'),
        second.commitFile('b.md', 'add b', 'System User', 'system@example.com'),
      ]);

      expect(a.commitHash).toMatch(/^[0-9a-f]{40}$/);
      expect(b.commitHash).toMatch(/^[0-9a-f]{40}$/);
      await expect(first.getFileAtCommit('a.md', a.commitHash)).resolves.toBe('a\n');
      await expect(second.getFileAtCommit('b.md', b.commitHash)).resolves.toBe('b\n');

      await service.removeWorktree(wtDir).catch(() => undefined);
      await rm(wtDir, { recursive: true, force: true }).catch(() => undefined);
    });
  });

  describe('squashMergeIntoMain', () => {
    it('merges a session branch as one commit on main, returning the new SHA + touched paths', async () => {
      const { commitHash: baseSha } = await writeAndCommit('seed.md', 'seed');
      const parent = await realpath(join(tempDir, '..'));
      const wtDir = join(parent, `wt-${Date.now()}-sm`);
      await service.addWorktree(wtDir, 'session/happy', baseSha);

      const scoped = service.forWorktree(wtDir);
      await writeFile(join(wtDir, 'a.yaml'), 'one: 1\n', 'utf-8');
      await scoped.commitFile('a.yaml', 'wip a', 'System User', 'system@example.com');
      await writeFile(join(wtDir, 'b.yaml'), 'two: 2\n', 'utf-8');
      await scoped.commitFile('b.yaml', 'wip b', 'System User', 'system@example.com');

      const result = await service.squashMergeIntoMain(
        'session/happy',
        'System User',
        'system@example.com',
        'Memory capture: 2 files [chat=abcd1234]',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error('unreachable');
      }
      expect(result.squashSha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.touchedPaths.sort()).toEqual(['a.yaml', 'b.yaml']);

      const mainHead = await service.revParseHead();
      expect(mainHead).toBe(result.squashSha);
      expect(mainHead).not.toBe(baseSha);

      await service.removeWorktree(wtDir).catch(() => undefined);
      await rm(wtDir, { recursive: true, force: true }).catch(() => undefined);
    });

    it('returns ok with empty touchedPaths when the session branch has no diff vs main', async () => {
      const { commitHash: baseSha } = await writeAndCommit('seed.md', 'seed');
      const parent = await realpath(join(tempDir, '..'));
      const wtDir = join(parent, `wt-${Date.now()}-sm-empty`);
      await service.addWorktree(wtDir, 'session/empty', baseSha);

      const result = await service.squashMergeIntoMain(
        'session/empty',
        'System User',
        'system@example.com',
        'should be a no-op',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error('unreachable');
      }
      expect(result.touchedPaths).toEqual([]);
      expect(result.squashSha).toBe(baseSha);

      await service.removeWorktree(wtDir).catch(() => undefined);
      await rm(wtDir, { recursive: true, force: true }).catch(() => undefined);
    });

    it('returns conflict=true and leaves main clean when session+main touched same file differently', async () => {
      await writeAndCommit('shared.yaml', 'base\n');
      const base = await service.revParseHead();
      if (!base) {
        throw new Error('no base head');
      }

      const parent = await realpath(join(tempDir, '..'));
      const wtDir = join(parent, `wt-${Date.now()}-conf`);
      await service.addWorktree(wtDir, 'session/conf', base);
      const scoped = service.forWorktree(wtDir);
      await writeFile(join(wtDir, 'shared.yaml'), 'session-edit\n', 'utf-8');
      await scoped.commitFile('shared.yaml', 'session edit', 'System User', 'system@example.com');

      // Main edits the same file a different way, after the session branched.
      await writeAndCommit('shared.yaml', 'main-edit\n');

      const result = await service.squashMergeIntoMain(
        'session/conf',
        'System User',
        'system@example.com',
        'Memory capture: 1 file [chat=dead1234]',
      );

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('unreachable');
      }
      expect(result.conflict).toBe(true);
      expect(result.conflictPaths).toContain('shared.yaml');

      const status = await (service as unknown as { git: import('simple-git').SimpleGit }).git.status();
      expect(status.isClean()).toBe(true);

      await service.removeWorktree(wtDir).catch(() => undefined);
      await rm(wtDir, { recursive: true, force: true }).catch(() => undefined);
    });

    it('reports untracked files that would be overwritten by the squash merge', async () => {
      const { commitHash: baseSha } = await writeAndCommit('seed.md', 'seed');
      const parent = await realpath(join(tempDir, '..'));
      const wtDir = join(parent, `wt-${Date.now()}-untracked`);
      await service.addWorktree(wtDir, 'session/untracked', baseSha);

      const scoped = service.forWorktree(wtDir);
      await writeFile(join(wtDir, 'knowledge.md'), 'session version\n', 'utf-8');
      await scoped.commitFile('knowledge.md', 'session write', 'System User', 'system@example.com');
      await writeFile(join(tempDir, 'knowledge.md'), 'untracked local version\n', 'utf-8');

      const result = await service.squashMergeIntoMain(
        'session/untracked',
        'System User',
        'system@example.com',
        'Memory capture: 1 file [chat=untracked]',
      );

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('unreachable');
      }
      expect(result.conflict).toBe(true);
      expect(result.conflictPaths).toEqual(['knowledge.md']);

      const status = await (service as unknown as { git: import('simple-git').SimpleGit }).git.status();
      expect(status.not_added).toContain('knowledge.md');

      await service.removeWorktree(wtDir).catch(() => undefined);
      await rm(wtDir, { recursive: true, force: true }).catch(() => undefined);
    });
  });
});
