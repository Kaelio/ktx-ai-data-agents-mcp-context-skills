import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { noopLogger, resolveWorktreesDir, type KtxCoreConfig, type KtxLogger } from './config.js';
import { GitService } from './git.service.js';

export type SessionOutcome = 'success' | 'empty' | 'conflict' | 'crash';

interface SentinelPayload {
  outcome: SessionOutcome;
  at: string;
  chatId: string;
  baseSha: string;
  conflictPaths?: string[];
}

export interface WorktreeConfigPort<TConfig> {
  forWorktree(workdir: string): TConfig;
}

export interface SessionWorktree<TConfig> {
  chatId: string;
  workdir: string;
  branch: string;
  baseSha: string;
  createdAt: Date;
  git: GitService;
  config: TConfig;
}

export interface SessionWorktreeServiceDeps<TConfig extends WorktreeConfigPort<TConfig>> {
  coreConfig: KtxCoreConfig;
  gitService: GitService;
  configService: TConfig;
  logger?: KtxLogger;
}

export class SessionWorktreeService<TConfig extends WorktreeConfigPort<TConfig> = WorktreeConfigPort<never>> {
  private readonly logger: KtxLogger;
  private readonly worktreesRoot: string;

  constructor(private readonly deps: SessionWorktreeServiceDeps<TConfig>) {
    this.logger = deps.logger ?? noopLogger;
    this.worktreesRoot = resolveWorktreesDir(deps.coreConfig);
  }

  async create(sessionKey: string, baseSha: string): Promise<SessionWorktree<TConfig>> {
    await mkdir(this.worktreesRoot, { recursive: true });

    let dirName = `session-${sessionKey}`;
    let branch = `session/${sessionKey}`;
    let workdir = join(this.worktreesRoot, dirName);

    try {
      await stat(workdir);
      const suffix = Date.now().toString();
      dirName = `session-${sessionKey}-${suffix}`;
      branch = `session/${sessionKey}-${suffix}`;
      workdir = join(this.worktreesRoot, dirName);
      this.logger.warn(`session worktree collision for key=${sessionKey}; using suffix ${suffix}`);
    } catch {
      // no collision: primary name is free
    }

    await this.deps.gitService.addWorktree(workdir, branch, baseSha);

    return {
      chatId: sessionKey,
      workdir,
      branch,
      baseSha,
      createdAt: new Date(),
      git: this.deps.gitService.forWorktree(workdir),
      config: this.deps.configService.forWorktree(workdir),
    };
  }

  async cleanup(
    session: SessionWorktree<TConfig>,
    outcome: SessionOutcome,
    extra?: { conflictPaths?: string[] },
  ): Promise<void> {
    if (outcome === 'success' || outcome === 'empty') {
      try {
        await this.deps.gitService.removeWorktree(session.workdir);
        await this.deps.gitService.deleteBranch(session.branch, true);
      } catch (error) {
        this.logger.warn(
          `cleanup(${outcome}) failed for ${session.chatId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return;
    }

    const payload: SentinelPayload = {
      outcome,
      at: new Date().toISOString(),
      chatId: session.chatId,
      baseSha: session.baseSha,
      ...(extra?.conflictPaths ? { conflictPaths: extra.conflictPaths } : {}),
    };
    try {
      await writeFile(join(session.workdir, '.ktx-outcome'), JSON.stringify(payload, null, 2), 'utf-8');
    } catch (error) {
      this.logger.warn(
        `cleanup(${outcome}) failed to write sentinel for ${session.chatId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
