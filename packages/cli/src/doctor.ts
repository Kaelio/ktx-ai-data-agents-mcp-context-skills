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
type DoctorGroup = 'toolchain' | 'project' | 'search' | 'history';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
  group?: DoctorGroup;
}

interface DoctorReport {
  title: string;
  checks: DoctorCheck[];
}

export type KtxDoctorArgs =
  | {
      command: 'setup';
      outputMode: KtxDoctorOutputMode;
      inputMode?: KtxDoctorInputMode;
      verbose?: boolean;
    }
  | {
      command: 'project';
      projectDir: string;
      outputMode: KtxDoctorOutputMode;
      inputMode?: KtxDoctorInputMode;
      verbose?: boolean;
    };

interface KtxDoctorIo {
  stdout: { isTTY?: boolean; write(chunk: string): void };
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

  return checks.map((entry) => ({ ...entry, group: 'toolchain' }));
}

interface ProjectChecksResult {
  checks: DoctorCheck[];
  projectName?: string;
}

async function runProjectChecks(projectDir: string, deps: KtxDoctorDeps = {}): Promise<ProjectChecksResult> {
  const { loadKtxProject } = await import('@ktx/context/project');
  const checks: DoctorCheck[] = [];
  let projectName: string | undefined;
  const tag = (entry: DoctorCheck, group: DoctorGroup): DoctorCheck => ({ ...entry, group });
  try {
    const project = await loadKtxProject({ projectDir });
    projectName = project.config.project;
    checks.push(tag(check('pass', 'project-config', 'Project config', project.config.project), 'project'));
    const connectionCount = Object.keys(project.config.connections).length;
    checks.push(
      tag(
        connectionCount > 0
          ? check('pass', 'connections', 'Connections', `${connectionCount} configured`)
          : check(
              'warn',
              'connections',
              'Connections',
              '0 configured',
              'Add a connection to ktx.yaml or run `ktx setup`',
            ),
        'project',
      ),
    );
    checks.push(
      tag(
        check('pass', 'storage', 'Storage', `${project.config.storage.state}/${project.config.storage.search}`),
        'project',
      ),
    );
    checks.push(tag(check('pass', 'llm-provider', 'LLM provider', project.config.llm.provider.backend), 'project'));
    checks.push(tag(await runSemanticSearchEmbeddingCheck(project.config.ingest.embeddings, projectDir, deps), 'search'));
    const runHistoricSqlDoctorChecks =
      deps.runHistoricSqlDoctorChecks ?? (await import('./historic-sql-doctor.js')).runPostgresHistoricSqlDoctorChecks;
    const historic = await runHistoricSqlDoctorChecks(project, deps);
    for (const entry of historic) {
      checks.push(tag(entry, 'history'));
    }
  } catch (error) {
    checks.push(
      tag(
        check(
          'fail',
          'project-config',
          'Project config',
          failureMessage(error),
          `Run: ktx init ${projectDir} --name <project-name>`,
        ),
        'project',
      ),
    );
  }
  return { checks, projectName };
}

const STATUS_SYMBOL: Record<DoctorStatus, string> = { pass: '✓', warn: '⚠', fail: '✗' };

const GROUP_ORDER: DoctorGroup[] = ['toolchain', 'project', 'search', 'history'];

const GROUP_LABEL: Record<DoctorGroup, string> = {
  toolchain: 'Environment',
  project: 'Project',
  search: 'Semantic search',
  history: 'Query history',
};

function shouldUseColor(io: KtxDoctorIo): boolean {
  if (io.stdout.isTTY !== true) return false;
  const env = process.env;
  return !env.NO_COLOR && env.TERM !== 'dumb' && !env.CI;
}

function styleStatus(useColor: boolean, status: DoctorStatus, text: string): string {
  if (!useColor) return text;
  const code = status === 'pass' ? 32 : status === 'warn' ? 33 : 31;
  return `\u001b[${code}m${text}\u001b[39m`;
}

function styleDim(useColor: boolean, text: string): string {
  return useColor ? `\u001b[2m${text}\u001b[22m` : text;
}

function styleBold(useColor: boolean, text: string): string {
  return useColor ? `\u001b[1m${text}\u001b[22m` : text;
}

function groupOf(entry: DoctorCheck): DoctorGroup {
  return entry.group ?? 'project';
}

function aggregateStatus(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'pass';
}

function abbreviateHome(filePath: string | undefined): string | undefined {
  if (!filePath) return filePath;
  const home = process.env.HOME;
  if (home && (filePath === home || filePath.startsWith(`${home}/`))) {
    return filePath === home ? '~' : `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

function groupSummaryWhenAllPass(entries: DoctorCheck[]): string {
  if (entries.length === 1) {
    const only = entries[0]!;
    return only.detail || only.label;
  }
  return entries.map((c) => c.label).join(' · ');
}

interface RenderOptions {
  verbose: boolean;
  useColor: boolean;
  durationMs?: number;
  projectName?: string;
  projectDir?: string;
  command?: 'setup' | 'project';
}

const NEXT_STEPS_PROJECT = ['ktx scan', 'ktx wiki', 'ktx sl ask "…"'];

export function formatDoctorReport(report: DoctorReport, options: Partial<RenderOptions> = {}): string {
  const opts: RenderOptions = {
    verbose: options.verbose ?? false,
    useColor: options.useColor ?? false,
    durationMs: options.durationMs,
    projectName: options.projectName,
    projectDir: options.projectDir,
    command: options.command,
  };
  return renderPlainReport(report, opts);
}

function renderSetupReport(report: DoctorReport, options: RenderOptions): string {
  const { verbose, useColor } = options;
  const dim = (text: string) => styleDim(useColor, text);
  const bold = (text: string) => styleBold(useColor, text);
  const status = (s: DoctorStatus, text: string) => styleStatus(useColor, s, text);
  const symbol = (s: DoctorStatus) => status(s, STATUS_SYMBOL[s]);

  const fails = report.checks.filter((c) => c.status === 'fail');
  const lines: string[] = [];
  lines.push(bold(report.title));
  lines.push('');
  lines.push(`  No project here yet.`);
  lines.push('');

  if (fails.length > 0) {
    lines.push(`  Before you can run ${bold('ktx setup')}, fix this:`);
    for (const entry of fails) {
      lines.push(`      ${symbol('fail')} ${entry.label}: ${entry.detail}`);
      if (entry.fix) {
        lines.push(`        ${dim(`→ ${entry.fix}`)}`);
      }
    }
    lines.push('');
  } else {
    lines.push(`  Run  ${bold('ktx setup')}  to get started.`);
    lines.push('');
  }

  if (verbose) {
    lines.push(dim('  Toolchain:'));
    for (const entry of report.checks) {
      lines.push(`      ${symbol(entry.status)} ${entry.label}: ${entry.detail}`);
      if (entry.fix && entry.status !== 'pass') {
        lines.push(`        ${dim(`→ ${entry.fix}`)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderPlainReport(report: DoctorReport, options: RenderOptions): string {
  if (options.command === 'setup') return renderSetupReport(report, options);
  const { verbose, useColor, durationMs, projectName, projectDir } = options;
  const dim = (text: string) => styleDim(useColor, text);
  const bold = (text: string) => styleBold(useColor, text);
  const status = (s: DoctorStatus, text: string) => styleStatus(useColor, s, text);
  const symbol = (s: DoctorStatus) => status(s, STATUS_SYMBOL[s]);

  const lines: string[] = [];
  const titleParts: string[] = [bold(report.title)];
  if (projectName) titleParts.push(projectName);
  const abbreviatedDir = abbreviateHome(projectDir);
  const titleLine = titleParts.join(` ${dim('·')} `);
  const dirSuffix = abbreviatedDir ? ` ${dim(`(${abbreviatedDir})`)}` : '';
  lines.push(`${titleLine}${dirSuffix}`);
  lines.push('');

  const groups = new Map<DoctorGroup, DoctorCheck[]>();
  for (const entry of report.checks) {
    const group = groupOf(entry);
    const bucket = groups.get(group) ?? [];
    bucket.push(entry);
    groups.set(group, bucket);
  }

  const orderedGroups: DoctorGroup[] = [];
  for (const g of GROUP_ORDER) {
    if (groups.has(g)) orderedGroups.push(g);
  }
  for (const g of groups.keys()) {
    if (!orderedGroups.includes(g)) orderedGroups.push(g);
  }

  const labelWidth = orderedGroups.reduce(
    (max, g) => Math.max(max, (GROUP_LABEL[g] ?? g).length),
    0,
  );

  for (const group of orderedGroups) {
    const entries = groups.get(group) ?? [];
    const head = aggregateStatus(entries);
    const nonPass = entries.filter((c) => c.status !== 'pass');
    const label = (GROUP_LABEL[group] ?? group).padEnd(labelWidth);

    if (nonPass.length === 0) {
      lines.push(`  ${symbol(head)} ${label}    ${dim(groupSummaryWhenAllPass(entries))}`);
      if (verbose) {
        for (const entry of entries) {
          lines.push(`      ${symbol(entry.status)} ${entry.label}: ${entry.detail}`);
        }
      }
      continue;
    }

    if (entries.length === 1) {
      const only = entries[0]!;
      lines.push(`  ${symbol(only.status)} ${label}    ${only.detail}`);
      if (only.fix) {
        lines.push(`  ${' '.repeat(2 + labelWidth + 4)}${dim(`→ ${only.fix}`)}`);
      }
      continue;
    }

    lines.push(`  ${symbol(head)} ${label}    ${dim(`${nonPass.length} of ${entries.length} need attention`)}`);
    for (const entry of entries) {
      if (entry.status === 'pass' && !verbose) continue;
      lines.push(`      ${symbol(entry.status)} ${entry.label}: ${entry.detail}`);
      if (entry.fix) {
        lines.push(`        ${dim(`→ ${entry.fix}`)}`);
      }
    }
  }

  lines.push('');

  const totalFail = report.checks.filter((c) => c.status === 'fail').length;
  const totalWarn = report.checks.filter((c) => c.status === 'warn').length;
  const durationText = durationMs !== undefined ? ` ${dim(`(${(durationMs / 1000).toFixed(2)}s)`)}` : '';

  if (totalFail === 0 && totalWarn === 0) {
    const hint = `  ${dim('Try:')} ${NEXT_STEPS_PROJECT.join(dim('  ·  '))}`;
    lines.push(`${status('pass', 'Everything ready.')}${hint}${durationText}`);
  } else if (totalFail === 0) {
    const word = totalWarn === 1 ? 'warning' : 'warnings';
    lines.push(
      `${status('warn', `${totalWarn} ${word}.`)} ${dim('Run')} ktx status --verbose ${dim('for full details.')}${durationText}`,
    );
  } else {
    const fWord = totalFail === 1 ? 'issue' : 'issues';
    const warnSuffix =
      totalWarn > 0
        ? ` ${dim('·')} ${status('warn', `${totalWarn} ${totalWarn === 1 ? 'warning' : 'warnings'}`)}`
        : '';
    lines.push(
      `${status('fail', `${totalFail} ${fWord} to fix.`)}${warnSuffix}${durationText}`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

function hasFailures(report: DoctorReport): boolean {
  return report.checks.some((item) => item.status === 'fail');
}

function writeReport(report: DoctorReport, outputMode: KtxDoctorOutputMode, io: KtxDoctorIo, options: RenderOptions): void {
  if (outputMode === 'json') {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  io.stdout.write(renderPlainReport(report, options));
}

export async function runKtxDoctor(
  args: KtxDoctorArgs,
  io: KtxDoctorIo = process,
  deps: KtxDoctorDeps = {},
): Promise<number> {
  const startedAt = Date.now();
  try {
    const runSetupChecks = deps.runSetupChecks ?? (() => runSetupDoctorChecks());
    const setupChecks = await runSetupChecks();
    let projectName: string | undefined;
    let projectDir: string | undefined;
    let report: DoctorReport;
    if (args.command === 'setup') {
      report = { title: 'KTX status', checks: setupChecks };
    } else {
      const projectResult = await runProjectChecks(args.projectDir, deps);
      projectName = projectResult.projectName;
      projectDir = args.projectDir;
      report = {
        title: 'KTX status',
        checks: [...setupChecks, ...projectResult.checks],
      };
    }

    const renderOptions: RenderOptions = {
      verbose: args.verbose ?? false,
      useColor: shouldUseColor(io),
      durationMs: Date.now() - startedAt,
      projectName,
      projectDir,
      command: args.command,
    };
    writeReport(report, args.outputMode, io, renderOptions);
    return hasFailures(report) ? 1 : 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
