import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KtxCoreConfig } from '../../../src/context/core/config.js';
import { GitService } from '../../../src/context/core/git.service.js';

// Regression for the production exception "Failed to initialize git repository"
// (PostHog issue 019ea9df-96d6-7882-98e2-6b892bf9c1ab, ktx 0.10.0, darwin).
//
// Repro: the project directory is ALREADY a git repo with no commits (the user ran
// `git init` first, or ktx is pointed at an empty repo), AND the machine has no configured
// git identity (a fresh Mac with no ~/.gitconfig). GitService only set the committer identity
// on the path where it created the repo itself, so the bootstrap commit failed with
// "Committer identity unknown" and was rethrown opaquely.
describe('GitService.initialize without a configured git identity', () => {
  let repoDir: string;
  let homeDir: string;
  let savedEnv: Record<string, string | undefined>;

  const IDENTITY_ENV_KEYS = [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'EMAIL',
  ];

  const coreConfig = (configDir: string): KtxCoreConfig => ({
    storage: { configDir, homeDir: configDir },
    git: {
      userName: 'Test User',
      userEmail: 'test@example.com',
      bootstrapMessage: 'Initialize test config repo',
      bootstrapAuthor: 'test-system',
      bootstrapAuthorEmail: 'system@example.com',
    },
  });

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'git-service-identity-'));
    homeDir = await mkdtemp(join(tmpdir(), 'git-service-home-'));

    // Model a machine with no configured git identity, deterministically and independent of
    // the host's ~/.gitconfig. `useConfigOnly` disables git's username@hostname email guess,
    // so a missing identity is a hard failure rather than a hostname-dependent one. Note we
    // cannot use GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM here: simple-git rejects those env vars.
    await writeFile(join(homeDir, '.gitconfig'), '[user]\n\tuseConfigOnly = true\n', 'utf-8');

    savedEnv = Object.fromEntries(IDENTITY_ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.XDG_CONFIG_HOME = join(homeDir, 'xdg-empty');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) {
      delete process.env[key];
    }

    // Pre-create an empty repo: checkIsRepo() will be true, but there is no HEAD yet.
    execFileSync('git', ['init'], { cwd: repoDir, env: process.env, stdio: 'ignore' });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(repoDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('bootstraps a commit in a pre-existing empty repo so HEAD resolves', async () => {
    const service = new GitService(coreConfig(repoDir));

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    const head = await service.revParseHead();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("does not write its identity into the user's repo config", async () => {
    const service = new GitService(coreConfig(repoDir));
    await service.onModuleInit();

    // ktx must not hijack the identity the user would use for their own commits in this repo.
    const localName = execFileSync('git', ['config', '--local', '--default', '', 'user.name'], {
      cwd: repoDir,
      env: process.env,
      encoding: 'utf-8',
    }).trim();
    expect(localName).toBe('');
  });
});
