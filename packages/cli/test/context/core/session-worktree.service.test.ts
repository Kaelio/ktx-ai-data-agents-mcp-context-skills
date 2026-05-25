import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KtxCoreConfig } from '../../../src/context/core/config.js';
import { GitService } from '../../../src/context/core/git.service.js';
import { SessionWorktreeService, type WorktreeConfigPort } from '../../../src/context/core/session-worktree.service.js';

interface TestWorktreeConfig extends WorktreeConfigPort<TestWorktreeConfig> {
  workdir?: string;
}

// SessionWorktreeService glues a real GitService to a scoped config adapter.
describe('SessionWorktreeService', () => {
  let sessionService: SessionWorktreeService<TestWorktreeConfig>;
  let gitService: GitService;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sws-spec-'));
    homeDir = await realpath(homeDir);

    const coreConfig: KtxCoreConfig = {
      storage: { configDir: homeDir, homeDir },
      git: {
        userName: 'System User',
        userEmail: 'system@example.com',
        bootstrapMessage: 'Initialize test config repo',
        bootstrapAuthor: 'test-system',
        bootstrapAuthorEmail: 'system@example.com',
      },
    };

    gitService = new GitService(coreConfig);
    await gitService.onModuleInit();
    const configService: TestWorktreeConfig = {
      forWorktree: vi.fn(
        (workdir: string): TestWorktreeConfig => ({ workdir, forWorktree: configService.forWorktree }),
      ),
    };
    sessionService = new SessionWorktreeService({
      coreConfig,
      gitService,
      configService,
    });
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a worktree + branch and returns scoped services', async () => {
      const baseSha = await gitService.revParseHead();
      if (!baseSha) {
        throw new Error('no base sha');
      }

      const session = await sessionService.create('chat-abc', baseSha);

      expect(session.workdir).toBe(join(homeDir, '.worktrees', 'session-chat-abc'));
      expect(session.branch).toBe('session/chat-abc');
      expect(session.baseSha).toBe(baseSha);
      const stats = await stat(session.workdir);
      expect(stats.isDirectory()).toBe(true);

      // Scoped git instance reports the worktree's HEAD (= baseSha at creation time).
      expect(await session.git.revParseHead()).toBe(baseSha);

      const list = await gitService.listWorktrees();
      expect(list.find((e) => e.path === session.workdir)).toBeTruthy();
    });

    it('appends a timestamp suffix when the primary dir already exists', async () => {
      const baseSha = await gitService.revParseHead();
      if (!baseSha) {
        throw new Error('no base sha');
      }

      const first = await sessionService.create('chat-dup', baseSha);
      const second = await sessionService.create('chat-dup', baseSha);

      expect(first.workdir).not.toBe(second.workdir);
      expect(second.branch).toMatch(/^session\/chat-dup-\d+$/);
    });
  });

  describe('cleanup', () => {
    it('success removes the worktree dir and deletes the branch', async () => {
      const baseSha = await gitService.revParseHead();
      if (!baseSha) {
        throw new Error('no base sha');
      }

      const session = await sessionService.create('chat-cleanup-ok', baseSha);
      await sessionService.cleanup(session, 'success');

      const list = await gitService.listWorktrees();
      expect(list.find((e) => e.path === session.workdir)).toBeFalsy();
      await expect(stat(session.workdir)).rejects.toThrow();
    });

    it('conflict keeps the worktree and writes a sentinel file', async () => {
      const baseSha = await gitService.revParseHead();
      if (!baseSha) {
        throw new Error('no base sha');
      }

      const session = await sessionService.create('chat-cleanup-conflict', baseSha);
      await sessionService.cleanup(session, 'conflict', { conflictPaths: ['shared.yaml'] });

      // Dir still exists.
      await expect(stat(session.workdir)).resolves.toBeTruthy();

      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(join(session.workdir, '.ktx-outcome'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.outcome).toBe('conflict');
      expect(parsed.chatId).toBe('chat-cleanup-conflict');
      expect(parsed.conflictPaths).toEqual(['shared.yaml']);
      expect(typeof parsed.at).toBe('string');
    });
  });
});
