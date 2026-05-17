import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitService } from '../../core/index.js';
import { FileIngestTraceWriter } from '../ingest-trace.js';
import { runIsolatedWorkUnit } from './work-unit-executor.js';

async function makeGit() {
  const homeDir = await mkdtemp(join(tmpdir(), 'ktx-isolated-wu-'));
  const configDir = join(homeDir, 'config');
  const git = new GitService({
    storage: { configDir, homeDir },
    git: {
      userName: 'System User',
      userEmail: 'system@example.com',
      bootstrapMessage: 'init',
      bootstrapAuthor: 'system',
      bootstrapAuthorEmail: 'system@example.com',
    },
  });
  await git.onModuleInit();
  await mkdir(join(configDir, 'raw-sources/c1/fake/s'), { recursive: true });
  await writeFile(join(configDir, 'raw-sources/c1/fake/s/a.json'), '{}\n');
  await git.commitFiles(['raw-sources/c1/fake/s/a.json'], 'raw snapshot', 'System User', 'system@example.com');
  return { homeDir, configDir, git, baseSha: await git.revParseHead() };
}

describe('runIsolatedWorkUnit', () => {
  it('creates a child worktree at the ingestion base and persists a patch proposal', async () => {
    const { homeDir, git, baseSha } = await makeGit();
    const childDir = join(homeDir, '.worktrees/session-job-1-wu-1');
    const sessionWorktreeService = {
      create: vi.fn(async (_key: string, startSha: string) => {
        await mkdir(join(homeDir, '.worktrees'), { recursive: true });
        await git.addWorktree(childDir, 'session/job-1-wu-1', startSha);
        const childGit = git.forWorktree(childDir);
        return {
          chatId: 'job-1-wu-1',
          workdir: childDir,
          branch: 'session/job-1-wu-1',
          baseSha: startSha,
          createdAt: new Date(),
          git: childGit,
          config: {},
        };
      }),
      cleanup: vi.fn(async () => undefined),
    };
    const tracePath = join(homeDir, '.ktx/ingest-traces/job-1/trace.jsonl');
    const trace = new FileIngestTraceWriter({
      tracePath,
      jobId: 'job-1',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await runIsolatedWorkUnit({
      unitIndex: 0,
      ingestionBaseSha: baseSha,
      sessionWorktreeService: sessionWorktreeService as never,
      patchDir: join(homeDir, '.ktx/ingest-patches/job-1'),
      trace,
      run: async (child) => {
        await mkdir(join(child.workdir, 'wiki/global'), { recursive: true });
        await writeFile(join(child.workdir, 'wiki/global/a.md'), '---\nsummary: A\nusage_mode: auto\n---\n\nBody\n');
        await child.git.commitFiles(['wiki/global/a.md'], 'test: write wiki', 'KTX Test', 'system@ktx.local');
        return {
          unitKey: 'wu-1',
          status: 'success',
          preSha: baseSha,
          postSha: await child.git.revParseHead(),
          actions: [{ target: 'wiki', type: 'created', key: 'a', detail: 'A' }],
          touchedSlSources: [],
        };
      },
      workUnit: { unitKey: 'wu-1', rawFiles: ['a.json'], peerFileIndex: [], dependencyPaths: [] },
    });

    expect(sessionWorktreeService.create).toHaveBeenCalledWith('job-1-wu-1', baseSha);
    expect(sessionWorktreeService.cleanup).toHaveBeenCalledWith(expect.any(Object), 'success');
    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      throw new Error('expected successful work unit');
    }
    const patchPath = result.patchPath;
    if (!patchPath) {
      throw new Error('expected patch path');
    }
    expect(patchPath).toContain('0000-wu-1.patch');
    await expect(readFile(patchPath, 'utf-8')).resolves.toContain('wiki/global/a.md');
    await expect(readFile(tracePath, 'utf-8')).resolves.toContain('work_unit_child_created');
  });
});
