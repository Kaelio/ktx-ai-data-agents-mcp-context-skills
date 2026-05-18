import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initKtxProject, parseKtxProjectConfig, readKtxSetupState, writeKtxSetupState } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type KtxSetupDatabaseDriver,
  type KtxSetupDatabasesDeps,
  type KtxSetupDatabasesPromptAdapter,
  runKtxSetupDatabasesStep,
} from './setup-databases.js';
import type { KtxCliIo } from './cli-runtime.js';
import type {
  DatabaseScopePickResult,
  PickDatabaseScopeArgs,
} from './database-tree-picker.js';

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

type ScopePick =
  | 'back'
  | 'enable-all'
  | { schemas: string[]; tables: string[] };

interface PickerStubs {
  pickDatabaseScope: KtxSetupDatabasesDeps['pickDatabaseScope'];
  scopeCalls: PickDatabaseScopeArgs[];
}

function makePickerStubs(options: { scopes?: ScopePick[] } = {}): PickerStubs {
  const queue: ScopePick[] = [...(options.scopes ?? [])];
  const scopeCalls: PickDatabaseScopeArgs[] = [];
  return {
    scopeCalls,
    pickDatabaseScope: vi.fn(async (args: PickDatabaseScopeArgs): Promise<DatabaseScopePickResult> => {
      scopeCalls.push(args);
      const next = queue.shift();
      if (next === undefined || next === 'enable-all') {
        const enabledTables = args.discovered.map((t) => `${t.schema}.${t.name}`);
        const activeSchemas = args.supportsSchemaScope
          ? Array.from(new Set(args.discovered.map((t) => t.schema)))
          : [];
        return { kind: 'selected', activeSchemas, enabledTables };
      }
      if (next === 'back') {
        return { kind: 'back' };
      }
      return {
        kind: 'selected',
        activeSchemas: args.supportsSchemaScope ? next.schemas : [],
        enabledTables: next.tables,
      };
    }),
  };
}

function makePromptAdapter(options: {
  multiselectValues?: string[][];
  selectValues?: string[];
  textValues?: (string | undefined)[];
  passwordValues?: (string | undefined)[];
}): KtxSetupDatabasesPromptAdapter {
  const multiselectValues = [...(options.multiselectValues ?? [])];
  const selectValues = [...(options.selectValues ?? [])];
  const textValues = [...(options.textValues ?? [])];
  const passwordValues = [...(options.passwordValues ?? [])];
  return {
    multiselect: vi.fn(async () => multiselectValues.shift() ?? ['postgres']),
    select: vi.fn(async ({ message }) => {
      if (message.includes('How much database context should KTX build?')) {
        const nextValue = selectValues[0];
        return nextValue === 'fast' || nextValue === 'deep' || nextValue === 'back'
          ? (selectValues.shift() ?? 'fast')
          : 'fast';
      }
      return selectValues.shift() ?? 'finish';
    }),
    text: vi.fn(async () => (textValues.length > 0 ? textValues.shift() : '')),
    password: vi.fn(async () => (passwordValues.length > 0 ? passwordValues.shift() : '')),
    cancel: vi.fn(),
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

describe('setup databases step', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-databases-'));
    await initKtxProject({ projectDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('shows every supported database in the interactive checklist', async () => {
    const prompts = makePromptAdapter({ multiselectValues: [['back']] });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      { prompts },
    );

    expect(result.status).toBe('back');
    expect(prompts.multiselect).toHaveBeenCalledWith({
      message:
        'Which databases should KTX connect to?\n' +
        'Use Up/Down to move, Space to select or unselect, Enter to confirm, Escape to go back, or Ctrl+C to exit.',
      options: [
        { value: 'sqlite', label: 'SQLite' },
        { value: 'duckdb', label: 'DuckDB' },
        { value: 'postgres', label: 'PostgreSQL' },
        { value: 'mysql', label: 'MySQL' },
        { value: 'clickhouse', label: 'ClickHouse' },
        { value: 'sqlserver', label: 'SQL Server' },
        { value: 'bigquery', label: 'BigQuery' },
        { value: 'snowflake', label: 'Snowflake' },
      ],
      required: true,
    });
  });

  it('lets Back from connection method selection return to database selection when adding a new driver', async () => {
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], ['back']],
      selectValues: ['back'],
    });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      { prompts },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'How do you want to connect to PostgreSQL?',
      options: [
        { value: 'url', label: 'Paste a connection URL' },
        { value: 'fields', label: 'Enter connection details (host, port, database, user)' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(prompts.multiselect).toHaveBeenCalledTimes(2);
    expect(vi.mocked(prompts.multiselect).mock.calls[1]?.[0].message).toBe(
      'Which databases should KTX connect to?\n' +
        'Use Up/Down to move, Space to select or unselect, Enter to confirm, Escape to go back, or Ctrl+C to exit.',
    );
  });

  it('offers connection URL paste first for URL-capable databases', async () => {
    const cases: Array<{ driver: KtxSetupDatabaseDriver; label: string }> = [
      { driver: 'postgres', label: 'PostgreSQL' },
      { driver: 'mysql', label: 'MySQL' },
      { driver: 'clickhouse', label: 'ClickHouse' },
      { driver: 'sqlserver', label: 'SQL Server' },
    ];

    for (const testCase of cases) {
      const prompts = makePromptAdapter({
        selectValues: ['back'],
      });

      const result = await runKtxSetupDatabasesStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          databaseDrivers: [testCase.driver],
          skipDatabases: false,
          databaseSchemas: [],
        },
        makeIo().io,
        { prompts },
      );

      expect(result.status).toBe('back');
      expect(prompts.select).toHaveBeenCalledWith({
        message: `How do you want to connect to ${testCase.label}?`,
        options: [
          { value: 'url', label: 'Paste a connection URL' },
          { value: 'fields', label: 'Enter connection details (host, port, database, user)' },
          { value: 'back', label: 'Back' },
        ],
      });
    }
  });

  it('lets Back leave database setup when the driver came from flags', async () => {
    const prompts = makePromptAdapter({ selectValues: ['back'] });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        skipDatabases: false,
        databaseSchemas: [],
      },
      makeIo().io,
      { prompts },
    );

    expect(result.status).toBe('back');
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(prompts.select).toHaveBeenCalledTimes(1);
  });

  it('labels existing database connections with the database type', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '',
      ].join('\n'),
      'utf-8',
    );
    const prompts = makePromptAdapter({ selectValues: ['back'] });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        skipDatabases: false,
        databaseSchemas: [],
      },
      makeIo().io,
      { prompts },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Configure PostgreSQL',
      options: [
        { value: 'existing:warehouse', label: 'Keep existing PostgreSQL connection: warehouse' },
        { value: 'edit:warehouse', label: 'Edit PostgreSQL connection: warehouse' },
        { value: 'new', label: 'Add another PostgreSQL connection' },
        { value: 'back', label: 'Back' },
      ],
    });
  });

  it('uses a database-specific editable connection name for new interactive connections', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['url'],
      textValues: ['', 'env:DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    expect(prompts.text).toHaveBeenNthCalledWith(1, {
      message: textInputPrompt(connectionNamePrompt('PostgreSQL')),
      placeholder: 'postgres-warehouse',
      initialValue: 'postgres-warehouse',
    });
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'postgres-warehouse', expect.anything());
    expect(scanConnection).toHaveBeenCalledWith(tempDir, 'postgres-warehouse', expect.anything());
    const configText = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    const config = parseKtxProjectConfig(configText);
    expect(config.connections['postgres-warehouse']).toEqual({
      driver: 'postgres',
      url: 'env:DATABASE_URL',
      context: { depth: 'fast' },
    });
  });

  it('tells users Escape goes back in free-text connection prompts', async () => {
    const prompts = makePromptAdapter({
      selectValues: ['url'],
      textValues: ['', 'env:DATABASE_URL'],
    });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      makeIo().io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
      },
    );

    expect(result.status).toBe('ready');
    expect(prompts.text).toHaveBeenNthCalledWith(1, {
      message: textInputPrompt(connectionNamePrompt('PostgreSQL')),
      placeholder: 'postgres-warehouse',
      initialValue: 'postgres-warehouse',
    });
    expect(prompts.text).toHaveBeenNthCalledWith(2, {
      message: textInputPrompt('PostgreSQL connection URL'),
    });
  });

  it('uses clear setup prompts for every new database connection type', async () => {
    const cases: Array<{
      driver: KtxSetupDatabaseDriver;
      selectValues?: string[];
      textValues: string[];
      passwordValues?: string[];
      expectedTextPrompts: Array<{ message: string; placeholder?: string; initialValue?: string }>;
      expectedPasswordPrompts?: Array<{ message: string }>;
    }> = [
      {
        driver: 'sqlite',
        textValues: ['', './warehouse.sqlite'],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('SQLite'),
            placeholder: 'sqlite-local',
            initialValue: 'sqlite-local',
          },
          {
            message: 'SQLite database file\nEnter a relative or absolute path, for example ./warehouse.sqlite.',
          },
        ],
      },
      {
        driver: 'duckdb',
        textValues: ['', './warehouse.duckdb'],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('DuckDB'),
            placeholder: 'duckdb-local',
            initialValue: 'duckdb-local',
          },
          {
            message: 'DuckDB database file\nEnter a relative or absolute path, for example ./warehouse.duckdb.',
          },
        ],
      },
      {
        driver: 'postgres',
        selectValues: ['url'],
        textValues: ['', 'env:DATABASE_URL'],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('PostgreSQL'),
            placeholder: 'postgres-warehouse',
            initialValue: 'postgres-warehouse',
          },
          {
            message: 'PostgreSQL connection URL',
          },
        ],
      },
      {
        driver: 'mysql',
        selectValues: ['url'],
        textValues: ['', 'env:MYSQL_DATABASE_URL'],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('MySQL'),
            placeholder: 'mysql-warehouse',
            initialValue: 'mysql-warehouse',
          },
          {
            message: 'MySQL connection URL',
          },
        ],
      },
      {
        driver: 'clickhouse',
        selectValues: ['url'],
        textValues: ['', 'env:CLICKHOUSE_URL'],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('ClickHouse'),
            placeholder: 'clickhouse-warehouse',
            initialValue: 'clickhouse-warehouse',
          },
          {
            message: 'ClickHouse connection URL',
          },
        ],
      },
      {
        driver: 'sqlserver',
        selectValues: ['url'],
        textValues: ['', 'env:SQLSERVER_DATABASE_URL'],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('SQL Server'),
            placeholder: 'sqlserver-warehouse',
            initialValue: 'sqlserver-warehouse',
          },
          {
            message: 'SQL Server connection URL',
          },
        ],
      },
      {
        driver: 'bigquery',
        selectValues: ['no'],
        textValues: ['', 'analytics', '/path/to/service-account.json', ''],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('BigQuery'),
            placeholder: 'bigquery-warehouse',
            initialValue: 'bigquery-warehouse',
          },
          {
            message: 'BigQuery dataset\nFor example analytics.',
          },
          {
            message: 'Path to service account JSON file',
          },
          {
            message: 'BigQuery location\nPress Enter for US, or enter a location like EU.',
            placeholder: 'US',
            initialValue: 'US',
          },
        ],
      },
      {
        driver: 'snowflake',
        selectValues: ['no'],
        textValues: ['', 'env:SNOWFLAKE_ACCOUNT', 'ANALYTICS_WH', 'ANALYTICS', '', 'env:SNOWFLAKE_USER', ''],
        passwordValues: ['env:SNOWFLAKE_PASSWORD'],
        expectedTextPrompts: [
          {
            message: connectionNamePrompt('Snowflake'),
            placeholder: 'snowflake-warehouse',
            initialValue: 'snowflake-warehouse',
          },
          {
            message: 'Snowflake account identifier',
          },
          {
            message: 'Snowflake warehouse\nFor example ANALYTICS_WH.',
          },
          {
            message: 'Snowflake database name',
          },
          {
            message: 'Snowflake schema\nPress Enter for PUBLIC, or enter a schema name.',
            placeholder: 'PUBLIC',
            initialValue: 'PUBLIC',
          },
          {
            message: 'Snowflake username',
          },
          {
            message: 'Snowflake role (optional)\nPress Enter to skip.',
          },
        ],
        expectedPasswordPrompts: [
          {
            message: 'Snowflake password',
          },
        ],
      },
    ];

    for (const testCase of cases) {
      const prompts = makePromptAdapter({
        selectValues: testCase.selectValues ?? ['new'],
        textValues: testCase.textValues,
        passwordValues: testCase.passwordValues,
      });
      const result = await runKtxSetupDatabasesStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          databaseDrivers: [testCase.driver],
          databaseSchemas: [],
          skipDatabases: false,
        },
        makeIo().io,
        {
          prompts,
          testConnection: vi.fn(async () => 0),
          scanConnection: vi.fn(async () => 0),
        },
      );

      expect(result.status).toBe('ready');
      expect(vi.mocked(prompts.text).mock.calls.map(([options]) => options)).toEqual(
        testCase.expectedTextPrompts.map((expectedPrompt) => ({
          ...expectedPrompt,
          message: textInputPrompt(expectedPrompt.message),
        })),
      );
      if (testCase.expectedPasswordPrompts) {
        expect(vi.mocked(prompts.password).mock.calls.map(([options]) => options)).toEqual(
          testCase.expectedPasswordPrompts.map((expectedPrompt) => ({
            ...expectedPrompt,
            message: textInputPrompt(expectedPrompt.message),
          })),
        );
      }
    }
  });

  it('lets Back from connection method selection return to database selection', async () => {
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], ['back']],
      selectValues: ['back'],
      textValues: [''],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => []);
    const listTables = vi.fn(async () => []);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        skipDatabases: false,
        databaseSchemas: [],
        disableQueryHistory: true,
      },
      makeIo().io,
      { prompts, testConnection, scanConnection, listSchemas, listTables },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenNthCalledWith(1, {
      message: 'How do you want to connect to PostgreSQL?',
      options: [
        { value: 'url', label: 'Paste a connection URL' },
        { value: 'fields', label: 'Enter connection details (host, port, database, user)' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(prompts.multiselect).toHaveBeenCalledTimes(2);
    expect(testConnection).not.toHaveBeenCalled();
    expect(scanConnection).not.toHaveBeenCalled();
  });

  it('shows a configured database menu instead of the type checklist when a database exists', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({ multiselectValues: [['back']], selectValues: ['continue'] });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        skipDatabases: false,
        databaseSchemas: [],
        disableQueryHistory: true,
      },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Databases configured: warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to context sources' },
        { value: 'edit', label: 'Edit an existing database' },
        { value: 'add', label: 'Add another database' },
      ],
    });
    expect(testConnection).not.toHaveBeenCalled();
    expect(scanConnection).not.toHaveBeenCalled();
  });

  it('preserves existing database ids when adding another database from the configured menu', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({
      selectValues: ['add', 'url', 'continue'],
      multiselectValues: [['mysql']],
      textValues: ['', 'env:MYSQL_DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        skipDatabases: false,
        databaseSchemas: [],
        disableQueryHistory: true,
      },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result).toEqual({
      status: 'ready',
      projectDir: tempDir,
      connectionIds: ['warehouse', 'mysql-warehouse'],
    });
    expect(prompts.multiselect).toHaveBeenCalledTimes(1);
    expect(prompts.multiselect).toHaveBeenCalledWith(expect.objectContaining({
      initialValues: ['postgres'],
      required: true,
    }));
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Databases configured: warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to context sources' },
        { value: 'edit', label: 'Edit an existing database' },
        { value: 'add', label: 'Add another database' },
      ],
    });
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'mysql-warehouse', expect.anything());
    const configText = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    const config = parseKtxProjectConfig(configText);
    expect(config.setup?.database_connection_ids).toEqual(['warehouse', 'mysql-warehouse']);
  });

  it('lets users add another database after completing the first one', async () => {
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], ['mysql']],
      selectValues: ['url', 'add', 'url', 'continue'],
      textValues: ['', 'env:DATABASE_URL', '', 'env:MYSQL_DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        skipDatabases: false,
        databaseSchemas: [],
        disableQueryHistory: true,
      },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result).toEqual({
      status: 'ready',
      projectDir: tempDir,
      connectionIds: ['postgres-warehouse', 'mysql-warehouse'],
    });
    expect(prompts.multiselect).toHaveBeenCalledTimes(2);
    expect(prompts.multiselect).toHaveBeenNthCalledWith(2, expect.objectContaining({
      initialValues: ['postgres'],
      required: true,
    }));
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Databases configured: postgres-warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to context sources' },
        { value: 'edit', label: 'Edit an existing database' },
        { value: 'add', label: 'Add another database' },
      ],
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.setup?.database_connection_ids).toEqual(['postgres-warehouse', 'mysql-warehouse']);
  });

  it('returns to configured primary menu when pressing back on driver selection after adding a source', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], ['back']],
      selectValues: ['url', 'add', 'continue'],
      textValues: ['', 'env:DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        skipDatabases: false,
        databaseSchemas: [],
        disableQueryHistory: true,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result).toEqual({
      status: 'ready',
      projectDir: tempDir,
      connectionIds: ['postgres-warehouse'],
    });
    expect(prompts.multiselect).toHaveBeenCalledTimes(2);
    expect(prompts.multiselect).toHaveBeenNthCalledWith(2, expect.objectContaining({
      initialValues: ['postgres'],
      required: true,
    }));
    expect(io.stdout()).not.toContain('KTX cannot work without at least one database');
    expect(prompts.select).toHaveBeenNthCalledWith(3, {
      message: 'Databases configured: postgres-warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to context sources' },
        { value: 'edit', label: 'Edit an existing database' },
        { value: 'add', label: 'Add another database' },
      ],
    });
  });

  it('returns to configured primary menu when pressing back on driver selection with pre-existing source', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const io = makeIo();
    const prompts = makePromptAdapter({
      multiselectValues: [['back']],
      selectValues: ['add', 'continue'],
    });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      io.io,
      { prompts },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(prompts.multiselect).toHaveBeenCalledWith(expect.objectContaining({
      initialValues: ['postgres'],
      required: true,
    }));
    expect(io.stdout()).not.toContain('KTX cannot work without at least one database');
    expect(prompts.select).toHaveBeenNthCalledWith(2, {
      message: 'Databases configured: warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to context sources' },
        { value: 'edit', label: 'Edit an existing database' },
        { value: 'add', label: 'Add another database' },
      ],
    });
  });

  it('returns from database edit selection back to the configured source menu', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({
      selectValues: ['edit', 'back', 'continue'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(prompts.select).toHaveBeenNthCalledWith(2, {
      message: 'Database to edit',
      options: [
        { value: 'warehouse', label: 'warehouse (PostgreSQL)' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(prompts.select).toHaveBeenNthCalledWith(3, {
      message: 'Databases configured: warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to context sources' },
        { value: 'edit', label: 'Edit an existing database' },
        { value: 'add', label: 'Add another database' },
      ],
    });
    expect(testConnection).not.toHaveBeenCalled();
    expect(scanConnection).not.toHaveBeenCalled();
  });

  it('reruns table selection after editing schema scope so stale enabled tables are removed', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    schemas:',
        '      - public',
        '    enabled_tables:',
        '      - public.orders',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({
      textValues: ['env:DATABASE_URL'],
    });
    let primaryMenuCount = 0;
    vi.mocked(prompts.select).mockImplementation(async (options) => {
      if (options.message === 'Databases configured: warehouse\nWhat would you like to do?') {
        primaryMenuCount += 1;
        return primaryMenuCount === 1 ? 'edit' : 'continue';
      }
      if (options.message === 'Database to edit') return 'warehouse';
      if (options.message === 'How do you want to connect to PostgreSQL?') return 'url';
      if (options.message.startsWith('Enable query-history ingest')) return 'no';
      return 'back';
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => ['analytics', 'public']);
    const listTables = vi.fn(async () => [{ schema: 'analytics', name: 'customers', kind: 'table' as const }]);
    const pickers = makePickerStubs({
      scopes: [{ schemas: ['analytics'], tables: ['analytics.customers'] }],
    });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      {
        prompts,
        testConnection,
        scanConnection,
        listSchemas,
        listTables,
        pickDatabaseScope: pickers.pickDatabaseScope,
      },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(prompts.text).toHaveBeenCalledWith({
      message: textInputPrompt('PostgreSQL connection URL'),
      placeholder: 'env:DATABASE_URL',
      initialValue: 'env:DATABASE_URL',
    });
    expect(listTables).toHaveBeenCalledWith(tempDir, 'warehouse', ['analytics', 'public']);
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    expect(scanConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      schemas: ['analytics'],
      enabled_tables: ['analytics.customers'],
    });
  });

  it('preselects existing schema and table choices when editing a database', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    schemas:',
        '      - public',
        '    enabled_tables:',
        '      - public.customers',
        '      - public.orders',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({
      textValues: ['env:DATABASE_URL'],
    });
    let primaryMenuCount = 0;
    vi.mocked(prompts.select).mockImplementation(async (options) => {
      if (options.message === 'Databases configured: warehouse\nWhat would you like to do?') {
        primaryMenuCount += 1;
        return primaryMenuCount === 1 ? 'edit' : 'continue';
      }
      if (options.message === 'Database to edit') return 'warehouse';
      if (options.message === 'How do you want to connect to PostgreSQL?') return 'url';
      if (options.message.startsWith('Enable query-history ingest')) return 'no';
      return 'back';
    });
    const listSchemas = vi.fn(async () => ['orbit_analytics', 'orbit_raw', 'public']);
    const listTables = vi.fn(async () => [
      { schema: 'public', name: 'customers', kind: 'table' as const },
      { schema: 'public', name: 'orders', kind: 'table' as const },
      { schema: 'public', name: 'products', kind: 'table' as const },
    ]);
    const pickers = makePickerStubs({
      scopes: [{ schemas: ['public'], tables: ['public.customers', 'public.orders'] }],
    });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        listSchemas,
        listTables,
        pickDatabaseScope: pickers.pickDatabaseScope,
      },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(pickers.scopeCalls).toHaveLength(1);
    expect(pickers.scopeCalls[0]).toMatchObject({
      connectionId: 'warehouse',
      schemaNoun: 'schema',
      supportsSchemaScope: true,
      existing: { enabledTables: ['public.customers', 'public.orders'] },
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      schemas: ['public'],
      enabled_tables: ['public.customers', 'public.orders'],
    });
  });

  it('returns to the configured primary menu when backing out of schema review during edit', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    schemas:',
        '      - public',
        '    enabled_tables:',
        '      - public.orders',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({
      textValues: ['env:DATABASE_URL'],
    });
    let primaryMenuCount = 0;
    vi.mocked(prompts.select).mockImplementation(async (options) => {
      if (options.message === 'Databases configured: warehouse\nWhat would you like to do?') {
        primaryMenuCount += 1;
        return primaryMenuCount === 1 ? 'edit' : 'continue';
      }
      if (options.message === 'Database to edit') return 'warehouse';
      if (options.message === 'How do you want to connect to PostgreSQL?') return 'url';
      if (options.message.startsWith('Enable query-history ingest')) return 'no';
      return 'back';
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => ['analytics', 'public']);
    const listTables = vi.fn(async () => [
      { schema: 'analytics', name: 'customers', kind: 'table' as const },
      { schema: 'public', name: 'orders', kind: 'table' as const },
    ]);
    const pickers = makePickerStubs({ scopes: ['back'] });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      {
        prompts,
        testConnection,
        scanConnection,
        listSchemas,
        listTables,
        pickDatabaseScope: pickers.pickDatabaseScope,
      },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(primaryMenuCount).toBe(2);
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    expect(scanConnection).not.toHaveBeenCalled();
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      url: 'env:DATABASE_URL',
      schemas: ['public'],
      enabled_tables: ['public.orders'],
    });
  });

  it('returns to the configured primary menu when backing out of table review during edit', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    schemas:',
        '      - public',
        '    enabled_tables:',
        '      - public.orders',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({ textValues: ['env:DATABASE_URL'] });
    let primaryMenuCount = 0;
    vi.mocked(prompts.select).mockImplementation(async (options) => {
      if (options.message === 'Databases configured: warehouse\nWhat would you like to do?') {
        primaryMenuCount += 1;
        return primaryMenuCount === 1 ? 'edit' : 'continue';
      }
      if (options.message === 'Database to edit') return 'warehouse';
      if (options.message === 'How do you want to connect to PostgreSQL?') return 'url';
      if (options.message.startsWith('Enable query-history ingest')) return 'no';
      return 'back';
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => ['public']);
    const listTables = vi.fn(async () => [
      { schema: 'public', name: 'customers', kind: 'table' as const },
      { schema: 'public', name: 'orders', kind: 'table' as const },
    ]);
    const pickers = makePickerStubs({ scopes: ['back'] });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      {
        prompts,
        testConnection,
        scanConnection,
        listSchemas,
        listTables,
        pickDatabaseScope: pickers.pickDatabaseScope,
      },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(primaryMenuCount).toBe(2);
    expect(listTables).toHaveBeenCalledWith(tempDir, 'warehouse', ['public']);
    expect(scanConnection).not.toHaveBeenCalled();
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      url: 'env:DATABASE_URL',
      schemas: ['public'],
      enabled_tables: ['public.orders'],
    });
  });

  it('restores an existing database edit when the follow-up scan fails', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    schemas:',
        '      - public',
        '    enabled_tables:',
        '      - public.orders',
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['databases'] });
    const prompts = makePromptAdapter({
      textValues: ['env:DATABASE_URL'],
    });
    vi.mocked(prompts.select).mockImplementation(async (options) => {
      if (options.message === 'Databases configured: warehouse\nWhat would you like to do?') return 'edit';
      if (options.message === 'Database to edit') return 'warehouse';
      if (options.message === 'How do you want to connect to PostgreSQL?') return 'url';
      if (options.message.startsWith('Enable query-history ingest')) return 'no';
      return 'back';
    });
    const listTables = vi.fn(async () => [
      { schema: 'public', name: 'customers', kind: 'table' as const },
      { schema: 'public', name: 'orders', kind: 'table' as const },
    ]);
    const pickers = makePickerStubs({ scopes: ['enable-all'] });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 1),
        listTables,
        pickDatabaseScope: pickers.pickDatabaseScope,
      },
    );

    expect(result).toEqual({ status: 'failed', projectDir: tempDir });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      enabled_tables: ['public.orders'],
    });
  });

  it('lets Escape from connection fields return to connection method selection', async () => {
    const prompts = makePromptAdapter({
      selectValues: ['fields', 'url'],
      textValues: ['', undefined, 'env:DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
        disableQueryHistory: true,
      },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    const selectMessages = vi.mocked(prompts.select).mock.calls.map(([options]) => options.message);
    expect(selectMessages.filter((message) => message === 'How do you want to connect to PostgreSQL?')).toHaveLength(2);
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'postgres-warehouse', expect.anything());
  });

  it('explains where Back goes after missing PostgreSQL field input', async () => {
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], ['back']],
      selectValues: ['fields', 'back'],
      textValues: ['', 'db.example.com', '5432', ''],
    });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
      },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenNthCalledWith(2, {
      message:
        'Some PostgreSQL connection details are missing.\n' +
        'Continue entering details, or go back to database selection.',
      options: [
        { value: 'retry', label: 'Continue entering PostgreSQL details' },
        { value: 'back', label: 'Back to database selection' },
      ],
    });
  });

  it('lets Escape from connection name return to database selection', async () => {
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], ['back']],
      textValues: [undefined],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseSchemas: [],
        skipDatabases: false,
      },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('back');
    expect(prompts.multiselect).toHaveBeenCalledTimes(2);
    expect(prompts.select).not.toHaveBeenCalled();
    expect(testConnection).not.toHaveBeenCalled();
    expect(scanConnection).not.toHaveBeenCalled();
  });

  it('builds a Postgres connection from individual fields and stores password in .ktx/secrets', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['fields'],
      textValues: ['', 'db.example.com', '', 'analytics', 'readonly'],
      passwordValues: ['s3cret'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    const configText = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    const config = parseKtxProjectConfig(configText);
    const connection = config.connections['postgres-warehouse'];
    expect(connection).toMatchObject({
      driver: 'postgres',
      host: 'db.example.com',
      port: 5432,
      database: 'analytics',
      username: 'readonly',
    });
    expect(connection.password).toMatch(/^file:/);
    const secretPath = join(tempDir, '.ktx/secrets/postgres-warehouse-password');
    await expect(readFile(secretPath, 'utf-8')).resolves.toBe('s3cret\n');
    if (process.platform !== 'win32') {
      expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('stores credential-bearing pasted URLs in .ktx/secrets automatically', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['url'],
      textValues: ['', 'postgresql://myuser:s3cret@db.example.com:5432/analytics'], // pragma: allowlist secret
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    const configText = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    const config = parseKtxProjectConfig(configText);
    const connection = config.connections['postgres-warehouse'];
    expect(connection.url).toBe(`file:${resolve(tempDir, '.ktx/secrets/postgres-warehouse-url')}`);
    expect(connection.driver).toBe('postgres');
    const secretContent = await readFile(join(tempDir, '.ktx/secrets/postgres-warehouse-url'), 'utf-8');
    expect(secretContent).toBe('postgresql://myuser:s3cret@db.example.com:5432/analytics\n'); // pragma: allowlist secret
  });

  it('summarizes connection test and structural scan output during setup', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['url'],
      textValues: ['', 'env:DATABASE_URL'],
    });
    const testConnection = vi.fn(async (_projectDir: string, _connectionId: string, commandIo: KtxCliIo) => {
      commandIo.stdout.write('Connection test passed: postgres-warehouse\n');
      commandIo.stdout.write('Driver: postgres\n');
      commandIo.stdout.write('Status: ok\n');
      return 0;
    });
    const scanConnection = vi.fn(async (_projectDir: string, _connectionId: string, commandIo: KtxCliIo) => {
      commandIo.stdout.write('Scanning postgres-warehouse for context. Large databases can take a while.\n');
      commandIo.stdout.write('[5%] Preparing scan\n');
      commandIo.stdout.write('[15%] Inspecting database schema\n');
      commandIo.stdout.write('[55%] Semantic layer comparison found 2 changes across 2 tables\n');
      commandIo.stdout.write('[70%] Writing schema artifacts\n');
      commandIo.stdout.write('[100%] Scan completed\n');
      commandIo.stdout.write('✓ KTX scan completed\n');
      commandIo.stdout.write('Status: done\n');
      commandIo.stdout.write('Run: local-moywh3ky\n');
      commandIo.stdout.write('Connection: postgres-warehouse\n');
      commandIo.stdout.write('Mode: structural\n');
      commandIo.stdout.write('Sync: 2026-05-09-221301-local-moywh3ky\n');
      commandIo.stdout.write('Dry run: no\n\n');
      commandIo.stdout.write('What changed\n');
      commandIo.stdout.write('  Semantic layer comparison found 2 changes across 2 tables\n');
      commandIo.stdout.write('  New tables: 2\n');
      commandIo.stdout.write('  Changed tables: 0\n');
      commandIo.stdout.write('  Removed tables: 0\n');
      commandIo.stdout.write('  Unchanged tables: 0\n\n');
      commandIo.stdout.write('Needs attention\n');
      commandIo.stdout.write('  None\n\n');
      commandIo.stdout.write('Artifacts\n');
      commandIo.stdout.write(
        '  Report: raw-sources/postgres-warehouse/live-database/2026-05-09-221301-local-moywh3ky/scan-report.json\n',
      );
      commandIo.stdout.write('  Raw sources: raw-sources/postgres-warehouse/live-database/2026-05-09-221301-local-moywh3ky\n');
      commandIo.stdout.write('  Schema shards: 1\n\n');
      commandIo.stdout.write('Next:\n');
      commandIo.stdout.write(`  ktx status --project-dir ${tempDir} local-moywh3ky\n`);
      return 0;
    });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    expect(io.stdout()).toContain(
      [
        '◇  Testing postgres-warehouse',
        '│  ✓ Connection test passed',
        '│  Driver: PostgreSQL',
        '│',
      ].join('\n'),
    );
    expect(io.stdout()).not.toContain('Tables: 2');
    expect(io.stdout()).toContain('◇  Building schema context for postgres-warehouse');
    expect(io.stdout()).toContain('│  Running fast database ingest…');
    expect(io.stdout()).toContain('◇  Schema context complete for postgres-warehouse');
    expect(io.stdout()).toContain('│  Changes: 2 new tables');
    expect(io.stdout()).toContain('◇  Database ready');
    expect(io.stdout()).not.toContain(['Primary source', 'ready'].join(' '));
    expect(io.stdout()).toContain('│  postgres-warehouse · PostgreSQL · schema context complete');
    expect(io.stdout()).not.toContain('Scanning postgres-warehouse');
    expect(io.stdout()).not.toContain('Scan complete for postgres-warehouse');
    expect(io.stdout()).not.toContain('structural scan complete');
    expect(io.stdout()).not.toContain('Report: raw-sources');
    expect(io.stdout()).not.toContain('live-database');
    expect(io.stdout()).not.toContain('[5%] Preparing scan');
    expect(io.stdout()).not.toContain('What changed');
    expect(io.stdout()).not.toContain('Next:');
  });

  it('normalizes $ENV_VAR syntax to env: references in pasted URLs', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['url'],
      textValues: ['', '$DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections['postgres-warehouse']).toMatchObject({
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    });
  });

  it('prompts for discovered Postgres schemas before the first scan', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      selectValues: ['url'],
      textValues: ['', 'env:DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async asyncScanProjectDir => {
      const config = parseKtxProjectConfig(await readFile(join(asyncScanProjectDir, 'ktx.yaml'), 'utf-8'));
      expect(config.connections['postgres-warehouse']).toMatchObject({
        schemas: ['orbit_analytics', 'orbit_raw'],
      });
      return 0;
    });
    const listSchemas = vi.fn(async () => ['orbit_analytics', 'orbit_raw', 'public']);
    const listTables = vi.fn(async () => [
      { schema: 'orbit_analytics', name: 'events', kind: 'table' as const },
      { schema: 'orbit_raw', name: 'inputs', kind: 'table' as const },
      { schema: 'public', name: 'misc', kind: 'table' as const },
    ]);
    const pickers = makePickerStubs({
      scopes: [
        {
          schemas: ['orbit_analytics', 'orbit_raw'],
          tables: ['orbit_analytics.events', 'orbit_raw.inputs'],
        },
      ],
    });

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        prompts,
        testConnection,
        scanConnection,
        listSchemas,
        listTables,
        pickDatabaseScope: pickers.pickDatabaseScope,
      },
    );

    expect(result.status).toBe('ready');
    expect(listSchemas).toHaveBeenCalledWith(tempDir, 'postgres-warehouse');
    expect(pickers.scopeCalls).toHaveLength(1);
    expect(pickers.scopeCalls[0]).toMatchObject({
      connectionId: 'postgres-warehouse',
      schemaNoun: 'schema',
      schemaNounPlural: 'schemas',
      defaultSchemas: ['orbit_analytics', 'orbit_raw'],
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections['postgres-warehouse']).toMatchObject({
      schemas: ['orbit_analytics', 'orbit_raw'],
    });
    expect(io.stdout()).toContain('✓ orbit_analytics, orbit_raw');
  });

  it('auto-selects all discovered Postgres schemas in non-interactive setup', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({});
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async asyncScanProjectDir => {
      const config = parseKtxProjectConfig(await readFile(join(asyncScanProjectDir, 'ktx.yaml'), 'utf-8'));
      expect(config.connections.warehouse).toMatchObject({
        schemas: ['orbit_analytics', 'orbit_raw', 'public'],
      });
      return 0;
    });
    const listSchemas = vi.fn(async () => ['orbit_analytics', 'orbit_raw', 'public']);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection, listSchemas },
    );

    expect(result.status).toBe('ready');
    expect(prompts.multiselect).not.toHaveBeenCalled();
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      schemas: ['orbit_analytics', 'orbit_raw', 'public'],
    });
    expect(io.stdout()).toContain('✓ orbit_analytics, orbit_raw, public');
  });

  it('adds one non-interactive Postgres URL connection, tests it, scans it, and marks databases complete', async () => {
    const io = makeIo();
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);
    const listSchemas = vi.fn(async () => ['orbit_analytics', 'orbit_raw', 'public']);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        skipDatabases: false,
        disableQueryHistory: true,
      },
      io.io,
      { testConnection, scanConnection, listSchemas },
    );

    expect(result.status).toBe('ready');
    expect(listSchemas).not.toHaveBeenCalled();
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    expect(scanConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toEqual({
      driver: 'postgres',
      url: 'env:DATABASE_URL',
      schemas: ['public'],
      context: { queryHistory: { enabled: false }, depth: 'fast' },
    });
    expect(config.setup).toEqual({
      database_connection_ids: ['warehouse'],
    });
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('databases');
    expect(io.stdout()).toContain('Database ready');
    expect(io.stdout()).not.toContain(['Primary source', 'ready'].join(' '));
    expect(io.stdout()).not.toContain('DATABASE_URL=');
  });

  it('adds one non-interactive SQLite connection from --database-url without prompting', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({});
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['sqlite'],
        databaseConnectionId: 'warehouse',
        databaseUrl: './warehouse.sqlite',
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    expect(prompts.text).not.toHaveBeenCalled();
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    expect(scanConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toEqual({
      driver: 'sqlite',
      path: './warehouse.sqlite',
      context: { depth: 'fast' },
    });
    expect(config.setup).toEqual({
      database_connection_ids: ['warehouse'],
    });
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('databases');
  });

  it('adds one non-interactive DuckDB connection from --database-url without prompting', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({});
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['duckdb'],
        databaseConnectionId: 'warehouse',
        databaseUrl: './warehouse.duckdb',
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    expect(prompts.text).not.toHaveBeenCalled();
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    expect(scanConnection).toHaveBeenCalledWith(tempDir, 'warehouse', expect.anything());
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toEqual({
      driver: 'duckdb',
      path: './warehouse.duckdb',
      context: { depth: 'fast' },
    });
    expect(config.setup).toEqual({
      database_connection_ids: ['warehouse'],
    });
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('databases');
  });

  it('selects multiple existing connections and validates each before recording setup ids', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '  analytics:',
        '    driver: snowflake',
        '    authMethod: password',
        '    account: env:SNOWFLAKE_ACCOUNT',
        '    warehouse: WH',
        '    database: ANALYTICS',
        '    schema_name: PUBLIC',
        '    username: reader',
        '    password: env:SNOWFLAKE_PASSWORD',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseConnectionIds: ['warehouse', 'analytics'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    expect(testConnection).toHaveBeenCalledTimes(2);
    expect(scanConnection).toHaveBeenCalledTimes(2);
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.setup?.database_connection_ids).toEqual(['warehouse', 'analytics']);
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('databases');
  });

  it('keeps the connection config but does not mark databases complete when scanning fails', async () => {
    const io = makeIo();
    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 1),
      },
    );

    expect(result.status).toBe('failed');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({ driver: 'postgres', url: 'env:DATABASE_URL' });
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect(io.stderr()).toContain('Fast database ingest failed for warehouse.');
    expect(io.stderr()).toContain('│  Fast database ingest failed for warehouse.');
    expect(io.stderr()).toContain(`Debug command: ktx ingest warehouse --project-dir ${tempDir} --fast --debug`);
    expect(io.stderr()).not.toContain('Structural scan failed for warehouse.');
    expect(io.stderr()).not.toMatch(/^Fast database ingest failed for warehouse\./m);
  });

  it('prints the native SQLite rebuild command when scanning hits a Node ABI mismatch', async () => {
    const io = makeIo();
    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        rebuildNativeSqlite: vi.fn(async () => 1),
        scanConnection: vi.fn(async (_projectDir: string, _connectionId: string, commandIo: KtxCliIo) => {
          commandIo.stderr.write(
            [
              "The module '/workspace/node_modules/better-sqlite3/build/Release/better_sqlite3.node'",
              'was compiled against a different Node.js version using',
              'NODE_MODULE_VERSION 147. This version of Node.js requires',
              'NODE_MODULE_VERSION 137. Please try re-compiling or re-installing',
              'the module (for instance, using `npm rebuild` or `npm install`).',
              '',
            ].join('\n'),
          );
          return 1;
        }),
      },
    );

    expect(result.status).toBe('failed');
    expect(io.stderr()).toContain('Native SQLite is built for a different Node.js ABI.');
    expect(io.stderr()).toContain('│  Native SQLite is built for a different Node.js ABI.');
    expect(io.stderr()).toContain('Fix: pnpm run native:rebuild');
    expect(io.stderr()).toContain(`Retry: ktx ingest warehouse --project-dir ${tempDir} --fast`);
    expect(io.stderr()).not.toContain('ktx scan');
    expect(io.stderr()).not.toContain('npm rebuild');
    expect(io.stderr()).not.toMatch(/^Native SQLite is built for a different Node.js ABI\./m);
  });

  it('rebuilds native SQLite once and retries setup scanning after a Node ABI mismatch', async () => {
    const io = makeIo();
    const scanConnection = vi.fn(async (_projectDir: string, _connectionId: string, commandIo: KtxCliIo) => {
      if (scanConnection.mock.calls.length === 1) {
        commandIo.stderr.write(
          [
            "The module '/workspace/node_modules/better-sqlite3/build/Release/better_sqlite3.node'",
            'was compiled against a different Node.js version using',
            'NODE_MODULE_VERSION 147. This version of Node.js requires',
            'NODE_MODULE_VERSION 137. Please try re-compiling or re-installing',
            'the module (for instance, using `npm rebuild` or `npm install`).',
            '',
          ].join('\n'),
        );
        return 1;
      }

      commandIo.stdout.write('What changed\n');
      commandIo.stdout.write('  Semantic layer comparison found 0 changes across 56 tables\n');
      commandIo.stdout.write('  New tables: 0\n');
      commandIo.stdout.write('  Changed tables: 0\n');
      commandIo.stdout.write('  Removed tables: 0\n');
      commandIo.stdout.write('  Unchanged tables: 56\n');
      return 0;
    });
    const rebuildNativeSqlite = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection,
        rebuildNativeSqlite,
      },
    );

    expect(result.status).toBe('ready');
    expect(rebuildNativeSqlite).toHaveBeenCalledOnce();
    expect(rebuildNativeSqlite).toHaveBeenCalledWith(expect.anything());
    expect(scanConnection).toHaveBeenCalledTimes(2);
    expect(io.stderr()).toContain('Native SQLite is built for a different Node.js ABI.');
    expect(io.stderr()).toContain('Rebuilding Native SQLite with pnpm run native:rebuild…');
    expect(io.stdout()).toContain('◇  Schema context complete for warehouse');
    expect(io.stdout()).toContain('│  Changes: 0 changes across 56 tables');
  });

  it('writes query history config for supported Snowflake databases after validation succeeds', async () => {
    const io = makeIo();
    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['snowflake'],
        databaseConnectionId: 'snowflake',
        databaseSchemas: [],
        enableQueryHistory: true,
        queryHistoryWindowDays: 30,
        queryHistoryServiceAccountPatterns: ['^svc_'],
        queryHistoryRedactionPatterns: ['(?i)secret'],
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        prompts: makePromptAdapter({
          textValues: ['env:SNOWFLAKE_ACCOUNT', 'WH', 'ANALYTICS', 'PUBLIC', 'reader', ''],
          passwordValues: ['env:SNOWFLAKE_PASSWORD'],
        }),
      },
    );

    expect(result.status).toBe('ready');
    const configText = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    const config = parseKtxProjectConfig(configText);
    expect(config.connections.snowflake).toMatchObject({
      driver: 'snowflake',
      authMethod: 'password',
      context: {
        queryHistory: {
          enabled: true,
          windowDays: 30,
          filters: {
            dropTrivialProbes: true,
            serviceAccounts: {
              patterns: ['^svc_'],
              mode: 'exclude',
            },
          },
          redactionPatterns: ['(?i)secret'],
        },
      },
    });
    expect(config.connections.snowflake.historicSql).toBeUndefined();
    expect(configText).not.toContain('live-database');
    expect(configText).not.toContain('historic-sql');
    expect(configText).not.toMatch(/^\s+adapters:/m);
    expect(config.ingest.adapters).toEqual([]);
  });

  it('writes Postgres query history config with minExecutions and ignores window/redaction output', async () => {
    const io = makeIo();
    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        enableQueryHistory: true,
        queryHistoryWindowDays: 30,
        queryHistoryMinExecutions: 12,
        queryHistoryServiceAccountPatterns: ['^svc_'],
        queryHistoryRedactionPatterns: ['(?i)secret'],
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlProbe: vi.fn(async () => ({ ok: true, lines: ['  OK pg_stat_statements ready (PostgreSQL 16.4)'] })),
      },
    );

    expect(result.status).toBe('ready');
    const configText = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    const config = parseKtxProjectConfig(configText);
    expect(config.connections.warehouse).toMatchObject({
      driver: 'postgres',
      url: 'env:DATABASE_URL',
      schemas: ['public'],
      context: {
        queryHistory: {
          enabled: true,
          minExecutions: 12,
          filters: {
            dropTrivialProbes: true,
            serviceAccounts: {
              patterns: ['^svc_'],
              mode: 'exclude',
            },
          },
        },
      },
    });
    expect(config.connections.warehouse.historicSql).toBeUndefined();
    const warehouseContext =
      config.connections.warehouse.context &&
      typeof config.connections.warehouse.context === 'object' &&
      !Array.isArray(config.connections.warehouse.context)
        ? (config.connections.warehouse.context as Record<string, unknown>)
        : {};
    expect(warehouseContext.queryHistory).not.toHaveProperty('windowDays');
    expect(warehouseContext.queryHistory).not.toHaveProperty('redactionPatterns');
    expect(configText).not.toContain('live-database');
    expect(configText).not.toContain('historic-sql');
    expect(configText).not.toMatch(/^\s+adapters:/m);
    expect(config.ingest.adapters).toEqual([]);
    expect(config.ingest.workUnits.maxConcurrency).toBe(6);
    expect(io.stdout()).toContain('Query history probe...');
    expect(io.stdout()).not.toContain('Historic SQL probe...');
    expect(io.stdout()).toContain('pg_stat_statements ready');
  });

  it('asks interactive Postgres setup whether to enable query history', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    readonly: true',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-6',
        'scan:',
        '  enrichment:',
        '    mode: llm',
        '    embeddings:',
        '      backend: openai',
        '      model: text-embedding-3-small',
        '      dimensions: 1536',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['yes', 'deep'] });
    const historicSqlProbe = vi.fn(async () => ({ ok: true, lines: [] }));

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseConnectionIds: ['warehouse'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlProbe,
      },
    );

    expect(result.status).toBe('ready');
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Enable query-history ingest for this PostgreSQL connection?',
      options: [
        { value: 'yes', label: 'Enable query history (recommended)' },
        { value: 'no', label: 'Do not enable query history' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(prompts.select).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: expect.stringContaining('How much database context should KTX build?'),
      }),
    );
    expect(historicSqlProbe).toHaveBeenCalledWith({
      projectDir: tempDir,
      connectionId: 'warehouse',
      dialect: 'postgres',
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      context: {
        queryHistory: {
          enabled: true,
          minExecutions: 5,
          filters: { dropTrivialProbes: true },
        },
        depth: 'deep',
      },
    });
  });

  it('writes query history config for supported existing database connections', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  analytics:',
        '    driver: bigquery',
        '    dataset_id: analytics',
        '    credentials_json: env:BIGQUERY_CREDENTIALS_JSON',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseConnectionIds: ['analytics'],
        databaseSchemas: [],
        enableQueryHistory: true,
        queryHistoryWindowDays: 45,
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
      },
    );

    expect(result.status).toBe('ready');
    const configText = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    const config = parseKtxProjectConfig(configText);
    expect(config.connections.analytics).toMatchObject({
      context: {
        queryHistory: {
          enabled: true,
          windowDays: 45,
          filters: {
            dropTrivialProbes: true,
          },
          redactionPatterns: [],
        },
      },
    });
    expect(config.connections.analytics.historicSql).toBeUndefined();
    expect(configText).not.toContain('live-database');
    expect(configText).not.toContain('historic-sql');
    expect(configText).not.toMatch(/^\s+adapters:/m);
    expect(config.ingest.adapters).toEqual([]);
  });

  it('rejects query history for DuckDB setup', async () => {
    const io = makeIo();
    await expect(
      runKtxSetupDatabasesStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          databaseDrivers: ['duckdb'],
          databaseConnectionId: 'warehouse',
          databaseUrl: './warehouse.duckdb',
          databaseSchemas: [],
          enableQueryHistory: true,
          skipDatabases: false,
        },
        io.io,
        {
          testConnection: vi.fn(async () => 0),
          scanConnection: vi.fn(async () => 0),
        },
      ),
    ).rejects.toThrow('Query history setup is only supported for Snowflake, BigQuery, and Postgres, not DuckDB.');
  });

  it('enables query history on an existing Postgres connection', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseConnectionIds: ['warehouse'],
        databaseSchemas: [],
        enableQueryHistory: true,
        queryHistoryMinExecutions: 8,
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlProbe: vi.fn(async () => ({ ok: true, lines: ['  OK pg_stat_statements ready (PostgreSQL 16.4)'] })),
      },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      context: {
        queryHistory: {
          enabled: true,
          minExecutions: 8,
          filters: {
            dropTrivialProbes: true,
          },
        },
      },
    });
    expect(config.connections.warehouse.historicSql).toBeUndefined();
  });

  it('migrates legacy historicSql to context.queryHistory during database setup', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    readonly: true',
        '    historicSql:',
        '      enabled: true',
        '      dialect: postgres',
        '      windowDays: 45',
        '      minExecutions: 9',
        '      concurrency: 3',
        '      staleArchiveAfterDays: 120',
        '      filters:',
        '        dropTrivialProbes: true',
        '        serviceAccounts:',
        '          mode: exclude',
        '          patterns:',
        "            - '^svc_'",
        '        orchestrators:',
        '          mode: exclude',
        '          patterns:',
        '            - airflow',
        '        dropFailedBelow: 2',
        '      redactionPatterns:',
        "        - '(?i)secret'",
        '',
      ].join('\n'),
      'utf-8',
    );

    const io = makeIo();

    await expect(
      runKtxSetupDatabasesStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          databaseConnectionIds: ['warehouse'],
          databaseSchemas: [],
          skipDatabases: false,
        },
        io.io,
        {
          testConnection: vi.fn(async () => 0),
          scanConnection: vi.fn(async () => 0),
          historicSqlProbe: vi.fn(async () => ({ ok: true, lines: [] })),
        },
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse.historicSql).toBeUndefined();
    expect(config.connections.warehouse.context).toMatchObject({
      queryHistory: {
        enabled: true,
        windowDays: 45,
        minExecutions: 9,
        concurrency: 3,
        staleArchiveAfterDays: 120,
        filters: {
          dropTrivialProbes: true,
          serviceAccounts: { mode: 'exclude', patterns: ['^svc_'] },
          orchestrators: { mode: 'exclude', patterns: ['airflow'] },
          dropFailedBelow: 2,
        },
        redactionPatterns: ['(?i)secret'],
      },
    });
  });

  it('prints a non-blocking Postgres query history probe failure after connection test succeeds', async () => {
    const io = makeIo();
    const historicSqlProbe = vi.fn(async () => ({
      ok: false,
      lines: [
        '  FAIL pg_stat_statements extension is not installed in the connection database',
        '  Fix: Run (against this database): CREATE EXTENSION pg_stat_statements;',
        "  Fix: Ensure shared_preload_libraries includes 'pg_stat_statements'.",
      ],
    }));

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: [],
        enableQueryHistory: true,
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlProbe,
      },
    );

    expect(result.status).toBe('ready');
    expect(historicSqlProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        connectionId: 'warehouse',
        dialect: 'postgres',
      }),
    );
    expect(io.stdout()).toContain('Query history probe...');
    expect(io.stdout()).not.toContain('Historic SQL probe...');
    expect(io.stdout()).toContain('pg_stat_statements extension is not installed');
    expect(io.stdout()).toContain('Setup written; first ingest run will fail until fixed.');
  });

  it('does not run the query history probe when the regular connection test fails', async () => {
    const io = makeIo();
    const historicSqlProbe = vi.fn(async () => ({ ok: true, lines: [] }));

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: [],
        enableQueryHistory: true,
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 1),
        scanConnection: vi.fn(async () => 0),
        historicSqlProbe,
      },
    );

    expect(result.status).toBe('failed');
    expect(historicSqlProbe).not.toHaveBeenCalled();
  });

  it('returns missing input when non-interactive database flags are incomplete', async () => {
    const io = makeIo();

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
    );

    expect(result.status).toBe('missing-input');
    expect(io.stderr()).toContain('Missing database connection id');
  });

  it('accepts former ingest subcommand names as non-interactive database connection ids', async () => {
    const io = makeIo();

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'replay',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
      },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.replay).toMatchObject({
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    });
  });

  it('leaves setup incomplete when databases are skipped', async () => {
    const io = makeIo();

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'disabled', databaseSchemas: [], skipDatabases: true },
      io.io,
    );

    expect(result.status).toBe('skipped');
    expect(io.stdout()).toContain('KTX cannot work until you add a database.');
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
  });
});
