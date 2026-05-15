import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadKtxProject,
  markKtxSetupStateStepComplete,
  serializeKtxProjectConfig,
} from '@ktx/context/project';
import { strToU8, zipSync } from 'fflate';
import type { KtxCliIo } from './cli-runtime.js';
import { bold, dim, green } from './io/symbols.js';
import { withMultiselectNavigation } from './prompt-navigation.js';
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
}

export type KtxSetupAgentsResult =
  | {
      status: 'ready';
      projectDir: string;
      installs: Array<{ target: KtxAgentTarget; scope: KtxAgentScope; mode: KtxAgentInstallMode }>;
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
    | { kind: 'file'; path: string; role?: 'skill' | 'rule' | 'analytics-skill' | 'claude-plugin' | 'launcher' }
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

interface KtxCliLauncher {
  command: string;
  args: string[];
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
    notices.push('Run `ktx mcp start` to enable the configured KTX MCP server.');
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
    snippets.push(`Codex MCP snippet for ~/.codex/config.toml:\n${codexSnippet(endpoint)}`);
  } else if (input.target === 'opencode') {
    const path =
      input.scope === 'global'
        ? '~/.config/opencode/opencode.json'
        : relative(input.projectDir, join(input.projectDir, 'opencode.json'));
    snippets.push(`opencode MCP snippet for ${path}:\n${opencodeSnippet(endpoint)}`);
  } else if (input.target === 'universal') {
    snippets.push(universalMcpSnippet(endpoint));
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

function claudeDesktopPluginPath(projectDir: string): string {
  return join(resolve(projectDir), '.ktx/agents/claude/ktx-plugin.zip');
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
        { kind: 'file', path: claudeDesktopPluginPath(input.projectDir), role: 'claude-plugin' as const },
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
  const projectDirArgs = ['--json', '--project-dir', input.projectDir];
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
    `- \`${ktxCommandLine(input.launcher, ['status', ...projectDirArgs])}\``,
    `- \`${ktxCommandLine(input.launcher, ['sl', 'list', ...projectDirArgs])}\``,
    `- \`${ktxCommandLine(input.launcher, ['sl', 'search', '<text>', ...projectDirArgs, '--connection-id', '<id>'])}\``,
    `- \`${ktxCommandLine(input.launcher, [
      'sl',
      'query',
      ...projectDirArgs,
      '--connection-id',
      '<id>',
      '--query-file',
      '<path>',
      '--execute',
      '--max-rows',
      '100',
    ])}\``,
    `- \`${ktxCommandLine(input.launcher, ['wiki', 'search', '<query>', ...projectDirArgs, '--limit', '10'])}\``,
    '',
    'Use semantic-layer queries before direct database access. Do not print secrets or credential references.',
    '',
  ].join('\n');
}

function claudePluginJsonContent(): string {
  return `${JSON.stringify(
    {
      name: 'ktx',
      version: '0.0.0-local',
      description: 'KTX analytics workflow guidance and local MCP tools.',
    },
    null,
    2,
  )}\n`;
}

function claudePluginVersionContent(): string {
  return `${JSON.stringify({ version: '0.0.0-local' }, null, 2)}\n`;
}

function claudePluginSetupContent(input: { projectDir: string; withAdminCli: boolean }): string {
  return [
    '# KTX Claude Plugin',
    '',
    'Install this plugin ZIP from Claude Desktop to load the KTX analytics skill.',
    '',
    `KTX project: \`${input.projectDir}\``,
    '',
    'Included:',
    '',
    '- `ktx-analytics` skill for the MCP analytics workflow',
    ...(input.withAdminCli ? ['- `ktx` admin CLI skill for KTX maintenance commands'] : []),
    '',
    'The KTX MCP server is registered separately in `claude_desktop_config.json` by `ktx setup` and runs as a local stdio child of Claude Desktop — no daemon to start.',
    '',
    'If this checkout or project directory moves, rerun `ktx setup --agents` and reinstall the regenerated plugin.',
    '',
  ].join('\n');
}

function claudePluginLauncherContent(input: { launcher: KtxCliLauncher }): string {
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
    'echo "KTX plugin could not find Node.js. Set KTX_NODE to a Node executable and reinstall the plugin." >&2',
    'exit 127',
    '',
  ].join('\n');
}

async function writeClaudeDesktopPlugin(input: {
  projectDir: string;
  path: string;
  mode: KtxAgentInstallMode;
  launcher: KtxCliLauncher;
}): Promise<void> {
  const withAdminCli = input.mode === 'mcp-cli';
  const files: Record<string, Uint8Array> = {
    '.claude-plugin/plugin.json': strToU8(claudePluginJsonContent()),
    'version.json': strToU8(claudePluginVersionContent()),
    'skills/ktx-analytics/SKILL.md': strToU8(await readAnalyticsSkillContent()),
    'SETUP.md': strToU8(claudePluginSetupContent({ projectDir: input.projectDir, withAdminCli })),
  };
  if (withAdminCli) {
    files['skills/ktx/SKILL.md'] = strToU8(
      cliInstructionContent({ projectDir: input.projectDir, launcher: input.launcher }),
    );
  }
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(input.path, Buffer.from(zipSync(files)));
}

async function writeClaudeDesktopLauncher(input: {
  path: string;
  launcher: KtxCliLauncher;
}): Promise<void> {
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(input.path, claudePluginLauncherContent({ launcher: input.launcher }), 'utf-8');
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

const fileEntryLabels: Record<KtxAgentTarget, string> = {
  'claude-code': 'Skill installed',
  'claude-desktop': 'Skill installed',
  codex: 'Skill installed',
  cursor: 'Rule installed',
  opencode: 'Command installed',
  universal: 'Skill installed',
};

function mcpEntryLabel(entry: Extract<InstallEntry, { kind: 'json-key' }>): string {
  return `MCP config installed — connects client agents to KTX MCP tools (${entry.jsonPath.join('.')})`;
}

function targetSupportsGlobalScope(target: KtxAgentTarget): boolean {
  return target === 'claude-code' || target === 'codex';
}

function effectiveInstallScope(target: KtxAgentTarget, requestedScope: KtxAgentScope): KtxAgentScope {
  return target === 'claude-desktop' ? 'global' : requestedScope;
}

export function formatInstallSummary(
  installs: Array<{ target: KtxAgentTarget; scope: KtxAgentScope; mode: KtxAgentInstallMode }>,
  entries: InstallEntry[],
  projectDir: string,
): string {
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

  const fileHints: Record<string, string> = {
    skill: 'teaches admin agents which KTX CLI commands to run',
    rule: 'tells admin agents when to use KTX CLI',
    'analytics-skill': 'teaches your agent the KTX MCP analytics workflow',
    'claude-plugin': 'bundles KTX skills for Claude Desktop (MCP server is registered in claude_desktop_config.json)',
    launcher: 'runs the local KTX CLI with an available Node.js for Claude Desktop',
  };

  const lines: string[] = [];
  for (const install of installs) {
    const targetEntries = entriesByTarget.get(install.target) ?? [];
    lines.push(`  ${targetDisplayNames[install.target]}`);
    for (const entry of targetEntries) {
      if (entry.kind === 'file') {
        const isRule = entry.role === 'rule' || (!entry.role && fileEntryLabels[install.target] === 'Rule installed');
        const label =
          entry.role === 'analytics-skill'
            ? 'Analytics skill installed'
            : entry.role === 'claude-plugin'
              ? 'Claude plugin generated'
            : entry.role === 'launcher'
              ? 'Launcher installed'
            : isRule
              ? 'Rule installed'
              : fileEntryLabels[install.target];
        const hint = fileHints[isRule ? 'rule' : (entry.role ?? 'skill')] ?? '';
        lines.push(`    + ${label} — ${hint}`);
        if (entry.role !== 'claude-plugin') {
          const displayPath =
            install.scope === 'global' ? entry.path : relative(projectDir, entry.path);
          lines.push(`      ${displayPath}`);
        }
      }
    }
    for (const entry of mcpEntriesByTarget
      .get(install.target)
      ?.filter((entry): entry is Extract<InstallEntry, { kind: 'json-key' }> => entry.kind === 'json-key') ?? []) {
      const displayPath = install.scope === 'global' ? entry.path : relative(projectDir, entry.path);
      lines.push(`    + ${mcpEntryLabel(entry)}`);
      lines.push(`      ${displayPath}`);
    }
  }
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
    if (entry.role === 'claude-plugin') {
      await writeClaudeDesktopPlugin({
        projectDir: input.projectDir,
        path: entry.path,
        mode: input.mode,
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
  const mode =
    args.inputMode === 'disabled'
      ? args.mode
      : ((await prompts.select({
          message: 'How should client agents connect to this KTX project?',
          options: [
            { value: 'mcp', label: 'MCP tools + analytics skill' },
            { value: 'mcp-cli', label: 'MCP tools + analytics skill + admin CLI skill' },
          ],
        })) as KtxAgentInstallMode | 'back');
  if (mode === 'back') return { status: 'skipped', projectDir: args.projectDir };

  const targets =
    args.target !== undefined
      ? [args.target]
      : args.inputMode === 'disabled'
        ? []
        : ((await prompts.multiselect({
            message: withMultiselectNavigation('Which agent targets should KTX install?'),
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
    io.stderr.write('Missing agent target: pass --target or use interactive setup.\n');
    return { status: 'missing-input', projectDir: args.projectDir };
  }

  const scopeTargets = targets.filter((target) => target !== 'claude-desktop');
  const selectedScope =
    args.inputMode !== 'disabled' &&
    args.scope === 'project' &&
    scopeTargets.length > 0 &&
    scopeTargets.every(targetSupportsGlobalScope)
      ? ((await prompts.select({
          message: 'Where should KTX install supported agent config?',
          options: [
            { value: 'project', label: 'Project' },
            { value: 'global', label: 'Global' },
          ],
        })) as KtxAgentScope | 'back')
      : args.scope;
  if (selectedScope === 'back') return { status: 'back', projectDir: args.projectDir };

  const installs = targets.map((target) => ({ target, scope: effectiveInstallScope(target, selectedScope), mode }));
  const entries: InstallEntry[] = [];
  const snippets: string[] = [];
  const notices = new Set<string>();
  let claudeDesktopTutorial: string | undefined;
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
      if (install.target === 'claude-desktop') {
        const pluginEntry = targetEntries.find(
          (entry): entry is Extract<InstallEntry, { kind: 'file' }> =>
            entry.kind === 'file' && entry.role === 'claude-plugin',
        );
        const pluginPath = pluginEntry?.path ?? '';
        const configPath = claudeDesktopConfigPath().path;
        claudeDesktopTutorial = [
          `${green('✓')} ${bold('KTX MCP server registered')}`,
          `  ${dim(configPath)}`,
          '',
          bold('1. Restart Claude Desktop'),
          '   Quit and reopen so it picks up the new MCP server.',
          '',
          bold('2. Install the KTX plugin'),
          '   Open Claude Desktop → Settings → Plugins and install from file:',
          `   📦 ${dim(pluginPath)}`,
        ].join('\n');
      }
    }
    await writeManifest(
      args.projectDir,
      mergeManifest(args.projectDir, await readKtxAgentInstallManifest(args.projectDir), installs, entries),
    );
    await markAgentsComplete(args.projectDir);
    const setupUi = createKtxSetupUiAdapter();
    setupUi.note(
      formatInstallSummary(installs, entries, args.projectDir),
      'Agent integration complete',
      io,
    );
    if (claudeDesktopTutorial) {
      setupUi.note(claudeDesktopTutorial, 'Finish Claude Desktop setup', io, {
        format: (line) => line,
      });
    }
    const nextStepBlocks: string[] = [];
    for (const notice of notices) nextStepBlocks.push(notice);
    for (const snippet of snippets) nextStepBlocks.push(snippet);
    if (nextStepBlocks.length > 0) {
      setupUi.note(nextStepBlocks.join('\n\n'), 'Next steps', io, { format: bold });
    }
    return { status: 'ready', projectDir: args.projectDir, installs };
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { status: 'failed', projectDir: args.projectDir };
  }
}
