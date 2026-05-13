import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { writeKtxSetupState } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { localFakeBundleReport, persistLocalBundleReport } from './ingest.test-utils.js';
import { contextBuildCommands, readKtxSetupContextState, writeKtxSetupContextState } from './setup-context.js';
import { runDemoTour } from './setup-demo-tour.js';
import { formatKtxSetupStatus, readKtxSetupStatus, runKtxSetup } from './setup.js';

vi.mock('./setup-demo-tour.js', () => ({
  runDemoTour: vi.fn(async () => 0),
}));

const execFileAsync = promisify(execFile);

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
        '      api_key: env:ANTHROPIC_API_KEY', // pragma: allowlist secret
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

  it.each([
    {
      backend: 'vertex',
      providerLines: ['    backend: vertex', '    vertex:', '      project: kaelio-dev', '      location: us-east5'],
      model: 'claude-sonnet-4-6',
    },
    {
      backend: 'gateway',
      providerLines: ['    backend: gateway', '    gateway:', '      api_key: env:AI_GATEWAY_API_KEY'],
      model: 'anthropic/claude-sonnet-4-6',
    },
  ])('reports configured $backend llm backends as setup-ready', async (fixture) => {
    await mkdir(tempDir, { recursive: true });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: revenue',
        'llm:',
        '  provider:',
        ...fixture.providerLines,
        '  models:',
        `    default: ${fixture.model}`,
        'connections: {}',
      ].join('\n'),
      'utf-8',
    );

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      llm: { backend: fixture.backend, ready: true, model: fixture.model },
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
        '      api_key: env:OPENAI_API_KEY', // pragma: allowlist secret
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project', 'databases'] });

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
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    readonly: true',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project'] });

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
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    readonly: true',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project', 'databases'] });

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
    await writeKtxSetupState(tempDir, { completed_steps: ['project', 'sources'] });

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
    await writeKtxSetupState(tempDir, {
      completed_steps: ['project', 'llm', 'embeddings', 'databases', 'sources'],
    });
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
        status: 'stale',
        runId: 'setup-context-local-abc123',
        statusCommand: `ktx status --project-dir ${tempDir}`,
        detail: 'Previous foreground context build did not finish. Rerun setup or ktx ingest.',
      },
    });
  });

  it('reports Vertex LLM and context ready after a successful Metabase ingest report', async () => {
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
        '  metabase:',
        '    driver: metabase',
        '    url: env:METABASE_URL',
        '    api_key_ref: env:METABASE_API_KEY',
        '    warehouse_connection_id: warehouse',
        'llm:',
        '  provider:',
        '    backend: vertex',
        '    vertex:',
        '      project: kaelio-dev',
        '      location: us-east5',
        '  models:',
        '    default: claude-sonnet-4-6',
        'ingest:',
        '  embeddings:',
        '    backend: deterministic',
        '    model: deterministic',
        '    dimensions: 8',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project', 'databases', 'sources'] });
    await persistLocalBundleReport(
      tempDir,
      localFakeBundleReport('metabase-job-1', {
        connectionId: 'warehouse',
        sourceKey: 'metabase',
      }),
    );

    const status = await readKtxSetupStatus(tempDir);
    const rendered = formatKtxSetupStatus(status);

    expect(status.llm).toMatchObject({ backend: 'vertex', ready: true, model: 'claude-sonnet-4-6' });
    expect(status.context).toMatchObject({ ready: true, status: 'completed' });
    expect(rendered).toContain('LLM ready: yes (claude-sonnet-4-6)');
    expect(rendered).toContain('KTX context built: yes');
  });

  it('formats plain and JSON setup status payloads', async () => {
    const status = await readKtxSetupStatus(tempDir);
    const rendered = formatKtxSetupStatus(status);

    expect(rendered).toContain(`No KTX project found at ${tempDir}.`);
    expect(rendered).toContain('Check another project: ktx --project-dir <folder> status');
    expect(rendered).toContain('Or from that folder: ktx status');
    expect(rendered).toContain('Create a new KTX project here: ktx setup');
    expect(rendered).not.toContain('Project ready: no');
    expect(JSON.parse(JSON.stringify(status))).toMatchObject({ project: { path: tempDir, ready: false } });
  });

  it('prints the readiness checklist for an existing project', async () => {
    await writeFile(join(tempDir, 'ktx.yaml'), 'project: revenue\nconnections: {}\n', 'utf-8');

    const rendered = formatKtxSetupStatus(await readKtxSetupStatus(tempDir));

    expect(rendered).toContain(`KTX project: ${tempDir}`);
    expect(rendered).toContain('Project ready: yes');
    expect(rendered).toContain('LLM ready: no');
    expect(rendered).toContain('KTX context built: no');
    expect(rendered).not.toContain('No KTX project found.');
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
        message: 'Where should KTX create the project?',
        options: expect.arrayContaining([expect.objectContaining({ value: 'back', label: 'Back' })]),
      }),
    );
    expect(projectPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Where should KTX create the project?',
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
        message: 'Project folder path\n│  Press Escape to go back.\n│',
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
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    await expect(readFile(join(tempDir, '.ktx', 'setup', 'state.json'), 'utf-8')).resolves.toBe(
      `${JSON.stringify({ completed_steps: ['project', 'sources'] }, null, 2)}\n`,
    );
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
          anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
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
        anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
        anthropicModel: 'claude-sonnet-4-6',
        skipLlm: false,
      }),
      testIo.io,
    );
  });

  it('passes Vertex AI model setup args after project selection succeeds', async () => {
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
          llmBackend: 'vertex',
          vertexProject: 'local-gcp-project',
          vertexLocation: 'us-east5',
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
        llmBackend: 'vertex',
        vertexProject: 'local-gcp-project',
        vertexLocation: 'us-east5',
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
          anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
          anthropicModel: 'claude-sonnet-4-6',
          skipLlm: false,
          embeddingBackend: 'openai',
          embeddingApiKeyEnv: 'OPENAI_API_KEY', // pragma: allowlist secret
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
        embeddingApiKeyEnv: 'OPENAI_API_KEY', // pragma: allowlist secret
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
          anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
          anthropicModel: 'claude-sonnet-4-6',
          skipLlm: false,
          embeddingBackend: 'openai',
          embeddingApiKeyEnv: 'OPENAI_API_KEY', // pragma: allowlist secret
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

  it.each([
    {
      backend: 'vertex',
      providerLines: ['    backend: vertex', '    vertex:', '      project: kaelio-dev', '      location: us-east5'],
      model: 'claude-sonnet-4-6',
    },
    {
      backend: 'gateway',
      providerLines: ['    backend: gateway', '    gateway:', '      api_key: env:AI_GATEWAY_API_KEY'],
      model: 'anthropic/claude-sonnet-4-6',
    },
  ])('adds a dbt source in non-interactive setup with existing $backend llm config', async (fixture) => {
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
        '    url: env:WAREHOUSE_URL',
        'llm:',
        '  provider:',
        ...fixture.providerLines,
        '  models:',
        `    default: ${fixture.model}`,
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project', 'databases'] });

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
          skipLlm: false,
          skipEmbeddings: true,
          skipDatabases: true,
          source: 'dbt',
          sourceConnectionId: 'dbt-main',
          sourceGitUrl: 'https://github.com/Kaelio/klo-dbt-demo',
          sourceBranch: 'main',
          sourceProjectName: 'orbit_analytics',
          sourceWarehouseConnectionId: 'warehouse',
          skipSources: false,
          databaseSchemas: [],
        },
        io.io,
        {
          sourcesDeps: { validateDbt: vi.fn(async () => ({ ok: true as const, detail: 'dbt project valid' })) },
          context: vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir, runId: 'setup-context-test' })),
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).not.toContain('Anthropic');
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).toContain('dbt-main:');
  });

  it('does not fail context build when prerequisites were explicitly skipped and agents are skipped', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: revenue',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DEMO_DATABASE_URL',
        '    readonly: true',
        '',
      ].join('\n'),
      'utf-8',
    );

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
          sources: async () => {
            calls.push('sources');
            return { status: 'skipped', projectDir: tempDir };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual(['model', 'embeddings', 'databases', 'sources']);
    expect(io.stderr()).not.toContain('KTX cannot build agent-ready context yet.');
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

  it('commits setup config changes written by later setup steps', async () => {
    const io = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'new',
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
          model: async () => ({ status: 'skipped', projectDir: tempDir }),
          embeddings: async () => ({ status: 'skipped', projectDir: tempDir }),
          databases: async () => {
            const configPath = join(tempDir, 'ktx.yaml');
            const current = await readFile(configPath, 'utf-8');
            await writeFile(
              configPath,
              current.replace(
                'connections: {}',
                ['connections:', '  warehouse:', '    driver: postgres', '    url: env:DATABASE_URL'].join('\n'),
              ),
              'utf-8',
            );
            return { status: 'skipped', projectDir: tempDir };
          },
          sources: async () => ({ status: 'skipped', projectDir: tempDir }),
          context: async () => ({ status: 'ready', projectDir: tempDir, runId: 'setup-context-local-test' }),
          agents: async () => ({
            status: 'ready',
            projectDir: tempDir,
            installs: [{ target: 'codex', scope: 'project', mode: 'cli' }],
          }),
        },
      ),
    ).resolves.toBe(0);

    const { stdout } = await execFileAsync('git', ['-C', tempDir, 'status', '--short', '--', 'ktx.yaml']);
    expect(stdout).toBe('');
    const committedConfig = await execFileAsync('git', ['-C', tempDir, 'show', 'HEAD:ktx.yaml']);
    expect(committedConfig.stdout).toContain('warehouse:');
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

  it('does not offer background watch choices from setup status', async () => {
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
      runId: 'setup-context-local-stale',
      status: 'running',
      startedAt: '2026-05-09T09:00:00.000Z',
      updatedAt: '2026-05-09T09:00:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir, 'setup-context-local-stale'),
    });

    const status = await readKtxSetupStatus(tempDir);
    expect(status.context.status).toBe('stale');
    expect(status.context.watchCommand).toBeUndefined();
    const state = await readKtxSetupContextState(tempDir);
    expect(state.status).toBe('stale');
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
    await writeKtxSetupState(tempDir, {
      completed_steps: ['project', 'llm', 'embeddings', 'sources', 'context', 'agents'],
    });
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
    await writeKtxSetupState(tempDir, {
      completed_steps: ['project', 'llm', 'embeddings', 'sources', 'context'],
    });
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
      installs: [{ target: 'universal' as const, scope: 'project' as const, mode: 'cli' as const }],
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
          anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
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
