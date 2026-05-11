import { Command, InvalidArgumentError } from '@commander-js/extra-typings';
import type { KtxCliDeps, KtxCliIo, KtxCliPackageInfo } from './cli-runtime.js';
import { registerAgentCommands } from './commands/agent-commands.js';
import { registerConnectionCommands } from './commands/connection-commands.js';
import { registerWikiCommands } from './commands/knowledge-commands.js';
import { registerPublicIngestCommands } from './commands/public-ingest-commands.js';
import { registerRuntimeCommands } from './commands/runtime-commands.js';
import { registerServeCommands } from './commands/serve-commands.js';
import { registerSetupCommands } from './commands/setup-commands.js';
import { registerSlCommands } from './commands/sl-commands.js';
import { registerStatusCommands } from './commands/status-commands.js';
import { registerDevCommands } from './dev.js';
import { findNearestKtxProjectDir, resolveKtxProjectDir } from './project-resolver.js';
import { profileMark, profileSpan } from './startup-profile.js';

profileMark('module:cli-program');

export interface KtxCliCommandContext {
  io: KtxCliIo;
  deps: KtxCliDeps;
  packageInfo: KtxCliPackageInfo;
  setExitCode: (code: number) => void;
  runInit: (args: { projectDir: string; projectName?: string; force: boolean }, io: KtxCliIo) => Promise<number>;
  writeDebug?: (command: string, commandContext: CommandWithGlobalOptions) => void;
}

export interface OutputModeOptions {
  plain?: boolean;
  json?: boolean;
  viz?: boolean;
  input?: boolean;
}

interface KtxCommanderProgramOptions {
  runInit: (args: { projectDir: string; projectName?: string; force: boolean }, io: KtxCliIo) => Promise<number>;
}

type CommanderExitLike = { exitCode: number; code: string; message: string };

interface KtxGlobalOptionValues {
  projectDir?: string;
  debug?: boolean;
}

const ROOT_COMMANDS = new Set([
  'setup',
  'connection',
  'ingest',
  'wiki',
  'sl',
  'runtime',
  'serve',
  'status',
  'help',
  'dev',
  'agent',
]);

export interface CommandWithGlobalOptions {
  opts: () => object;
  optsWithGlobals?: () => object;
}

function isCommanderExit(error: unknown): error is CommanderExitLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'exitCode' in error &&
    typeof (error as { exitCode: unknown }).exitCode === 'number' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

export function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function parsePositiveIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return parsed;
}

export function parseNonNegativeIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('must be a non-negative integer');
  }
  return parsed;
}

export function parseBooleanStringOption(value: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new InvalidArgumentError('must be true or false');
}

export function parseSafeConnectionIdOption(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new InvalidArgumentError(`Unsafe connection id: ${value}`);
  }
  return value;
}

export function parseNonEmptyAssignmentOption(value: string): { key: string; value: string } {
  const separatorIndex = value.indexOf('=');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new InvalidArgumentError('must be a non-empty <key>=<value> assignment');
  }
  return {
    key: value.slice(0, separatorIndex),
    value: value.slice(separatorIndex + 1),
  };
}

function optionsWithGlobals(command: CommandWithGlobalOptions): KtxGlobalOptionValues {
  const options = command.optsWithGlobals ? command.optsWithGlobals() : command.opts();
  const values = options as { projectDir?: unknown; debug?: unknown };
  return {
    projectDir: typeof values.projectDir === 'string' ? values.projectDir : undefined,
    debug: typeof values.debug === 'boolean' ? values.debug : undefined,
  };
}

export function resolveCommandProjectDir(command: CommandWithGlobalOptions): string {
  return resolveKtxProjectDir({ explicitProjectDir: optionsWithGlobals(command).projectDir });
}

export function resolveCommandProjectDirOverride(command: CommandWithGlobalOptions): string | undefined {
  return optionsWithGlobals(command).projectDir ?? process.env.KTX_PROJECT_DIR;
}

function createBaseProgram(info: KtxCliPackageInfo, io: KtxCliIo): Command {
  return new Command()
    .name('ktx')
    .description('Standalone KTX developer CLI')
    .option('--project-dir <path>', 'KTX project directory (default: KTX_PROJECT_DIR, nearest ktx.yaml, or cwd)')
    .option('--debug', 'Enable diagnostic logging to stderr')
    .version(`${info.name} ${info.version}`, '-v, --version', 'Show CLI version')
    .helpOption('-h, --help', 'Show this help text')
    .configureHelp({ showGlobalOptions: true })
    .addHelpText(
      'after',
      '\nAdvanced:\n  ktx dev        Low-level diagnostics, scans, adapter commands, and mapping tools.\n',
    )
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (chunk) => io.stdout.write(chunk),
      writeErr: (chunk) => io.stderr.write(chunk),
      outputError: (chunk, write) => write(chunk),
    });
}

function writeDebug(io: KtxCliIo, commandContext: CommandWithGlobalOptions, command: string): void {
  const global = optionsWithGlobals(commandContext);
  if (global.debug !== true) {
    return;
  }
  io.stderr.write(`[debug] projectDir=${resolveCommandProjectDir(commandContext)}\n`);
  io.stderr.write(`[debug] dispatch=${command}\n`);
}

function formatCliError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldUseErrorStyle(io: KtxCliIo): boolean {
  return io.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb' && !process.env.CI;
}

function ansi(text: string, open: string, close: string, enabled: boolean): string {
  return enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;
}

function formatErrorLabel(enabled: boolean): string {
  return ansi('error', '31', '39', enabled);
}

function formatCommandToken(command: string, enabled: boolean): string {
  return enabled ? ansi(command, '1', '22', true) : `\`${command}\``;
}

function formatHint(text: string, enabled: boolean): string {
  return ansi(text, '2', '22', enabled);
}

function findRootCommandToken(argv: string[]): string | null | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === '--') {
      return null;
    }
    if (arg === '--project-dir') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        return undefined;
      }
      i += 1;
      continue;
    }
    if (arg.startsWith('--project-dir=')) {
      continue;
    }
    if (arg === '--debug' || arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v') {
      continue;
    }
    if (arg.startsWith('-')) {
      return undefined;
    }
    return arg;
  }
  return null;
}

function writeRemovedInitCommandError(io: KtxCliIo): void {
  const styled = shouldUseErrorStyle(io);
  const command = (value: string) => formatCommandToken(value, styled);
  io.stderr.write(`${formatErrorLabel(styled)}: ${command('ktx init')} is no longer a public command.\n\n`);
  io.stderr.write('Create or resume a KTX project:\n');
  io.stderr.write(`  ${command('ktx setup')}\n`);
  io.stderr.write(`  ${command('ktx setup --new --project-dir <path>')}\n\n`);
  io.stderr.write('Developer scaffolding:\n');
  io.stderr.write(`  ${command('ktx dev init [path] --name <project-name>')}\n\n`);
  io.stderr.write(`${formatHint('Run `ktx --help` to see all commands.', styled)}\n`);
}

function writeUnknownRootCommandError(commandName: string, io: KtxCliIo): void {
  const styled = shouldUseErrorStyle(io);
  io.stderr.write(`${formatErrorLabel(styled)}: unknown command ${formatCommandToken(commandName, styled)}\n\n`);
  io.stderr.write(`${formatHint('Run `ktx --help` to see available commands.', styled)}\n`);
}

function writeRootCommandPreflightError(argv: string[], io: KtxCliIo): boolean {
  const commandName = findRootCommandToken(argv);
  if (commandName === undefined || commandName === null || ROOT_COMMANDS.has(commandName)) {
    return false;
  }
  if (commandName === 'init') {
    writeRemovedInitCommandError(io);
    return true;
  }
  writeUnknownRootCommandError(commandName, io);
  return true;
}

async function runBareInteractiveCommand(
  program: Command,
  io: KtxCliIo,
  context: KtxCliCommandContext,
): Promise<number> {
  const nearestProjectDir = findNearestKtxProjectDir(process.cwd());
  const envProjectDir = process.env.KTX_PROJECT_DIR;
  const runner = context.deps.setup ?? (await import('./setup.js')).runKtxSetup;

  if (!nearestProjectDir && !envProjectDir) {
    return await runner(
      {
        command: 'run',
        projectDir: resolveKtxProjectDir(),
        mode: 'auto',
        agents: false,
        agentScope: 'project',
        agentInstallMode: 'cli',
        skipAgents: false,
        inputMode: 'auto',
        yes: false,
        cliVersion: context.packageInfo.version,
        skipLlm: false,
        skipEmbeddings: false,
        databaseSchemas: [],
        skipDatabases: false,
        skipSources: false,
      },
      io,
    );
  }

  program.outputHelp();
  return 0;
}

export async function runCommanderKtxCli(
  argv: string[],
  io: KtxCliIo,
  deps: KtxCliDeps,
  info: KtxCliPackageInfo,
  options: KtxCommanderProgramOptions,
): Promise<number> {
  profileMark('commander:entry');
  let exitCode = 0;
  const program = createBaseProgram(info, io);
  profileMark('commander:base-program');
  const context: KtxCliCommandContext = {
    io,
    deps,
    packageInfo: info,
    setExitCode: (code: number) => {
      exitCode = code;
    },
    runInit: options.runInit,
    writeDebug: (command: string, commandContext: CommandWithGlobalOptions) => {
      writeDebug(io, commandContext, command);
    },
  };

  registerSetupCommands(program, context);
  profileMark('commander:register-setup');

  registerConnectionCommands(program, context);
  profileMark('commander:register-connection');

  registerPublicIngestCommands(program, context);
  profileMark('commander:register-public-ingest');

  registerWikiCommands(program, context);
  profileMark('commander:register-wiki');

  registerSlCommands(program, context);
  profileMark('commander:register-sl');

  registerRuntimeCommands(program, context);
  profileMark('commander:register-runtime');

  registerServeCommands(program, context);
  profileMark('commander:register-serve');

  registerStatusCommands(program, context);
  profileMark('commander:register-status');

  registerAgentCommands(program, context);
  profileMark('commander:register-agent');

  registerDevCommands(program, context);
  profileMark('commander:register-dev');

  if (argv.length === 0) {
    if (io.stdout.isTTY === true) {
      try {
        return await runBareInteractiveCommand(program, io, context);
      } catch (error) {
        io.stderr.write(`${formatCliError(error)}\n`);
        return 1;
      }
    }
    program.outputHelp();
    return 0;
  }

  if (writeRootCommandPreflightError(argv, io)) {
    return 1;
  }

  try {
    await profileSpan('commander:parseAsync', () => program.parseAsync(argv, { from: 'user' }));
  } catch (error) {
    if (isCommanderExit(error)) {
      return error.exitCode === 0 ? 0 : 1;
    }
    io.stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }

  return exitCode;
}
