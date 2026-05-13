import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initKtxProject, parseKtxProjectConfig, readKtxSetupState, writeKtxSetupState } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type KtxSetupDatabaseDriver,
  type KtxSetupDatabasesPromptAdapter,
  runKtxSetupDatabasesStep,
} from './setup-databases.js';
import type { KtxCliIo } from './cli-runtime.js';

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
    select: vi.fn(async () => selectValues.shift() ?? 'finish'),
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
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('shows every supported primary source in the interactive checklist', async () => {
    const prompts = makePromptAdapter({ multiselectValues: [['back']] });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      { prompts },
    );

    expect(result.status).toBe('back');
    expect(prompts.multiselect).toHaveBeenCalledWith({
      message:
        'Which primary sources should KTX connect to?\n' +
        'Use Up/Down to move, Space to select or unselect, Enter to confirm, Escape to go back, or Ctrl+C to exit.',
      options: [
        { value: 'sqlite', label: 'SQLite' },
        { value: 'postgres', label: 'PostgreSQL' },
        { value: 'mysql', label: 'MySQL' },
        { value: 'clickhouse', label: 'ClickHouse' },
        { value: 'sqlserver', label: 'SQL Server' },
        { value: 'bigquery', label: 'BigQuery' },
        { value: 'snowflake', label: 'Snowflake' },
      ],
      required: false,
    });
  });

  it('requires choosing a primary source after an empty interactive selection', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      multiselectValues: [[], ['back']],
      selectValues: ['choose'],
    });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      io.io,
      { prompts },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).not.toHaveBeenCalled();
    expect(io.stdout()).toContain(
      'KTX cannot work without at least one primary source. Select a source or press Escape to go back.',
    );
    expect(prompts.multiselect).toHaveBeenCalledTimes(2);
  });

  it('lets Back from connection method selection return to primary source selection when adding a new driver', async () => {
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
      'Which primary sources should KTX connect to?\n' +
        'Use Up/Down to move, Space to select or unselect, Enter to confirm, Escape to go back, or Ctrl+C to exit.',
    );
  });

  it('offers connection URL paste first for URL-capable primary sources', async () => {
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
        'project: warehouse',
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
        { value: 'existing:warehouse', label: 'Use existing PostgreSQL connection: warehouse' },
        { value: 'new', label: 'Add new PostgreSQL connection' },
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
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections['postgres-warehouse']).toEqual({
      driver: 'postgres',
      url: 'env:DATABASE_URL',
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

  it('lets Back from connection method selection return to primary source selection', async () => {
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], ['back']],
      selectValues: ['back'],
      textValues: [''],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      { prompts, testConnection, scanConnection },
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

  it('shows a configured primary source menu instead of the type checklist when a primary source exists', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: warehouse',
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
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Primary sources already configured: warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to knowledge sources' },
        { value: 'add', label: 'Add another primary source' },
      ],
    });
    expect(testConnection).not.toHaveBeenCalled();
    expect(scanConnection).not.toHaveBeenCalled();
  });

  it('preserves existing primary source ids when adding another source from the configured menu', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: warehouse',
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
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result).toEqual({
      status: 'ready',
      projectDir: tempDir,
      connectionIds: ['warehouse', 'mysql-warehouse'],
    });
    expect(prompts.multiselect).toHaveBeenCalledTimes(1);
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Primary sources already configured: warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to knowledge sources' },
        { value: 'add', label: 'Add another primary source' },
      ],
    });
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(testConnection).toHaveBeenCalledWith(tempDir, 'mysql-warehouse', expect.anything());
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.setup?.database_connection_ids).toEqual(['warehouse', 'mysql-warehouse']);
  });

  it('lets users add another primary source after completing the first one', async () => {
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], ['mysql']],
      selectValues: ['url', 'add', 'url', 'continue'],
      textValues: ['', 'env:DATABASE_URL', '', 'env:MYSQL_DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result).toEqual({
      status: 'ready',
      projectDir: tempDir,
      connectionIds: ['postgres-warehouse', 'mysql-warehouse'],
    });
    expect(prompts.multiselect).toHaveBeenCalledTimes(2);
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Primary sources already configured: postgres-warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to knowledge sources' },
        { value: 'add', label: 'Add another primary source' },
      ],
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.setup?.database_connection_ids).toEqual(['postgres-warehouse', 'mysql-warehouse']);
  });

  it('returns to configured primary menu when submitting empty driver selection after adding a source', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      multiselectValues: [['postgres'], []],
      selectValues: ['url', 'add', 'continue'],
      textValues: ['', 'env:DATABASE_URL'],
    });
    const testConnection = vi.fn(async () => 0);
    const scanConnection = vi.fn(async () => 0);

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      io.io,
      { prompts, testConnection, scanConnection },
    );

    expect(result).toEqual({
      status: 'ready',
      projectDir: tempDir,
      connectionIds: ['postgres-warehouse'],
    });
    expect(prompts.multiselect).toHaveBeenCalledTimes(2);
    expect(io.stdout()).not.toContain('KTX cannot work without at least one primary source');
    expect(prompts.select).toHaveBeenNthCalledWith(2, {
      message: 'Primary sources already configured: postgres-warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to knowledge sources' },
        { value: 'add', label: 'Add another primary source' },
      ],
    });
  });

  it('returns to configured primary menu when submitting empty driver selection with pre-existing source', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: warehouse',
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
      multiselectValues: [[]],
      selectValues: ['add', 'continue'],
    });

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'auto', skipDatabases: false, databaseSchemas: [] },
      io.io,
      { prompts },
    );

    expect(result).toEqual({ status: 'ready', projectDir: tempDir, connectionIds: ['warehouse'] });
    expect(io.stdout()).not.toContain('KTX cannot work without at least one primary source');
    expect(prompts.select).toHaveBeenNthCalledWith(2, {
      message: 'Primary sources already configured: warehouse\nWhat would you like to do?',
      options: [
        { value: 'continue', label: 'Continue to knowledge sources' },
        { value: 'add', label: 'Add another primary source' },
      ],
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
      },
      makeIo().io,
      { prompts, testConnection, scanConnection },
    );

    expect(result.status).toBe('ready');
    expect(prompts.select).toHaveBeenCalledTimes(2);
    expect(vi.mocked(prompts.select).mock.calls[0]?.[0].message).toBe('How do you want to connect to PostgreSQL?');
    expect(vi.mocked(prompts.select).mock.calls[1]?.[0].message).toBe('How do you want to connect to PostgreSQL?');
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
        'Continue entering details, or go back to primary source selection.',
      options: [
        { value: 'retry', label: 'Continue entering PostgreSQL details' },
        { value: 'back', label: 'Back to primary source selection' },
      ],
    });
  });

  it('lets Escape from connection name return to primary source selection', async () => {
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
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
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
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
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
      commandIo.stdout.write('Tables: 2\n');
      return 0;
    });
    const scanConnection = vi.fn(async (_projectDir: string, _connectionId: string, commandIo: KtxCliIo) => {
      commandIo.stdout.write('Scanning postgres-warehouse for context. Large primary sources can take a while.\n');
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
    expect(io.stdout()).toContain(
      [
        '◇  Scanning postgres-warehouse',
        '│  Running structural scan…',
        '│',
      ].join('\n'),
    );
    expect(io.stdout()).toContain(
      [
        '◇  Scan complete for postgres-warehouse',
        '│  Changes: 2 new tables',
        '│  Report: raw-sources/postgres-warehouse/live-database/.../scan-report.json',
        '│',
        '◇  Primary source ready',
        '│  postgres-warehouse · PostgreSQL · structural scan complete',
      ].join('\n'),
    );
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
      multiselectValues: [['orbit_analytics', 'orbit_raw']],
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

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseDrivers: ['postgres'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      { prompts, testConnection, scanConnection, listSchemas },
    );

    expect(result.status).toBe('ready');
    expect(listSchemas).toHaveBeenCalledWith(tempDir, 'postgres-warehouse');
    expect(prompts.multiselect).toHaveBeenCalledWith({
      message: expect.stringContaining('PostgreSQL schemas to scan'),
      options: [
        { value: 'orbit_analytics', label: 'orbit_analytics' },
        { value: 'orbit_raw', label: 'orbit_raw' },
        { value: 'public', label: 'public' },
      ],
      initialValues: ['orbit_analytics', 'orbit_raw'],
      required: true,
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
    });
    expect(config.setup).toEqual({
      database_connection_ids: ['warehouse'],
    });
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('databases');
    expect(io.stdout()).toContain('Primary source ready');
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
        'project: warehouse',
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
    expect(io.stderr()).toContain('Structural scan failed for warehouse.');
    expect(io.stderr()).toContain('│  Structural scan failed for warehouse.');
    expect(io.stderr()).not.toMatch(/^Structural scan failed for warehouse\./m);
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
    expect(io.stderr()).toContain(`Retry: ktx scan --project-dir ${tempDir} warehouse`);
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
    expect(io.stdout()).toContain('◇  Scan complete for warehouse');
  });

  it('writes Historic SQL config for supported Snowflake databases after validation succeeds', async () => {
    const io = makeIo();
    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['snowflake'],
        databaseConnectionId: 'snowflake',
        databaseSchemas: [],
        enableHistoricSql: true,
        historicSqlWindowDays: 30,
        historicSqlServiceAccountPatterns: ['^svc_'],
        historicSqlRedactionPatterns: ['(?i)secret'],
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
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.snowflake).toMatchObject({
      driver: 'snowflake',
      authMethod: 'password',
      historicSql: {
        enabled: true,
        dialect: 'snowflake',
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
    });
    expect(config.ingest.adapters).toContain('historic-sql');
  });

  it('writes Postgres Historic SQL config with minExecutions and ignores window/redaction output', async () => {
    const io = makeIo();
    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        enableHistoricSql: true,
        historicSqlWindowDays: 30,
        historicSqlMinExecutions: 12,
        historicSqlServiceAccountPatterns: ['^svc_'],
        historicSqlRedactionPatterns: ['(?i)secret'],
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
      driver: 'postgres',
      url: 'env:DATABASE_URL',
      schemas: ['public'],
      historicSql: {
        enabled: true,
        dialect: 'postgres',
        minExecutions: 12,
        filters: {
          dropTrivialProbes: true,
          serviceAccounts: {
            patterns: ['^svc_'],
            mode: 'exclude',
          },
        },
      },
    });
    expect(config.connections.warehouse.historicSql).not.toHaveProperty('windowDays');
    expect(config.connections.warehouse.historicSql).not.toHaveProperty('redactionPatterns');
    expect(config.ingest.adapters).toContain('historic-sql');
    expect(config.ingest.workUnits.maxConcurrency).toBe(6);
    expect(io.stdout()).toContain('Historic SQL probe...');
    expect(io.stdout()).toContain('pg_stat_statements ready');
  });

  it('writes Historic SQL config for supported existing database connections', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: warehouse',
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
        enableHistoricSql: true,
        historicSqlWindowDays: 45,
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
    expect(config.connections.analytics).toMatchObject({
      historicSql: {
        enabled: true,
        dialect: 'bigquery',
        windowDays: 45,
        filters: {
          dropTrivialProbes: true,
        },
        redactionPatterns: [],
      },
    });
    expect(config.ingest.adapters).toContain('historic-sql');
  });

  it('enables Historic SQL on an existing Postgres connection', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: warehouse',
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
        enableHistoricSql: true,
        historicSqlMinExecutions: 8,
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
      historicSql: {
        enabled: true,
        dialect: 'postgres',
        minExecutions: 8,
        filters: {
          dropTrivialProbes: true,
        },
      },
    });
  });

  it('prints a non-blocking Postgres Historic SQL probe failure after connection test succeeds', async () => {
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
        enableHistoricSql: true,
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
    expect(io.stdout()).toContain('Historic SQL probe...');
    expect(io.stdout()).toContain('pg_stat_statements extension is not installed');
    expect(io.stdout()).toContain('Setup written; first ingest run will fail until fixed.');
  });

  it('does not run the Historic SQL probe when the regular connection test fails', async () => {
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
        enableHistoricSql: true,
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

  it('leaves setup incomplete when primary sources are skipped', async () => {
    const io = makeIo();

    const result = await runKtxSetupDatabasesStep(
      { projectDir: tempDir, inputMode: 'disabled', databaseSchemas: [], skipDatabases: true },
      io.io,
    );

    expect(result.status).toBe('skipped');
    expect(io.stdout()).toContain('KTX cannot work until you add a primary source.');
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
  });
});
