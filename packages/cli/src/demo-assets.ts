import { constants as fsConstants } from 'node:fs';
import { access, copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

interface DemoProjectResult {
  projectDir: string;
  configPath: string;
  databasePath: string;
  replayPath: string;
}

interface EnsureDemoProjectOptions {
  projectDir: string;
  force: boolean;
}

export const DEMO_CONNECTION_ID = 'orbit_demo';
export const DEMO_ADAPTER = 'live-database';
export const DEMO_REPLAY_FILE = 'replay.memory-flow.v1.json';

const REQUIRED_PACKAGED_BASE_ASSET_PATHS = ['demo.db', 'manifest.json', DEMO_REPLAY_FILE] as const;

const REQUIRED_SEEDED_ASSET_PATHS = [
  'demo.db',
  'manifest.json',
  DEMO_REPLAY_FILE,
  join('semantic-layer', 'dbt-main', 'mart_arr_daily.yaml'),
  join('semantic-layer', 'postgres-warehouse', 'mart_account_activity.yaml'),
  join('wiki', 'global', 'orbit-company-overview.md'),
] as const;

function assetDir(): string {
  return fileURLToPath(new URL('../assets/demo/orbit/', import.meta.url));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function defaultDemoProjectDir(): string {
  const suffix = randomBytes(4).toString('hex');
  return join(tmpdir(), `ktx-demo-${suffix}`);
}

function demoConfig(databasePath: string): string {
  return [
    'project: ktx-demo-orbit',
    'connections:',
    `  ${DEMO_CONNECTION_ID}:`,
    '    driver: sqlite',
    `    path: ${JSON.stringify(databasePath)}`,
    'storage:',
    '  state: sqlite',
    '  search: sqlite-fts5',
    '  git:',
    '    auto_commit: true',
    '    author: ktx <ktx@example.com>',
    'llm:',
    '  provider:',
    '    backend: anthropic',
    '    anthropic:',
    '      api_key: env:ANTHROPIC_API_KEY',
    '  models:',
    '    default: claude-sonnet-4-6',
    'ingest:',
    '  adapters:',
    `    - ${DEMO_ADAPTER}`,
    '  embeddings:',
    '    backend: none',
    '    dimensions: 8',
    '  workUnits:',
    '    stepBudget: 40',
    '    maxConcurrency: 1',
    '    failureMode: continue',
    '',
  ].join('\n');
}

async function copyPackagedReplay(projectDir: string): Promise<string> {
  const replayDir = join(projectDir, 'replays');
  await mkdir(replayDir, { recursive: true });
  const replayPath = join(replayDir, DEMO_REPLAY_FILE);
  await copyFile(join(assetDir(), DEMO_REPLAY_FILE), replayPath);
  return replayPath;
}

async function assertPackagedBaseAssetsPresent(): Promise<void> {
  const missing: string[] = [];
  for (const relativePath of REQUIRED_PACKAGED_BASE_ASSET_PATHS) {
    if (!(await exists(join(assetDir(), relativePath)))) {
      missing.push(relativePath);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Packaged demo assets are incomplete: missing ${missing.join(', ')}`);
  }
}

async function assertPackagedSeededAssetsPresent(): Promise<void> {
  const missing: string[] = [];
  for (const relativePath of REQUIRED_SEEDED_ASSET_PATHS) {
    if (!(await exists(join(assetDir(), relativePath)))) {
      missing.push(relativePath);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Packaged seeded demo assets are incomplete: missing ${missing.join(', ')}`);
  }
}

export async function ensureDemoProject(options: EnsureDemoProjectOptions): Promise<DemoProjectResult> {
  const projectDir = resolve(options.projectDir);
  const configPath = join(projectDir, 'ktx.yaml');
  if (!options.force && (await exists(configPath))) {
    throw new Error(`Demo project already exists at ${projectDir}; pass --force to recreate it`);
  }

  await assertPackagedBaseAssetsPresent();

  if (options.force) {
    await rm(projectDir, { recursive: true, force: true });
  }

  await mkdir(projectDir, { recursive: true });
  for (const relativeDir of ['reports', 'semantic-layer', 'wiki', 'replays', 'raw-sources', 'links']) {
    await mkdir(join(projectDir, relativeDir), { recursive: true });
  }

  const databasePath = join(projectDir, 'demo.db');
  await copyFile(join(assetDir(), 'demo.db'), databasePath);
  await writeFile(join(projectDir, 'state.sqlite'), '', { flag: 'a' });
  await copyFile(join(assetDir(), 'manifest.json'), join(projectDir, 'manifest.json'));
  const replayPath = await copyPackagedReplay(projectDir);
  await writeFile(configPath, demoConfig(databasePath), 'utf-8');

  return { projectDir, configPath, databasePath, replayPath };
}

async function copyDirIfExists(src: string, dest: string): Promise<void> {
  if (await exists(src)) {
    await cp(src, dest, { recursive: true });
  }
}

async function copySeededAssetDirectories(projectDir: string): Promise<void> {
  const src = assetDir();
  const dest = resolve(projectDir);

  await Promise.all([
    copyDirIfExists(join(src, 'semantic-layer'), join(dest, 'semantic-layer')),
    copyDirIfExists(join(src, 'wiki'), join(dest, 'wiki')),
    copyDirIfExists(join(src, 'raw-sources'), join(dest, 'raw-sources')),
    copyDirIfExists(join(src, 'links'), join(dest, 'links')),
    copyDirIfExists(join(src, 'reports'), join(dest, 'reports')),
  ]);
}

export async function ensureSeededDemoProject(options: EnsureDemoProjectOptions): Promise<DemoProjectResult> {
  await assertPackagedSeededAssetsPresent();
  const projectDir = resolve(options.projectDir);
  const result = await ensureDemoProject(options).catch((error) => {
    if (!options.force && error instanceof Error && error.message.includes('Demo project already exists')) {
      return {
        projectDir,
        configPath: join(projectDir, 'ktx.yaml'),
        databasePath: join(projectDir, 'demo.db'),
        replayPath: join(projectDir, 'replays', DEMO_REPLAY_FILE),
      };
    }
    throw error;
  });

  await copySeededAssetDirectories(result.projectDir);
  return result;
}
