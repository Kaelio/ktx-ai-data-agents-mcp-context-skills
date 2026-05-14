import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  initKtxProject,
  type KtxLocalProject,
  loadKtxProject,
  markKtxSetupStateStepComplete,
  mergeKtxSetupGitignoreEntries,
  serializeKtxProjectConfig,
} from '@ktx/context/project';
import type { KtxCliIo } from './cli-runtime.js';
import { gray } from './io/symbols.js';
import { withTextInputNavigation } from './prompt-navigation.js';
import {
  createKtxSetupPromptAdapter,
  type KtxSetupPromptOption,
} from './setup-prompts.js';

export type KtxSetupProjectMode = 'auto' | 'new' | 'existing' | 'prompt-new';
export type KtxSetupInputMode = 'auto' | 'disabled';

export interface KtxSetupProjectArgs {
  projectDir: string;
  mode: KtxSetupProjectMode;
  inputMode: KtxSetupInputMode;
  yes: boolean;
  allowBack?: boolean;
}

export type KtxSetupProjectResult =
  | { status: 'ready'; projectDir: string; project: KtxLocalProject; confirmedCreation?: boolean }
  | { status: 'back'; projectDir: string }
  | { status: 'cancelled'; projectDir: string }
  | { status: 'missing-input'; projectDir: string };

export interface KtxSetupProjectPromptAdapter {
  select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
  text(options: { message: string; placeholder?: string }): Promise<string | undefined>;
  cancel(message: string): void;
}

export interface KtxSetupProjectDeps {
  prompts?: KtxSetupProjectPromptAdapter;
  initProject?: typeof initKtxProject;
  loadProject?: typeof loadKtxProject;
  homeDir?: string;
}

type PromptProjectDirResult =
  | { status: 'selected'; projectDir: string; confirmedCreation: boolean }
  | { status: 'cancelled'; projectDir: string }
  | { status: 'missing-input'; projectDir: string }
  | { status: 'back'; projectDir: string };

const DEFAULT_NEW_PROJECT_FOLDER_NAME = 'ktx-project';

function createClackSetupProjectPromptAdapter(): KtxSetupProjectPromptAdapter {
  return createKtxSetupPromptAdapter({ selectCancelValue: 'exit' });
}

function hasProjectConfig(projectDir: string): boolean {
  return existsSync(join(projectDir, 'ktx.yaml'));
}

function resolveFromProjectDir(projectDir: string, input: string, homeDir: string): string {
  if (input === '~') {
    return resolve(homeDir);
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return resolve(homeDir, input.slice(2));
  }
  return resolve(projectDir, input);
}

async function existingFolderState(
  projectDir: string,
): Promise<'missing' | 'empty-directory' | 'non-empty-directory' | 'not-directory'> {
  try {
    const projectDirStat = await stat(projectDir);
    if (!projectDirStat.isDirectory()) {
      return 'not-directory';
    }
    return (await readdir(projectDir)).length === 0 ? 'empty-directory' : 'non-empty-directory';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

type ConfirmProjectDirResult =
  | { status: 'confirmed'; confirmedCreation: boolean }
  | { status: 'choose-another' }
  | { status: 'back' }
  | { status: 'cancelled' }
  | { status: 'not-directory' };

async function confirmProjectDir(
  selectedDir: string,
  io: KtxCliIo,
  prompts: KtxSetupProjectPromptAdapter,
): Promise<ConfirmProjectDirResult> {
  const state = await existingFolderState(selectedDir);

  if (state === 'not-directory') {
    io.stderr.write(`Project folder path exists and is not a directory: ${selectedDir}\n`);
    return { status: 'not-directory' };
  }

  if (state === 'non-empty-directory') {
    const action = await prompts.select({
      message: `That folder already exists and is not empty: ${selectedDir}`,
      options: [
        { value: 'use-existing', label: 'Yes, create KTX files there' },
        { value: 'choose-another', label: 'Choose another folder' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (action === 'choose-another') return { status: 'choose-another' };
    if (action === 'back') return { status: 'back' };
    if (action !== 'use-existing') return { status: 'cancelled' };
    return { status: 'confirmed', confirmedCreation: true };
  }

  io.stdout.write(`│  KTX will create:\n│    ${selectedDir}\n`);
  const action = await prompts.select({
    message: `Create KTX project at ${selectedDir}?`,
    options: [
      { value: 'create', label: 'Create project' },
      { value: 'choose-another', label: 'Choose another folder' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (action === 'choose-another') return { status: 'choose-another' };
  if (action === 'back') return { status: 'back' };
  if (action !== 'create') return { status: 'cancelled' };
  return { status: 'confirmed', confirmedCreation: true };
}

async function normalizeSetupGitignore(projectDir: string): Promise<void> {
  const gitignorePath = join(projectDir, '.ktx/.gitignore');
  await mkdir(join(projectDir, '.ktx'), { recursive: true });
  const current = existsSync(gitignorePath) ? await readFile(gitignorePath, 'utf-8') : '';
  await writeFile(gitignorePath, mergeKtxSetupGitignoreEntries(current), 'utf-8');
}

async function persistProjectStep(project: KtxLocalProject): Promise<KtxLocalProject> {
  await writeFile(project.configPath, serializeKtxProjectConfig(project.config), 'utf-8');
  await markKtxSetupStateStepComplete(project.projectDir, 'project');
  await normalizeSetupGitignore(project.projectDir);
  return await loadKtxProject({ projectDir: project.projectDir });
}

async function createProject(projectDir: string, deps: KtxSetupProjectDeps): Promise<KtxLocalProject> {
  const initProject = deps.initProject ?? initKtxProject;
  const initialized = await initProject({ projectDir });
  return await persistProjectStep(initialized);
}

async function loadExistingProject(projectDir: string, deps: KtxSetupProjectDeps): Promise<KtxLocalProject> {
  const loadProject = deps.loadProject ?? loadKtxProject;
  const project = await loadProject({ projectDir });
  return await persistProjectStep(project);
}

function printProjectSummary(io: KtxCliIo, projectDir: string): void {
  io.stdout.write(`│  Project: ${projectDir}\n`);
}

async function promptForNewProjectDir(
  projectDir: string,
  homeDir: string,
  io: KtxCliIo,
  prompts: KtxSetupProjectPromptAdapter,
): Promise<PromptProjectDirResult> {
  const defaultProjectDir = join(projectDir, DEFAULT_NEW_PROJECT_FOLDER_NAME);

  while (true) {
    const destinationChoice = await prompts.select({
      message: 'Where should KTX create the project?',
      options: [
        { value: 'default', label: `Create the default project folder: ${defaultProjectDir}` },
        { value: 'custom', label: 'Enter a custom path' },
        { value: 'back', label: 'Back' },
      ],
    });

    let selectedDir: string;
    if (destinationChoice === 'back') {
      return { status: 'back', projectDir };
    }

    if (destinationChoice === 'default') {
      selectedDir = defaultProjectDir;
    } else if (destinationChoice === 'custom') {
      const rawSelectedDir = await prompts.text({
        message: withTextInputNavigation('Project folder path'),
        placeholder: './analytics-ktx, ~/analytics-ktx, or /Users/you/projects/analytics-ktx',
      });
      if (rawSelectedDir === undefined) {
        continue;
      }
      const trimmedSelectedDir = rawSelectedDir.trim();
      if (trimmedSelectedDir.length === 0) {
        io.stderr.write(
          'Enter a relative path like ./analytics-ktx, a home path like ~/analytics-ktx, or an absolute path.\n',
        );
        return { status: 'missing-input', projectDir };
      }
      selectedDir = resolveFromProjectDir(projectDir, trimmedSelectedDir, homeDir);
    } else {
      return { status: 'cancelled', projectDir };
    }

    const confirmed = await confirmProjectDir(selectedDir, io, prompts);
    if (confirmed.status === 'not-directory') return { status: 'missing-input', projectDir };
    if (confirmed.status === 'choose-another') continue;
    if (confirmed.status === 'back') return { status: 'back', projectDir };
    if (confirmed.status === 'cancelled') return { status: 'cancelled', projectDir };
    return { status: 'selected', projectDir: selectedDir, confirmedCreation: confirmed.confirmedCreation };
  }
}

export async function runKtxSetupProjectStep(
  args: KtxSetupProjectArgs,
  io: KtxCliIo,
  deps: KtxSetupProjectDeps = {},
): Promise<KtxSetupProjectResult> {
  const projectDir = resolve(args.projectDir);
  const homeDir = deps.homeDir ?? homedir();
  const exists = hasProjectConfig(projectDir);

  if (args.mode === 'existing') {
    if (!exists) {
      io.stderr.write(`No existing KTX project found at ${projectDir}. Pass --new to create it.\n`);
      return { status: 'missing-input', projectDir };
    }
    const project = await loadExistingProject(projectDir, deps);
    printProjectSummary(io, projectDir);
    return { status: 'ready', projectDir, project };
  }

  if (args.mode === 'new') {
    const project = await createProject(projectDir, deps);
    printProjectSummary(io, projectDir);
    return { status: 'ready', projectDir, project };
  }

  if (args.mode === 'prompt-new') {
    if (args.inputMode === 'disabled') {
      io.stderr.write('Missing new project folder: pass --new --project-dir to create a project without prompts.\n');
      return { status: 'missing-input', projectDir };
    }
    if (!io.stdout.isTTY && !deps.prompts) {
      io.stderr.write(
        'Missing new project folder: pass --new --project-dir to create a project outside an interactive terminal.\n',
      );
      return { status: 'missing-input', projectDir };
    }

    const prompts = deps.prompts ?? createClackSetupProjectPromptAdapter();
    const selected = await promptForNewProjectDir(projectDir, homeDir, io, prompts);
    if (selected.status === 'back') {
      return args.allowBack ? { status: 'back', projectDir } : { status: 'cancelled', projectDir };
    }
    if (selected.status !== 'selected') {
      return selected;
    }

    const project = await createProject(selected.projectDir, deps);
    printProjectSummary(io, selected.projectDir);
    return {
      status: 'ready',
      projectDir: selected.projectDir,
      project,
      confirmedCreation: selected.confirmedCreation,
    };
  }

  if (exists) {
    const project = await loadExistingProject(projectDir, deps);
    printProjectSummary(io, projectDir);
    return { status: 'ready', projectDir, project };
  }

  if (args.inputMode === 'disabled') {
    if (!args.yes) {
      io.stderr.write('Missing setup choice: pass --new or --yes to create a project in non-interactive setup.\n');
      return { status: 'missing-input', projectDir };
    }
    const project = await createProject(projectDir, deps);
    printProjectSummary(io, projectDir);
    return { status: 'ready', projectDir, project };
  }

  if (!io.stdout.isTTY && !deps.prompts) {
    io.stderr.write('Missing setup choice: pass --new or --yes to create a project outside an interactive terminal.\n');
    return { status: 'missing-input', projectDir };
  }

  const prompts = deps.prompts ?? createClackSetupProjectPromptAdapter();
  const defaultProjectDir = join(projectDir, DEFAULT_NEW_PROJECT_FOLDER_NAME);
  const defaultProjectDirLabel = [
    gray(defaultProjectDir.slice(0, -DEFAULT_NEW_PROJECT_FOLDER_NAME.length)),
    DEFAULT_NEW_PROJECT_FOLDER_NAME,
  ].join('');
  io.stdout.write(
    '│  Use Up/Down to move, Enter to confirm the current selection, choose Back to return to the previous step, Ctrl+C to exit.\n',
  );
  while (true) {
    const choice = await prompts.select({
      message: 'Where should KTX create the project?',
      options: [
        { value: 'current', label: `Current directory (${projectDir})` },
        { value: 'new-default', label: `New subfolder (${defaultProjectDirLabel})` },
        { value: 'new-custom', label: 'Custom path' },
        ...(args.allowBack ? [{ value: 'back', label: 'Back' }] : []),
        ...(args.allowBack ? [] : [{ value: 'exit', label: 'Exit' }]),
      ],
    });

    if (choice === 'back') {
      return args.allowBack ? { status: 'back', projectDir } : { status: 'cancelled', projectDir };
    }

    if (choice === 'exit') {
      prompts.cancel('Setup cancelled.');
      return { status: 'cancelled', projectDir };
    }

    if (choice === 'current') {
      const project = await createProject(projectDir, deps);
      printProjectSummary(io, projectDir);
      return { status: 'ready', projectDir, project };
    }

    if (choice === 'new-default') {
      const confirmed = await confirmProjectDir(defaultProjectDir, io, prompts);
      if (confirmed.status === 'choose-another' || confirmed.status === 'back') continue;
      if (confirmed.status === 'not-directory') return { status: 'missing-input', projectDir };
      if (confirmed.status === 'cancelled') return { status: 'cancelled', projectDir };
      const project = await createProject(defaultProjectDir, deps);
      printProjectSummary(io, defaultProjectDir);
      return {
        status: 'ready',
        projectDir: defaultProjectDir,
        project,
        confirmedCreation: confirmed.confirmedCreation,
      };
    }

    if (choice === 'new-custom') {
      const rawPath = await prompts.text({
        message: withTextInputNavigation('Project folder path'),
        placeholder: './analytics-ktx, ~/analytics-ktx, or /Users/you/projects/analytics-ktx',
      });
      if (rawPath === undefined) continue;
      const trimmed = rawPath.trim();
      if (trimmed.length === 0) {
        io.stderr.write(
          'Enter a relative path like ./analytics-ktx, a home path like ~/analytics-ktx, or an absolute path.\n',
        );
        return { status: 'missing-input', projectDir };
      }
      const customDir = resolveFromProjectDir(projectDir, trimmed, homeDir);
      const confirmed = await confirmProjectDir(customDir, io, prompts);
      if (confirmed.status === 'choose-another' || confirmed.status === 'back') continue;
      if (confirmed.status === 'not-directory') return { status: 'missing-input', projectDir };
      if (confirmed.status === 'cancelled') return { status: 'cancelled', projectDir };
      const project = await createProject(customDir, deps);
      printProjectSummary(io, customDir);
      return { status: 'ready', projectDir: customDir, project, confirmedCreation: confirmed.confirmedCreation };
    }

    prompts.cancel('Setup cancelled.');
    return { status: 'cancelled', projectDir };
  }
}
