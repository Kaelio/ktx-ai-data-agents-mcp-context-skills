import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { contextBuildCommands, writeKtxSetupContextState } from './setup-context.js';
import { runDemoTour } from './setup-demo-tour.js';
import { readKtxSetupStatus, runKtxSetup } from './setup.js';

vi.mock('./setup-demo-tour.js', () => ({
  runDemoTour: vi.fn(async () => 0),
}));

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('setup status', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-status-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reports a missing project without creating files', async () => {
    const status = await readKtxSetupStatus(tempDir);

    expect(status).toMatchObject({
      project: { path: tempDir, ready: false },
      llm: { ready: false },
      embeddings: { ready: false },
      databases: [],
      sources: [],
      context: { ready: false, status: 'not_started' },
      agents: [],
    });
  });

  it('reports deterministic default embeddings as not setup-ready', async () => {
    await mkdir(tempDir, { recursive: true });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: revenue',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '    anthropic:',
        '      api_key: env:ANTHROPIC_API_KEY',
        '  models:',
        '    default: claude-sonnet-4-6',
        'ingest:',
        '  embeddings:',
        '    backend: deterministic',
        '    model: deterministic',
        '    dimensions: 8',
        'connections: {}',
      ].join('\n'),
      'utf-8',
    );

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      project: { path: tempDir, ready: true },
      llm: { backend: 'anthropic', ready: true, model: 'claude-sonnet-4-6' },
      embeddings: { backend: 'deterministic', ready: false, model: 'deterministic', dimensions: 8 },
    });
  });

  it('uses setup database connection ids when present', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: revenue',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '    - analytics',
        '  completed_steps:',
        '    - project',
        '    - databases',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_URL',
        'ingest:',
        '  embeddings:',
        '    backend: openai',
        '    model: text-embedding-3-small',
        '    dimensions: 1536',
        '    openai:',
        '      api_key: env:OPENAI_API_KEY',
      ].join('\n'),
      'utf-8',
    );

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      databases: [
        { connectionId: 'warehouse', ready: true },
        { connectionId: 'analytics', ready: false },
      ],
    });
  });

  it('reports selected databases as ready only after the database setup step is complete', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: revenue',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '  completed_steps:',
        '    - project',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    readonly: true',
        '',
      ].join('\n'),
      'utf-8',
    );

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      databases: [{ connectionId: 'warehouse', ready: false }],
    });

    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: revenue',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '  completed_steps:',
        '    - project',
        '    - databases',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    readonly: true',
        '',
      ].join('\n'),
      'utf-8',
    );

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      databases: [{ connectionId: 'warehouse', ready: true }],
    });
  });

  it('reports source status from configured source connections', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: revenue',
        'setup:',
        '  database_connection_ids: []',
        '  completed_steps:',
        '    - project',
        '    - sources',
        'connections:',
        '  docs:',
        '    driver: notion',
        '    auth_token_ref: env:NOTION_TOKEN',
        '    crawl_mode: all_accessible',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '',
      ].join('\n'),
      'utf-8',
    );

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      sources: [{ connectionId: 'docs', type: 'notion', ready: true }],
    });
  });

  it('reports agent status from the install manifest', async () => {
    await mkdir(join(tempDir, '.ktx', 'agents'), { recursive: true });
    await writeFile(join(tempDir, 'ktx.yaml'), 'project: revenue\nconnections: {}\n', 'utf-8');
    await writeFile(
      join(tempDir, '.ktx/agents/install-manifest.json'),
      JSON.stringify(
        {
          version: 1,
          projectDir: tempDir,
          installedAt: '2026-05-07T00:00:00.000Z',
          installs: [{ target: 'codex', scope: 'project', mode: 'cli' }],
          entries: [],
        },
        null,
        2,
      ),
      'utf-8',
    );

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      agents: [{ target: 'codex', scope: 'project', ready: true }],
    });
  });

  it('reports setup-managed context build status and commands', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: revenue',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '  completed_steps:',
        '    - project',
        '    - llm',
        '    - embeddings',
        '    - databases',
        '    - sources',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-6',
        'ingest:',
        '  embeddings:',
        '    backend: openai',
        '    model: text-embedding-3-small',
        '    dimensions: 1536',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-abc123',
      status: 'running',
      startedAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:01:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir, 'setup-context-local-abc123'),
    });

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      context: {
        ready: false,
        status: 'running',
        runId: 'setup-context-local-abc123',
        watchCommand: `ktx setup context watch setup-context-local-abc123 --project-dir ${tempDir}`,
        statusCommand: `ktx setup context status setup-context-local-abc123 --project-dir ${tempDir}`,
      },
    });
  });

  it('prints plain and JSON setup status', async () => {
    const plainIo = makeIo();
    const jsonIo = makeIo();

    await expect(runKtxSetup({ command: 'status', projectDir: tempDir, json: false }, plainIo.io)).resolves.toBe(0);
    await expect(runKtxSetup({ command: 'status', projectDir: tempDir, json: true }, jsonIo.io)).resolves.toBe(0);

    expect(plainIo.stdout()).toContain(`No KTX project found at ${tempDir}.`);
    expect(plainIo.stdout()).toContain('Check another project: ktx --project-dir <folder> setup status');
    expect(plainIo.stdout()).toContain('Or from that folder: ktx setup status');
    expect(plainIo.stdout()).toContain('Create a new KTX project here: ktx setup');
    expect(plainIo.stdout()).not.toContain('Project ready: no');
    expect(JSON.parse(jsonIo.stdout())).toMatchObject({ project: { path: tempDir, ready: false } });
    expect(plainIo.stderr()).toBe('');
    expect(jsonIo.stderr()).toBe('');
  });

  it('prints the readiness checklist for an existing project', async () => {
    const testIo = makeIo();
    await writeFile(join(tempDir, 'ktx.yaml'), 'project: revenue\nconnections: {}\n', 'utf-8');

    await expect(runKtxSetup({ command: 'status', projectDir: tempDir, json: false }, testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toContain(`KTX project: ${tempDir}`);
    expect(testIo.stdout()).toContain('Project ready: yes');
    expect(testIo.stdout()).toContain('LLM ready: no');
    expect(testIo.stdout()).toContain('KTX context built: no');
    expect(testIo.stdout()).not.toContain('No KTX project found.');
    expect(testIo.stderr()).toBe('');
  });

  it('prints the setup shell intro for auto-created run mode', async () => {
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
      ),
    ).resolves.toBe(0);

    expect(testIo.stdout()).toContain('KTX setup');
    expect(testIo.stdout()).toContain(`Project: ${tempDir}`);
    expect(testIo.stdout()).toContain('Project ready: yes');
    expect(testIo.stdout()).toContain('What you can do next:');
    expect(testIo.stdout()).toContain('Connect data, then build context.');
    expect(testIo.stdout()).toContain('ktx setup');
    expect(testIo.stdout()).not.toContain('ktx agent context --json');
    expect(testIo.stdout()).not.toContain('Optional MCP:');
    expect(testIo.stderr()).toBe('');
  });

  it('shows demo near the bottom of the first setup intent menu before project creation', async () => {
    const testIo = makeIo();
    const select = vi.fn(async (options: { options: Array<{ value: string; label: string }> }) => {
      const labels = options.options.map((option) => option.label);
      expect(labels).toEqual([
        'Set up KTX for my data',
        'Check setup status',
        'Explore a pre-built KTX project',
        'Exit',
      ]);
      expect(labels.indexOf('Explore a pre-built KTX project')).toBe(labels.length - 2);
      return 'exit';
    });
    const cancel = vi.fn();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: false,
          skipSources: false,
          showEntryMenu: true,
        },
        testIo.io,
        { entryMenuDeps: { prompts: { select, cancel } } },
      ),
    ).resolves.toBe(0);

    expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: 'What do you want to do?' }));
    expect(cancel).toHaveBeenCalledWith('Setup cancelled.');
  });

  it('shows agent connection only when the selected setup project exists', async () => {
    const missingIo = makeIo();
    const existingIo = makeIo();
    const missingSelect = vi.fn(async (options: { options: Array<{ value: string; label: string }> }) => {
      expect(options.options.map((option) => option.label)).not.toContain('Connect a coding agent to KTX');
      return 'exit';
    });
    const existingSelect = vi.fn(async (options: { options: Array<{ value: string; label: string }> }) => {
      const labels = options.options.map((option) => option.label);
      expect(labels).toEqual([
        'Resume or change an existing setup',
        'Create a new KTX project',
        'Connect a coding agent to KTX',
        'Check setup status',
        'Explore a pre-built KTX project',
        'Exit',
      ]);
      return 'exit';
    });

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: false,
          skipSources: false,
          showEntryMenu: true,
        },
        missingIo.io,
        { entryMenuDeps: { prompts: { select: missingSelect, cancel: vi.fn() } } },
      ),
    ).resolves.toBe(0);

    await writeFile(join(tempDir, 'ktx.yaml'), 'project: revenue\nconnections: {}\n', 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: false,
          skipSources: false,
          showEntryMenu: true,
        },
        existingIo.io,
        { entryMenuDeps: { prompts: { select: existingSelect, cancel: vi.fn() } } },
      ),
    ).resolves.toBe(0);

    expect(missingSelect).toHaveBeenCalledTimes(1);
    expect(existingSelect).toHaveBeenCalledTimes(1);
  });

  it('lets Back from project selection return to the first setup intent menu', async () => {
    const entryChoices = ['setup', 'exit'];
    const entryPrompts = {
      select: vi.fn(async () => entryChoices.shift() ?? 'exit'),
      cancel: vi.fn(),
    };
    const projectPrompts = {
      select: vi.fn(async () => 'back'),
      text: vi.fn(),
      cancel: vi.fn(),
    };

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
          showEntryMenu: true,
        },
        makeIo().io,
        {
          entryMenuDeps: { prompts: entryPrompts },
          project: { prompts: projectPrompts },
        },
      ),
    ).resolves.toBe(0);

    expect(projectPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Which KTX project should setup use?',
        options: expect.arrayContaining([expect.objectContaining({ value: 'back', label: 'Back' })]),
      }),
    );
    expect(projectPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Which KTX project should setup use?',
        options: expect.not.arrayContaining([expect.objectContaining({ value: 'exit', label: 'Exit' })]),
      }),
    );
    expect(entryPrompts.select).toHaveBeenCalledTimes(2);
    expect(entryPrompts.cancel).toHaveBeenCalledWith('Setup cancelled.');
    expect(projectPrompts.cancel).not.toHaveBeenCalled();
    await expect(stat(join(tempDir, 'ktx.yaml'))).rejects.toThrow();
  });

  it('lets Back from new project creation return to the first setup intent menu', async () => {
    const existingConfig = 'project: revenue\nconnections: {}\n';
    await writeFile(join(tempDir, 'ktx.yaml'), existingConfig, 'utf-8');

    const entryChoices = ['new-project', 'exit'];
    const entryPrompts = {
      select: vi.fn(async () => entryChoices.shift() ?? 'exit'),
      cancel: vi.fn(),
    };
    const projectPrompts = {
      select: vi.fn(async () => 'back'),
      text: vi.fn(),
      cancel: vi.fn(),
    };

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
          showEntryMenu: true,
        },
        makeIo().io,
        {
          entryMenuDeps: { prompts: entryPrompts },
          project: { prompts: projectPrompts },
        },
      ),
    ).resolves.toBe(0);

    expect(projectPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Where should KTX create the project?',
        options: expect.arrayContaining([expect.objectContaining({ value: 'back', label: 'Back' })]),
      }),
    );
    expect(entryPrompts.select).toHaveBeenCalledTimes(2);
    expect(entryPrompts.cancel).toHaveBeenCalledWith('Setup cancelled.');
    expect(projectPrompts.cancel).not.toHaveBeenCalled();
    await expect(readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).resolves.toBe(existingConfig);
  });

  it('creates a separate project when the existing setup menu chooses new project', async () => {
    const existingProjectDir = join(tempDir, 'existing');
    const newProjectDir = join(tempDir, 'fresh');
    await mkdir(existingProjectDir, { recursive: true });
    const existingConfig = 'project: revenue\nconnections: {}\n';
    await writeFile(join(existingProjectDir, 'ktx.yaml'), existingConfig, 'utf-8');

    const projectChoices = ['custom', 'create'];
    const projectPrompts = {
      select: vi.fn(async () => projectChoices.shift() ?? 'exit'),
      text: vi.fn(async () => newProjectDir),
      cancel: vi.fn(),
    };
    const model = vi.fn(async (args: { projectDir: string }) => ({
      status: 'skipped' as const,
      projectDir: args.projectDir,
    }));
    const embeddings = vi.fn(async (args: { projectDir: string }) => ({
      status: 'skipped' as const,
      projectDir: args.projectDir,
    }));
    const databases = vi.fn(async (args: { projectDir: string }) => ({
      status: 'skipped' as const,
      projectDir: args.projectDir,
    }));
    const sources = vi.fn(async (args: { projectDir: string }) => ({
      status: 'skipped' as const,
      projectDir: args.projectDir,
    }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: existingProjectDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
          showEntryMenu: true,
        },
        makeIo().io,
        {
          entryMenuDeps: { prompts: { select: vi.fn(async () => 'new-project'), cancel: vi.fn() } },
          project: { prompts: projectPrompts },
          model,
          embeddings,
          databases,
          sources,
        },
      ),
    ).resolves.toBe(0);

    expect(projectPrompts.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Project folder path\nPress Escape to go back.\n',
        placeholder: './analytics-ktx, ~/analytics-ktx, or /Users/you/projects/analytics-ktx',
      }),
    );
    expect(projectPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Where should KTX create the project?' }),
    );
    await expect(stat(join(newProjectDir, 'ktx.yaml'))).resolves.toBeDefined();
    await expect(readFile(join(existingProjectDir, 'ktx.yaml'), 'utf-8')).resolves.toBe(existingConfig);
    expect(model).toHaveBeenCalledWith(expect.objectContaining({ projectDir: newProjectDir }), expect.anything());
    expect(embeddings).toHaveBeenCalledWith(expect.objectContaining({ projectDir: newProjectDir }), expect.anything());
    expect(databases).toHaveBeenCalledWith(expect.objectContaining({ projectDir: newProjectDir }), expect.anything());
    expect(sources).toHaveBeenCalledWith(expect.objectContaining({ projectDir: newProjectDir }), expect.anything());
  });

  it('does not print navigation instructions immediately after confirming new project creation', async () => {
    const existingProjectDir = join(tempDir, 'existing');
    const newProjectDir = join(tempDir, 'fresh');
    await mkdir(existingProjectDir, { recursive: true });
    await writeFile(join(existingProjectDir, 'ktx.yaml'), 'project: revenue\nconnections: {}\n', 'utf-8');

    const projectChoices = ['custom', 'create'];
    const projectPrompts = {
      select: vi.fn(async () => projectChoices.shift() ?? 'exit'),
      text: vi.fn(async () => newProjectDir),
      cancel: vi.fn(),
    };
    const model = vi.fn(async (args: { projectDir: string; showPromptInstructions?: boolean }) => {
      expect(args.showPromptInstructions).toBe(false);
      return { status: 'skipped' as const, projectDir: args.projectDir };
    });
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: existingProjectDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
          showEntryMenu: true,
        },
        testIo.io,
        {
          entryMenuDeps: { prompts: { select: vi.fn(async () => 'new-project'), cancel: vi.fn() } },
          project: { prompts: projectPrompts },
          model,
        },
      ),
    ).resolves.toBe(0);

    expect(testIo.stdout()).toContain(`Project: ${newProjectDir}\n`);
    expect(testIo.stdout()).not.toContain(
      'Use Up/Down to move, Enter to confirm the current selection, choose Back to return to the previous step, Ctrl+C to exit.',
    );
  });

  it('runs the demo tour when the first setup intent menu chooses demo', async () => {
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: false,
          skipSources: false,
          showEntryMenu: true,
        },
        testIo.io,
        { entryMenuDeps: { prompts: { select: vi.fn(async () => 'demo'), cancel: vi.fn() } } },
      ),
    ).resolves.toBe(0);

    expect(runDemoTour).toHaveBeenCalledWith(
      { inputMode: 'auto' },
      testIo.io,
      expect.objectContaining({}),
    );
  });

  it('creates a project through run mode when --new is selected', async () => {
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'new',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
      ),
    ).resolves.toBe(0);

    await expect(stat(join(tempDir, 'ktx.yaml'))).resolves.toBeDefined();
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).toContain('completed_steps:');
    expect(testIo.stdout()).toContain('KTX setup');
    expect(testIo.stdout()).toContain(`Project: ${tempDir}`);
    expect(testIo.stdout()).toContain('Project ready: yes');
    expect(testIo.stderr()).toBe('');
  });

  it('returns nonzero when project selection is missing in no-input mode even when optional sections are skipped', async () => {
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
      ),
    ).resolves.toBe(1);

    expect(testIo.stderr()).toContain('Missing setup choice');
    await expect(stat(join(tempDir, 'ktx.yaml'))).rejects.toThrow();
  });

  it('returns nonzero when project selection is missing in non-interactive setup', async () => {
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
      ),
    ).resolves.toBe(1);

    expect(testIo.stderr()).toContain('Missing setup choice');
    await expect(stat(join(tempDir, 'ktx.yaml'))).rejects.toThrow();
  });

  it('runs the Anthropic model step after project selection succeeds', async () => {
    const testIo = makeIo();
    const model = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'new',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: false,
          cliVersion: '0.2.0',
          anthropicApiKeyEnv: 'ANTHROPIC_API_KEY',
          anthropicModel: 'claude-sonnet-4-6',
          skipLlm: false,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
        { model },
      ),
    ).resolves.toBe(0);

    expect(model).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        inputMode: 'disabled',
        anthropicApiKeyEnv: 'ANTHROPIC_API_KEY',
        anthropicModel: 'claude-sonnet-4-6',
        skipLlm: false,
      }),
      testIo.io,
    );
  });

  it('runs the embedding setup step after the model step succeeds', async () => {
    const testIo = makeIo();
    const model = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir }));
    const embeddings = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'new',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          anthropicApiKeyEnv: 'ANTHROPIC_API_KEY',
          anthropicModel: 'claude-sonnet-4-6',
          skipLlm: false,
          embeddingBackend: 'openai',
          embeddingApiKeyEnv: 'OPENAI_API_KEY',
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
        { model, embeddings },
      ),
    ).resolves.toBe(0);

    expect(embeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        embeddingBackend: 'openai',
        embeddingApiKeyEnv: 'OPENAI_API_KEY',
        skipEmbeddings: false,
      }),
      testIo.io,
    );
  });

  it('passes no-input runtime policy to the embeddings step', async () => {
    const io = makeIo();
    const embeddings = vi.fn(async () => ({ status: 'failed' as const, projectDir: tempDir }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'new',
          agents: false,
          agentScope: 'project',
          agentInstallMode: 'cli',
          skipAgents: true,
          inputMode: 'disabled',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        io.io,
        { embeddings },
      ),
    ).resolves.toBe(1);

    expect(embeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'never',
      }),
      io.io,
    );
  });

  it('lets Back from embedding setup return to the model step instead of exiting', async () => {
    const testIo = makeIo();
    const modelResults = [
      { status: 'ready' as const, projectDir: tempDir },
      { status: 'back' as const, projectDir: tempDir },
    ];
    const model = vi.fn(async () => modelResults.shift() ?? { status: 'back' as const, projectDir: tempDir });
    const embeddings = vi.fn(async () => ({ status: 'back' as const, projectDir: tempDir }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'new',
          agents: false,
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
        { model, embeddings },
      ),
    ).resolves.toBe(0);

    expect(model).toHaveBeenCalledTimes(2);
    expect(model).toHaveBeenNthCalledWith(2, expect.objectContaining({ forcePrompt: true }), testIo.io);
    expect(embeddings).toHaveBeenCalledTimes(1);
  });

  it('lets Back from database selection return to embedding setup after an empty selection warning', async () => {
    const testIo = makeIo();
    const modelResults = [
      { status: 'ready' as const, projectDir: tempDir },
      { status: 'back' as const, projectDir: tempDir },
    ];
    const model = vi.fn(async () => modelResults.shift() ?? { status: 'back' as const, projectDir: tempDir });
    const embeddingResults = [
      { status: 'ready' as const, projectDir: tempDir },
      { status: 'back' as const, projectDir: tempDir },
    ];
    const embeddings = vi.fn(async () => embeddingResults.shift() ?? { status: 'back' as const, projectDir: tempDir });
    const databaseMultiselectValues = [[], ['back']];
    const databasePrompts = {
      multiselect: vi.fn(async () => databaseMultiselectValues.shift() ?? ['back']),
      select: vi.fn(async () => 'back'),
      text: vi.fn(),
      password: vi.fn(),
      cancel: vi.fn(),
    };

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'new',
          agents: false,
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: false,
          skipSources: true,
        },
        testIo.io,
        {
          model,
          embeddings,
          databasesDeps: { prompts: databasePrompts },
        },
      ),
    ).resolves.toBe(0);

    expect(databasePrompts.select).not.toHaveBeenCalled();
    expect(testIo.stdout()).toContain(
      'KTX cannot work without at least one primary source. Select a source or press Escape to go back.',
    );
    expect(embeddings).toHaveBeenCalledTimes(2);
    expect(embeddings).toHaveBeenNthCalledWith(2, expect.objectContaining({ forcePrompt: true }), testIo.io);
    expect(testIo.stderr()).not.toContain('No primary sources selected.');
  });

  it('lets Back from the first setup step return to the entry menu instead of exiting', async () => {
    await writeFile(join(tempDir, 'ktx.yaml'), 'project: test\nconnections: {}\n', 'utf-8');
    const testIo = makeIo();

    const entryChoices = ['setup', 'exit'];
    const entryPrompts = {
      select: vi.fn(async () => entryChoices.shift() ?? 'exit'),
      cancel: vi.fn(),
    };
    const model = vi.fn(async () => ({ status: 'back' as const, projectDir: tempDir }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
          showEntryMenu: true,
        },
        testIo.io,
        {
          entryMenuDeps: { prompts: entryPrompts },
          model,
        },
      ),
    ).resolves.toBe(0);

    expect(entryPrompts.select).toHaveBeenCalledTimes(2);
    expect(entryPrompts.cancel).toHaveBeenCalledWith('Setup cancelled.');
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('runs database setup after embeddings succeed', async () => {
    const testIo = makeIo();
    const model = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir }));
    const embeddings = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir }));
    const databases = vi.fn(async () => ({
      status: 'ready' as const,
      projectDir: tempDir,
      connectionIds: ['warehouse'],
    }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'new',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: false,
          cliVersion: '0.2.0',
          anthropicApiKeyEnv: 'ANTHROPIC_API_KEY',
          anthropicModel: 'claude-sonnet-4-6',
          skipLlm: false,
          embeddingBackend: 'openai',
          embeddingApiKeyEnv: 'OPENAI_API_KEY',
          skipEmbeddings: false,
          databaseDrivers: ['postgres'],
          databaseConnectionId: 'warehouse',
          databaseUrl: 'env:DATABASE_URL',
          databaseSchemas: ['public'],
          skipDatabases: false,
          skipSources: true,
        },
        testIo.io,
        { model, embeddings, databases },
      ),
    ).resolves.toBe(0);

    expect(databases).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        skipDatabases: false,
      }),
      testIo.io,
    );
  });

  it('runs sources after database setup', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await writeFile(join(tempDir, 'ktx.yaml'), ['project: revenue', 'connections: {}', ''].join('\n'), 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'existing',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          databaseSchemas: [],
        },
        io.io,
        {
          model: async () => {
            calls.push('model');
            return { status: 'skipped', projectDir: tempDir };
          },
          embeddings: async () => {
            calls.push('embeddings');
            return { status: 'skipped', projectDir: tempDir };
          },
          databases: async () => {
            calls.push('databases');
            return { status: 'skipped', projectDir: tempDir };
          },
          sources: async (args) => {
            expect(args.runInitialSourceIngest).toBe(false);
            calls.push('sources');
            return { status: 'skipped', projectDir: tempDir };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual(['model', 'embeddings', 'databases', 'sources']);
  });

  it('runs context after sources and before agents in full setup', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await writeFile(join(tempDir, 'ktx.yaml'), ['project: revenue', 'connections: {}', ''].join('\n'), 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'existing',
          agents: false,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          model: async () => {
            calls.push('model');
            return { status: 'skipped', projectDir: tempDir };
          },
          embeddings: async () => {
            calls.push('embeddings');
            return { status: 'skipped', projectDir: tempDir };
          },
          databases: async () => {
            calls.push('databases');
            return { status: 'skipped', projectDir: tempDir };
          },
          sources: async () => {
            calls.push('sources');
            return { status: 'skipped', projectDir: tempDir };
          },
          context: async () => {
            calls.push('context');
            return { status: 'ready', projectDir: tempDir, runId: 'setup-context-local-test' };
          },
          agents: async () => {
            calls.push('agents');
            return {
              status: 'ready',
              projectDir: tempDir,
              installs: [{ target: 'codex', scope: 'project', mode: 'cli' }],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual(['model', 'embeddings', 'databases', 'sources', 'context', 'agents']);
  });

  it('runs agent setup after context succeeds in --agents mode', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await writeFile(join(tempDir, 'ktx.yaml'), ['project: revenue', 'connections: {}', ''].join('\n'), 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'existing',
          agents: true,
          target: 'codex',
          agentScope: 'project',
          agentInstallMode: 'cli',
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          model: async () => ({ status: 'skipped', projectDir: tempDir }),
          embeddings: async () => ({ status: 'skipped', projectDir: tempDir }),
          databases: async () => ({ status: 'skipped', projectDir: tempDir }),
          sources: async () => ({ status: 'skipped', projectDir: tempDir }),
          context: async () => {
            calls.push('context');
            return { status: 'ready', projectDir: tempDir, runId: 'setup-context-local-test' };
          },
          agents: async () => {
            calls.push('agents');
            return {
              status: 'ready',
              projectDir: tempDir,
              installs: [{ target: 'codex', scope: 'project', mode: 'cli' }],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual(['context', 'agents']);
  });

  it('does not install agents when non-interactive --agents finds context incomplete', async () => {
    const io = makeIo();
    const agents = vi.fn(async () => ({
      status: 'ready' as const,
      projectDir: tempDir,
      installs: [{ target: 'codex' as const, scope: 'project' as const, mode: 'cli' as const }],
    }));
    await writeFile(join(tempDir, 'ktx.yaml'), ['project: revenue', 'connections: {}', ''].join('\n'), 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'existing',
          agents: true,
          target: 'codex',
          agentScope: 'project',
          agentInstallMode: 'cli',
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          context: async () => ({ status: 'skipped', projectDir: tempDir }),
          agents,
        },
      ),
    ).resolves.toBe(1);

    expect(agents).not.toHaveBeenCalled();
    expect(io.stderr()).toContain('KTX context is not ready for agents.');
  });

  it('does not install agents when full setup context build is detached', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await writeFile(join(tempDir, 'ktx.yaml'), ['project: revenue', 'connections: {}', ''].join('\n'), 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'existing',
          agents: false,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          context: async () => {
            calls.push('context');
            return { status: 'detached', projectDir: tempDir, runId: 'setup-context-local-test' };
          },
          agents: async () => {
            calls.push('agents');
            return {
              status: 'ready',
              projectDir: tempDir,
              installs: [{ target: 'codex', scope: 'project', mode: 'cli' }],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual(['context']);
  });

  it('resumes an active context build before prompting for earlier setup steps', async () => {
    const io = makeIo();
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: revenue',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-active',
      status: 'running',
      startedAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:00:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir, 'setup-context-local-active'),
    });
    const context = vi.fn(async () => ({
      status: 'detached' as const,
      projectDir: tempDir,
      runId: 'setup-context-local-active',
    }));
    const databases = vi.fn(async () => {
      throw new Error('database setup should not run while context build is active');
    });

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'existing',
          agents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          skipDatabases: false,
          skipSources: false,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        { context, databases },
      ),
    ).resolves.toBe(0);

    expect(context).toHaveBeenCalledWith(
      { projectDir: tempDir, inputMode: 'auto', allowEmpty: true },
      io.io,
    );
    expect(databases).not.toHaveBeenCalled();
  });

  it('skips entry menu and auto-watches when context build is active and showEntryMenu is true', async () => {
    const io = makeIo();
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: revenue',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-active',
      status: 'detached',
      startedAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:00:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir, 'setup-context-local-active'),
    });
    const context = vi.fn(async () => ({
      status: 'detached' as const,
      projectDir: tempDir,
      runId: 'setup-context-local-active',
    }));
    const entryMenuSelect = vi.fn(async () => 'exit');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'existing',
          agents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          skipDatabases: false,
          skipSources: false,
          skipAgents: false,
          databaseSchemas: [],
          showEntryMenu: true,
        },
        io.io,
        {
          context,
          entryMenuDeps: { prompts: { select: entryMenuSelect, cancel: vi.fn() } },
        },
      ),
    ).resolves.toBe(0);

    expect(entryMenuSelect).not.toHaveBeenCalled();
    expect(context).toHaveBeenCalledWith(
      { projectDir: tempDir, inputMode: 'auto', allowEmpty: true, autoWatch: true },
      io.io,
    );
  });

  it('routes a ready project menu selection to agent setup', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await mkdir(join(tempDir, '.ktx', 'agents'), { recursive: true });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: revenue',
        'setup:',
        '  completed_steps:',
        '    - project',
        '    - llm',
        '    - embeddings',
        '    - sources',
        '    - context',
        '    - agents',
        '  database_connection_ids: []',
        'connections: {}',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-6',
        'ingest:',
        '  embeddings:',
        '    backend: openai',
        '    model: text-embedding-3-small',
        '    dimensions: 1536',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(tempDir, '.ktx/agents/install-manifest.json'),
      JSON.stringify(
        {
          version: 1,
          projectDir: tempDir,
          installedAt: '2026-05-07T00:00:00.000Z',
          installs: [{ target: 'codex', scope: 'project', mode: 'cli' }],
          entries: [],
        },
        null,
        2,
      ),
      'utf-8',
    );
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-ready',
      status: 'completed',
      startedAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:02:00.000Z',
      completedAt: '2026-05-09T10:02:00.000Z',
      primarySourceConnectionIds: [],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir, 'setup-context-local-ready'),
    });

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'existing',
          agents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          skipDatabases: false,
          skipSources: false,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          readyMenuDeps: { prompts: { select: vi.fn(async () => 'agents'), cancel: vi.fn() } },
          model: async (args) => {
            expect(args.skipLlm).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          embeddings: async (args) => {
            expect(args.skipEmbeddings).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          databases: async (args) => {
            expect(args.skipDatabases).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          sources: async (args) => {
            expect(args.skipSources).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          agents: async () => {
            calls.push('agents');
            return {
              status: 'ready',
              projectDir: tempDir,
              installs: [{ target: 'codex', scope: 'project', mode: 'cli' }],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual(['agents']);
  });

  it('skips to agent setup when context is ready but agents are not configured', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: revenue',
        'setup:',
        '  completed_steps:',
        '    - project',
        '    - llm',
        '    - embeddings',
        '    - sources',
        '    - context',
        '  database_connection_ids: []',
        'connections: {}',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-6',
        'ingest:',
        '  embeddings:',
        '    backend: openai',
        '    model: text-embedding-3-small',
        '    dimensions: 1536',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-ready',
      status: 'completed',
      startedAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:02:00.000Z',
      completedAt: '2026-05-09T10:02:00.000Z',
      primarySourceConnectionIds: [],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir, 'setup-context-local-ready'),
    });

    const readyMenuSelect = vi.fn();
    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'existing',
          agents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          skipDatabases: false,
          skipSources: false,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          readyMenuDeps: { prompts: { select: readyMenuSelect, cancel: vi.fn() } },
          model: async (args) => {
            expect(args.skipLlm).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          embeddings: async (args) => {
            expect(args.skipEmbeddings).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          databases: async (args) => {
            expect(args.skipDatabases).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          sources: async (args) => {
            expect(args.skipSources).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          agents: async () => {
            calls.push('agents');
            return {
              status: 'ready',
              projectDir: tempDir,
              installs: [{ target: 'codex', scope: 'project', mode: 'cli' }],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(readyMenuSelect).not.toHaveBeenCalled();
    expect(calls).toEqual(['agents']);
  });

  it('runs only project resolution, context gate, and agent setup in --agents mode', async () => {
    const io = makeIo();
    const context = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir, runId: 'setup-context-local-test' }));
    const agents = vi.fn(async () => ({
      status: 'ready' as const,
      projectDir: tempDir,
      installs: [{ target: 'universal' as const, scope: 'project' as const, mode: 'both' as const }],
    }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'new',
          agents: true,
          target: 'universal',
          agentScope: 'project',
          agentInstallMode: 'both',
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          skipDatabases: false,
          skipSources: false,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          model: async () => {
            throw new Error('model should not run');
          },
          context,
          agents,
        },
      ),
    ).resolves.toBe(0);

    expect(context).toHaveBeenCalledTimes(1);
    expect(agents).toHaveBeenCalledTimes(1);
  });

  it('removes agent integrations through setup remove command', async () => {
    const io = makeIo();
    const removeAgents = vi.fn(async () => 0);

    await expect(runKtxSetup({ command: 'remove-agents', projectDir: tempDir }, io.io, { removeAgents })).resolves.toBe(
      0,
    );

    expect(removeAgents).toHaveBeenCalledWith(tempDir, io.io);
  });

  it('does not run embedding setup when the model step fails', async () => {
    const testIo = makeIo();
    const model = vi.fn(async () => ({ status: 'failed' as const, projectDir: tempDir }));
    const embeddings = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'new',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: false,
          cliVersion: '0.2.0',
          anthropicApiKeyEnv: 'ANTHROPIC_API_KEY',
          anthropicModel: 'claude-sonnet-4-6',
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: true,
        },
        testIo.io,
        { model, embeddings },
      ),
    ).resolves.toBe(1);

    expect(embeddings).not.toHaveBeenCalled();
  });
});
