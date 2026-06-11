import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { classifyKtxRepoOwnership, GitService, KtxForeignGitRepositoryError } from '../../context/core/git.service.js';
import { type KtxCoreConfig, type KtxLogger, noopLogger } from '../../context/core/config.js';
import type { KtxProjectConfig } from './config.js';
import { buildDefaultKtxProjectConfig, parseKtxProjectConfig, serializeKtxProjectConfig } from './config.js';
import { LocalGitFileStore } from './local-git-file-store.js';

export interface InitKtxProjectOptions {
  projectDir: string;
  force?: boolean;
  authorName?: string;
  authorEmail?: string;
  logger?: KtxLogger;
}

export interface LoadKtxProjectOptions {
  projectDir: string;
  authorName?: string;
  authorEmail?: string;
  logger?: KtxLogger;
}

export interface KtxLocalProject {
  projectDir: string;
  configPath: string;
  config: KtxProjectConfig;
  coreConfig: KtxCoreConfig;
  git: GitService;
  fileStore: LocalGitFileStore;
}

export interface InitKtxProjectResult extends KtxLocalProject {
  commitHash: string | null;
}

const TRACKED_SCAFFOLD_FILES: Array<{ path: string; content: string }> = [
  {
    path: '.ktx/.gitignore',
    content: 'cache/\ndb.sqlite\ndb.sqlite-*\ningest-transcripts/\nsecrets/\nsetup/\nagents/\n',
  },
  { path: '.ktx/prompts/.gitkeep', content: '' },
  { path: '.ktx/skills/.gitkeep', content: '' },
  { path: 'wiki/global/.gitkeep', content: '' },
  { path: 'semantic-layer/.gitkeep', content: '' },
  { path: 'raw-sources/.gitkeep', content: '' },
];

function createCoreConfig(projectDir: string, authorName: string, authorEmail: string): KtxCoreConfig {
  return {
    storage: {
      configDir: projectDir,
      homeDir: dirname(projectDir),
      worktreesDir: join(projectDir, '.ktx/worktrees'),
    },
    git: {
      userName: authorName,
      userEmail: authorEmail,
      bootstrapMessage: 'Initialize ktx project repository',
      bootstrapAuthor: authorName,
      bootstrapAuthorEmail: authorEmail,
    },
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = join(projectDir, relativePath);
  await fs.mkdir(dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf-8');
}

async function createRuntime(
  projectDir: string,
  config: KtxProjectConfig,
  authorName: string,
  authorEmail: string,
  logger: KtxLogger,
): Promise<KtxLocalProject> {
  const coreConfig = createCoreConfig(projectDir, authorName, authorEmail);
  const git = new GitService(coreConfig, logger);
  await git.onModuleInit();

  return {
    projectDir,
    configPath: join(projectDir, 'ktx.yaml'),
    config,
    coreConfig,
    git,
    fileStore: new LocalGitFileStore({ rootDir: projectDir, git }),
  };
}

export async function initKtxProject(options: InitKtxProjectOptions): Promise<InitKtxProjectResult> {
  const projectDir = resolve(options.projectDir);
  const projectName = basename(projectDir) || 'ktx-project';
  const authorName = options.authorName ?? 'ktx';
  const authorEmail = options.authorEmail ?? 'ktx@example.com';
  const logger = options.logger ?? noopLogger;
  const configPath = join(projectDir, 'ktx.yaml');

  await fs.mkdir(projectDir, { recursive: true });
  if (!options.force && (await fileExists(configPath))) {
    throw new Error(`Project already contains ktx.yaml: ${configPath}`);
  }

  // Refuse to adopt a repo ktx did not create. This must run before ktx.yaml is
  // written, because once that file exists the directory classifies as
  // ktx-managed. GitService re-checks on init, but it can only catch a foreign
  // repo while ktx.yaml is still absent — and `ktx init`/`admin --force` reach
  // here without the setup wizard's own pre-flight, so this is their guard.
  if ((await classifyKtxRepoOwnership(projectDir)) === 'foreign') {
    throw new KtxForeignGitRepositoryError(projectDir);
  }

  const config = buildDefaultKtxProjectConfig();

  // Write the scaffold tree first, ktx.yaml second, and only then initialize
  // git. The root ktx.yaml is ktx's ownership signal, so this ordering makes an
  // interrupted init unambiguous at every point: before the ktx.yaml write the
  // directory has no `.git` and no ktx.yaml (a rerun starts clean), and from the
  // ktx.yaml write onward — with or without `.git` — the directory classifies as
  // ktx's own (unowned or ktx-managed), never as a foreign repo. ktx.yaml going
  // last among the file writes also means its presence implies a complete
  // scaffold. Recovery happens on the next `loadKtxProject`, not by re-running
  // this function: `GitService.initialize()` re-creates a missing `.git` for an
  // `unowned` dir and recognizes an existing one for a `ktx-managed` dir. That
  // load path is what every command and the setup wizard's resume branch run, so
  // re-running `initKtxProject` itself keeps refusing an existing ktx.yaml
  // without `--force` (its contract). The ordering's only job is to rule out the
  // unrecoverable residue: a bare `.git` with no ktx.yaml, misread as foreign.
  await fs.mkdir(join(projectDir, '.ktx/cache'), { recursive: true });
  for (const file of TRACKED_SCAFFOLD_FILES) {
    await writeProjectFile(projectDir, file.path, file.content);
  }
  await writeProjectFile(projectDir, 'ktx.yaml', serializeKtxProjectConfig(config));

  const runtime = await createRuntime(projectDir, config, authorName, authorEmail, logger);

  const commit = await runtime.git.commitFiles(
    ['ktx.yaml', ...TRACKED_SCAFFOLD_FILES.map((file) => file.path)],
    `Initialize KTX project: ${projectName}`,
    authorName,
    authorEmail,
  );

  return {
    ...runtime,
    commitHash: commit.commitHash,
  };
}

export async function loadKtxProject(options: LoadKtxProjectOptions): Promise<KtxLocalProject> {
  const projectDir = resolve(options.projectDir);
  const authorName = options.authorName ?? 'ktx';
  const authorEmail = options.authorEmail ?? 'ktx@example.com';
  const logger = options.logger ?? noopLogger;
  const configPath = join(projectDir, 'ktx.yaml');
  const raw = await fs.readFile(configPath, 'utf-8');
  // Tolerant, read-only parse. A ktx.yaml written by a different ktx version may carry
  // keys this version does not recognize; they are stripped from the in-memory config so
  // every command still runs. The file on disk is deliberately left untouched — loading
  // must never silently rewrite the user's config, which would permanently delete a typo
  // or a field belonging to a newer ktx. `ktx doctor` surfaces the ignored fields, and the
  // next legitimate write (e.g. `ktx setup`) re-serializes the cleaned config.
  const config = parseKtxProjectConfig(raw);
  return createRuntime(projectDir, config, authorName, authorEmail, logger);
}
