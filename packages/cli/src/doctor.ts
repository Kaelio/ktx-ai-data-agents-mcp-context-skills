import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { KtxLocalProject, KtxProjectEmbeddingConfig } from '@ktx/context/project';
import type { KtxEmbeddingConfig, KtxEmbeddingHealthCheckOptions, KtxEmbeddingHealthCheckResult } from '@ktx/llm';
import type { HistoricSqlDoctorDeps } from './historic-sql-doctor.js';

const execFileAsync = promisify(execFile);

type DoctorStatus = 'pass' | 'warn' | 'fail';
type KtxDoctorOutputMode = 'plain' | 'json';
type KtxDoctorInputMode = 'auto' | 'disabled';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

interface DoctorReport {
  title: string;
  checks: DoctorCheck[];
}

export type KtxDoctorArgs =
  | { command: 'setup'; outputMode: KtxDoctorOutputMode; inputMode?: KtxDoctorInputMode }
  | { command: 'project'; projectDir: string; outputMode: KtxDoctorOutputMode; inputMode?: KtxDoctorInputMode };

interface KtxDoctorIo {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

interface SetupDoctorDeps {
  env?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
  execText?: (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<string>;
  pathExists?: (path: string) => Promise<boolean>;
  importBetterSqlite3?: () => Promise<unknown>;
}

type EmbeddingHealthCheck = (
  config: KtxEmbeddingConfig,
  options?: KtxEmbeddingHealthCheckOptions,
) => Promise<KtxEmbeddingHealthCheckResult>;

interface SemanticSearchDoctorDeps {
  env?: NodeJS.ProcessEnv;
  embeddingHealthCheck?: EmbeddingHealthCheck;
  embeddingProbeTimeoutMs?: number;
}

interface KtxDoctorDeps extends SemanticSearchDoctorDeps, HistoricSqlDoctorDeps {
  runSetupChecks?: () => Promise<DoctorCheck[]>;
  runHistoricSqlDoctorChecks?: (project: KtxLocalProject, deps: HistoricSqlDoctorDeps) => Promise<DoctorCheck[]>;
}

function workspaceRootDir(): string {
  return resolve(fileURLToPath(new URL('../../../', import.meta.url)));
}

async function defaultExecText(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return `${result.stdout}${result.stderr}`.trim();
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim().split('\n')[0] ?? error.message.trim();
  }
  return String(error);
}

function parseVersion(value: string): number[] {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return [];
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(value: string, minimum: [number, number, number]): boolean {
  const parsed = parseVersion(value);
  if (parsed.length !== 3) {
    return false;
  }
  for (let index = 0; index < minimum.length; index += 1) {
    if (parsed[index] > minimum[index]) return true;
    if (parsed[index] < minimum[index]) return false;
  }
  return true;
}

function check(status: DoctorStatus, id: string, label: string, detail: string, fix?: string): DoctorCheck {
  return fix ? { id, label, status, detail, fix } : { id, label, status, detail };
}

const SEMANTIC_SEARCH_HEALTH_TEXT = 'KTX semantic search doctor probe';
const SEMANTIC_SEARCH_HEALTH_TIMEOUT_MS = 5_000;
const SEMANTIC_SEARCH_LOCAL_HEALTH_TIMEOUT_MS = 120_000;

function semanticEmbeddingSetupFix(projectDir: string, backend: KtxProjectEmbeddingConfig['backend']): string {
  if (backend === 'openai') {
    return `Set OPENAI_API_KEY or rerun: ktx setup --project-dir ${projectDir} --embedding-backend openai --no-input`;
  }
  return `Run: ktx setup --project-dir ${projectDir} --no-input`;
}

function embeddingConfigLabel(config: KtxProjectEmbeddingConfig | KtxEmbeddingConfig): string {
  const model = config.model?.trim() || 'model not configured';
  return `${config.backend}/${model} (${config.dimensions}d)`;
}

function semanticLaneFallbackDetail(reason: string): string {
  return `${reason}. Semantic lane will be skipped; lexical, dictionary, and token lanes remain available.`;
}

async function defaultEmbeddingHealthCheck(
  config: KtxEmbeddingConfig,
  options?: KtxEmbeddingHealthCheckOptions,
): Promise<KtxEmbeddingHealthCheckResult> {
  const { runKtxEmbeddingHealthCheck } = await import('@ktx/llm');
  return runKtxEmbeddingHealthCheck(config, options);
}

async function runSemanticSearchEmbeddingCheck(
  config: KtxProjectEmbeddingConfig,
  projectDir: string,
  deps: SemanticSearchDoctorDeps = {},
): Promise<DoctorCheck> {
  if (config.backend === 'none' || config.backend === 'deterministic') {
    return check(
      'warn',
      'semantic-search-embeddings',
      'Semantic search embeddings',
      semanticLaneFallbackDetail(`ingest.embeddings.backend is ${config.backend}`),
      semanticEmbeddingSetupFix(projectDir, config.backend),
    );
  }

  try {
    const { resolveLocalKtxEmbeddingConfig } = await import('@ktx/context');
    const resolved = resolveLocalKtxEmbeddingConfig(config, deps.env ?? process.env);
    if (!resolved) {
      return check(
        'warn',
        'semantic-search-embeddings',
        'Semantic search embeddings',
        semanticLaneFallbackDetail(`No runtime embedding config resolved for ${embeddingConfigLabel(config)}`),
        semanticEmbeddingSetupFix(projectDir, config.backend),
      );
    }

    const healthCheck = deps.embeddingHealthCheck ?? defaultEmbeddingHealthCheck;
    const timeoutMs =
      deps.embeddingProbeTimeoutMs ??
      (resolved.backend === 'sentence-transformers'
        ? SEMANTIC_SEARCH_LOCAL_HEALTH_TIMEOUT_MS
        : SEMANTIC_SEARCH_HEALTH_TIMEOUT_MS);
    const health = await healthCheck(resolved, {
      text: SEMANTIC_SEARCH_HEALTH_TEXT,
      timeoutMs,
    });
    if (health.ok) {
      return check(
        'pass',
        'semantic-search-embeddings',
        'Semantic search embeddings',
        `${embeddingConfigLabel(resolved)} probe succeeded`,
      );
    }

    return check(
      'warn',
      'semantic-search-embeddings',
      'Semantic search embeddings',
      semanticLaneFallbackDetail(`${embeddingConfigLabel(resolved)} probe failed: ${health.message}`),
      semanticEmbeddingSetupFix(projectDir, config.backend),
    );
  } catch (error) {
    return check(
      'warn',
      'semantic-search-embeddings',
      'Semantic search embeddings',
      semanticLaneFallbackDetail(`${embeddingConfigLabel(config)} probe failed: ${failureMessage(error)}`),
      semanticEmbeddingSetupFix(projectDir, config.backend),
    );
  }
}

export async function runSetupDoctorChecks(deps: SetupDoctorDeps = {}): Promise<DoctorCheck[]> {
  const env = deps.env ?? process.env;
  const root = deps.workspaceRoot ?? workspaceRootDir();
  const execText = deps.execText ?? defaultExecText;
  const pathExists = deps.pathExists ?? defaultPathExists;
  const importBetterSqlite3 = deps.importBetterSqlite3 ?? (() => import('better-sqlite3'));
  const checks: DoctorCheck[] = [];

  const nodeDetail = `${process.version} ABI ${process.versions.modules}`;
  checks.push(
    versionAtLeast(process.version, [22, 0, 0])
      ? check('pass', 'node', 'Node 22+', nodeDetail)
      : check('fail', 'node', 'Node 22+', nodeDetail, 'Install Node 22 or newer, then rerun `pnpm run setup:dev`'),
  );

  try {
    const pnpmVersion = await execText('pnpm', ['--version'], { cwd: root, env });
    checks.push(
      versionAtLeast(pnpmVersion, [10, 20, 0])
        ? check('pass', 'pnpm', 'pnpm 10.20+', pnpmVersion)
        : check(
            'fail',
            'pnpm',
            'pnpm 10.20+',
            pnpmVersion,
            'Run: corepack enable && corepack prepare pnpm@10.28.0 --activate',
          ),
    );
  } catch (error) {
    checks.push(
      check(
        'fail',
        'pnpm',
        'pnpm 10.20+',
        failureMessage(error),
        'Run: corepack enable && corepack prepare pnpm@10.28.0 --activate',
      ),
    );
  }

  try {
    const corepackVersion = await execText('corepack', ['--version'], { cwd: root, env });
    checks.push(check('pass', 'corepack', 'Corepack', corepackVersion));
  } catch (error) {
    checks.push(check('warn', 'corepack', 'Corepack', failureMessage(error), 'Run: corepack enable'));
  }

  try {
    const uvVersion = await execText('uv', ['--version'], { cwd: root, env });
    checks.push(check('pass', 'uv', 'uv', uvVersion));
  } catch (error) {
    checks.push(check('fail', 'uv', 'uv', failureMessage(error), 'Install uv, then rerun `pnpm run setup:dev`'));
  }

  try {
    await importBetterSqlite3();
    checks.push(check('pass', 'native-sqlite', 'Native SQLite', 'better-sqlite3 loaded'));
  } catch (error) {
    checks.push(
      check('fail', 'native-sqlite', 'Native SQLite', failureMessage(error), 'Run: pnpm run native:rebuild'),
    );
  }

  const cliBin = join(root, 'packages/cli/dist/bin.js');
  if (await pathExists(cliBin)) {
    checks.push(check('pass', 'package-build', 'TypeScript package build', 'packages/cli/dist/bin.js exists'));
  } else {
    checks.push(
      check(
        'fail',
        'package-build',
        'TypeScript package build',
        'Missing packages/cli/dist/bin.js',
        'Run: pnpm run build',
      ),
    );
  }

  try {
    const output = await execText(process.execPath, [cliBin, '--version'], { cwd: root, env });
    checks.push(check('pass', 'workspace-cli', 'Workspace-local CLI', output));
  } catch (error) {
    checks.push(
      check(
        'fail',
        'workspace-cli',
        'Workspace-local CLI',
        failureMessage(error),
        'Run: pnpm run build && pnpm run ktx -- --version',
      ),
    );
  }

  return checks;
}

async function runProjectChecks(projectDir: string, deps: KtxDoctorDeps = {}): Promise<DoctorCheck[]> {
  const { loadKtxProject } = await import('@ktx/context/project');
  const checks: DoctorCheck[] = [];
  try {
    const project = await loadKtxProject({ projectDir });
    checks.push(check('pass', 'project-config', 'Project config', project.config.project));
    const connectionCount = Object.keys(project.config.connections).length;
    checks.push(
      connectionCount > 0
        ? check('pass', 'connections', 'Connections', `${connectionCount} configured`)
        : check(
            'warn',
            'connections',
            'Connections',
            '0 configured',
            'Add a connection to ktx.yaml or run `ktx setup`',
          ),
    );
    checks.push(check('pass', 'storage', 'Storage', `${project.config.storage.state}/${project.config.storage.search}`));
    checks.push(check('pass', 'llm-provider', 'LLM provider', project.config.llm.provider.backend));
    checks.push(await runSemanticSearchEmbeddingCheck(project.config.ingest.embeddings, projectDir, deps));
    const runHistoricSqlDoctorChecks =
      deps.runHistoricSqlDoctorChecks ?? (await import('./historic-sql-doctor.js')).runPostgresHistoricSqlDoctorChecks;
    checks.push(...(await runHistoricSqlDoctorChecks(project, deps)));
  } catch (error) {
    checks.push(
      check(
        'fail',
        'project-config',
        'Project config',
        failureMessage(error),
        `Run: ktx init ${projectDir} --name <project-name>`,
      ),
    );
  }
  return checks;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [report.title];
  for (const item of report.checks) {
    lines.push(`${item.status.toUpperCase()} ${item.label}: ${item.detail}`);
    if (item.fix) {
      lines.push(`     Fix: ${item.fix}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function hasFailures(report: DoctorReport): boolean {
  return report.checks.some((item) => item.status === 'fail');
}

function writeReport(report: DoctorReport, outputMode: KtxDoctorOutputMode, io: KtxDoctorIo): void {
  if (outputMode === 'json') {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  io.stdout.write(formatDoctorReport(report));
}

export async function runKtxDoctor(
  args: KtxDoctorArgs,
  io: KtxDoctorIo = process,
  deps: KtxDoctorDeps = {},
): Promise<number> {
  try {
    const runSetupChecks = deps.runSetupChecks ?? (() => runSetupDoctorChecks());
    const setupChecks = await runSetupChecks();
    const report: DoctorReport =
      args.command === 'setup'
        ? { title: 'KTX setup doctor', checks: setupChecks }
        : {
            title: 'KTX project doctor',
            checks: [...setupChecks, ...(await runProjectChecks(args.projectDir, deps))],
          };

    writeReport(report, args.outputMode, io);
    return hasFailures(report) ? 1 : 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
