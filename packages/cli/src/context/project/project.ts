import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { GitService } from '../../context/core/git.service.js';
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

  const config = buildDefaultKtxProjectConfig();
  const runtime = await createRuntime(projectDir, config, authorName, authorEmail, logger);

  await writeProjectFile(projectDir, 'ktx.yaml', serializeKtxProjectConfig(config));
  await fs.mkdir(join(projectDir, '.ktx/cache'), { recursive: true });
  for (const file of TRACKED_SCAFFOLD_FILES) {
    await writeProjectFile(projectDir, file.path, file.content);
  }

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
  const config = parseKtxProjectConfig(raw);
  return createRuntime(projectDir, config, authorName, authorEmail, logger);
}
