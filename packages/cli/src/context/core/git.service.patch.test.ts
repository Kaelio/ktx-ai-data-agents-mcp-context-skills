import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitService } from './git.service.js';

async function makeGit() {
  const homeDir = await mkdtemp(join(tmpdir(), 'ktx-git-patch-'));
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
  return { homeDir, configDir, git };
}

describe('GitService patch helpers', () => {
  it('collects binary-safe no-rename patches and applies them with --3way --index', async () => {
    const { homeDir, configDir, git } = await makeGit();
    await mkdir(join(configDir, 'wiki/global'), { recursive: true });
    await writeFile(join(configDir, 'wiki/global/page.md'), 'old\n');
    await git.commitFiles(['wiki/global/page.md'], 'add page', 'System User', 'system@example.com');
    const base = await git.revParseHead();

    await writeFile(join(configDir, 'wiki/global/page.md'), 'new\n');
    await git.commitFiles(['wiki/global/page.md'], 'edit page', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'proposal.patch');
    await git.writeBinaryNoRenamePatch(base, 'HEAD', patchPath);

    const targetDir = join(homeDir, 'target');
    await git.addWorktree(targetDir, 'target', base);
    const targetGit = git.forWorktree(targetDir);
    await targetGit.applyPatchFile3WayIndex(patchPath);
    await targetGit.commitStaged('apply proposal', 'System User', 'system@example.com');

    await expect(readFile(join(targetDir, 'wiki/global/page.md'), 'utf-8')).resolves.toBe('new\n');
  });
});
