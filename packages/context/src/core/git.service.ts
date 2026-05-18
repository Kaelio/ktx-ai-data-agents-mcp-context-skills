import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SimpleGit } from 'simple-git';
import { noopLogger, resolveConfigDir, type KtxCoreConfig, type KtxLogger } from './config.js';
import { createSimpleGit } from './git-env.js';

export interface GitCommitInfo {
  commitHash: string;
  shortHash: string;
  message: string;
  author: string;
  authorEmail: string;
  timestamp: string;
  committedDate: string;
  /**
   * True if this call produced a new commit. False when the file was already up-to-date
   * and the returned info describes the pre-existing HEAD commit (no-op write).
   */
  created: boolean;
  /** Async LLM-generated commit summary attached as a git note. Undefined if no note present. */
  enhancedMessage?: string;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
}

export type SquashMergeResult =
  | { ok: true; squashSha: string; touchedPaths: string[] }
  | { ok: false; conflict: true; conflictPaths: string[] };

function mergeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function extractUntrackedOverwritePaths(message: string): string[] {
  const marker = 'The following untracked working tree files would be overwritten by merge:';
  const markerIndex = message.indexOf(marker);
  if (markerIndex === -1) {
    return [];
  }

  const afterMarker = message.slice(markerIndex + marker.length);
  const abortIndex = afterMarker.indexOf('Please move or remove them before you merge.');
  const pathBlock = abortIndex === -1 ? afterMarker : afterMarker.slice(0, abortIndex);
  return pathBlock
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== 'Aborting')
    .map((line) => line.replace(/^"(.+)"$/, '$1'));
}

function mergeConflictPaths(unmergedPaths: string[], mergeError: unknown): string[] {
  const paths = new Set(unmergedPaths);
  if (mergeError !== null) {
    for (const path of extractUntrackedOverwritePaths(mergeErrorMessage(mergeError))) {
      paths.add(path);
    }
  }
  return [...paths];
}

export class GitService {
  private static readonly mutationQueues = new Map<string, Promise<void>>();

  private readonly logger: KtxLogger;
  private git!: SimpleGit;
  private configDir: string;

  constructor(
    private readonly config: KtxCoreConfig,
    logger?: KtxLogger,
  ) {
    this.logger = logger ?? noopLogger;
    this.configDir = resolveConfigDir(config);
  }

  async onModuleInit(): Promise<void> {
    // Ensure config directory exists
    await fs.mkdir(this.configDir, { recursive: true });
    this.logger.log(`Config directory ensured at: ${this.configDir}`);

    // Initialize simple-git
    this.git = createSimpleGit(this.configDir);

    // Initialize git repository
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      // Check if already initialized
      const isRepo = await this.git.checkIsRepo();

      if (!isRepo) {
        await this.git.init();
        const gitConfig = this.config.git;
        await this.git.addConfig('user.name', gitConfig.userName);
        await this.git.addConfig('user.email', gitConfig.userEmail);
        this.logger.log('Initialized git repository');
      }

      // Keep any auto-maintenance triggered by writes in-process. Detached maintenance can
      // keep object-pack directories alive briefly after awaited git commands complete,
      // which makes temp-project cleanup flaky in CI.
      await this.git.addConfig('gc.autoDetach', 'false');
      await this.git.addConfig('maintenance.autoDetach', 'false');

      // Ensure HEAD always resolves to a commit so callers (e.g., the memory-agent squash flow)
      // can rely on `revParseHead()` returning a SHA. Idempotent: skip if HEAD already exists.
      const head = await this.revParseHead();
      if (!head) {
        await this.git.commit(this.config.git.bootstrapMessage ?? 'Initialize ktx project repository', {
          '--allow-empty': null,
          '--author': `${this.config.git.bootstrapAuthor ?? 'ktx system'} <${
            this.config.git.bootstrapAuthorEmail ?? 'system@ktx.local'
          }>`,
        });
        this.logger.log('Wrote bootstrap commit to config repo');
      }
    } catch (error) {
      this.logger.error('Failed to initialize git repository', error);
      throw new Error('Failed to initialize git repository');
    }
  }

  async commitFile(
    filePath: string,
    commitMessage: string,
    author: string,
    authorEmail: string,
  ): Promise<GitCommitInfo> {
    return this.withMutationQueue(() => this.commitFileUnlocked(filePath, commitMessage, author, authorEmail));
  }

  private async commitFileUnlocked(
    filePath: string,
    commitMessage: string,
    author: string,
    authorEmail: string,
  ): Promise<GitCommitInfo> {
    try {
      // Stage the file
      await this.git.add(filePath);

      // Check if there are any staged changes to commit
      const stagedChanges = await this.git.diff(['--cached', '--name-only']);

      if (!stagedChanges.trim()) {
        // No changes to commit, file already matches what's in git
        this.logger.debug(`No changes to commit for ${filePath}, file already up to date`);

        // Return info about the current HEAD commit
        const log = await this.git.log({ maxCount: 1 });
        const commit = log.latest;

        if (!commit) {
          throw new Error('Failed to retrieve commit details');
        }

        return {
          commitHash: commit.hash,
          shortHash: commit.hash.substring(0, 8),
          message: commit.message,
          author: commit.author_name,
          authorEmail: commit.author_email,
          timestamp: commit.date,
          committedDate: new Date(commit.date).toISOString(),
          created: false,
        };
      }

      // There are changes to commit
      const result = await this.git.commit(commitMessage, {
        '--author': `${author} <${authorEmail}>`,
      });

      if (!result.commit) {
        throw new Error('No commit hash returned');
      }

      // Get commit details
      const log = await this.git.log({ maxCount: 1 });
      const commit = log.latest;

      if (!commit) {
        throw new Error('Failed to retrieve commit details');
      }

      return {
        commitHash: commit.hash,
        shortHash: commit.hash.substring(0, 8),
        message: commit.message,
        author: commit.author_name,
        authorEmail: commit.author_email,
        timestamp: commit.date,
        committedDate: new Date(commit.date).toISOString(),
        created: true,
      };
    } catch (error) {
      this.logger.error(`Failed to commit file ${filePath}`, error);
      throw new Error(`Failed to commit file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Stage multiple files and produce a single commit. Mirrors `commitFile` but batches
   * N paths into one atomic commit — used by the SL capture agent to commit all edits at once.
   */
  async commitFiles(
    filePaths: string[],
    commitMessage: string,
    author: string,
    authorEmail: string,
  ): Promise<GitCommitInfo> {
    return this.withMutationQueue(() => this.commitFilesUnlocked(filePaths, commitMessage, author, authorEmail));
  }

  private async commitFilesUnlocked(
    filePaths: string[],
    commitMessage: string,
    author: string,
    authorEmail: string,
  ): Promise<GitCommitInfo> {
    try {
      for (const filePath of filePaths) {
        await this.git.add(filePath);
      }

      const stagedChanges = await this.git.diff(['--cached', '--name-only']);

      if (!stagedChanges.trim()) {
        this.logger.debug(`No changes to commit for ${filePaths.length} file(s), already up to date`);
        const log = await this.git.log({ maxCount: 1 });
        const commit = log.latest;
        if (!commit) {
          throw new Error('Failed to retrieve commit details');
        }
        return {
          commitHash: commit.hash,
          shortHash: commit.hash.substring(0, 8),
          message: commit.message,
          author: commit.author_name,
          authorEmail: commit.author_email,
          timestamp: commit.date,
          committedDate: new Date(commit.date).toISOString(),
          created: false,
        };
      }

      const result = await this.git.commit(commitMessage, {
        '--author': `${author} <${authorEmail}>`,
      });

      if (!result.commit) {
        throw new Error('No commit hash returned');
      }

      const log = await this.git.log({ maxCount: 1 });
      const commit = log.latest;
      if (!commit) {
        throw new Error('Failed to retrieve commit details');
      }

      return {
        commitHash: commit.hash,
        shortHash: commit.hash.substring(0, 8),
        message: commit.message,
        author: commit.author_name,
        authorEmail: commit.author_email,
        timestamp: commit.date,
        committedDate: new Date(commit.date).toISOString(),
        created: true,
      };
    } catch (error) {
      this.logger.error(`Failed to batch commit ${filePaths.length} file(s)`, error);
      throw new Error(`Failed to batch commit: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Revert working-tree changes for the given paths (equivalent to `git checkout -- <paths>`).
   * Used to roll back dirty files when validation fails.
   */
  async checkoutFiles(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) {
      return;
    }
    return this.withMutationQueue(() => this.checkoutFilesUnlocked(filePaths));
  }

  private async checkoutFilesUnlocked(filePaths: string[]): Promise<void> {
    try {
      await this.git.checkout(['--', ...filePaths]);
    } catch (error) {
      this.logger.warn(
        `Failed to checkout ${filePaths.length} file(s): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Read the content of `filePath` as it existed at `commitHash`. Equivalent to
   * `git show <sha>:<path>`. Reads from git object storage, so it's safe against
   * concurrent working-tree mutations.
   */
  async getFileAtCommit(filePath: string, commitHash: string): Promise<string> {
    try {
      return await this.git.show([`${commitHash}:${filePath}`]);
    } catch (error) {
      this.logger.error(`Failed to read ${filePath} at ${commitHash}`, error);
      throw new Error(`Failed to read file at commit: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getFileHistory(filePath: string, limit: number = 50): Promise<GitCommitInfo[]> {
    try {
      const log = await this.git.log({
        file: filePath,
        maxCount: limit,
      });

      // N+1 fetch of notes is fine here: capped at 100 commits, cold UI path.
      return Promise.all(
        log.all.map(async (commit) => ({
          commitHash: commit.hash,
          shortHash: commit.hash.substring(0, 8),
          message: commit.message,
          author: commit.author_name,
          authorEmail: commit.author_email,
          timestamp: commit.date,
          committedDate: new Date(commit.date).toISOString(),
          created: true,
          enhancedMessage: await this.getNote(commit.hash),
        })),
      );
    } catch (error) {
      this.logger.error(`Failed to get history for ${filePath}`, error);
      throw new Error(`Failed to retrieve file history: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Attach or overwrite an LLM-generated summary note on a commit.
   * Uses `-f` so retries overwrite rather than fail on existing notes (idempotent).
   * Callers are responsible for holding `config:repo` Redlock — notes writes mutate
   * `.git/refs/notes/commits` and must serialize with commits.
   */
  async addNote(commitHash: string, message: string): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }
    return this.withMutationQueue(() => this.addNoteUnlocked(commitHash, trimmed));
  }

  private async addNoteUnlocked(commitHash: string, trimmed: string): Promise<void> {
    try {
      await this.git.raw(['notes', 'add', '-f', '-m', trimmed, commitHash]);
    } catch (error) {
      this.logger.error(`Failed to attach note to ${commitHash}`, error);
      throw new Error(`Failed to attach git note: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Read the LLM-generated note for a commit, or undefined if none present.
   * Swallows `simple-git`'s "no note found" error so callers can treat it as optional.
   */
  async getNote(commitHash: string): Promise<string | undefined> {
    try {
      const note = await this.git.raw(['notes', 'show', commitHash]);
      const trimmed = note.trim();
      return trimmed ? trimmed : undefined;
    } catch {
      // `git notes show` exits non-zero when no note exists — treat as "no note".
      return undefined;
    }
  }

  /**
   * Return the patch for a commit, optionally scoped to a single path.
   * Strips the commit header above the first `diff --git` so only the patch body remains,
   * and clips to 12 KB to bound LLM token cost. Returns '' if the commit changed nothing
   * on the requested path (e.g. a commit that only touched other files).
   */
  async getCommitDiff(commitHash: string, path?: string): Promise<string> {
    const args = ['show', '--format=', '--no-color', '--patch', commitHash];
    if (path) {
      args.push('--', path);
    }
    try {
      const raw = await this.git.raw(args);
      const diffStart = raw.indexOf('diff --git');
      const body = diffStart >= 0 ? raw.slice(diffStart) : raw.trim();
      const MAX_DIFF_BYTES = 12_000;
      return body.length > MAX_DIFF_BYTES ? `${body.slice(0, MAX_DIFF_BYTES)}\n… [diff truncated]` : body;
    } catch (error) {
      this.logger.error(`Failed to read diff for ${commitHash}`, error);
      throw new Error(`Failed to read commit diff: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteFile(
    filePath: string,
    commitMessage: string,
    author: string,
    authorEmail: string,
  ): Promise<GitCommitInfo> {
    return this.withMutationQueue(() => this.deleteFileUnlocked(filePath, commitMessage, author, authorEmail));
  }

  private async deleteFileUnlocked(
    filePath: string,
    commitMessage: string,
    author: string,
    authorEmail: string,
  ): Promise<GitCommitInfo> {
    try {
      // Remove the file from git
      await this.git.rm(filePath);

      // Commit the deletion
      const result = await this.git.commit(commitMessage, {
        '--author': `${author} <${authorEmail}>`,
      });

      if (!result.commit) {
        throw new Error('No commit hash returned');
      }

      // Get commit details
      const log = await this.git.log({ maxCount: 1 });
      const commit = log.latest;

      if (!commit) {
        throw new Error('Failed to retrieve commit details');
      }

      return {
        commitHash: commit.hash,
        shortHash: commit.hash.substring(0, 8),
        message: commit.message,
        author: commit.author_name,
        authorEmail: commit.author_email,
        timestamp: commit.date,
        committedDate: new Date(commit.date).toISOString(),
        created: true,
      };
    } catch (error) {
      this.logger.error(`Failed to delete file ${filePath}`, error);
      throw new Error(`Failed to delete file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Resolve HEAD to a full commit SHA. Returns the empty string if the repo has no commits yet
   * (a freshly-init'd repo before any writes), so callers can treat that as "nothing to reconcile".
   */
  async revParseHead(): Promise<string> {
    try {
      const sha = await this.git.revparse(['HEAD']);
      return sha.trim();
    } catch {
      return '';
    }
  }

  /**
   * Verify a commit object exists in the local repo. Used by the reconciler to detect
   * the "history was rewritten / partial clone" case before attempting `git diff $sha..HEAD`.
   */
  async commitExists(commitHash: string): Promise<boolean> {
    if (!commitHash) {
      return false;
    }
    try {
      await this.git.raw(['cat-file', '-e', `${commitHash}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `git diff --name-status $from..$to -- $pathSpec`. Returns one entry per changed path.
   * Renames (`R{score}\told\tnew`) are split into a `D` for the old path plus an `A` for
   * the new — the reconciler treats each path independently and the new path's row will
   * upsert with whatever content the file actually has.
   */
  async diffNameStatus(
    from: string,
    to: string,
    pathSpec?: string,
  ): Promise<Array<{ status: 'A' | 'M' | 'D'; path: string }>> {
    const args = ['diff', '--name-status', '-z', `${from}..${to}`];
    if (pathSpec) {
      args.push('--', pathSpec);
    }
    const raw = await this.git.raw(args);
    if (!raw) {
      return [];
    }
    // -z output: NUL-separated fields. For A/M/D: "<status>\0<path>\0". For R/C: "<status>\0<old>\0<new>\0".
    const fields = raw.split('\0').filter((f) => f.length > 0);
    const out: Array<{ status: 'A' | 'M' | 'D'; path: string }> = [];
    let i = 0;
    while (i < fields.length) {
      const status = fields[i];
      const code = status[0];
      if (code === 'R' || code === 'C') {
        const oldPath = fields[i + 1];
        const newPath = fields[i + 2];
        out.push({ status: 'D', path: oldPath });
        out.push({ status: 'A', path: newPath });
        i += 3;
      } else if (code === 'A' || code === 'M' || code === 'D') {
        out.push({ status: code, path: fields[i + 1] });
        i += 2;
      } else {
        // Unknown status (T type-change, U unmerged, X unknown) — treat as modify, skip if no path
        if (fields[i + 1]) {
          out.push({ status: 'M', path: fields[i + 1] });
        }
        i += 2;
      }
    }
    return out;
  }

  async changedPaths(): Promise<string[]> {
    const raw = await this.git.raw(['status', '--porcelain=v1', '-z']);
    const fields = raw.split('\0').filter(Boolean);
    const paths: string[] = [];
    for (const field of fields) {
      const path = field.slice(3);
      if (path.length > 0) {
        paths.push(path);
      }
    }
    return [...new Set(paths)].sort();
  }

  /**
   * List all paths under the working tree that match `pathSpec`, scoped to HEAD.
   * Used for the reconciler's first-ever run when there's no watermark to diff from.
   */
  async listFilesAtHead(pathSpec: string): Promise<string[]> {
    try {
      const raw = await this.git.raw(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', pathSpec]);
      if (!raw) {
        return [];
      }
      return raw.split('\0').filter((f) => f.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Collapse all commits between `preHead` and current HEAD into a single commit with the given
   * message. Used by the memory agent to squash N per-tool-call commits into one ingest commit.
   *
   * Author-check guard: if any commit between preHead..HEAD has an author other than
   * `expectedAuthor`, skips the squash and returns `{ squashed: false, reason: ... }`. This
   * prevents accidentally collapsing another writer's commits if writes interleaved with ours.
   *
   * Caller is responsible for holding the `config:repo` lock so writes and squash serialize.
   */
  async squashTo(
    preHead: string,
    options: { message: string; author: string; authorEmail: string; expectedAuthor?: string },
  ): Promise<{ squashed: boolean; commitHash: string | null; reason?: string; squashedCount?: number }> {
    return this.withMutationQueue(() => this.squashToUnlocked(preHead, options));
  }

  private async squashToUnlocked(
    preHead: string,
    options: { message: string; author: string; authorEmail: string; expectedAuthor?: string },
  ): Promise<{ squashed: boolean; commitHash: string | null; reason?: string; squashedCount?: number }> {
    const { message, author, authorEmail } = options;
    const expectedAuthor = options.expectedAuthor ?? author;

    if (!preHead) {
      return { squashed: false, commitHash: null, reason: 'no pre-head recorded (empty repo at start)' };
    }

    let currentHead: string;
    try {
      currentHead = (await this.git.revparse(['HEAD'])).trim();
    } catch {
      return { squashed: false, commitHash: null, reason: 'no HEAD (repo is empty)' };
    }

    if (currentHead === preHead) {
      return { squashed: false, commitHash: preHead, reason: 'no new commits' };
    }

    try {
      const log = await this.git.log({ from: preHead, to: 'HEAD' });
      const commits = log.all;
      if (commits.length === 0) {
        return { squashed: false, commitHash: preHead, reason: 'no new commits' };
      }
      const foreign = commits.find((c) => c.author_name !== expectedAuthor);
      if (foreign) {
        this.logger.warn(
          `Skipping squash: commit ${foreign.hash.substring(0, 8)} authored by "${foreign.author_name}" ` +
            `differs from expected "${expectedAuthor}". Leaving ${commits.length} commit(s) as-is.`,
        );
        return {
          squashed: false,
          commitHash: currentHead,
          reason: `foreign commit by ${foreign.author_name}`,
          squashedCount: commits.length,
        };
      }

      // Soft reset to preHead, then produce a single commit with all the staged changes.
      await this.git.reset(['--soft', preHead]);

      const staged = await this.git.diff(['--cached', '--name-only']);
      if (!staged.trim()) {
        // All intervening commits cancelled each other out — return to preHead and commit nothing.
        return { squashed: true, commitHash: preHead, reason: 'no net changes', squashedCount: commits.length };
      }

      await this.git.commit(message, { '--author': `${author} <${authorEmail}>` });
      const newHead = (await this.git.revparse(['HEAD'])).trim();
      this.logger.log(
        `squashTo: collapsed ${commits.length} commit(s) into ${newHead.substring(0, 8)} (was ${currentHead.substring(0, 8)})`,
      );
      return { squashed: true, commitHash: newHead, squashedCount: commits.length };
    } catch (error) {
      this.logger.error('Failed to squash commits', error);
      throw new Error(`Failed to squash commits: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Squash-merge `branch` into the currently-checked-out branch of THIS worktree (the
   * main worktree, when called on the root GitService instance). Produces a single
   * commit whose tree equals the source branch's tree, with the given message/author.
   * Returns `{ ok: false, conflict: true, conflictPaths }` and leaves the main worktree
   * clean if git reports merge conflicts.
   *
   * Caller must hold the `config:repo` lock so interactive writes don't race against the
   * merge window.
   */
  async squashMergeIntoMain(
    branch: string,
    author: string,
    authorEmail: string,
    commitMessage: string,
  ): Promise<SquashMergeResult> {
    return this.withMutationQueue(() => this.squashMergeIntoMainUnlocked(branch, author, authorEmail, commitMessage));
  }

  private async squashMergeIntoMainUnlocked(
    branch: string,
    author: string,
    authorEmail: string,
    commitMessage: string,
  ): Promise<SquashMergeResult> {
    // Diff of HEAD..branch (two dots) lists commits/files reachable from `branch` that
    // aren't on HEAD — i.e. exactly what the squash would apply. Three dots (HEAD...branch)
    // is symmetric difference and would mis-classify cases where main moved ahead.
    const diff = await this.git.raw(['diff', '--name-only', `HEAD..${branch}`]);
    const touchedPaths = diff
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (touchedPaths.length === 0) {
      const head = (await this.git.revparse(['HEAD'])).trim();
      return { ok: true, squashSha: head, touchedPaths: [] };
    }

    // `git merge --squash` may NOT throw on a textual conflict — it stages the clean
    // hunks and leaves conflicted paths unmerged in the index. simple-git may also
    // throw if the underlying git exits non-zero. Handle both: try the merge, then
    // independently inspect the index for unmerged paths before committing.
    let mergeError: unknown = null;
    try {
      await this.git.raw(['merge', '--squash', branch]);
    } catch (error) {
      mergeError = error;
    }

    const unmergedOut = await this.git.raw(['diff', '--name-only', '--diff-filter=U']).catch(() => '');
    const unmergedPaths = unmergedOut
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const conflictPaths = mergeConflictPaths(unmergedPaths, mergeError);

    if (conflictPaths.length > 0 || mergeError !== null) {
      // `merge --abort` only works for an in-progress merge; squash sets MERGE_MSG but not
      // MERGE_HEAD, so fall back to a hard reset which clears the index and worktree.
      await this.git.raw(['merge', '--abort']).catch(() => undefined);
      await this.git.raw(['reset', '--hard', 'HEAD']).catch(() => undefined);
      this.logger.warn(
        `squashMergeIntoMain: conflict merging ${branch} — aborted. conflictPaths=${conflictPaths.join(',')}` +
          (mergeError ? ` error=${mergeErrorMessage(mergeError)}` : ''),
      );
      return { ok: false, conflict: true, conflictPaths };
    }

    await this.git.commit(commitMessage, { '--author': `${author} <${authorEmail}>` });
    const squashSha = (await this.git.revparse(['HEAD'])).trim();
    return { ok: true, squashSha, touchedPaths };
  }

  /**
   * Rewinds the current branch's HEAD to `targetSha`, discarding all later commits and any
   * uncommitted worktree changes. Used by Stage-3 to back out a failed work-unit's commits
   * on the session worktree - simpler and more robust than `git revert` over a multi-commit
   * range, which can pause the sequencer on conflicts.
   */
  async resetHardTo(targetSha: string): Promise<void> {
    await this.withMutationQueue(() => this.git.raw(['reset', '--hard', targetSha]));
  }

  /**
   * Throws if the worktree is in a state that would make a downstream merge unsafe: an
   * in-progress merge, rebase, cherry-pick, revert, interrupted sequencer operation, or
   * unmerged paths in the index.
   */
  async assertWorktreeClean(): Promise<void> {
    const inProgressMarkers: ReadonlyArray<{ relPath: string; label: string }> = [
      { relPath: 'MERGE_HEAD', label: 'MERGE_HEAD' },
      { relPath: 'REBASE_HEAD', label: 'REBASE_HEAD' },
      { relPath: 'CHERRY_PICK_HEAD', label: 'CHERRY_PICK_HEAD' },
      { relPath: 'REVERT_HEAD', label: 'REVERT_HEAD' },
      { relPath: 'sequencer/todo', label: 'sequencer (interrupted multi-commit op)' },
    ];

    for (const { relPath, label } of inProgressMarkers) {
      const gitPath = (await this.git.raw(['rev-parse', '--git-path', relPath])).trim();
      const fullPath = gitPath.startsWith('/') ? gitPath : join(this.configDir, gitPath);
      if (await this.fileExists(fullPath)) {
        throw new Error(
          `Worktree has in-progress git operation (${label} present at ${fullPath}); refusing to proceed`,
        );
      }
    }

    const unmerged = (await this.git.raw(['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (unmerged.length > 0) {
      throw new Error(
        `Worktree has ${unmerged.length} unmerged path(s): ${unmerged.slice(0, 5).join(', ')}; refusing to proceed`,
      );
    }
  }

  async writeBinaryNoRenamePatch(from: string, to: string, patchPath: string): Promise<void> {
    await this.withMutationQueue(async () => {
      const patch = await this.git.raw(['diff', '--binary', '--no-renames', `${from}..${to}`]);
      await fs.mkdir(dirname(patchPath), { recursive: true });
      await fs.writeFile(patchPath, patch, 'utf-8');
    });
  }

  async applyPatchFile3WayIndex(patchPath: string): Promise<void> {
    await this.withMutationQueue(async () => {
      await this.git.raw(['apply', '--3way', '--index', patchPath]);
    });
  }

  async commitStaged(commitMessage: string, author: string, authorEmail: string): Promise<GitCommitInfo> {
    return this.withMutationQueue(async () => {
      const stagedChanges = await this.git.diff(['--cached', '--name-only']);
      if (!stagedChanges.trim()) {
        const head = (await this.git.revparse(['HEAD'])).trim();
        const log = await this.git.log({ maxCount: 1 });
        const latest = log.latest;
        return {
          commitHash: head,
          shortHash: head.substring(0, 8),
          message: latest?.message ?? '',
          author: latest?.author_name ?? '',
          authorEmail: latest?.author_email ?? '',
          timestamp: latest?.date ?? new Date(0).toISOString(),
          committedDate: latest?.date ? new Date(latest.date).toISOString() : new Date(0).toISOString(),
          created: false,
        };
      }
      await this.git.commit(commitMessage, { '--author': `${author} <${authorEmail}>` });
      const head = (await this.git.revparse(['HEAD'])).trim();
      const log = await this.git.log({ maxCount: 1 });
      const latest = log.latest;
      return {
        commitHash: head,
        shortHash: head.substring(0, 8),
        message: latest?.message ?? commitMessage,
        author: latest?.author_name ?? author,
        authorEmail: latest?.author_email ?? authorEmail,
        timestamp: latest?.date ?? new Date().toISOString(),
        committedDate: latest?.date ? new Date(latest.date).toISOString() : new Date().toISOString(),
        created: true,
      };
    });
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new worktree at `path` with a new branch `branch` pointing at `startSha`.
   * Used by the memory agent to isolate per-session writes from interactive saves on main.
   */
  async addWorktree(path: string, branch: string, startSha: string): Promise<void> {
    await this.withMutationQueue(() => this.addWorktreeUnlocked(path, branch, startSha));
  }

  private async addWorktreeUnlocked(path: string, branch: string, startSha: string): Promise<void> {
    try {
      await this.git.raw(['worktree', 'add', '-b', branch, path, startSha]);
    } catch (error) {
      throw new Error(`Failed to add worktree at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Remove the worktree entry and its on-disk directory. Uses `--force` because session
   * worktrees are ktx-internal — a clean working tree is not required.
   */
  async removeWorktree(path: string): Promise<void> {
    await this.withMutationQueue(() => this.removeWorktreeUnlocked(path));
  }

  private async removeWorktreeUnlocked(path: string): Promise<void> {
    try {
      await this.git.raw(['worktree', 'remove', '--force', path]);
    } catch (error) {
      this.logger.warn(
        `removeWorktree failed for ${path}: ${error instanceof Error ? error.message : String(error)} — attempting prune`,
      );
      await this.git.raw(['worktree', 'prune']).catch(() => undefined);
    }
  }

  /**
   * List all worktrees attached to this repo, parsed from `worktree list --porcelain`.
   * The main worktree is included.
   */
  async listWorktrees(): Promise<WorktreeEntry[]> {
    const out = await this.git.raw(['worktree', 'list', '--porcelain']);
    const entries: WorktreeEntry[] = [];
    let current: Partial<WorktreeEntry> = {};
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) {
          entries.push({
            path: current.path,
            branch: current.branch ?? null,
            head: current.head ?? null,
          });
        }
        current = { path: line.slice('worktree '.length) };
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length);
      }
    }
    if (current.path) {
      entries.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head ?? null,
      });
    }
    return entries;
  }

  async deleteBranch(branch: string, force = false): Promise<void> {
    await this.withMutationQueue(() => this.git.raw(['branch', force ? '-D' : '-d', branch]));
  }

  /**
   * Lightweight factory returning a GitService instance whose simple-git client is scoped
   * to `workdir`. Used by memory-agent session worktrees. The returned instance shares
   * config and the logger with the parent; it does NOT run `onModuleInit`
   * (the main instance has already initialized the repo).
   */
  forWorktree(workdir: string): GitService {
    const scoped = new GitService(this.config, this.logger);
    scoped.git = createSimpleGit(workdir);
    scoped.configDir = workdir;
    return scoped;
  }

  async deleteDirectory(
    directoryPath: string,
    commitMessage: string,
    author: string,
    authorEmail: string,
  ): Promise<GitCommitInfo> {
    return this.withMutationQueue(() => this.deleteDirectoryUnlocked(directoryPath, commitMessage, author, authorEmail));
  }

  private async deleteDirectoryUnlocked(
    directoryPath: string,
    commitMessage: string,
    author: string,
    authorEmail: string,
  ): Promise<GitCommitInfo> {
    try {
      // Remove the directory recursively from git
      await this.git.rm(['-r', directoryPath]);

      // Commit the deletion
      const result = await this.git.commit(commitMessage, {
        '--author': `${author} <${authorEmail}>`,
      });

      if (!result.commit) {
        throw new Error('No commit hash returned');
      }

      // Get commit details
      const log = await this.git.log({ maxCount: 1 });
      const commit = log.latest;

      if (!commit) {
        throw new Error('Failed to retrieve commit details');
      }

      return {
        commitHash: commit.hash,
        shortHash: commit.hash.substring(0, 8),
        message: commit.message,
        author: commit.author_name,
        authorEmail: commit.author_email,
        timestamp: commit.date,
        committedDate: new Date(commit.date).toISOString(),
        created: true,
      };
    } catch (error) {
      this.logger.error(`Failed to delete directory ${directoryPath}`, error);
      throw new Error(`Failed to delete directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Remove multiple directories recursively and commit them as one change.
   * Paths that don't exist in the working tree are skipped silently (useful for GC
   * where the DB-known path has already been evicted by a previous run).
   * Returns a GitCommitInfo with created=false and an empty commitHash when no
   * paths were actually removed.
   */
  async deleteDirectories(
    directoryPaths: string[],
    commitMessage: string,
    author: string,
    authorEmail: string,
  ): Promise<GitCommitInfo> {
    return this.withMutationQueue(() =>
      this.deleteDirectoriesUnlocked(directoryPaths, commitMessage, author, authorEmail),
    );
  }

  private async deleteDirectoriesUnlocked(
    directoryPaths: string[],
    commitMessage: string,
    author: string,
    authorEmail: string,
  ): Promise<GitCommitInfo> {
    if (directoryPaths.length === 0) {
      return {
        commitHash: '',
        shortHash: '',
        message: commitMessage,
        author,
        authorEmail,
        timestamp: new Date().toISOString(),
        committedDate: new Date().toISOString(),
        created: false,
      };
    }
    const removed: string[] = [];
    for (const path of directoryPaths) {
      try {
        await this.git.rm(['-r', path]);
        removed.push(path);
      } catch (error) {
        this.logger.warn(
          `deleteDirectories: skipping ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (removed.length === 0) {
      return {
        commitHash: '',
        shortHash: '',
        message: commitMessage,
        author,
        authorEmail,
        timestamp: new Date().toISOString(),
        committedDate: new Date().toISOString(),
        created: false,
      };
    }

    const result = await this.git.commit(commitMessage, { '--author': `${author} <${authorEmail}>` });
    if (!result.commit) {
      throw new Error('No commit hash returned from deleteDirectories');
    }
    const log = await this.git.log({ maxCount: 1 });
    const commit = log.latest;
    if (!commit) {
      throw new Error('Failed to retrieve commit details after deleteDirectories');
    }
    return {
      commitHash: commit.hash,
      shortHash: commit.hash.substring(0, 8),
      message: commit.message,
      author: commit.author_name,
      authorEmail: commit.author_email,
      timestamp: commit.date,
      committedDate: new Date(commit.date).toISOString(),
      created: true,
    };
  }

  private async withMutationQueue<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.configDir;
    const previous = GitService.mutationQueues.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = previous.catch(() => undefined).then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    GitService.mutationQueues.set(key, current);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (GitService.mutationQueues.get(key) === current) {
        GitService.mutationQueues.delete(key);
      }
    }
  }
}
