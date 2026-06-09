import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reindexLocalIndexes } from '../../../src/context/index-sync/reindex.js';
import { initKtxProject, type KtxLocalProject } from '../../../src/context/project/project.js';

const AUTHOR = 'Agent';
const EMAIL = 'agent@example.com';

const WIKI_PAGE = '---\nsummary: Revenue\nusage_mode: auto\n---\n\nPaid orders.\n';

/**
 * Regression for the "wiki silently unsearchable when the project dir is not the git root"
 * bug: a ktx project initialized below an existing git working tree. ingest writes wiki
 * pages through a session worktree and squash-merges into main, so the page must land
 * inside the project dir (where reindex scans), not at the enclosing git root.
 */
describe('reindex with a ktx project nested inside an enclosing git repo', () => {
  let tempDir: string;
  let enclosing: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-nested-git-root-'));
    enclosing = join(tempDir, 'enclosing');
    await mkdir(enclosing, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: enclosing });
    projectDir = join(enclosing, 'analytics');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('indexes a wiki page written through a session worktree and squash-merged into main', async () => {
    const project: KtxLocalProject = await initKtxProject({
      projectDir,
      authorName: AUTHOR,
      authorEmail: EMAIL,
    });

    // Mirror the ingest write path: create a session worktree, write the page on its
    // branch through the worktree-scoped file store, then squash-merge into main.
    const mainHead = await project.git.revParseHead();
    const workdir = join(projectDir, '.ktx/worktrees/session-test');
    const branch = 'session/test';
    await project.git.addWorktree(workdir, branch, mainHead);
    const worktreeStore = project.fileStore.forWorktree(workdir);
    await worktreeStore.writeFile('wiki/global/revenue.md', WIKI_PAGE, AUTHOR, EMAIL, 'Add revenue page');
    const merge = await project.git.squashMergeIntoMain(branch, AUTHOR, EMAIL, 'Merge session');
    expect(merge.ok).toBe(true);
    await project.git.removeWorktree(workdir);
    await project.git.deleteBranch(branch, true);

    // The page must land inside the project dir, not the enclosing git root.
    await expect(stat(join(projectDir, 'wiki/global/revenue.md'))).resolves.toBeDefined();
    await expect(stat(join(enclosing, 'wiki/global/revenue.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    // ...and reindex must discover and index it.
    const summary = await reindexLocalIndexes(project, { force: false, embeddingService: null });
    const global = summary.scopes.find((scope) => scope.label === 'global');
    expect(global).toMatchObject({ scanned: 1, updated: 1 });
  });
});
