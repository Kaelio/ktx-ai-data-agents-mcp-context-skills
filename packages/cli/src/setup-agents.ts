import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancel, confirm, isCancel, multiselect, select } from '@clack/prompts';
import {
  loadKtxProject,
  markKtxSetupStateStepComplete,
  serializeKtxProjectConfig,
  stripKtxSetupCompletedSteps,
} from '@ktx/context/project';
import type { KtxCliIo } from './cli-runtime.js';
import { withMenuOptionsSpacing, withMultiselectNavigation } from './prompt-navigation.js';
import { withSetupInterruptConfirmation } from './setup-interrupt.js';

export type KtxAgentTarget = 'claude-code' | 'codex' | 'cursor' | 'opencode' | 'universal';
export type KtxAgentScope = 'project' | 'global';
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
    | { kind: 'file'; path: string; role?: 'skill' | 'rule' }
    | { kind: 'json-key'; path: string; jsonPath: string[] }
  >;
}

type InstallEntry = KtxAgentInstallManifest['entries'][number];

interface KtxCliLauncher {
  command: string;
  args: string[];
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
        { kind: 'file', path: join(home, '.claude/rules/ktx.md'), role: 'rule' as const },
      ];
    }
    if (input.target === 'codex') {
      const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex');
      return [
        { kind: 'file', path: join(codexHome, 'skills/ktx/SKILL.md'), role: 'skill' as const },
        { kind: 'file', path: join(codexHome, 'instructions/ktx.md'), role: 'rule' as const },
      ];
    }
    throw new Error(`Global ${input.target} installation is not supported; use --project.`);
  }

  const root = resolve(input.projectDir);
  const cliEntries: Partial<Record<KtxAgentTarget, InstallEntry>> = {
    'claude-code': { kind: 'file', path: join(root, '.claude/skills/ktx/SKILL.md'), role: 'skill' },
    codex: { kind: 'file', path: join(root, '.agents/skills/ktx/SKILL.md'), role: 'skill' },
    cursor: { kind: 'file', path: join(root, '.cursor/rules/ktx.mdc') },
    opencode: { kind: 'file', path: join(root, '.opencode/commands/ktx.md') },
    universal: { kind: 'file', path: join(root, '.agents/skills/ktx/SKILL.md') },
  };
  const ruleEntries: Partial<Record<KtxAgentTarget, InstallEntry>> = {
    'claude-code': { kind: 'file', path: join(root, '.claude/rules/ktx.md'), role: 'rule' },
    codex: { kind: 'file', path: join(root, '.codex/instructions/ktx.md'), role: 'rule' },
  };
  return [cliEntries[input.target], ruleEntries[input.target]].filter(
    (entry): entry is InstallEntry => entry !== undefined,
  );
}

function ktxCliLauncher(): KtxCliLauncher {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('./bin.js', import.meta.url))],
  };
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
    'description: Use local KTX semantic context, wiki knowledge, and safe SQL execution for this project.',
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
    `- \`${ktxCommandLine(input.launcher, ['agent', 'context', ...projectDirArgs])}\``,
    `- \`${ktxCommandLine(input.launcher, ['agent', 'sl', 'list', ...projectDirArgs])}\``,
    `- \`${ktxCommandLine(input.launcher, ['agent', 'sl', 'read', '<sourceName>', ...projectDirArgs])}\``,
    `- \`${ktxCommandLine(input.launcher, [
      'agent',
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
    `- \`${ktxCommandLine(input.launcher, ['agent', 'wiki', 'search', '<query>', ...projectDirArgs])}\``,
    `- \`${ktxCommandLine(input.launcher, ['agent', 'wiki', 'read', '<pageId>', ...projectDirArgs])}\``,
    `- \`${ktxCommandLine(input.launcher, [
      'agent',
      'sql',
      'execute',
      ...projectDirArgs,
      '--connection-id',
      '<id>',
      '--sql-file',
      '<path>',
      '--max-rows',
      '100',
    ])}\``,
    '',
    'SQL execution is read-only, requires an explicit row limit, and should use the smallest useful limit.',
    '',
  ].join('\n');
}

function ruleInstructionContent(input: { projectDir: string }): string {
  return [
    `Use the \`ktx\` CLI to query local semantic context, wiki knowledge, and execute safe SQL for this project (\`--project-dir ${input.projectDir}\`).`,
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
  select(options: { message: string; options: Array<{ value: string; label: string }> }): Promise<string>;
  multiselect(options: {
    message: string;
    options: Array<{ value: string; label: string }>;
    required?: boolean;
  }): Promise<string[]>;
  cancel(message: string): void;
}

export interface KtxSetupAgentsDeps {
  prompts?: KtxSetupAgentsPromptAdapter;
}

function createPromptAdapter(): KtxSetupAgentsPromptAdapter {
  return {
    async select(options) {
      const value = await withSetupInterruptConfirmation(() => select(withMenuOptionsSpacing(options)));
      if (isCancel(value)) {
        cancel('Setup cancelled.');
        return 'back';
      }
      return String(value);
    },
    async multiselect(options) {
      while (true) {
        const value = await withSetupInterruptConfirmation(() => multiselect(withMenuOptionsSpacing(options)));
        if (isCancel(value)) {
          cancel('Setup cancelled.');
          return ['back'];
        }
        const selected = [...value] as string[];
        if (selected.length === 0 && !options.required) {
          const skipConfirmed = await confirm({ message: 'Nothing selected. Skip this step?', initialValue: false });
          if (isCancel(skipConfirmed)) {
            cancel('Setup cancelled.');
            return ['back'];
          }
          if (!skipConfirmed) continue;
        }
        return selected;
      }
    },
    cancel(message) {
      cancel(message);
    },
  };
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
  let idx = 0;
  for (const install of installs) {
    const planned = plannedKtxAgentFiles({ projectDir, ...install });
    entriesByTarget.set(install.target, entries.slice(idx, idx + planned.length));
    idx += planned.length;
  }

  const fileHints: Record<string, string> = {
    skill: 'teaches your agent which KTX commands to run',
    rule: 'tells your agent when to use KTX',
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
        const label = isRule ? 'Rule installed' : fileEntryLabels[install.target];
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
        : cliInstructionContent({ projectDir: input.projectDir, launcher });
    await mkdir(dirname(entry.path), { recursive: true });
    await writeFile(entry.path, content, 'utf-8');
  }
  return entries;
}

async function markAgentsComplete(projectDir: string): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  await writeFile(project.configPath, serializeKtxProjectConfig(stripKtxSetupCompletedSteps(project.config)), 'utf-8');
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
  try {
    for (const install of installs) entries.push(...(await installTarget({ projectDir: args.projectDir, ...install })));
    await writeManifest(args.projectDir, mergeManifest(args.projectDir, await readKtxAgentInstallManifest(args.projectDir), installs, entries));
    await markAgentsComplete(args.projectDir);
    io.stdout.write(`\nAgent integration complete\n\n${formatInstallSummary(installs, entries, args.projectDir)}\n`);
    return { status: 'ready', projectDir: args.projectDir, installs };
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { status: 'failed', projectDir: args.projectDir };
  }
}
