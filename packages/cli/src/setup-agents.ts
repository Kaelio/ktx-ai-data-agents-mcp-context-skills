import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import { log, outro } from '@clack/prompts';
import {
  loadKtxProject,
  markKtxSetupStateStepComplete,
  serializeKtxProjectConfig,
} from '@ktx/context/project';
import { strToU8, zipSync } from 'fflate';
import type { KtxCliIo } from './cli-runtime.js';
import {
  createKtxSetupPromptAdapter,
  createKtxSetupUiAdapter,
  type KtxSetupPromptOption,
} from './setup-prompts.js';
import { readKtxMcpDaemonStatus } from './managed-mcp-daemon.js';

export type KtxAgentTarget = 'claude-code' | 'claude-desktop' | 'codex' | 'cursor' | 'opencode' | 'universal';
export type KtxAgentScope = 'project' | 'global' | 'local';
export type KtxAgentInstallMode = 'mcp' | 'mcp-cli';

export interface KtxSetupAgentsArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  yes: boolean;
  agents: boolean;
  target?: KtxAgentTarget;
  scope: KtxAgentScope;
  mode: KtxAgentInstallMode;
  skipAgents: boolean;
  showNextActions?: boolean;
}

export type KtxSetupAgentsResult =
  | {
      status: 'ready';
      projectDir: string;
      installs: Array<{ target: KtxAgentTarget; scope: KtxAgentScope; mode: KtxAgentInstallMode }>;
      nextActions?: string;
    }
  | { status: 'skipped'; projectDir: string }
  | { status: 'back'; projectDir: string }
  | { status: 'missing-input'; projectDir: string }
  | { status: 'failed'; projectDir: string };

export interface KtxAgentInstallManifest {
  version: 1;
  projectDir: string;
  installedAt: string;
  installs: Array<{ target: KtxAgentTarget; scope: KtxAgentScope; mode: KtxAgentInstallMode }>;
  entries: Array<
    | {
        kind: 'file';
        path: string;
        role?: 'skill' | 'rule' | 'analytics-skill' | 'claude-desktop-skill-bundle' | 'launcher';
      }
    | { kind: 'json-key'; path: string; jsonPath: string[] }
  >;
}

type InstallEntry = KtxAgentInstallManifest['entries'][number];

interface KtxMcpEndpointInfo {
  url: string;
  tokenAuth: boolean;
  running: boolean;
}

interface KtxMcpClientInstallResult {
  entries: InstallEntry[];
  snippets: string[];
  notices: string[];
}

const MCP_DAEMON_REQUIRED_NOTICE = 'mcp-daemon-required';

interface KtxCliLauncher {
  command: string;
  args: string[];
}

function isWritableTtyOutput(output: KtxCliIo['stdout']): output is KtxCliIo['stdout'] & Writable {
  return (
    output.isTTY === true &&
    typeof (output as { on?: unknown }).on === 'function' &&
    typeof (output as { columns?: unknown }).columns !== 'undefined'
  );
}

function writeSetupInfo(io: KtxCliIo, message: string): void {
  if (isWritableTtyOutput(io.stdout)) {
    log.info(message, { output: io.stdout });
    return;
  }
  io.stdout.write(`${message}\n`);
}

function writeSetupStep(io: KtxCliIo, message: string): void {
  if (isWritableTtyOutput(io.stdout)) {
    log.step(message, { output: io.stdout });
    return;
  }
  io.stdout.write(`\n${message}\n`);
}

function writeSetupOutro(io: KtxCliIo, message: string): void {
  if (isWritableTtyOutput(io.stdout)) {
    outro(message, { output: io.stdout });
    return;
  }
  io.stdout.write(`\n${message}\n`);
}

const STEP_HEADING_RE = /^(\d+)\. (.+)$/;
const ACTION_MARKER_RE = /^(RUN|PASTE|USE|OPEN):$/;

export function createAgentNextActionsLineFormatter(
  stdout: KtxCliIo['stdout'],
): (line: string) => string {
  const maybeHasColors = (stdout as { hasColors?: unknown }).hasColors;
  const supportsColor = typeof maybeHasColors === 'function' && Boolean(maybeHasColors.call(stdout));
  if (!supportsColor) return (line) => line;

  const homeDir = process.env.HOME ? resolve(process.env.HOME) : '';
  const styleOptions = { validateStream: false } as const;
  const dim = (s: string) => styleText('dim', s, styleOptions);
  const bold = (s: string) => styleText('bold', s, styleOptions);
  const cyanBold = (s: string) => styleText(['cyan', 'bold'], s, styleOptions);
  const dimCyan = (s: string) => styleText(['dim', 'cyan'], s, styleOptions);
  const shortenPath = (path: string): string => {
    if (!homeDir) return path;
    if (path === homeDir) return '~';
    if (path.startsWith(`${homeDir}/`)) return `~/${path.slice(homeDir.length + 1)}`;
    return path;
  };

  return (rawLine: string): string => {
    if (rawLine.length === 0 || rawLine.includes('[')) return rawLine;

    const heading = rawLine.match(STEP_HEADING_RE);
    if (heading) {
      return `${cyanBold(heading[1])}  ${bold(heading[2])}`;
    }

    if (!rawLine.startsWith('  ')) return rawLine;
    const body = rawLine.slice(2);

    if (ACTION_MARKER_RE.test(body)) {
      return `   ${dim(body)}`;
    }

    if (body.endsWith('.zip') && (body.startsWith('/') || body.startsWith('~'))) {
      return `     ${dimCyan('•')}  ${shortenPath(body)}`;
    }

    if (body.includes(' > ')) {
      return `   ${body.replaceAll(' > ', `  ${dim('›')}  `)}`;
    }

    return `   ${dim(body)}`;
  };
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function objectAtPath(root: Record<string, unknown>, jsonPath: string[]): Record<string, unknown> {
  let cursor = root;
  for (const segment of jsonPath) {
    const current = cursor[segment];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  return cursor;
}

async function writeJsonKey(path: string, jsonPath: string[], value: unknown): Promise<void> {
  const root = await readJsonObject(path);
  const parent = objectAtPath(root, jsonPath.slice(0, -1));
  parent[jsonPath.at(-1) as string] = value;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(root, null, 2)}\n`, 'utf-8');
}

async function resolveMcpEndpoint(projectDir: string): Promise<KtxMcpEndpointInfo> {
  const status = await readKtxMcpDaemonStatus({ projectDir }).catch(() => null);
  if (status?.kind === 'running') {
    return {
      url: status.url,
      tokenAuth: status.state.tokenAuth,
      running: true,
    };
  }
  if (status?.kind === 'stale' && status.state) {
    return {
      url: `http://${status.state.host}:${status.state.port}/mcp`,
      tokenAuth: status.state.tokenAuth || Boolean(process.env.KTX_MCP_TOKEN),
      running: false,
    };
  }
  return {
    url: 'http://localhost:7878/mcp',
    tokenAuth: Boolean(process.env.KTX_MCP_TOKEN),
    running: false,
  };
}

function tokenHeaders(endpoint: KtxMcpEndpointInfo): Record<string, string> | undefined {
  return endpoint.tokenAuth ? { Authorization: 'Bearer ${KTX_MCP_TOKEN}' } : undefined;
}

function claudeMcpEntry(endpoint: KtxMcpEndpointInfo): Record<string, unknown> {
  return {
    type: 'http',
    url: endpoint.url,
    ...(tokenHeaders(endpoint) ? { headers: tokenHeaders(endpoint) } : {}),
  };
}

function cursorMcpEntry(endpoint: KtxMcpEndpointInfo): Record<string, unknown> {
  return {
    url: endpoint.url,
    ...(tokenHeaders(endpoint) ? { headers: tokenHeaders(endpoint) } : {}),
  };
}

function codexSnippet(endpoint: KtxMcpEndpointInfo): string {
  if (endpoint.tokenAuth) {
    return [
      'Codex MCP config does not currently document HTTP headers.',
      'Run KTX on loopback without token auth for Codex, or configure headers after Codex documents support.',
    ].join('\n');
  }
  return [`[mcp_servers.ktx]`, `url = "${endpoint.url}"`].join('\n');
}

function opencodeSnippet(endpoint: KtxMcpEndpointInfo): string {
  return JSON.stringify(
    {
      mcp: {
        ktx: {
          type: 'remote',
          url: endpoint.url,
          enabled: true,
          ...(tokenHeaders(endpoint) ? { headers: tokenHeaders(endpoint) } : {}),
        },
      },
    },
    null,
    2,
  );
}

function universalMcpSnippet(endpoint: KtxMcpEndpointInfo): string {
  return [
    'Universal MCP endpoint:',
    endpoint.url,
    ...(endpoint.tokenAuth ? ['Header: Authorization: Bearer ${KTX_MCP_TOKEN}'] : []),
  ].join('\n');
}

function claudeConfigPath(projectDir: string, scope: KtxAgentScope): { path: string; jsonPath: string[] } {
  const home = process.env.HOME ?? '';
  if (scope === 'global') {
    return { path: join(home, '.claude.json'), jsonPath: ['mcpServers', 'ktx'] };
  }
  if (scope === 'local') {
    return { path: join(home, '.claude.json'), jsonPath: ['projects', resolve(projectDir), 'mcpServers', 'ktx'] };
  }
  return { path: join(resolve(projectDir), '.mcp.json'), jsonPath: ['mcpServers', 'ktx'] };
}

function cursorConfigPath(projectDir: string, scope: KtxAgentScope): { path: string; jsonPath: string[] } {
  const home = process.env.HOME ?? '';
  return {
    path: scope === 'global' ? join(home, '.cursor/mcp.json') : join(resolve(projectDir), '.cursor/mcp.json'),
    jsonPath: ['mcpServers', 'ktx'],
  };
}

function claudeDesktopConfigPath(): { path: string; jsonPath: string[] } {
  const home = process.env.HOME ?? '';
  const path =
    process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(home, 'AppData/Roaming'), 'Claude/claude_desktop_config.json')
      : join(home, 'Library/Application Support/Claude/claude_desktop_config.json');
  return { path, jsonPath: ['mcpServers', 'ktx'] };
}

const CLAUDE_DESKTOP_FORWARDED_ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;

export function collectClaudeDesktopForwardedEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === '') continue;
    if (key.startsWith('KTX_') || (CLAUDE_DESKTOP_FORWARDED_ENV_KEYS as readonly string[]).includes(key)) {
      captured[key] = value;
    }
  }
  return captured;
}

function claudeDesktopMcpEntry(input: {
  launcherPath: string;
  projectDir: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, unknown> {
  const captured = collectClaudeDesktopForwardedEnv(input.env ?? process.env);
  return {
    command: input.launcherPath,
    args: ['--project-dir', input.projectDir, 'mcp', 'stdio'],
    ...(Object.keys(captured).length > 0 ? { env: captured } : {}),
  };
}

async function installMcpClientConfig(input: {
  projectDir: string;
  target: KtxAgentTarget;
  scope: KtxAgentScope;
}): Promise<KtxMcpClientInstallResult> {
  const entries: InstallEntry[] = [];
  const snippets: string[] = [];
  const notices: string[] = [];

  if (input.target === 'claude-desktop') {
    const config = claudeDesktopConfigPath();
    const launcherPath = claudeDesktopLauncherPath(input.projectDir);
    await writeJsonKey(
      config.path,
      config.jsonPath,
      claudeDesktopMcpEntry({ launcherPath, projectDir: input.projectDir }),
    );
    entries.push({ kind: 'json-key', path: config.path, jsonPath: config.jsonPath });
    return { entries, snippets, notices };
  }

  const endpoint = await resolveMcpEndpoint(input.projectDir);
  if (!endpoint.running) {
    notices.push(MCP_DAEMON_REQUIRED_NOTICE);
  }

  if (input.target === 'claude-code') {
    const config = claudeConfigPath(input.projectDir, input.scope);
    await writeJsonKey(config.path, config.jsonPath, claudeMcpEntry(endpoint));
    entries.push({ kind: 'json-key', path: config.path, jsonPath: config.jsonPath });
  } else if (input.target === 'cursor') {
    const config = cursorConfigPath(input.projectDir, input.scope);
    await writeJsonKey(config.path, config.jsonPath, cursorMcpEntry(endpoint));
    entries.push({ kind: 'json-key', path: config.path, jsonPath: config.jsonPath });
  } else if (input.target === 'codex') {
    snippets.push(`Add this Codex MCP snippet to ~/.codex/config.toml:\n${codexSnippet(endpoint)}`);
  } else if (input.target === 'opencode') {
    const path =
      input.scope === 'global'
        ? '~/.config/opencode/opencode.json'
        : relative(input.projectDir, join(input.projectDir, 'opencode.json'));
    snippets.push(`Add this OpenCode MCP snippet to ${path}:\n${opencodeSnippet(endpoint)}`);
  } else if (input.target === 'universal') {
    snippets.push(`Use this universal MCP endpoint with unsupported MCP clients:\n${universalMcpSnippet(endpoint)}`);
  }

  return { entries, snippets, notices };
}

function plannedMcpJsonEntries(input: {
  projectDir: string;
  target: KtxAgentTarget;
  scope: KtxAgentScope;
}): InstallEntry[] {
  if (input.target === 'claude-code') {
    const config = claudeConfigPath(input.projectDir, input.scope);
    return [{ kind: 'json-key', path: config.path, jsonPath: config.jsonPath }];
  }
  if (input.target === 'claude-desktop') {
    const config = claudeDesktopConfigPath();
    return [{ kind: 'json-key', path: config.path, jsonPath: config.jsonPath }];
  }
  if (input.target === 'cursor') {
    const config = cursorConfigPath(input.projectDir, input.scope);
    return [{ kind: 'json-key', path: config.path, jsonPath: config.jsonPath }];
  }
  return [];
}

export function agentInstallManifestPath(projectDir: string): string {
  return join(resolve(projectDir), '.ktx/agents/install-manifest.json');
}

function claudeDesktopAnalyticsSkillBundlePath(projectDir: string): string {
  return join(resolve(projectDir), '.ktx/agents/claude/ktx-analytics.zip');
}

function claudeDesktopAdminSkillBundlePath(projectDir: string): string {
  return join(resolve(projectDir), '.ktx/agents/claude/ktx.zip');
}

function claudeDesktopLauncherPath(projectDir: string): string {
  return join(resolve(projectDir), '.ktx/agents/claude/ktx-plugin-runner.sh');
}

export function plannedKtxAgentFiles(input: {
  projectDir: string;
  target: KtxAgentTarget;
  scope: KtxAgentScope;
  mode: KtxAgentInstallMode;
}): InstallEntry[] {
  const withAdminCli = input.mode === 'mcp-cli';

  if (input.scope === 'global') {
    if (input.target === 'claude-code') {
      const home = process.env.HOME ?? '';
      return [
        { kind: 'file', path: join(home, '.claude/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' as const },
        ...(withAdminCli
          ? [
              { kind: 'file' as const, path: join(home, '.claude/skills/ktx/SKILL.md'), role: 'skill' as const },
              { kind: 'file' as const, path: join(home, '.claude/rules/ktx.md'), role: 'rule' as const },
            ]
          : []),
      ];
    }
    if (input.target === 'codex') {
      const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex');
      return [
        { kind: 'file', path: join(codexHome, 'skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' as const },
        ...(withAdminCli
          ? [
              { kind: 'file' as const, path: join(codexHome, 'skills/ktx/SKILL.md'), role: 'skill' as const },
              { kind: 'file' as const, path: join(codexHome, 'instructions/ktx.md'), role: 'rule' as const },
            ]
          : []),
      ];
    }
    if (input.target === 'cursor' || input.target === 'opencode') {
      return [];
    }
    if (input.target === 'claude-desktop') {
      return [
        { kind: 'file', path: claudeDesktopLauncherPath(input.projectDir), role: 'launcher' as const },
        {
          kind: 'file',
          path: claudeDesktopAnalyticsSkillBundlePath(input.projectDir),
          role: 'claude-desktop-skill-bundle' as const,
        },
        ...(withAdminCli
          ? [
              {
                kind: 'file' as const,
                path: claudeDesktopAdminSkillBundlePath(input.projectDir),
                role: 'claude-desktop-skill-bundle' as const,
              },
            ]
          : []),
      ];
    }
    throw new Error(`Global ${input.target} installation is not supported; omit --global.`);
  }

  const root = resolve(input.projectDir);
  const analyticsEntries: Partial<Record<KtxAgentTarget, InstallEntry[]>> = {
    'claude-code': [
      { kind: 'file', path: join(root, '.claude/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
    ],
    codex: [
      { kind: 'file', path: join(root, '.agents/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
    ],
    cursor: [
      { kind: 'file', path: join(root, '.cursor/rules/ktx-analytics.mdc'), role: 'analytics-skill' },
    ],
    opencode: [
      { kind: 'file', path: join(root, '.opencode/commands/ktx-analytics.md'), role: 'analytics-skill' },
    ],
    universal: [
      { kind: 'file', path: join(root, '.agents/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
    ],
    'claude-desktop': [],
  };
  const cliEntries: Partial<Record<KtxAgentTarget, InstallEntry[]>> = {
    'claude-code': [
      { kind: 'file', path: join(root, '.claude/skills/ktx/SKILL.md'), role: 'skill' },
    ],
    codex: [
      { kind: 'file', path: join(root, '.agents/skills/ktx/SKILL.md'), role: 'skill' },
    ],
    cursor: [
      { kind: 'file', path: join(root, '.cursor/rules/ktx.mdc') },
    ],
    opencode: [
      { kind: 'file', path: join(root, '.opencode/commands/ktx.md') },
    ],
    universal: [
      { kind: 'file', path: join(root, '.agents/skills/ktx/SKILL.md') },
    ],
    'claude-desktop': [],
  };
  const ruleEntries: Partial<Record<KtxAgentTarget, InstallEntry>> = {
    'claude-code': { kind: 'file', path: join(root, '.claude/rules/ktx.md'), role: 'rule' },
    codex: { kind: 'file', path: join(root, '.codex/instructions/ktx.md'), role: 'rule' },
  };
  return [
    ...(analyticsEntries[input.target] ?? []),
    ...(withAdminCli ? (cliEntries[input.target] ?? []) : []),
    ...(withAdminCli ? [ruleEntries[input.target]] : []),
  ].filter(
    (entry): entry is InstallEntry => entry !== undefined,
  );
}

function ktxCliLauncher(): KtxCliLauncher {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('./bin.js', import.meta.url))],
  };
}

async function readAnalyticsSkillContent(): Promise<string> {
  const path = fileURLToPath(new URL('./skills/analytics/SKILL.md', import.meta.url));
  const content = await readFile(path, 'utf-8');
  return content.endsWith('\n') ? content : `${content}\n`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellScriptQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function ktxCommandLine(launcher: KtxCliLauncher, args: string[]): string {
  return [launcher.command, ...launcher.args, ...args].map(shellQuote).join(' ');
}

function cliInstructionContent(input: { projectDir: string; launcher: KtxCliLauncher }): string {
  const projectDirArgs = ['--project-dir', input.projectDir];
  const jsonProjectDirArgs = ['--json', ...projectDirArgs];
  return [
    '---',
    'name: ktx',
    'description: Use local KTX semantic context and wiki knowledge for this project.',
    '---',
    '',
    '# KTX Local Context',
    '',
    'This is an admin/developer CLI helper. End-user data agents should use the KTX MCP tools when available.',
    '',
    `Use this project with \`--project-dir ${input.projectDir}\`.`,
    'Commands are pinned to the local KTX CLI path that created this file, so agents do not need `ktx` in PATH.',
    'If the CLI path no longer exists after moving this checkout or reinstalling KTX, rerun `ktx setup --agents`.',
    '',
    'Agents must not print secrets, credential references, environment variable values, or file contents from ' +
      '`.ktx/secrets`.',
    '',
    'Available commands:',
    '',
    `- \`${ktxCommandLine(input.launcher, ['status', ...jsonProjectDirArgs])}\``,
    `- \`${ktxCommandLine(input.launcher, ['sl', 'list', ...jsonProjectDirArgs])}\``,
    `- \`${ktxCommandLine(input.launcher, ['sl', 'search', '<text>', ...jsonProjectDirArgs, '--connection-id', '<id>'])}\``,
    `- \`${ktxCommandLine(input.launcher, [
      'sl',
      'query',
      ...projectDirArgs,
      '--connection-id',
      '<id>',
      '--query-file',
      '<path>',
      '--format',
      'json',
      '--execute',
      '--max-rows',
      '100',
    ])}\``,
    `- \`${ktxCommandLine(input.launcher, ['wiki', 'search', '<query>', ...jsonProjectDirArgs, '--limit', '10'])}\``,
    '',
    'Use semantic-layer queries before direct database access. Do not print secrets or credential references.',
    '',
  ].join('\n');
}

function claudeDesktopLauncherContent(input: { launcher: KtxCliLauncher }): string {
  const binPath = input.launcher.args[0];
  if (!binPath) {
    throw new Error('Expected KTX CLI launcher to include a bin path.');
  }
  const candidates = [
    input.launcher.command,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
  return [
    '#!/bin/sh',
    'set -eu',
    '',
    `KTX_CLI_BIN=${shellScriptQuote(binPath)}`,
    '',
    'run_with_node() {',
    '  node_bin=$1',
    '  shift',
    '  exec "$node_bin" "$KTX_CLI_BIN" "$@"',
    '}',
    '',
    'if [ -n "${KTX_NODE:-}" ] && [ -x "${KTX_NODE:-}" ]; then',
    '  run_with_node "$KTX_NODE" "$@"',
    'fi',
    '',
    'if [ -x "$HOME/.volta/bin/node" ]; then',
    '  run_with_node "$HOME/.volta/bin/node" "$@"',
    'fi',
    '',
    ...candidates.map((candidate) =>
      [
        `if [ -x ${shellScriptQuote(candidate)} ]; then`,
        `  run_with_node ${shellScriptQuote(candidate)} "$@"`,
        'fi',
      ].join('\n'),
    ),
    '',
    'for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do',
    '  if [ -x "$candidate" ]; then',
    '    run_with_node "$candidate" "$@"',
    '  fi',
    'done',
    '',
    'if command -v node >/dev/null 2>&1; then',
    '  run_with_node "$(command -v node)" "$@"',
    'fi',
    '',
    'echo "KTX Claude Desktop launcher could not find Node.js. Set KTX_NODE to a Node executable and rerun ktx setup --agents." >&2',
    'exit 127',
    '',
  ].join('\n');
}

async function writeClaudeDesktopSkillBundle(input: {
  projectDir: string;
  path: string;
  skillName: 'ktx-analytics' | 'ktx';
  launcher: KtxCliLauncher;
}): Promise<void> {
  const content =
    input.skillName === 'ktx-analytics'
      ? await readAnalyticsSkillContent()
      : cliInstructionContent({ projectDir: input.projectDir, launcher: input.launcher });
  const files: Record<string, Uint8Array> = {
    [`${input.skillName}/SKILL.md`]: strToU8(content),
  };
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(input.path, Buffer.from(zipSync(files)));
}

function claudeDesktopSkillNameForBundle(path: string): 'ktx-analytics' | 'ktx' {
  if (path.endsWith('/ktx-analytics.zip')) {
    return 'ktx-analytics';
  }
  if (path.endsWith('/ktx.zip')) {
    return 'ktx';
  }
  throw new Error(`Unsupported Claude Desktop skill bundle path: ${path}`);
}

async function writeClaudeDesktopLauncher(input: {
  path: string;
  launcher: KtxCliLauncher;
}): Promise<void> {
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(input.path, claudeDesktopLauncherContent({ launcher: input.launcher }), 'utf-8');
  await chmod(input.path, 0o755);
}

function ruleInstructionContent(input: { projectDir: string }): string {
  return [
    `Use the \`ktx\` CLI to query local semantic context and wiki knowledge for this project ` +
      `(\`--project-dir ${input.projectDir}\`).`,
    '',
    'Use when the user asks about data schemas, metrics, dimensions, database structure, or wants to run SQL queries.',
    '',
    'Do not use for general programming, code review, or tasks unrelated to data and analytics.',
    '',
  ].join('\n');
}

async function removeJsonKey(path: string, jsonPath: string[]): Promise<void> {
  const root = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  let cursor: Record<string, unknown> = root;
  for (const segment of jsonPath.slice(0, -1)) {
    const next = cursor[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    cursor = next as Record<string, unknown>;
  }
  delete cursor[jsonPath.at(-1) as string];
  await writeFile(path, `${JSON.stringify(root, null, 2)}\n`, 'utf-8');
}

export async function readKtxAgentInstallManifest(projectDir: string): Promise<KtxAgentInstallManifest | null> {
  try {
    return JSON.parse(await readFile(agentInstallManifestPath(projectDir), 'utf-8')) as KtxAgentInstallManifest;
  } catch {
    return null;
  }
}

async function writeManifest(projectDir: string, manifest: KtxAgentInstallManifest): Promise<void> {
  const path = agentInstallManifestPath(projectDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

function entryKey(entry: InstallEntry): string {
  return entry.kind === 'json-key'
    ? `${entry.kind}:${entry.path}:${entry.jsonPath.join('.')}`
    : `${entry.kind}:${entry.path}`;
}

function mergeManifest(
  projectDir: string,
  existing: KtxAgentInstallManifest | null,
  installs: KtxAgentInstallManifest['installs'],
  entries: InstallEntry[],
): KtxAgentInstallManifest {
  const installMap = new Map<string, KtxAgentInstallManifest['installs'][number]>();
  for (const install of [...(existing?.installs ?? []), ...installs]) {
    installMap.set(`${install.target}:${install.scope}:${install.mode}`, install);
  }
  const entryMap = new Map<string, InstallEntry>();
  for (const entry of [...(existing?.entries ?? []), ...entries]) {
    entryMap.set(entryKey(entry), entry);
  }
  return {
    version: 1,
    projectDir,
    installedAt: new Date().toISOString(),
    installs: [...installMap.values()],
    entries: [...entryMap.values()],
  };
}

export async function removeKtxAgentInstall(projectDir: string, io: KtxCliIo): Promise<number> {
  const manifest = await readKtxAgentInstallManifest(projectDir);
  if (!manifest) {
    io.stdout.write('No KTX agent installation manifest found.\n');
    return 0;
  }
  for (const entry of manifest.entries) {
    if (entry.kind === 'file') await rm(entry.path, { force: true });
    if (entry.kind === 'json-key') await removeJsonKey(entry.path, entry.jsonPath).catch(() => undefined);
  }
  await rm(agentInstallManifestPath(projectDir), { force: true });
  io.stdout.write('Removed KTX agent integration files from manifest.\n');
  return 0;
}

export interface KtxSetupAgentsPromptAdapter {
  select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
  multiselect(options: {
    message: string;
    options: KtxSetupPromptOption[];
    required?: boolean;
  }): Promise<string[]>;
  cancel(message: string): void;
}

export interface KtxSetupAgentsDeps {
  prompts?: KtxSetupAgentsPromptAdapter;
}

function createPromptAdapter(): KtxSetupAgentsPromptAdapter {
  return createKtxSetupPromptAdapter({
    selectCancelValue: 'back',
    multiselectCancelValue: 'back',
    confirmEmptyOptionalMultiselect: true,
  });
}

const targetDisplayNames: Record<KtxAgentTarget, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  universal: 'Universal .agents',
};

export function targetDisplayName(target: string): string {
  return Object.hasOwn(targetDisplayNames, target) ? targetDisplayNames[target as KtxAgentTarget] : target;
}

function targetSupportsGlobalScope(target: KtxAgentTarget): boolean {
  return target === 'claude-code' || target === 'codex';
}

function effectiveInstallScope(target: KtxAgentTarget, requestedScope: KtxAgentScope): KtxAgentScope {
  return target === 'claude-desktop' ? 'global' : requestedScope;
}

function scopeDisplayName(scope: KtxAgentScope): string {
  if (scope === 'project') return 'Project scope';
  if (scope === 'global') return 'Global scope';
  return 'Local scope';
}

function targetUsesHttpMcpDaemon(target: KtxAgentTarget): boolean {
  return target !== 'claude-desktop';
}

function manualMcpConfigInstruction(target: KtxAgentTarget, scope: KtxAgentScope): string {
  if (target === 'codex') {
    return 'Add the snippet shown below to ~/.codex/config.toml.';
  }
  if (target === 'opencode') {
    return scope === 'global'
      ? 'Add the snippet shown below to ~/.config/opencode/opencode.json.'
      : 'Add the snippet shown below to opencode.json.';
  }
  if (target === 'universal') {
    return 'Use the printed endpoint with unsupported MCP clients.';
  }
  return 'Add the printed snippet manually.';
}

function guidanceInstallLine(target: KtxAgentTarget): string {
  if (target === 'codex') return 'Codex guidance installed';
  if (target === 'cursor') return 'Cursor rules installed';
  if (target === 'opencode') return 'OpenCode commands installed';
  if (target === 'universal') return '.agents guidance installed';
  return 'Agent guidance installed';
}

function hasEntryRole(entries: InstallEntry[], role: Extract<InstallEntry, { kind: 'file' }>['role']): boolean {
  return entries.some((entry) => entry.kind === 'file' && entry.role === role);
}

function hasAdminCliEntries(entries: InstallEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.kind === 'file' &&
      (entry.role === 'skill' || entry.role === 'rule' || entry.role === undefined),
  );
}

export interface InstallSummaryEntry {
  title: string;
  lines: string[];
}

function formatInlinePath(path: string): string {
  const home = process.env.HOME;
  if (!home) return path;
  const resolvedHome = resolve(home);
  if (path === resolvedHome) return '~';
  if (path.startsWith(`${resolvedHome}/`)) {
    return `~/${relative(resolvedHome, path)}`;
  }
  return path;
}

export function formatInstallSummaryLines(
  installs: Array<{ target: KtxAgentTarget; scope: KtxAgentScope; mode: KtxAgentInstallMode }>,
  entries: InstallEntry[],
  projectDir: string,
): InstallSummaryEntry[] {
  const entriesByTarget = new Map<KtxAgentTarget, InstallEntry[]>();
  for (const install of installs) {
    const plannedFilePaths = new Set(
      plannedKtxAgentFiles({ projectDir, ...install })
        .filter((entry) => entry.kind === 'file')
        .map((entry) => entry.path),
    );
    entriesByTarget.set(
      install.target,
      entries.filter((entry) => entry.kind === 'file' && plannedFilePaths.has(entry.path)),
    );
  }
  const mcpEntriesByTarget = new Map<KtxAgentTarget, InstallEntry[]>();
  for (const install of installs) {
    const plannedMcpKeys = new Set(plannedMcpJsonEntries({ projectDir, ...install }).map(entryKey));
    mcpEntriesByTarget.set(
      install.target,
      entries.filter((entry) => entry.kind === 'json-key' && plannedMcpKeys.has(entryKey(entry))),
    );
  }

  return installs.map((install) => {
    const targetEntries = entriesByTarget.get(install.target) ?? [];
    const mcpEntry = mcpEntriesByTarget
      .get(install.target)
      ?.find((entry): entry is Extract<InstallEntry, { kind: 'json-key' }> => entry.kind === 'json-key');
    const lines: string[] = [];

    if (mcpEntry) {
      lines.push(formatInlinePath(mcpEntry.path));
    } else if (install.target !== 'claude-desktop') {
      lines.push(manualMcpConfigInstruction(install.target, install.scope));
    }

    if (targetUsesHttpMcpDaemon(install.target)) {
      lines.push('Requires MCP to be started.');
    }

    const hasAnalytics = hasEntryRole(targetEntries, 'analytics-skill');
    const hasAdmin = hasAdminCliEntries(targetEntries);
    const claudeDesktopSkillBundles = targetEntries.filter(
      (entry): entry is Extract<InstallEntry, { kind: 'file' }> =>
        entry.kind === 'file' && entry.role === 'claude-desktop-skill-bundle',
    );

    if (install.target === 'claude-code') {
      if (hasAnalytics) {
        lines.push('Analytics skill installed.');
      }
      if (hasAdmin) {
        lines.push('Admin CLI skill installed.');
      }
    } else if (install.target === 'claude-desktop') {
      if (claudeDesktopSkillBundles.length > 0) {
        lines.push('Skill bundles:');
        for (const bundle of claudeDesktopSkillBundles) {
          lines.push(`  ${bundle.path}`);
        }
      }
    } else if (hasAnalytics || hasAdmin) {
      lines.push(`${guidanceInstallLine(install.target)}.`);
    }

    if (hasEntryRole(targetEntries, 'launcher')) {
      lines.push('Starts KTX over stdio from Claude Desktop.');
    }

    return {
      title: `${targetDisplayName(install.target)} · ${scopeDisplayName(install.scope)}`,
      lines,
    };
  });
}

function claudeDesktopSkillBundlePathsForInstalls(
  projectDir: string,
  installs: Array<{ target: KtxAgentTarget; scope: KtxAgentScope; mode: KtxAgentInstallMode }>,
): string[] {
  return installs
    .filter((install) => install.target === 'claude-desktop')
    .flatMap((install) => plannedKtxAgentFiles({ projectDir, ...install }))
    .filter(
      (entry): entry is Extract<InstallEntry, { kind: 'file' }> =>
        entry.kind === 'file' && entry.role === 'claude-desktop-skill-bundle',
    )
    .map((entry) => entry.path);
}

function humanList(values: string[]): string {
  if (values.length <= 2) {
    return values.join(' and ');
  }
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function pushBlankLine(lines: string[]): void {
  if (lines.length > 0 && lines[lines.length - 1] !== '') {
    lines.push('');
  }
}

function trimTrailingBlankLines(lines: string[]): void {
  while (lines[lines.length - 1] === '') {
    lines.pop();
  }
}

function manualActionFromSnippet(snippet: string): {
  title: string;
  instruction: string;
  marker: 'PASTE' | 'USE';
  body: string[];
} {
  const [label = '', ...body] = snippet.split('\n');
  const codexPrefix = 'Add this Codex MCP snippet to ~/.codex/config.toml:';
  if (label === codexPrefix) {
    return {
      title: 'Configure Codex',
      instruction: 'Open ~/.codex/config.toml, then paste this block:',
      marker: 'PASTE',
      body,
    };
  }

  const opencodeMatch = label.match(/^Add this OpenCode MCP snippet to (.+):$/);
  if (opencodeMatch) {
    return {
      title: 'Configure OpenCode',
      instruction: `Open ${opencodeMatch[1]}, then paste this block:`,
      marker: 'PASTE',
      body,
    };
  }

  if (label === 'Use this universal MCP endpoint with unsupported MCP clients:') {
    return {
      title: 'Configure unsupported MCP clients',
      instruction: 'Use this endpoint when setting up unsupported MCP clients:',
      marker: 'USE',
      body,
    };
  }

  return {
    title: 'Configure MCP client',
    instruction: label,
    marker: 'PASTE',
    body,
  };
}

function formatAgentNextActions(input: {
  projectDir: string;
  installs: Array<{ target: KtxAgentTarget; scope: KtxAgentScope; mode: KtxAgentInstallMode }>;
  notices: string[];
  snippets: string[];
}): string {
  const projectDir = resolve(input.projectDir);
  const lines: string[] = [];
  let step = 1;

  for (const snippet of input.snippets) {
    const action = manualActionFromSnippet(snippet);
    lines.push(`${step}. ${action.title}`);
    lines.push(`  ${action.instruction}`);
    if (action.body.length > 0) {
      lines.push('', `  ${action.marker}:`);
    }
    for (const line of action.body) {
      lines.push(`  ${line}`);
    }
    pushBlankLine(lines);
    step += 1;
  }

  const httpTargets = input.installs
    .filter((install) => targetUsesHttpMcpDaemon(install.target))
    .map((install) => targetDisplayName(install.target));
  if (input.notices.length > 0 && httpTargets.length > 0) {
    lines.push(`${step}. Start MCP`);
    lines.push(`  Run this command before using ${humanList(httpTargets)}:`);
    lines.push('');
    lines.push('  RUN:');
    lines.push(`  ktx mcp start --project-dir ${projectDir}`);
    lines.push('');
    lines.push('  If you need to stop MCP later:');
    lines.push(`  ktx mcp stop --project-dir ${projectDir}`);
    pushBlankLine(lines);
    step += 1;
  }

  const claudeCodeInstall = input.installs.find((install) => install.target === 'claude-code');
  if (claudeCodeInstall) {
    lines.push(`${step}. Open Claude Code`);
    if (claudeCodeInstall.scope === 'project') {
      lines.push('  Open Claude Code from the KTX project directory:');
      lines.push('');
      lines.push('  RUN:');
      lines.push(`  cd ${shellScriptQuote(projectDir)}`);
      lines.push('  claude');
    } else {
      lines.push('  RUN:');
      lines.push('  claude');
    }
    pushBlankLine(lines);
    step += 1;
  }

  const cursorInstall = input.installs.find((install) => install.target === 'cursor');
  if (cursorInstall) {
    lines.push(`${step}. Open Cursor`);
    if (cursorInstall.scope === 'project') {
      lines.push('  Open Cursor from the KTX project directory:');
      lines.push('');
      lines.push('  OPEN:');
      lines.push(`  ${projectDir}`);
    } else {
      lines.push('  Open Cursor.');
    }
    pushBlankLine(lines);
    step += 1;
  }

  if (input.installs.some((install) => install.target === 'claude-desktop')) {
    lines.push(`${step}. Restart Claude Desktop`);
    lines.push('  Claude Desktop loads KTX MCP after restart.');
    pushBlankLine(lines);
    step += 1;

    const skillBundlePaths = claudeDesktopSkillBundlePathsForInstalls(projectDir, input.installs);
    if (skillBundlePaths.length > 0) {
      lines.push(`${step}. Upload Claude Desktop skills`);
      lines.push('  Open Claude Desktop: Customize > Skills > + > Create skill > Upload a skill.');
      lines.push(skillBundlePaths.length === 1 ? '  Upload this file:' : '  Upload each file separately:');
      for (const path of skillBundlePaths) {
        lines.push(`  ${path}`);
      }
      lines.push('  Toggle the uploaded KTX skills on.');
      pushBlankLine(lines);
      step += 1;
    }
  }

  if (lines.length === 0) {
    lines.push('Open your configured agent and ask a data question.');
  }

  trimTrailingBlankLines(lines);
  return lines.join('\n');
}

async function installTarget(input: {
  projectDir: string;
  target: KtxAgentTarget;
  scope: KtxAgentScope;
  mode: KtxAgentInstallMode;
}): Promise<InstallEntry[]> {
  const entries = plannedKtxAgentFiles(input);
  const launcher = ktxCliLauncher();
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    if (entry.role === 'launcher') {
      await writeClaudeDesktopLauncher({ path: entry.path, launcher });
      continue;
    }
    if (entry.role === 'claude-desktop-skill-bundle') {
      await writeClaudeDesktopSkillBundle({
        projectDir: input.projectDir,
        path: entry.path,
        skillName: claudeDesktopSkillNameForBundle(entry.path),
        launcher,
      });
      continue;
    }
    const content =
      entry.role === 'rule'
        ? ruleInstructionContent({ projectDir: input.projectDir })
        : entry.role === 'analytics-skill'
          ? await readAnalyticsSkillContent()
        : cliInstructionContent({ projectDir: input.projectDir, launcher });
    await mkdir(dirname(entry.path), { recursive: true });
    await writeFile(entry.path, content, 'utf-8');
  }
  return entries;
}

async function markAgentsComplete(projectDir: string): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  await writeFile(project.configPath, serializeKtxProjectConfig(project.config), 'utf-8');
  await markKtxSetupStateStepComplete(projectDir, 'agents');
}

export async function runKtxSetupAgentsStep(
  args: KtxSetupAgentsArgs,
  io: KtxCliIo,
  deps: KtxSetupAgentsDeps = {},
): Promise<KtxSetupAgentsResult> {
  if (args.skipAgents) {
    io.stdout.write('│  Agent integration skipped.\n');
    return { status: 'skipped', projectDir: args.projectDir };
  }
  if (!args.agents && args.inputMode === 'disabled') {
    return { status: 'skipped', projectDir: args.projectDir };
  }

  const prompts = deps.prompts ?? createPromptAdapter();
  if (args.inputMode === 'auto' && args.target === undefined) {
    writeSetupInfo(io, 'Space to select, Enter to confirm, Esc to go back.');
  }
  const mode =
    args.inputMode === 'disabled'
      ? args.mode
      : ((await prompts.select({
          message: 'What should agents be allowed to do with this KTX project?',
          options: [
            {
              value: 'mcp',
              label: 'Ask data questions with KTX MCP',
              hint: 'Installs the MCP connection and analytics workflow skill. Best for normal use.',
            },
            {
              value: 'mcp-cli',
              label: 'Ask data questions + manage KTX with CLI commands',
              hint: 'Adds an admin CLI skill so agents can run ktx status, sl, wiki, and setup commands.',
            },
          ],
        })) as KtxAgentInstallMode | 'back');
  if (mode === 'back') return { status: 'skipped', projectDir: args.projectDir };

  const targets =
    args.target !== undefined
      ? [args.target]
      : args.inputMode === 'disabled'
        ? []
        : ((await prompts.multiselect({
            message: 'Which agent targets should KTX install?',
            options: [
              { value: 'claude-code', label: 'Claude Code' },
              { value: 'claude-desktop', label: 'Claude Desktop' },
              { value: 'codex', label: 'Codex' },
              { value: 'cursor', label: 'Cursor' },
              { value: 'opencode', label: 'OpenCode' },
              { value: 'universal', label: 'Universal .agents' },
            ],
            required: true,
          })) as KtxAgentTarget[]);
  if (targets.includes('back' as KtxAgentTarget)) return { status: 'back', projectDir: args.projectDir };
  if (targets.length === 0) {
    io.stderr.write(
      args.inputMode === 'disabled'
        ? 'Run in a TTY, or pass --target <target>.\n'
        : 'Missing agent target: pass --target or use interactive setup.\n',
    );
    return { status: 'missing-input', projectDir: args.projectDir };
  }

  const scopeTargets = targets.filter((target) => target !== 'claude-desktop');
  const selectedScope =
    args.inputMode !== 'disabled' &&
    args.scope === 'project' &&
    scopeTargets.length > 0 &&
    scopeTargets.every(targetSupportsGlobalScope)
      ? ((await prompts.select({
          message: `Where should KTX install supported agent config?\n\nKTX project: ${resolve(args.projectDir)}`,
          options: [
            {
              value: 'project',
              label: 'Project scope (KTX project directory)',
              hint: 'Only agents opened from this KTX project path load the project-scoped config.',
            },
            {
              value: 'global',
              label: 'Global scope (user config)',
              hint: 'Agents can load this KTX project from any working directory.',
            },
          ],
        })) as KtxAgentScope | 'back')
      : args.scope;
  if (selectedScope === 'back') return { status: 'back', projectDir: args.projectDir };

  const installs = targets.map((target) => ({ target, scope: effectiveInstallScope(target, selectedScope), mode }));
  const entries: InstallEntry[] = [];
  const snippets: string[] = [];
  const notices = new Set<string>();
  try {
    for (const install of installs) {
      const targetEntries = await installTarget({ projectDir: args.projectDir, ...install });
      entries.push(...targetEntries);
      const mcpResult = await installMcpClientConfig({
        projectDir: args.projectDir,
        target: install.target,
        scope: install.scope,
      });
      entries.push(...mcpResult.entries);
      for (const snippet of mcpResult.snippets) snippets.push(snippet);
      for (const notice of mcpResult.notices) notices.add(notice);
    }
    await writeManifest(
      args.projectDir,
      mergeManifest(args.projectDir, await readKtxAgentInstallManifest(args.projectDir), installs, entries),
    );
    await markAgentsComplete(args.projectDir);
    const setupUi = createKtxSetupUiAdapter();
    for (const summary of formatInstallSummaryLines(installs, entries, args.projectDir)) {
      writeSetupStep(
        io,
        summary.lines.length > 0 ? `${summary.title}\n${summary.lines.join('\n')}` : summary.title,
      );
    }
    const nextActions = formatAgentNextActions({
      projectDir: args.projectDir,
      installs,
      notices: [...notices],
      snippets,
    });
    if (args.showNextActions !== false) {
      setupUi.note(nextActions, 'Required before using agents', io, {
        format: createAgentNextActionsLineFormatter(io.stdout),
      });
      writeSetupOutro(io, 'All set.');
    }
    return { status: 'ready', projectDir: args.projectDir, installs, nextActions };
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { status: 'failed', projectDir: args.projectDir };
  }
}
