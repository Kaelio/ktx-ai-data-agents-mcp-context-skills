import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadKtxProject,
  markKtxSetupStateStepComplete,
  serializeKtxProjectConfig,
} from '@ktx/context/project';
import type { KtxCliIo } from './cli-runtime.js';
import { withMultiselectNavigation } from './prompt-navigation.js';
import {
  createKtxSetupPromptAdapter,
  type KtxSetupPromptOption,
} from './setup-prompts.js';
import { readKtxMcpDaemonStatus } from './managed-mcp-daemon.js';

export type KtxAgentTarget = 'claude-code' | 'codex' | 'cursor' | 'opencode' | 'universal';
export type KtxAgentScope = 'project' | 'global' | 'local';
export type KtxAgentInstallMode = 'cli';

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
    | { kind: 'file'; path: string; role?: 'skill' | 'rule' | 'research-skill' }
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

async function installMcpClientConfig(input: {
  projectDir: string;
  target: KtxAgentTarget;
  scope: KtxAgentScope;
}): Promise<KtxMcpClientInstallResult> {
  const endpoint = await resolveMcpEndpoint(input.projectDir);
  const entries: InstallEntry[] = [];
  const snippets: string[] = [];
  const notices: string[] = [];

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
    const path = input.scope === 'global' ? '~/.config/opencode/opencode.json' : relative(input.projectDir, join(input.projectDir, 'opencode.json'));
    snippets.push(`opencode MCP snippet for ${path}:\n${opencodeSnippet(endpoint)}`);
  }

  return { entries, snippets, notices };
}

export function agentInstallManifestPath(projectDir: string): string {
  return join(resolve(projectDir), '.ktx/agents/install-manifest.json');
}

export function plannedKtxAgentFiles(input: {
  projectDir: string;
  target: KtxAgentTarget;
  scope: KtxAgentScope;
  mode: KtxAgentInstallMode;
}): InstallEntry[] {
  if (input.scope === 'global') {
    if (input.target === 'claude-code') {
      const home = process.env.HOME ?? '';
      return [
        { kind: 'file', path: join(home, '.claude/skills/ktx/SKILL.md'), role: 'skill' as const },
        { kind: 'file', path: join(home, '.claude/skills/ktx-research/SKILL.md'), role: 'research-skill' as const },
        { kind: 'file', path: join(home, '.claude/rules/ktx.md'), role: 'rule' as const },
      ];
    }
    if (input.target === 'codex') {
      const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex');
      return [
        { kind: 'file', path: join(codexHome, 'skills/ktx/SKILL.md'), role: 'skill' as const },
        { kind: 'file', path: join(codexHome, 'skills/ktx-research/SKILL.md'), role: 'research-skill' as const },
        { kind: 'file', path: join(codexHome, 'instructions/ktx.md'), role: 'rule' as const },
      ];
    }
    if (input.target === 'cursor' || input.target === 'opencode') {
      return [];
    }
    throw new Error(`Global ${input.target} installation is not supported; omit --global.`);
  }

  const root = resolve(input.projectDir);
  const cliEntries: Partial<Record<KtxAgentTarget, InstallEntry[]>> = {
    'claude-code': [
      { kind: 'file', path: join(root, '.claude/skills/ktx/SKILL.md'), role: 'skill' },
      { kind: 'file', path: join(root, '.claude/skills/ktx-research/SKILL.md'), role: 'research-skill' },
    ],
    codex: [
      { kind: 'file', path: join(root, '.agents/skills/ktx/SKILL.md'), role: 'skill' },
      { kind: 'file', path: join(root, '.agents/skills/ktx-research/SKILL.md'), role: 'research-skill' },
    ],
    cursor: [
      { kind: 'file', path: join(root, '.cursor/rules/ktx.mdc') },
      { kind: 'file', path: join(root, '.cursor/rules/ktx-research.mdc'), role: 'research-skill' },
    ],
    opencode: [
      { kind: 'file', path: join(root, '.opencode/commands/ktx.md') },
      { kind: 'file', path: join(root, '.opencode/commands/ktx-research.md'), role: 'research-skill' },
    ],
    universal: [
      { kind: 'file', path: join(root, '.agents/skills/ktx/SKILL.md') },
      { kind: 'file', path: join(root, '.agents/skills/ktx-research/SKILL.md'), role: 'research-skill' },
    ],
  };
  const ruleEntries: Partial<Record<KtxAgentTarget, InstallEntry>> = {
    'claude-code': { kind: 'file', path: join(root, '.claude/rules/ktx.md'), role: 'rule' },
    codex: { kind: 'file', path: join(root, '.codex/instructions/ktx.md'), role: 'rule' },
  };
  return [...(cliEntries[input.target] ?? []), ruleEntries[input.target]].filter(
    (entry): entry is InstallEntry => entry !== undefined,
  );
}

function ktxCliLauncher(): KtxCliLauncher {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('./bin.js', import.meta.url))],
  };
}

async function readResearchSkillContent(): Promise<string> {
  const path = fileURLToPath(new URL('./skills/research/SKILL.md', import.meta.url));
  const content = await readFile(path, 'utf-8');
  return content.endsWith('\n') ? content : `${content}\n`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
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
    `Use this project with \`--project-dir ${input.projectDir}\`.`,
    'Commands are pinned to the local KTX CLI path that created this file, so agents do not need `ktx` in PATH.',
    'If the CLI path no longer exists after moving this checkout or reinstalling KTX, rerun `ktx setup --agents`.',
    '',
    'Agents must not print secrets, credential references, environment variable values, or file contents from `.ktx/secrets`.',
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

function ruleInstructionContent(input: { projectDir: string }): string {
  return [
    `Use the \`ktx\` CLI to query local semantic context and wiki knowledge for this project (\`--project-dir ${input.projectDir}\`).`,
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
  return entry.kind === 'json-key' ? `${entry.kind}:${entry.path}:${entry.jsonPath.join('.')}` : `${entry.kind}:${entry.path}`;
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
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  universal: 'Universal .agents',
};

const fileEntryLabels: Record<KtxAgentTarget, string> = {
  'claude-code': 'Skill installed',
  codex: 'Skill installed',
  cursor: 'Rule installed',
  opencode: 'Command installed',
  universal: 'Skill installed',
};

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

  const fileHints: Record<string, string> = {
    skill: 'teaches your agent which KTX commands to run',
    rule: 'tells your agent when to use KTX',
    'research-skill': 'teaches your agent the KTX MCP research workflow',
  };

  const lines: string[] = [];
  for (const install of installs) {
    const targetEntries = entriesByTarget.get(install.target) ?? [];
    lines.push(`  ${targetDisplayNames[install.target]}`);
    for (const entry of targetEntries) {
      const displayPath =
        install.scope === 'global' ? entry.path : relative(projectDir, entry.path);
      if (entry.kind === 'file') {
        const isRule = entry.role === 'rule' || fileEntryLabels[install.target] === 'Rule installed';
        const label = entry.role === 'research-skill' ? 'Research skill installed' : isRule ? 'Rule installed' : fileEntryLabels[install.target];
        const hint = fileHints[isRule ? 'rule' : (entry.role ?? 'skill')] ?? '';
        lines.push(`    + ${label} — ${hint}`);
        lines.push(`      ${displayPath}`);
      }
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
    const content =
      entry.role === 'rule'
        ? ruleInstructionContent({ projectDir: input.projectDir })
        : entry.role === 'research-skill'
          ? await readResearchSkillContent()
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
          message: 'How should agents use this KTX project?',
          options: [
            { value: 'cli', label: 'CLI tools and skills' },
            { value: 'skip', label: 'Skip' },
          ],
        })) as KtxAgentInstallMode | 'skip' | 'back');
  if (mode === 'back') return { status: 'skipped', projectDir: args.projectDir };
  if (mode === 'skip') return { status: 'skipped', projectDir: args.projectDir };

  const targets =
    args.target !== undefined
      ? [args.target]
      : args.inputMode === 'disabled'
        ? []
        : ((await prompts.multiselect({
            message: withMultiselectNavigation('Which agent targets should KTX install?'),
            options: [
              { value: 'claude-code', label: 'Claude Code' },
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

  const installs = targets.map((target) => ({ target, scope: args.scope, mode }));
  const entries: InstallEntry[] = [];
  const snippets: string[] = [];
  const notices = new Set<string>();
  try {
    for (const install of installs) {
      entries.push(...(await installTarget({ projectDir: args.projectDir, ...install })));
      const mcpResult = await installMcpClientConfig({ projectDir: args.projectDir, target: install.target, scope: install.scope });
      entries.push(...mcpResult.entries);
      for (const snippet of mcpResult.snippets) snippets.push(snippet);
      for (const notice of mcpResult.notices) notices.add(notice);
    }
    await writeManifest(args.projectDir, mergeManifest(args.projectDir, await readKtxAgentInstallManifest(args.projectDir), installs, entries));
    await markAgentsComplete(args.projectDir);
    io.stdout.write(`\nAgent integration complete\n\n${formatInstallSummary(installs, entries, args.projectDir)}\n`);
    for (const snippet of snippets) {
      io.stdout.write(`\n${snippet}\n`);
    }
    for (const notice of notices) {
      io.stdout.write(`\n${notice}\n`);
    }
    return { status: 'ready', projectDir: args.projectDir, installs };
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { status: 'failed', projectDir: args.projectDir };
  }
}
