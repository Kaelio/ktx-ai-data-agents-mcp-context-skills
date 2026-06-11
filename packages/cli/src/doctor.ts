import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { KtxConfigIssue } from './context/project/config.js';
import { shouldUseColorOutput } from './io/tty.js';
import { KTX_NEXT_STEP_DIRECT_COMMANDS } from './next-steps.js';
import type { BuildProjectStatusOptions } from './status-project.js';

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
      fast?: boolean;
    }
  | {
      command: 'validate';
      projectDir: string;
      outputMode: KtxDoctorOutputMode;
      inputMode?: KtxDoctorInputMode;
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

interface KtxDoctorDeps extends BuildProjectStatusOptions {
  runSetupChecks?: () => Promise<DoctorCheck[]>;
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

const STATUS_SYMBOL: Record<DoctorStatus, string> = { pass: '✓', warn: '⚠', fail: '✗' };

const GROUP_ORDER: DoctorGroup[] = ['toolchain', 'project', 'search', 'history'];

const GROUP_LABEL: Record<DoctorGroup, string> = {
  toolchain: 'Environment',
  project: 'Project',
  search: 'Semantic search',
  history: 'Query history',
};

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

const NEXT_STEPS_PROJECT = KTX_NEXT_STEP_DIRECT_COMMANDS.map((step) => step.command);

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

export function renderInvalidConfigMessage(
  projectDir: string,
  issues: KtxConfigIssue[],
  outputMode: KtxDoctorOutputMode,
  io: KtxDoctorIo,
): void {
  if (outputMode === 'json') {
    io.stdout.write(
      `${JSON.stringify(
        {
          error: 'invalid_config',
          projectDir,
          issues,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const useColor = shouldUseColorOutput(io.stdout);
  const dim = (text: string) => styleDim(useColor, text);
  const bold = (text: string) => styleBold(useColor, text);
  const status = (s: DoctorStatus, text: string) => styleStatus(useColor, s, text);
  const abbreviated = abbreviateHome(projectDir) ?? projectDir;

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.length - errorCount;

  const lines: string[] = [];
  lines.push(`${bold('KTX status')} ${dim('·')} ${abbreviated}`);
  lines.push('');
  lines.push(
    `  ${status('fail', '✗')} ${bold('Config')}    ktx.yaml has ${errorCount} schema issue${errorCount === 1 ? '' : 's'}${warningCount > 0 ? ` · ${warningCount} ignored field${warningCount === 1 ? '' : 's'}` : ''}`,
  );
  for (const issue of issues) {
    const glyph = issue.severity === 'error' ? status('fail', '✗') : status('warn', '⚠');
    lines.push(`      ${glyph} ${issue.message}`);
    if (issue.fix) {
      lines.push(`        ${dim(`→ ${issue.fix}`)}`);
    }
  }
  lines.push('');
  lines.push(`  ${dim('Fix the issues in')} ${join(abbreviated, 'ktx.yaml')} ${dim('and rerun')} ${bold('ktx status')}.`);
  lines.push('');

  io.stdout.write(lines.join('\n'));
}

export function renderValidConfigMessage(
  projectDir: string,
  outputMode: KtxDoctorOutputMode,
  io: KtxDoctorIo,
  warnings: KtxConfigIssue[] = [],
): void {
  if (outputMode === 'json') {
    io.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          projectDir,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const useColor = shouldUseColorOutput(io.stdout);
  const dim = (text: string) => styleDim(useColor, text);
  const bold = (text: string) => styleBold(useColor, text);
  const status = (s: DoctorStatus, text: string) => styleStatus(useColor, s, text);
  const abbreviated = abbreviateHome(projectDir) ?? projectDir;

  const lines: string[] = [];
  lines.push(`${bold('KTX status')} ${dim('·')} ${abbreviated}`);
  lines.push('');
  if (warnings.length > 0) {
    lines.push(
      `  ${status('warn', '⚠')} ${bold('Config')}    ktx.yaml schema valid · ${warnings.length} ignored field${warnings.length === 1 ? '' : 's'}`,
    );
    for (const warning of warnings) {
      lines.push(`      ${status('warn', '⚠')} ${warning.message}`);
      if (warning.fix) {
        lines.push(`        ${dim(`→ ${warning.fix}`)}`);
      }
    }
  } else {
    lines.push(`  ${status('pass', '✓')} ${bold('Config')}    ${dim('ktx.yaml schema valid')}`);
  }
  lines.push('');

  io.stdout.write(lines.join('\n'));
}

export function renderMissingProjectMessage(
  projectDir: string,
  outputMode: KtxDoctorOutputMode,
  io: KtxDoctorIo,
): void {
  if (outputMode === 'json') {
    io.stdout.write(
      `${JSON.stringify(
        {
          error: 'missing_project',
          projectDir,
          message: `No ktx.yaml found in ${projectDir}`,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const useColor = shouldUseColorOutput(io.stdout);
  const dim = (text: string) => styleDim(useColor, text);
  const bold = (text: string) => styleBold(useColor, text);
  const abbreviated = abbreviateHome(projectDir) ?? projectDir;
  const envProjectDir = process.env.KTX_PROJECT_DIR;

  const lines: string[] = [];
  lines.push(`${bold('KTX status')} ${dim('·')} ${abbreviated}`);
  lines.push('');
  lines.push(`  No KTX project here yet. ${dim('(ktx.yaml not found)')}`);
  lines.push('');
  lines.push(`  Run  ${bold('ktx setup')}  to create one.`);
  if (envProjectDir !== undefined) {
    lines.push(`  ${dim(`Or unset KTX_PROJECT_DIR (currently ${envProjectDir}) to use a different directory.`)}`);
  } else {
    lines.push(`  ${dim('Or pass --project-dir to point at an existing project.')}`);
  }
  lines.push('');

  io.stdout.write(lines.join('\n'));
}

export async function runKtxDoctor(
  args: KtxDoctorArgs,
  io: KtxDoctorIo = process,
  deps: KtxDoctorDeps = {},
): Promise<number> {
  const startedAt = Date.now();
  try {
    const runSetupChecks = deps.runSetupChecks ?? (() => runSetupDoctorChecks());

    if (args.command === 'validate') {
      const configPath = join(args.projectDir, 'ktx.yaml');
      if (!(await defaultPathExists(configPath))) {
        renderMissingProjectMessage(args.projectDir, args.outputMode, io);
        return 1;
      }
      const { validateKtxProjectConfig } = await import('./context/project/config.js');
      const rawConfig = await readFile(configPath, 'utf-8');
      const validation = validateKtxProjectConfig(rawConfig);
      if (!validation.ok) {
        renderInvalidConfigMessage(args.projectDir, validation.issues, args.outputMode, io);
        return 1;
      }
      renderValidConfigMessage(args.projectDir, args.outputMode, io, validation.issues);
      return 0;
    }

    if (args.command === 'project') {
      const configPath = join(args.projectDir, 'ktx.yaml');
      if (!(await defaultPathExists(configPath))) {
        renderMissingProjectMessage(args.projectDir, args.outputMode, io);
        return 1;
      }
      const { loadKtxProject } = await import('./context/project/project.js');
      const { validateKtxProjectConfig } = await import('./context/project/config.js');
      const { buildProjectStatus, renderProjectStatus } = await import('./status-project.js');
      const rawConfig = await readFile(configPath, 'utf-8');
      const validation = validateKtxProjectConfig(rawConfig);
      if (!validation.ok) {
        renderInvalidConfigMessage(args.projectDir, validation.issues, args.outputMode, io);
        return 1;
      }
      const project = await loadKtxProject({ projectDir: args.projectDir });
      const fast = args.fast ?? false;
      const useSpinner =
        !fast && args.outputMode === 'plain' && io.stdout.isTTY === true;
      const projectStatus = await buildProjectStatus(project, {
        ...deps,
        configIssues: validation.issues,
        fast,
        useSpinner,
      });
      const verbose = args.verbose ?? false;
      const toolchainChecks = verbose ? await runSetupChecks() : undefined;
      if (args.outputMode === 'json') {
        io.stdout.write(`${JSON.stringify(projectStatus, null, 2)}\n`);
      } else {
        io.stdout.write(
          renderProjectStatus(projectStatus, {
            verbose,
            useColor: shouldUseColorOutput(io.stdout),
            durationMs: Date.now() - startedAt,
            toolchainChecks,
          }),
        );
      }
      return projectStatus.verdict === 'blocked' ? 1 : 0;
    }

    const setupChecks = await runSetupChecks();
    const report: DoctorReport = { title: 'KTX status', checks: setupChecks };
    const renderOptions: RenderOptions = {
      verbose: args.verbose ?? false,
      useColor: shouldUseColorOutput(io.stdout),
      durationMs: Date.now() - startedAt,
      command: args.command,
    };
    writeReport(report, args.outputMode, io, renderOptions);
    return hasFailures(report) ? 1 : 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
