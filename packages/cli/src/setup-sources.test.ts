import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initKtxProject,
  type KtxProjectConnectionConfig,
  parseKtxProjectConfig,
  readKtxSetupState,
  serializeKtxProjectConfig,
} from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KtxCliIo } from './cli-runtime.js';
import {
  runKtxSetupSourcesStep,
  type KtxSetupSourcesDeps,
  type KtxSetupSourcesPromptAdapter,
  type KtxSetupSourceType,
} from './setup-sources.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: true,
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

function prompts(values: {
  multiselect?: string[][];
  select?: string[];
  text?: Array<string | undefined>;
  password?: Array<string | undefined>;
}): KtxSetupSourcesPromptAdapter {
  const multiselectValues = [...(values.multiselect ?? [])];
  const selectValues = [...(values.select ?? [])];
  const textValues = [...(values.text ?? [])];
  const passwordValues = [...(values.password ?? [])];
  return {
    multiselect: vi.fn(async () => multiselectValues.shift() ?? []),
    select: vi.fn(async () => selectValues.shift() ?? 'skip'),
    text: vi.fn(async () => (textValues.length > 0 ? textValues.shift() : '')),
    password: vi.fn(async () => (passwordValues.length > 0 ? passwordValues.shift() : undefined)),
    cancel: vi.fn(),
    log: vi.fn(),
  };
}

function connectionNamePrompt(label: string): string {
  return `Name this ${label} connection\nKTX will use this short name in commands and config. You can rename it now.`;
}

function textInputPrompt(message: string): string {
  const normalized = message.replace(/\n+$/, '');
  if (!normalized.includes('\n')) {
    return `${normalized}\n│  Press Escape to go back.\n│`;
  }
  const [title, ...bodyLines] = normalized.split('\n');
  return `${title}\n│\n│  ${bodyLines.join('\n│  ')}\n│  Press Escape to go back.\n│`;
}

describe('setup sources step', () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-sources-'));
    projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'sources' });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function readConfig() {
    return parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
  }

  async function addPrimarySource() {
    const config = await readConfig();
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      serializeKtxProjectConfig({
        ...config,
        connections: {
          ...config.connections,
          warehouse: { driver: 'postgres', url: 'env:DATABASE_URL' },
        },
        setup: {
          ...config.setup,
          database_connection_ids: ['warehouse'],
        },
      }),
      'utf-8',
    );
  }

  async function addConnection(connectionId: string, connection: KtxProjectConnectionConfig) {
    const config = await readConfig();
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      serializeKtxProjectConfig({
        ...config,
        connections: {
          ...config.connections,
          [connectionId]: connection,
        },
      }),
      'utf-8',
    );
  }

  it('marks optional sources complete when skipped', async () => {
    const io = makeIo();
    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'disabled', runInitialSourceIngest: false, skipSources: true },
        io.io,
      ),
    ).resolves.toEqual({
      status: 'skipped',
      projectDir,
    });

    expect((await readKtxSetupState(projectDir)).completed_steps).toContain('sources');
    expect(io.stdout()).toContain('Context source setup skipped.');
  });

  it('writes a dbt local source connection after validation succeeds', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const runInitialIngest = vi.fn(async () => 0);
    const io = makeIo();

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'dbt',
          sourceConnectionId: 'analytics_dbt',
          sourcePath: '/repo/dbt',
          sourceProjectName: 'analytics',
          runInitialSourceIngest: true,
          skipSources: false,
        },
        io.io,
        { validateDbt, runInitialIngest },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['analytics_dbt'] });

    const config = await readConfig();
    expect(config.connections.analytics_dbt).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/dbt',
      project_name: 'analytics',
    });
    expect((await readKtxSetupState(projectDir)).completed_steps).toContain('sources');
    expect(runInitialIngest).toHaveBeenCalledWith(projectDir, 'analytics_dbt', io.io, { inputMode: 'disabled' });
  });

  it('writes Metabase config and validates mapping through existing mapping path', async () => {
    await addPrimarySource();
    const validateMetabase = vi.fn(async () => ({ ok: true as const, detail: 'user=admin@example.com' }));
    const runMapping = vi.fn(async (_projectDir: string, _connectionId: string, commandIo: KtxCliIo) => {
      commandIo.stdout.write('Mapping validated — 1 mapping configured\n');
      return 0;
    });
    const io = makeIo();

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'metabase',
          sourceConnectionId: 'prod_metabase',
          sourceUrl: 'https://metabase.example.com',
          sourceApiKeyRef: 'env:METABASE_API_KEY', // pragma: allowlist secret
          sourceWarehouseConnectionId: 'warehouse',
          metabaseDatabaseId: 1,
          runInitialSourceIngest: false,
          skipSources: false,
        },
        io.io,
        { validateMetabase, runMapping },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['prod_metabase'] });

    expect((await readConfig()).connections.prod_metabase).toMatchObject({
      driver: 'metabase',
      api_url: 'https://metabase.example.com',
      api_key_ref: 'env:METABASE_API_KEY', // pragma: allowlist secret
      mappings: {
        databaseMappings: { '1': 'warehouse' },
        syncEnabled: { '1': true },
        syncMode: 'ALL',
      },
    });
    expect(runMapping).toHaveBeenCalledWith(
      projectDir,
      'prod_metabase',
      expect.objectContaining({
        stdout: expect.objectContaining({ write: expect.any(Function) }),
        stderr: expect.objectContaining({ write: expect.any(Function) }),
      }),
    );
    expect(io.stdout()).toContain('│  Mapping validated — 1 mapping configured');
    expect(io.stdout()).not.toMatch(/^Mapping validated — 1 mapping configured$/m);
  });

  it('writes Notion config with the full default knowledge create budget', async () => {
    await addPrimarySource();
    const validateNotion = vi.fn(async () => ({ ok: true as const, detail: 'roots=1' }));

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'notion',
          sourceConnectionId: 'notion-main',
          sourceApiKeyRef: 'env:NOTION_TOKEN', // pragma: allowlist secret
          notionCrawlMode: 'selected_roots',
          notionRootPageIds: ['page-1'],
          runInitialSourceIngest: false,
          skipSources: false,
        },
        makeIo().io,
        { validateNotion },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['notion-main'] });

    expect((await readConfig()).connections['notion-main']).toMatchObject({
      driver: 'notion',
      auth_token_ref: 'env:NOTION_TOKEN',
      root_page_ids: ['page-1'],
      max_knowledge_creates_per_run: 25,
      max_knowledge_updates_per_run: 20,
    });
  });

  it('uses selected Notion roots when root page ids are provided even if crawl mode says all accessible', async () => {
    await addPrimarySource();
    const validateNotion = vi.fn(async () => ({ ok: true as const, detail: 'roots=1' }));

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'notion',
          sourceConnectionId: 'notion-main',
          sourceApiKeyRef: 'env:NOTION_TOKEN', // pragma: allowlist secret
          notionCrawlMode: 'all_accessible',
          notionRootPageIds: ['page-1'],
          runInitialSourceIngest: false,
          skipSources: false,
        },
        makeIo().io,
        { validateNotion },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['notion-main'] });

    expect((await readConfig()).connections['notion-main']).toMatchObject({
      driver: 'notion',
      root_page_ids: ['page-1'],
      crawl_mode: 'selected_roots',
    });
  });

  it('uses the rich Notion picker for interactive selected root setup', async () => {
    await addPrimarySource();
    const validateNotion = vi.fn(async () => ({ ok: true as const, detail: 'roots=1' }));
    const pickNotionRootPages = vi.fn(async (input: Parameters<NonNullable<KtxSetupSourcesDeps['pickNotionRootPages']>>[0]) => {
      expect(input.connectionId).toBe('notion-main');
      expect(input.connection).toMatchObject({
        driver: 'notion',
        auth_token_ref: 'env:NOTION_TOKEN',
        crawl_mode: 'selected_roots',
        root_page_ids: [],
      });
      return { kind: 'selected' as const, rootPageIds: ['11111111-2222-3333-4444-555555555555'] };
    });
    const testPrompts = prompts({
      multiselect: [['notion']],
      select: ['env', 'selected_roots', 'done'],
      text: ['notion-main'],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        { prompts: testPrompts, validateNotion, pickNotionRootPages },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['notion-main'] });

    expect(pickNotionRootPages).toHaveBeenCalledOnce();
    expect(testPrompts.select).toHaveBeenCalledWith({
      message: 'Which Notion pages should KTX ingest?',
      options: [
        { value: 'selected_roots', label: 'Specific pages and their subpages (choose them in a picker)' },
        { value: 'all_accessible', label: 'All pages the integration can access' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect((await readConfig()).connections['notion-main']).toMatchObject({
      driver: 'notion',
      auth_token_ref: 'env:NOTION_TOKEN',
      crawl_mode: 'selected_roots',
      root_page_ids: ['11111111-2222-3333-4444-555555555555'],
    });
  });

  it('backs out of the Notion picker without writing selected_roots when the picker quits', async () => {
    await addPrimarySource();
    const validateNotion = vi.fn(async () => ({ ok: true as const, detail: 'roots=0' }));
    const pickNotionRootPages = vi.fn(async () => ({ kind: 'back' as const }));
    const testPrompts = prompts({
      multiselect: [['notion']],
      select: ['env', 'selected_roots', 'all_accessible', 'done'],
      text: ['notion-main'],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        { prompts: testPrompts, validateNotion, pickNotionRootPages },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['notion-main'] });

    expect(pickNotionRootPages).toHaveBeenCalledOnce();
    expect((await readConfig()).connections['notion-main']).toMatchObject({
      driver: 'notion',
      crawl_mode: 'all_accessible',
    });
    expect((await readConfig()).connections['notion-main']?.root_page_ids).toBeUndefined();
  });

  it('surfaces Notion picker failures and returns to the page-mode step', async () => {
    await addPrimarySource();
    const validateNotion = vi.fn(async () => ({ ok: true as const, detail: 'roots=0' }));
    const pickNotionRootPages = vi.fn(async () => ({
      kind: 'unavailable' as const,
      message: 'Notion picker requires a TTY',
    }));
    const testPrompts = prompts({
      multiselect: [['notion']],
      select: ['env', 'selected_roots', 'all_accessible', 'done'],
      text: ['notion-main'],
    });
    const io = makeIo();

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        { prompts: testPrompts, validateNotion, pickNotionRootPages },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['notion-main'] });

    expect(io.stderr()).toContain('Notion picker requires a TTY');
    expect((await readConfig()).connections['notion-main']).toMatchObject({
      driver: 'notion',
      crawl_mode: 'all_accessible',
    });
  });

  it('defaults interactive Metabase and Looker source setup to the only warehouse connection', async () => {
    await addPrimarySource();
    const cases: Array<{
      source: 'metabase' | 'looker';
      text: string[];
      deps: KtxSetupSourcesDeps;
      expectedConnection: Record<string, unknown>;
    }> = [
      {
        source: 'metabase',
        text: ['metabase-main', 'https://metabase.example.com'],
        deps: {
          discoverMetabaseDatabases: vi.fn(async () => [
            { id: 1, name: 'Analytics', engine: 'postgres', host: 'db.example.com', dbName: 'analytics' },
          ]),
          validateMetabase: vi.fn(async () => ({ ok: true as const, detail: 'mapping validated' })),
          runMapping: vi.fn(async () => 0),
        },
        expectedConnection: {
          driver: 'metabase',
          mappings: { databaseMappings: { '1': 'warehouse' } },
        },
      },
      {
        source: 'looker',
        text: ['looker-main', 'https://looker.example.com', 'client-id', ''],
        deps: {
          validateLooker: vi.fn(async () => ({ ok: true as const, detail: 'mapping refreshed' })),
          runMapping: vi.fn(async () => 0),
        },
        expectedConnection: {
          driver: 'looker',
          mappings: { connectionMappings: { warehouse: 'warehouse' } },
        },
      },
    ];

    for (const testCase of cases) {
      const testPrompts = prompts({
        multiselect: [[testCase.source]],
        select: ['env', 'done'],
        text: testCase.text,
      });

      await expect(
        runKtxSetupSourcesStep(
          { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
          makeIo().io,
          {
            prompts: testPrompts,
            ...testCase.deps,
          },
        ),
      ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: [`${testCase.source}-main`] });

      expect(
        vi.mocked(testPrompts.text).mock.calls.some(([options]) => options.message.includes('Mapped warehouse')),
      ).toBe(false);
      if (testCase.source === 'metabase') {
        expect(
          vi.mocked(testPrompts.text).mock.calls.some(([options]) => options.message.includes('Metabase database id')),
        ).toBe(false);
      }
      expect((await readConfig()).connections[`${testCase.source}-main`]).toMatchObject(testCase.expectedConnection);
    }
  });

  it('prompts for the mapped warehouse when interactive Metabase and Looker source setup has multiple choices', async () => {
    await addPrimarySource();
    await addConnection('analytics_warehouse', {
      driver: 'snowflake',
      account: 'acme',
      database: 'analytics',
    });

    const cases: Array<{
      source: 'metabase' | 'looker';
      text: string[];
      deps: KtxSetupSourcesDeps;
      expectedConnection: Record<string, unknown>;
    }> = [
      {
        source: 'metabase',
        text: ['metabase-main', 'https://metabase.example.com'],
        deps: {
          discoverMetabaseDatabases: vi.fn(async () => [
            { id: 1, name: 'Finance', engine: 'postgres', host: 'db.example.com', dbName: 'finance' },
            { id: 2, name: 'Analytics', engine: 'postgres', host: 'db.example.com', dbName: 'analytics' },
          ]),
          validateMetabase: vi.fn(async () => ({ ok: true as const, detail: 'mapping validated' })),
          runMapping: vi.fn(async () => 0),
        },
        expectedConnection: {
          driver: 'metabase',
          mappings: { databaseMappings: { '2': 'analytics_warehouse' } },
        },
      },
      {
        source: 'looker',
        text: ['looker-main', 'https://looker.example.com', 'client-id', 'analytics'],
        deps: {
          validateLooker: vi.fn(async () => ({ ok: true as const, detail: 'mapping refreshed' })),
          runMapping: vi.fn(async () => 0),
        },
        expectedConnection: {
          driver: 'looker',
          mappings: { connectionMappings: { analytics: 'analytics_warehouse' } },
        },
      },
    ];

    for (const testCase of cases) {
      const testPrompts = prompts({
        multiselect: [[testCase.source]],
        select: testCase.source === 'metabase' ? ['env', 'analytics_warehouse', '2', 'done'] : ['env', 'analytics_warehouse', 'done'],
        text: testCase.text,
      });

      await expect(
        runKtxSetupSourcesStep(
          { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
          makeIo().io,
          {
            prompts: testPrompts,
            ...testCase.deps,
          },
        ),
      ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: [`${testCase.source}-main`] });

      expect(testPrompts.select).toHaveBeenCalledWith({
        message: 'Mapped warehouse connection',
        options: [
          { value: 'analytics_warehouse', label: 'analytics_warehouse (SNOWFLAKE)' },
          { value: 'warehouse', label: 'warehouse (POSTGRESQL)' },
          { value: 'back', label: 'Back' },
        ],
      });
      if (testCase.source === 'metabase') {
        expect(testPrompts.select).toHaveBeenCalledWith({
          message: 'Metabase database',
          options: [
            { value: '1', label: '1: Finance (postgres)' },
            { value: '2', label: '2: Analytics (postgres)' },
            { value: 'back', label: 'Back' },
          ],
        });
        expect(
          vi.mocked(testPrompts.text).mock.calls.some(([options]) => options.message.includes('Metabase database id')),
        ).toBe(false);
      }
      expect((await readConfig()).connections[`${testCase.source}-main`]).toMatchObject(testCase.expectedConnection);
    }
  });

  it('lets visible Metabase mapping surface refresh and validation failures', async () => {
    await addPrimarySource();
    const runMapping = vi.fn(async (_projectDir: string, _connectionId: string, io: KtxCliIo) => {
      io.stderr.write('1: Metabase database does not match KTX connection database\n');
      return 1;
    });
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['metabase']],
      select: ['env'],
      text: ['metabase-main', 'https://metabase.example.com'],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
          discoverMetabaseDatabases: vi.fn(async () => [
            { id: 1, name: 'Analytics', engine: 'postgres', host: 'db.example.com', dbName: 'analytics' },
          ]),
          runMapping,
        },
      ),
    ).resolves.toEqual({ status: 'failed', projectDir });

    expect(runMapping).toHaveBeenCalledWith(
      projectDir,
      'metabase-main',
      expect.objectContaining({
        stdout: expect.objectContaining({ write: expect.any(Function) }),
        stderr: expect.objectContaining({ write: expect.any(Function) }),
      }),
    );
    expect(io.stderr()).toContain('1: Metabase database does not match KTX connection database');
    expect(io.stderr()).not.toContain('Metabase mapping validation failed');
  });

  it('does not mark sources complete when validation fails', async () => {
    await addPrimarySource();
    const io = makeIo();
    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'lookml',
          sourceConnectionId: 'looker_repo',
          sourceGitUrl: 'https://github.com/acme/lookml.git',
          runInitialSourceIngest: false,
          skipSources: false,
        },
        io.io,
        { validateLookml: vi.fn(async () => ({ ok: false as const, message: 'No LookML files found' })) },
      ),
    ).resolves.toEqual({ status: 'failed', projectDir });

    expect((await readKtxSetupState(projectDir)).completed_steps).not.toContain('sources');
    expect(io.stderr()).toContain('No LookML files found');
  });

  it('can go back from the interactive source checklist', async () => {
    await addPrimarySource();
    const io = makeIo();
    const testPrompts = prompts({ multiselect: [['back']] });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
        },
      ),
    ).resolves.toEqual({ status: 'back', projectDir });

    expect(testPrompts.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Which context sources should KTX ingest?\nUse Up/Down to move, Space to select or unselect, Enter to confirm, Escape to go back, or Ctrl+C to exit.',
      }),
    );
    const options = vi.mocked(testPrompts.multiselect).mock.calls[0]?.[0].options ?? [];
    expect(options).toContainEqual({ value: 'notion', label: 'Notion' });
  });

  it('shows already configured context sources in the interactive checklist', async () => {
    await addPrimarySource();
    await addConnection('notion-main', {
      driver: 'notion',
      auth_token_ref: 'env:NOTION_TOKEN',
      crawl_mode: 'all_accessible',
    });
    const io = makeIo();
    const testPrompts = prompts({ multiselect: [['back']] });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        { prompts: testPrompts },
      ),
    ).resolves.toEqual({ status: 'back', projectDir });

    expect(testPrompts.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValues: ['notion'],
        options: expect.arrayContaining([{ value: 'notion', label: 'Notion', hint: 'configured: notion-main' }]),
      }),
    );
  });

  it('uses a source-specific editable connection name for new interactive connections', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path'],
      text: ['dbt-main', '/repo/dbt', '', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
          validateDbt,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testPrompts.text).toHaveBeenNthCalledWith(1, {
      message: textInputPrompt(connectionNamePrompt('dbt')),
      placeholder: 'dbt-main',
      initialValue: 'dbt-main',
    });
    expect((await readConfig()).connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/dbt',
    });
  });

  it('skips token prompt for public repos when git connection test succeeds', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testGitRepo = vi.fn(async () => ({ ok: true as const }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['git'],
      text: ['dbt-main', 'https://github.com/acme-org/ktx-dbt-demo', 'main', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
          validateDbt,
          testGitRepo,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testGitRepo).toHaveBeenCalledWith({ repoUrl: 'https://github.com/acme-org/ktx-dbt-demo' });
    expect(testPrompts.log).toHaveBeenCalledWith('Repository connected.');
    expect(testPrompts.text).toHaveBeenNthCalledWith(4, {
      message: textInputPrompt(
        [
          'Folder containing dbt_project.yml (optional)',
          'Press Enter when dbt_project.yml is at the repo root.',
          'For monorepos, enter a relative path like analytics/dbt.',
        ].join('\n'),
      ),
      placeholder: 'optional',
    });
    expect(testPrompts.text).toHaveBeenCalledTimes(4);
  });

  it('prompts for token when git connection test fails', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testGitRepo = vi.fn(async () => ({ ok: false as const, error: 'authentication required' }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['git', 'env'],
      text: ['dbt-main', 'https://github.com/acme-org/private-repo', 'main', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
          validateDbt,
          testGitRepo,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testGitRepo).toHaveBeenCalledWith({ repoUrl: 'https://github.com/acme-org/private-repo' });
    expect(testPrompts.select).toHaveBeenCalledWith({
      message: 'This repo requires authentication.',
      options: [
        { value: 'env', label: 'Use GITHUB_TOKEN from the environment' },
        { value: 'paste', label: 'Paste a token and save it as a local secret file' },
        { value: 'skip', label: 'Skip — try without authentication' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(testPrompts.text).toHaveBeenCalledTimes(4);
  });

  it('enables the dbt adapter when adding a dbt source connection', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'dbt',
          sourceConnectionId: 'dbt-main',
          sourcePath: '/repo/dbt',
          runInitialSourceIngest: false,
          skipSources: false,
        },
        makeIo().io,
        { validateDbt },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect((await readConfig()).ingest.adapters).toContain('dbt');
  });

  it('lets interactive setup retry or continue after initial source ingest fails', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const runInitialIngest = vi.fn(async () => 1);
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path', 'continue', 'done'],
      text: ['dbt-main', '/repo/dbt', '', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: true, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
          validateDbt,
          runInitialIngest,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(runInitialIngest).toHaveBeenCalledTimes(1);
    expect((await readConfig()).connections['dbt-main']).toMatchObject({ driver: 'dbt', source_dir: '/repo/dbt' });
    expect(io.stdout()).toContain('Context source saved without a completed context build for dbt-main.');
    expect(io.stdout()).toContain('Run later: ktx ingest run --connection-id dbt-main --adapter <adapter>');
  });

  it('retries initial source ingest from the failure menu', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const runInitialIngest = vi.fn(async () => (runInitialIngest.mock.calls.length === 1 ? 1 : 0));
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path', 'retry'],
      text: ['dbt-main', '/repo/dbt', '', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: true, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateDbt,
          runInitialIngest,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(runInitialIngest).toHaveBeenCalledTimes(2);
  });

  it('offers existing context source connections before prompting for new details', async () => {
    await addPrimarySource();
    await addConnection('dbt-main', {
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
      project_name: 'analytics',
    });
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['existing:dbt-main'],
      text: [undefined],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateDbt,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testPrompts.select).toHaveBeenCalledWith({
      message: 'Configure dbt',
      options: [
        { value: 'existing:dbt-main', label: 'Use existing dbt connection: dbt-main' },
        { value: 'new', label: 'Add new dbt connection' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(testPrompts.text).not.toHaveBeenCalled();
    expect(validateDbt).toHaveBeenCalledWith({
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
      project_name: 'analytics',
    });
    expect((await readConfig()).connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
    });
  });

  it('offers existing connections for every context source type', async () => {
    await addPrimarySource();
    const cases: Array<{
      source: KtxSetupSourceType;
      connectionId: string;
      connection: KtxProjectConnectionConfig;
      deps: KtxSetupSourcesDeps;
      expectedLabel: string;
    }> = [
      {
        source: 'dbt',
        connectionId: 'dbt-main',
        connection: { driver: 'dbt', source_dir: '/repo/dbt', project_name: 'analytics' },
        deps: { validateDbt: vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' })) },
        expectedLabel: 'dbt',
      },
      {
        source: 'metricflow',
        connectionId: 'metricflow-main',
        connection: { driver: 'metricflow', metricflow: { repoUrl: 'file:///repo/metricflow' } },
        deps: { validateMetricflow: vi.fn(async () => ({ ok: true as const, detail: 'metrics=1' })) },
        expectedLabel: 'MetricFlow',
      },
      {
        source: 'metabase',
        connectionId: 'metabase-main',
        connection: {
          driver: 'metabase',
          api_url: 'https://metabase.example.com',
          api_key_ref: 'env:METABASE_API_KEY', // pragma: allowlist secret
          mappings: {
            databaseMappings: { '1': 'warehouse' },
            syncEnabled: { '1': true },
            syncMode: 'ALL',
          },
        },
        deps: {
          validateMetabase: vi.fn(async () => ({ ok: true as const, detail: 'mapping validated' })),
          runMapping: vi.fn(async () => 0),
        },
        expectedLabel: 'Metabase',
      },
      {
        source: 'looker',
        connectionId: 'looker-main',
        connection: {
          driver: 'looker',
          base_url: 'https://looker.example.com',
          client_id: 'client-id',
          client_secret_ref: 'env:LOOKER_CLIENT_SECRET', // pragma: allowlist secret
          mappings: { connectionMappings: { warehouse: 'warehouse' } },
        },
        deps: {
          validateLooker: vi.fn(async () => ({ ok: true as const, detail: 'mapping refreshed' })),
          runMapping: vi.fn(async () => 0),
        },
        expectedLabel: 'Looker',
      },
      {
        source: 'lookml',
        connectionId: 'lookml-main',
        connection: {
          driver: 'lookml',
          repoUrl: 'file:///repo/lookml',
          mappings: { expectedLookerConnectionName: null },
        },
        deps: { validateLookml: vi.fn(async () => ({ ok: true as const, detail: 'lookmlFiles=1' })) },
        expectedLabel: 'LookML',
      },
      {
        source: 'notion',
        connectionId: 'notion-main',
        connection: {
          driver: 'notion',
          auth_token_ref: 'env:NOTION_TOKEN',
          crawl_mode: 'all_accessible',
          root_page_ids: [],
          root_database_ids: [],
          root_data_source_ids: [],
        },
        deps: { validateNotion: vi.fn(async () => ({ ok: true as const, detail: 'roots=0' })) },
        expectedLabel: 'Notion',
      },
    ];

    for (const testCase of cases) {
      await addConnection(testCase.connectionId, testCase.connection);
      const testPrompts = prompts({
        multiselect: [[testCase.source]],
        select: [`existing:${testCase.connectionId}`],
        text: [undefined],
      });

      await expect(
        runKtxSetupSourcesStep(
          { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
          makeIo().io,
          {
            prompts: testPrompts,
            ...testCase.deps,
          },
        ),
      ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: [testCase.connectionId] });

      expect(testPrompts.select).toHaveBeenCalledWith({
        message: `Configure ${testCase.expectedLabel}`,
        options: [
          {
            value: `existing:${testCase.connectionId}`,
            label: `Use existing ${testCase.expectedLabel} connection: ${testCase.connectionId}`,
          },
          { value: 'new', label: `Add new ${testCase.expectedLabel} connection` },
          { value: 'back', label: 'Back' },
        ],
      });
      expect(testPrompts.text).not.toHaveBeenCalled();
    }
  });

  it('lets Escape from dbt git URL return to source location selection', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['git', 'path'],
      text: ['dbt-main', undefined, '/repo/dbt', '', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateDbt,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    const selectMessages = vi.mocked(testPrompts.select).mock.calls.map(([options]) => options.message);
    expect(selectMessages[0]).toBe('dbt source location');
    expect(selectMessages[1]).toBe('dbt source location');
    expect(selectMessages.at(-1)).toContain('Add another?');
    expect((await readConfig()).connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/dbt',
    });
  });

  it('lets Escape from source connection name return to context source selection', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testPrompts = prompts({
      multiselect: [['dbt'], ['back']],
      text: [undefined],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateDbt,
        },
      ),
    ).resolves.toEqual({ status: 'back', projectDir });

    expect(testPrompts.multiselect).toHaveBeenCalledTimes(2);
    expect(validateDbt).not.toHaveBeenCalled();
  });

  it('backs up one prompt inside every interactive context source connection', async () => {
    await addPrimarySource();
    const cases: Array<{
      source: KtxSetupSourceType;
      select?: string[];
      text: Array<string | undefined>;
      deps: KtxSetupSourcesDeps;
      repeatedSelectMessage?: string;
      repeatedTextMessage?: string;
    }> = [
      {
        source: 'dbt',
        select: ['git', 'path'],
        text: ['dbt-main', undefined, '/repo/dbt', '', ''],
        deps: { validateDbt: vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' })) },
        repeatedSelectMessage: 'dbt source location',
      },
      {
        source: 'metricflow',
        select: ['git', 'path'],
        text: ['metricflow-main', undefined, '/repo/metricflow', ''],
        deps: { validateMetricflow: vi.fn(async () => ({ ok: true as const, detail: 'metrics=1' })) },
        repeatedSelectMessage: 'metricflow source location',
      },
      {
        source: 'lookml',
        select: ['git', 'path'],
        text: ['lookml-main', undefined, '/repo/lookml', ''],
        deps: { validateLookml: vi.fn(async () => ({ ok: true as const, detail: 'lookmlFiles=1' })) },
        repeatedSelectMessage: 'lookml source location',
      },
      {
        source: 'metabase',
        select: ['back', 'env'],
        text: [
          'metabase-main',
          'https://old-metabase.example.com',
          'https://metabase.example.com',
          '1',
        ],
        deps: {
          validateMetabase: vi.fn(async () => ({ ok: true as const, detail: 'mapping validated' })),
          runMapping: vi.fn(async () => 0),
        },
        repeatedTextMessage: textInputPrompt('Metabase URL'),
      },
      {
        source: 'looker',
        select: ['env'],
        text: [
          'looker-main',
          'https://old-looker.example.com',
          undefined,
          'https://looker.example.com',
          'client-id',
          '',
        ],
        deps: {
          validateLooker: vi.fn(async () => ({ ok: true as const, detail: 'mapping refreshed' })),
          runMapping: vi.fn(async () => 0),
        },
        repeatedTextMessage: textInputPrompt('Looker base URL'),
      },
      {
        source: 'notion',
        select: ['env', 'back', 'env', 'all_accessible'],
        text: ['notion-main'],
        deps: { validateNotion: vi.fn(async () => ({ ok: true as const, detail: 'roots=0' })) },
        repeatedSelectMessage: 'How should KTX find your Notion integration token?',
      },
    ];

    for (const testCase of cases) {
      const testPrompts = prompts({
        multiselect: [[testCase.source]],
        select: testCase.select,
        text: testCase.text,
      });

      await expect(
        runKtxSetupSourcesStep(
          { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
          makeIo().io,
          {
            prompts: testPrompts,
            ...testCase.deps,
          },
        ),
      ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: [`${testCase.source}-main`] });

      if (testCase.repeatedSelectMessage) {
        expect(
          vi
            .mocked(testPrompts.select)
            .mock.calls.map(([options]) => options.message)
            .filter((message) => message === testCase.repeatedSelectMessage),
        ).toHaveLength(2);
      }
      if (testCase.repeatedTextMessage) {
        expect(
          vi
            .mocked(testPrompts.text)
            .mock.calls.map(([options]) => options.message)
            .filter((message) => message === testCase.repeatedTextMessage),
        ).toHaveLength(2);
      }
    }
  });

  it('does not offer context sources until a primary source exists', async () => {
    const io = makeIo();
    const testPrompts = prompts({ multiselect: [['notion']] });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        { prompts: testPrompts },
      ),
    ).resolves.toEqual({ status: 'skipped', projectDir });

    expect(testPrompts.multiselect).not.toHaveBeenCalled();
    expect(io.stdout()).toContain('Connect a primary source before adding context sources.');
    expect(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
  });

  it('auto-detects dbt_project.yml at the root of a local path', async () => {
    await addPrimarySource();
    const dbtDir = join(tempDir, 'dbt-repo');
    await mkdir(dbtDir, { recursive: true });
    await writeFile(join(dbtDir, 'dbt_project.yml'), 'name: analytics\n');

    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path'],
      text: ['dbt-main', dbtDir],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        { prompts: testPrompts, validateDbt },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testPrompts.text).toHaveBeenCalledTimes(2);
    const config = await readConfig();
    expect(config.connections['dbt-main']).toMatchObject({ driver: 'dbt', source_dir: dbtDir });
    expect(config.connections['dbt-main']).not.toHaveProperty('path');
  });

  it('auto-detects dbt_project.yml in a subdirectory of a local path', async () => {
    await addPrimarySource();
    const dbtDir = join(tempDir, 'monorepo');
    await mkdir(join(dbtDir, 'analytics', 'dbt'), { recursive: true });
    await writeFile(join(dbtDir, 'analytics', 'dbt', 'dbt_project.yml'), 'name: analytics\n');

    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path'],
      text: ['dbt-main', dbtDir],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        { prompts: testPrompts, validateDbt },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testPrompts.text).toHaveBeenCalledTimes(2);
    expect(testPrompts.log).toHaveBeenCalledWith('Found dbt_project.yml in analytics/dbt/');
    const config = await readConfig();
    expect(config.connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: dbtDir,
      path: 'analytics/dbt',
    });
  });

  it('shows a picker when multiple dbt projects are found in a local path', async () => {
    await addPrimarySource();
    const dbtDir = join(tempDir, 'multi-dbt');
    await mkdir(join(dbtDir, 'analytics'), { recursive: true });
    await mkdir(join(dbtDir, 'staging'), { recursive: true });
    await writeFile(join(dbtDir, 'analytics', 'dbt_project.yml'), 'name: analytics\n');
    await writeFile(join(dbtDir, 'staging', 'dbt_project.yml'), 'name: staging\n');

    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path', 'staging'],
      text: ['dbt-main', dbtDir],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        { prompts: testPrompts, validateDbt },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Multiple dbt projects found — which one should KTX use?',
      }),
    );
    expect(testPrompts.text).toHaveBeenCalledTimes(2);
    const config = await readConfig();
    expect(config.connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: dbtDir,
      path: 'staging',
    });
  });
});
