import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getKtxCliPackageInfo,
  packageInfoFromJson,
  rendererUnavailableVizFallback,
  renderMemoryFlowTui,
  resolveVizFallback,
  runKtxCli,
  sanitizeMemoryFlowTuiError,
  startLiveMemoryFlowTui,
  warnVizFallbackOnce,
} from './index.js';

const require = createRequire(import.meta.url);

function makeIo(options: { stdoutIsTty?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: options.stdoutIsTty,
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

describe('getKtxCliPackageInfo', () => {
  it('identifies the CLI package and its context dependency', () => {
    expect(getKtxCliPackageInfo()).toEqual({
      name: '@ktx/cli',
      version: '0.1.0-rc.1',
      packageVersion: '0.0.0-private',
      runtimeVersion: '0.1.0-rc.1',
      contextPackageName: '@ktx/context',
    });
  });

  it('exports package metadata for package managers and runtime diagnostics', () => {
    const packageJson = require('@ktx/cli/package.json') as { name: string; version: string };

    expect(packageJson).toMatchObject({
      name: '@ktx/cli',
      version: '0.0.0-private',
    });
  });

  it('normalizes public package metadata from package.json contents', () => {
    expect(
      packageInfoFromJson({
        name: '@kaelio/ktx',
        version: '0.1.0',
      }),
    ).toEqual({
      name: '@kaelio/ktx',
      version: '0.1.0',
      packageVersion: '0.1.0',
      runtimeVersion: '0.1.0',
      contextPackageName: '@ktx/context',
    });
  });
});

describe('memory-flow renderer exports', () => {
  it('exports runtime-agnostic renderer entry points for hosted terminal clients', () => {
    expect(renderMemoryFlowTui).toBeTypeOf('function');
    expect(startLiveMemoryFlowTui).toBeTypeOf('function');
    expect(sanitizeMemoryFlowTuiError('token=abc123')).toBe('[redacted]');
  });

  it('exports shared visualization fallback helpers for hosted terminal clients', () => {
    const fallback = resolveVizFallback({ stdout: { isTTY: true }, stderr: { write: vi.fn() } }, { TERM: 'dumb' });

    expect(fallback).toEqual({
      shouldDegrade: true,
      reason: 'term-dumb',
      message: 'TERM=dumb does not support the visual renderer',
    });
    expect(rendererUnavailableVizFallback()).toEqual({
      shouldDegrade: true,
      reason: 'renderer-unavailable',
      message: 'the terminal renderer is unavailable',
    });
    expect(warnVizFallbackOnce).toBeTypeOf('function');
  });
});

describe('runKtxCli', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-'));
    await writeFile(join(tempDir, 'ktx.yaml'), '{}\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('prints version information', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['--version'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toBe('@ktx/cli 0.1.0-rc.1\n');
    expect(testIo.stderr()).toBe('');
  });

  it('prints the public command surface in root help', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['--help'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx [options] [command]');
    expect(testIo.stdout()).toContain('KTX data agent context layer CLI');
    for (const command of ['setup', 'connection', 'ingest', 'wiki', 'sl', 'status', 'dev']) {
      expect(testIo.stdout()).toContain(`${command}`);
    }
    expect(testIo.stdout()).not.toMatch(/^  scan\s/m);
    for (const removed of ['demo', 'init', 'connect', 'ask', 'knowledge', 'agent', 'completion', 'serve']) {
      expect(testIo.stdout()).not.toMatch(new RegExp(`^\\s+${removed}(?:\\s|\\[|$)`, 'm'));
    }
    expect(testIo.stdout()).toContain('--project-dir <path>');
    expect(testIo.stdout()).toContain('KTX_PROJECT_DIR');
    expect(testIo.stdout()).toContain('--debug');
    expect(testIo.stdout()).not.toContain('--' + 'verbose');
    expect(testIo.stdout()).not.toContain('Advanced:');
    expect(testIo.stderr()).toBe('');
  });

  it('routes supported public wiki commands', async () => {
    const knowledge = vi.fn(async () => 0);

    const listIo = makeIo();
    await expect(runKtxCli(['--project-dir', tempDir, 'wiki', 'list', '--json'], listIo.io, { knowledge }))
      .resolves.toBe(0);
    expect(knowledge).toHaveBeenCalledWith(
      {
        command: 'list',
        projectDir: tempDir,
        userId: 'local',
        json: true,
      },
      listIo.io,
    );

    const searchIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, 'wiki', 'search', 'revenue', '--limit', '5'], searchIo.io, { knowledge }),
    ).resolves.toBe(0);
    expect(knowledge).toHaveBeenLastCalledWith(
      {
        command: 'search',
        projectDir: tempDir,
        query: 'revenue',
        userId: 'local',
        json: false,
        limit: 5,
      },
      searchIo.io,
    );

    const debugSearchIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, '--debug', 'wiki', 'search', 'revenue'], debugSearchIo.io, { knowledge }),
    ).resolves.toBe(0);
    expect(knowledge).toHaveBeenLastCalledWith(
      {
        command: 'search',
        projectDir: tempDir,
        query: 'revenue',
        userId: 'local',
        json: false,
        debug: true,
      },
      debugSearchIo.io,
    );
  });

  it('rejects removed public wiki read and write commands', async () => {
    const knowledge = vi.fn(async () => 0);

    for (const argv of [
      ['--project-dir', tempDir, 'wiki', 'read', 'revenue', '--json'],
      ['--project-dir', tempDir, 'wiki', 'write', 'revenue', '--summary', 'Revenue', '--content', 'Revenue.'],
    ]) {
      const io = makeIo();

      await expect(runKtxCli(argv, io.io, { knowledge })).resolves.toBe(1);

      expect(io.stderr()).toMatch(/unknown command|error:/);
    }

    expect(knowledge).not.toHaveBeenCalled();
  });

  it('rejects removed public sl read/write commands', async () => {
    const sl = vi.fn(async () => 0);

    for (const argv of [
      ['--project-dir', tempDir, 'sl', 'read', 'orders', '--connection-id', 'warehouse'],
      ['--project-dir', tempDir, 'sl', 'write', 'orders', '--connection-id', 'warehouse', '--yaml', 'name: orders'],
    ]) {
      const io = makeIo();
      await expect(runKtxCli(argv, io.io, { sl })).resolves.toBe(1);
      expect(io.stderr()).toMatch(/unknown command|error:/);
    }

    expect(sl).not.toHaveBeenCalled();
  });

  it('routes sl search and rejects the old sl list --query flag', async () => {
    const sl = vi.fn(async () => 0);

    const searchIo = makeIo();
    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'sl', 'search', 'revenue', '--connection-id', 'warehouse', '--limit', '5', '--json'],
        searchIo.io,
        { sl },
      ),
    ).resolves.toBe(0);
    expect(sl).toHaveBeenCalledWith(
      {
        command: 'search',
        projectDir: tempDir,
        connectionId: 'warehouse',
        query: 'revenue',
        limit: 5,
        json: true,
        output: undefined,
      },
      searchIo.io,
    );

    const listIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, 'sl', 'list', '--query', 'revenue'], listIo.io, { sl }),
    ).resolves.toBe(1);
    expect(listIo.stderr()).toContain("unknown option '--query'");
  });

  it('routes runtime management commands with the release runtime version', async () => {
    const runtime = vi.fn(async () => 0);
    const installIo = makeIo();
    const startIo = makeIo();
    const stopIo = makeIo();
    const stopAllIo = makeIo();
    const statusIo = makeIo();
    const pruneIo = makeIo();

    await expect(
      runKtxCli(['dev', 'runtime', 'install', '--feature', 'local-embeddings', '--force', '--yes'], installIo.io, {
        runtime,
      }),
    ).resolves.toBe(0);
    await expect(
      runKtxCli(['dev', 'runtime', 'start', '--feature', 'local-embeddings', '--force'], startIo.io, { runtime }),
    ).resolves.toBe(0);
    await expect(runKtxCli(['dev', 'runtime', 'stop'], stopIo.io, { runtime })).resolves.toBe(0);
    await expect(runKtxCli(['dev', 'runtime', 'stop', '--all'], stopAllIo.io, { runtime })).resolves.toBe(0);
    await expect(runKtxCli(['dev', 'runtime', 'status', '--json'], statusIo.io, { runtime })).resolves.toBe(0);
    await expect(runKtxCli(['dev', 'runtime', 'prune', '--dry-run'], pruneIo.io, { runtime })).resolves.toBe(1);

    expect(runtime).toHaveBeenNthCalledWith(
      1,
      {
        command: 'install',
        cliVersion: '0.1.0-rc.1',
        feature: 'local-embeddings',
        force: true,
      },
      installIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      2,
      {
        command: 'start',
        cliVersion: '0.1.0-rc.1',
        projectDir: expect.any(String),
        feature: 'local-embeddings',
        force: true,
      },
      startIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      3,
      {
        command: 'stop',
        cliVersion: '0.1.0-rc.1',
        projectDir: expect.any(String),
        all: false,
      },
      stopIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      4,
      {
        command: 'stop',
        cliVersion: '0.1.0-rc.1',
        projectDir: expect.any(String),
        all: true,
      },
      stopAllIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      5,
      {
        command: 'status',
        cliVersion: '0.1.0-rc.1',
        json: true,
      },
      statusIo.io,
    );
    expect(runtime).toHaveBeenCalledTimes(5);
    for (const io of [installIo, startIo, stopIo, stopAllIo, statusIo]) {
      expect(io.stderr()).toBe('');
    }
    expect(pruneIo.stderr()).toMatch(/unknown command|error:/);
  });

  it('prints the resolved project directory for ordinary project commands', async () => {
    const connection = vi.fn(async () => 0);
    const testIo = makeIo();

    await expect(runKtxCli(['--project-dir', tempDir, 'connection', 'list'], testIo.io, { connection })).resolves.toBe(
      0,
    );

    expect(connection).toHaveBeenCalledWith({ command: 'list', projectDir: tempDir }, testIo.io);
    expect(testIo.stderr()).toBe(`Project: ${tempDir}\n`);
  });

  it('does not print the command-level project directory line for setup', async () => {
    const setup = vi.fn(async () => 0);
    const testIo = makeIo();

    await expect(runKtxCli(['--project-dir', tempDir, 'setup', '--no-input'], testIo.io, { setup })).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: tempDir,
      }),
      testIo.io,
    );
    expect(testIo.stderr()).toBe('');
  });

  it('skips the project directory line for JSON output mode', async () => {
    const publicIngest = vi.fn(async () => 0);
    const jsonIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', tempDir, 'ingest', 'warehouse', '--json'], jsonIo.io, { publicIngest }),
    ).resolves.toBe(0);

    expect(jsonIo.stderr()).toBe('');
  });

  it('documents runtime stop all in command help', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['dev', 'runtime', 'stop', '--help'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toContain('--all');
    expect(testIo.stdout()).toContain('Stop all KTX daemon processes recorded or discoverable');
    expect(testIo.stdout()).toContain('on this machine');
    expect(testIo.stderr()).toBe('');
  });

  it('routes sl query managed runtime install policies', async () => {
    const sl = vi.fn(async () => 0);

    const promptIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, 'sl', 'query', '--measure', 'orders.order_count'], promptIo.io, { sl }),
    ).resolves.toBe(0);
    expect(sl).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: 'query',
        projectDir: tempDir,
        cliVersion: '0.1.0-rc.1',
        runtimeInstallPolicy: 'prompt',
        query: expect.objectContaining({ measures: ['orders.order_count'], dimensions: [] }),
      }),
      promptIo.io,
    );

    const autoIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, 'sl', 'query', '--measure', 'orders.order_count', '--yes'], autoIo.io, {
        sl,
      }),
    ).resolves.toBe(0);
    expect(sl).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cliVersion: '0.1.0-rc.1',
        runtimeInstallPolicy: 'auto',
      }),
      autoIo.io,
    );

    const noInputIo = makeIo();
    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'sl', 'query', '--measure', 'orders.order_count', '--no-input'],
        noInputIo.io,
        { sl },
      ),
    ).resolves.toBe(0);
    expect(sl).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cliVersion: '0.1.0-rc.1',
        runtimeInstallPolicy: 'never',
      }),
      noInputIo.io,
    );
  });

  it('rejects conflicting sl query runtime install flags', async () => {
    const io = makeIo();
    const sl = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'sl', 'query', '--measure', 'orders.order_count', '--yes', '--no-input'],
        io.io,
        { sl },
      ),
    ).resolves.toBe(1);

    expect(sl).not.toHaveBeenCalled();
    expect(io.stderr()).toContain('Choose only one runtime install mode: --yes or --no-input');
  });

  it('documents setup with only the common interactive options visible', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['setup', '--help'], testIo.io)).resolves.toBe(0);

    const stdout = testIo.stdout();
    expect(stdout).toContain('Usage: ktx setup [options]');
    expect(stdout).toContain('--agents');
    expect(stdout).toContain('--target <target>');
    expect(stdout).toContain('--global');
    expect(stdout).toContain('--local');
    expect(stdout).toContain('--yes');
    expect(stdout).toContain('--no-input');
    expect(stdout).toContain('Global Options:');
    expect(stdout.match(/--project-dir <path>/g)).toHaveLength(1);
    expect(stdout).not.toContain('Commands:');
    expect(stdout).not.toContain('setup demo');
    expect(stdout).not.toContain('setup context');

    for (const hiddenFlag of [
      '--new',
      '--existing',
      '--agent-scope',
      '--skip-agents',
      '--llm-backend',
      '--anthropic-api-key-env',
      '--vertex-project',
      '--embedding-backend',
      '--database ',
      '--database-connection-id',
      '--new-database-connection-id',
      '--enable-historic-sql',
      '--historic-sql-min-executions',
      '--enable-query-history',
      '--disable-query-history',
      '--query-history-window-days',
      '--query-history-min-executions',
      '--query-history-service-account-pattern',
      '--query-history-redaction-pattern',
      '--skip-databases',
      '--source ',
      '--source-connection-id',
      '--metabase-database-id',
      '--notion-root-page-id',
      '--skip-initial-source-ingest',
      '--skip-sources',
      '--skip-llm',
      '--skip-embeddings',
      '--embedding-model',
      '--embedding-dimensions',
      '--embedding-base-url',
    ]) {
      expect(stdout).not.toContain(hiddenFlag);
    }
    expect(stdout).not.toMatch(/^  --project\s/m);
    expect(stdout).not.toContain('primary ' + 'source');
    expect(stdout).not.toContain('primary ' + 'sources');
    expect(testIo.stderr()).toBe('');
  });

  it('prints help for bare ktx outside a TTY', async () => {
    const setup = vi.fn(async () => 0);
    const testIo = makeIo({ stdoutIsTty: false });

    await expect(runKtxCli([], testIo.io, { setup })).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx [options] [command]');
    expect(setup).not.toHaveBeenCalled();
    expect(testIo.stderr()).toBe('');
  });

  it('keeps representative JSON command stdout parseable', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    const commands = [
      ['--project-dir', projectDir, 'status', '--json'],
      ['--project-dir', projectDir, 'sl', 'list', '--json'],
    ];

    for (const argv of commands) {
      const testIo = makeIo();
      const code = await runKtxCli(argv, testIo.io);
      expect([0, 1]).toContain(code);

      expect(() => JSON.parse(testIo.stdout())).not.toThrow();
      expect(testIo.stderr()).toBe('');
    }
  });

  it('starts setup for bare ktx in a TTY when no project is discoverable', async () => {
    const { mkdtemp, realpath, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const originalCwd = process.cwd();
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-bare-setup-'));
    const setup = vi.fn(async () => 0);
    const testIo = makeIo({ stdoutIsTty: true });
    const previousProjectDir = process.env.KTX_PROJECT_DIR;
    const expectedProjectDir = await realpath(tempDir);

    try {
      delete process.env.KTX_PROJECT_DIR;
      process.chdir(tempDir);

      await expect(runKtxCli([], testIo.io, { setup })).resolves.toBe(0);

      expect(setup).toHaveBeenCalledWith(
        {
          command: 'run',
          projectDir: expectedProjectDir,
          mode: 'auto',
          agents: false,
          agentScope: 'project',
          skipAgents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.1.0-rc.1',
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: false,
          skipSources: false,
        },
        testIo.io,
      );
      expect(testIo.stdout()).not.toContain('Usage: ktx [options] [command]');
      expect(testIo.stderr()).toBe('');
    } finally {
      process.chdir(originalCwd);
      if (previousProjectDir === undefined) {
        delete process.env.KTX_PROJECT_DIR;
      } else {
        process.env.KTX_PROJECT_DIR = previousProjectDir;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prints help without project status for bare ktx in a TTY when a project is discoverable', async () => {
    const { mkdtemp, realpath, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const originalCwd = process.cwd();
    const previousProjectDir = process.env.KTX_PROJECT_DIR;
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-bare-existing-'));
    const setup = vi.fn(async () => 0);
    const testIo = makeIo({ stdoutIsTty: true });
    const expectedProjectDir = await realpath(tempDir);

    try {
      delete process.env.KTX_PROJECT_DIR;
      await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
      process.chdir(tempDir);

      await expect(runKtxCli([], testIo.io, { setup })).resolves.toBe(0);

      expect(testIo.stdout()).toContain('Usage: ktx [options] [command]');
      expect(testIo.stdout()).not.toContain(`Project: ${expectedProjectDir}`);
      expect(setup).not.toHaveBeenCalled();
    } finally {
      process.chdir(originalCwd);
      if (previousProjectDir === undefined) {
        delete process.env.KTX_PROJECT_DIR;
      } else {
        process.env.KTX_PROJECT_DIR = previousProjectDir;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not invoke status for bare ktx in a TTY when status would fail', async () => {
    const setup = vi.fn(async () => {
      throw new Error('Unsupported ingest.llm: use top-level llm.provider, llm.models, and ingest.workUnits');
    });
    const testIo = makeIo({ stdoutIsTty: true });
    const previousProjectDir = process.env.KTX_PROJECT_DIR;

    try {
      process.env.KTX_PROJECT_DIR = tempDir;

      await expect(runKtxCli([], testIo.io, { setup })).resolves.toBe(0);

      expect(testIo.stdout()).toContain('Usage: ktx [options] [command]');
      expect(setup).not.toHaveBeenCalled();
      expect(testIo.stderr()).toBe('');
    } finally {
      if (previousProjectDir === undefined) {
        delete process.env.KTX_PROJECT_DIR;
      } else {
        process.env.KTX_PROJECT_DIR = previousProjectDir;
      }
    }
  });

  it('rejects removed verbose global option through Commander', async () => {
    const testIo = makeIo();
    const removedVerboseOption = '--' + 'verbose';

    await expect(runKtxCli([removedVerboseOption, 'connection', 'list'], testIo.io)).resolves.toBe(1);

    expect(testIo.stderr()).toContain(`unknown option '${removedVerboseOption}'`);
    expect(testIo.stdout()).toBe('');
  });

  it('rejects removed shell completion commands', async () => {
    const completionIo = makeIo();
    const hiddenIo = makeIo();

    await expect(runKtxCli(['dev', 'completion', 'zsh'], completionIo.io)).resolves.toBe(1);
    await expect(
      runKtxCli(['dev', '__complete', '--shell', 'zsh', '--position', '2', '--', 'ktx', 'co'], hiddenIo.io),
    ).resolves.toBe(1);

    expect(completionIo.stderr()).toMatch(/unknown command|error:/);
    expect(hiddenIo.stderr()).toMatch(/unknown command|error:/);
  });

  it('rejects removed serve commands', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['--project-dir', tempDir, 'serve', '--mcp', 'stdio', '--user-id', 'agent'], testIo.io))
      .resolves.toBe(1);

    expect(testIo.stderr()).toMatch(/unknown command|error:/);
  });

  it('routes public connection-centric ingest shorthand', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', tempDir, 'ingest', 'warehouse', '--fast', '--no-input'], testIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(0);

    expect(publicIngest).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: tempDir,
        targetConnectionId: 'warehouse',
        all: false,
        json: false,
        inputMode: 'disabled',
        depth: 'fast',
        queryHistory: 'default',
        cliVersion: '0.1.0-rc.1',
        runtimeInstallPolicy: 'never',
      },
      testIo.io,
    );
    expect(testIo.stderr()).toBe(`Project: ${tempDir}\n`);
  });

  it('routes public ingest --all --deep with JSON output', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', tempDir, 'ingest', '--all', '--deep', '--json'], testIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(0);

    expect(publicIngest).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: tempDir,
        all: true,
        json: true,
        inputMode: 'auto',
        depth: 'deep',
        queryHistory: 'default',
        cliVersion: '0.1.0-rc.1',
        runtimeInstallPolicy: 'prompt',
      },
      testIo.io,
    );
    expect(testIo.stderr()).toBe('');
  });

  it('routes public ingest --yes as automatic runtime installation', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', tempDir, 'ingest', 'warehouse', '--yes'], testIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(0);

    expect(publicIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        targetConnectionId: 'warehouse',
        runtimeInstallPolicy: 'auto',
      }),
      testIo.io,
    );
  });

  it('rejects conflicting public ingest runtime install modes', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', tempDir, 'ingest', 'warehouse', '--yes', '--no-input'], testIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(1);

    expect(publicIngest).not.toHaveBeenCalled();
    expect(testIo.stderr()).toContain('Choose only one runtime install mode: --yes or --no-input');
  });

  it('rejects mutually exclusive public ingest depth flags before dispatch', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', '/tmp/project', 'ingest', 'warehouse', '--fast', '--deep'], testIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(1);

    expect(publicIngest).not.toHaveBeenCalled();
    expect(testIo.stderr()).toMatch(/option '--(deep|fast)' cannot be used with option '--(fast|deep)'/);
  });

  it.each(['run', 'status', 'watch', 'replay'])(
    'routes former ingest subcommand name "%s" as a connection id',
    async (connectionId) => {
      const testIo = makeIo();
      const publicIngest = vi.fn(async () => 0);

      await expect(
        runKtxCli(['--project-dir', tempDir, 'ingest', connectionId, '--no-input'], testIo.io, {
          publicIngest,
        }),
      ).resolves.toBe(0);

      expect(publicIngest).toHaveBeenCalledWith(
        {
          command: 'run',
          projectDir: tempDir,
          targetConnectionId: connectionId,
          all: false,
          json: false,
          inputMode: 'disabled',
          queryHistory: 'default',
          cliVersion: '0.1.0-rc.1',
          runtimeInstallPolicy: 'never',
        },
        testIo.io,
      );
    },
  );

  it('rejects standalone demo commands', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['demo', '--mode', 'replay', '--no-input'], testIo.io)).resolves.toBe(1);

    expect(testIo.stderr()).toMatch(/unknown command|error:/i);
  });

  it('rejects removed setup subcommands', async () => {
    const setup = vi.fn(async () => 0);
    const cases = [
      ['setup', 'demo', '--mode', 'replay', '--no-input'],
      ['setup', '--no-input', 'demo', '--mode', 'seeded'],
      ['setup', 'demo', 'ingest', '--mode', 'full', '--no-input'],
      ['setup', 'context', 'build'],
      ['setup', 'context', 'watch', 'setup-context-local-1'],
      ['setup', 'context', 'status', 'setup-context-local-1', '--json'],
      ['setup', 'context', 'stop', 'setup-context-local-1'],
      ['setup', 'remove', '--agents'],
      ['setup', 'status', '--json'],
    ];

    for (const args of cases) {
      const testIo = makeIo();
      await expect(runKtxCli(['--project-dir', tempDir, ...args], testIo.io, { setup })).resolves.toBe(1);
      expect(testIo.stderr()).toMatch(/unknown command|error:/i);
    }

    expect(setup).not.toHaveBeenCalled();
  });

  it('rejects removed setup options', async () => {
    const setup = vi.fn(async () => 0);
    const cases = [
      ['setup', '--project'],
      ['setup', '--agent-scope', 'global'],
      ['setup', '--skip-initial-source-ingest'],
    ];

    for (const args of cases) {
      const testIo = makeIo();
      await expect(runKtxCli(['--project-dir', tempDir, ...args], testIo.io, { setup })).resolves.toBe(1);
      expect(testIo.stderr()).toMatch(/unknown option|error:/i);
    }

    expect(setup).not.toHaveBeenCalled();
  });

  it('prints ingest help without invoking ingest execution', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn();

    await expect(runKtxCli(['ingest', '--help'], testIo.io, { publicIngest })).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx ingest');
    expect(testIo.stdout()).toContain('Build or inspect KTX context');
    expect(testIo.stdout()).toContain('--all');
    expect(testIo.stdout()).toContain('--fast');
    expect(testIo.stdout()).toContain('--deep');
    expect(testIo.stdout()).toContain('--query-history');
    expect(testIo.stdout()).toContain('--no-query-history');
    expect(testIo.stdout()).toContain('--query-history-window-days <days>');
    expect(testIo.stdout()).toContain('text');
    expect(testIo.stdout()).not.toMatch(/^  status\s/m);
    expect(testIo.stdout()).not.toMatch(/^  replay\s/m);
    expect(testIo.stdout()).not.toMatch(/^  run\s/m);
    expect(testIo.stdout()).not.toMatch(/^  watch\s/m);
    expect(testIo.stdout()).not.toContain('--manifest');
    expect(testIo.stderr()).toBe('');
    expect(publicIngest).not.toHaveBeenCalled();
  });

  it('routes text memory ingest through Commander without exposing chat ids', async () => {
    const textIngest = vi.fn(async () => 0);
    const testIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'ingest',
          'text',
          '--text',
          'Revenue means gross receipts.',
          '--text',
          'Orders are completed purchases.',
          '--connection-id',
          'warehouse',
          '--user-id',
          'agent',
          '--json',
          '--fail-fast',
        ],
        testIo.io,
        { textIngest },
      ),
    ).resolves.toBe(0);

    expect(textIngest).toHaveBeenCalledWith(
      {
        projectDir: tempDir,
        texts: ['Revenue means gross receipts.', 'Orders are completed purchases.'],
        files: [],
        connectionId: 'warehouse',
        userId: 'agent',
        json: true,
        failFast: true,
      },
      testIo.io,
    );
    expect(testIo.stderr()).toBe('');
  });

  it('documents text ingest inputs without a manifest option', async () => {
    const textIngest = vi.fn(async () => 0);
    const testIo = makeIo();

    await expect(runKtxCli(['ingest', 'text', '--help'], testIo.io, { textIngest })).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx ingest text [options] [files...]');
    expect(testIo.stdout()).toContain('--text <content>');
    expect(testIo.stdout()).toContain('--connection-id <connectionId>');
    expect(testIo.stdout()).toContain('--user-id <id>');
    expect(testIo.stdout()).toContain('--fail-fast');
    expect(testIo.stdout()).not.toContain('--manifest');
    expect(textIngest).not.toHaveBeenCalled();
  });

  it('rejects old adapter-backed ingest flags at the top level and under dev', async () => {
    const rootRunIo = makeIo();
    const devRunIo = makeIo();
    const publicIngest = vi.fn(async () => 0);

    await expect(
      runKtxCli(['ingest', 'run', '--connection-id', 'warehouse', '--adapter', 'metabase'], rootRunIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(1);
    await expect(
      runKtxCli(['dev', 'ingest', 'run', '--connection-id', 'warehouse', '--adapter', 'metabase'], devRunIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(1);
    expect(publicIngest).not.toHaveBeenCalled();
    expect(rootRunIo.stderr()).toMatch(/unknown option '--connection-id'|error:/);
    expect(devRunIo.stderr()).toMatch(/unknown command|error:/);
  });

  it('rejects removed dev doctor and removed ingest parser cases', async () => {
    const doctor = vi.fn(async () => 0);
    const doctorIo = makeIo();
    const ingestRunIo = makeIo();

    await expect(runKtxCli(['dev', 'doctor', 'setup', '--json', '--no-input'], doctorIo.io, { doctor })).resolves.toBe(1);
    await expect(
      runKtxCli(
        [
          'ingest',
          'run',
          '--project-dir',
          tempDir,
          '--connection-id',
          'warehouse',
          '--adapter',
          'fake',
          '--source-dir',
          tempDir,
          '--debug-llm-request-file',
          `${tempDir}/debug.jsonl`,
          '--json',
          '--no-input',
        ],
        ingestRunIo.io,
        {},
      ),
    ).resolves.toBe(1);

    expect(doctor).not.toHaveBeenCalled();
    expect(doctorIo.stderr()).toMatch(/unknown command|error:/);
    expect(ingestRunIo.stderr()).toMatch(/unknown option '--connection-id'|error:/);
  });

  it('dispatches public connection through the existing connection implementation', async () => {
    const testIo = makeIo();
    const connection = vi.fn(async () => 0);

    await expect(runKtxCli(['--project-dir', tempDir, 'connection', 'list'], testIo.io, { connection })).resolves.toBe(
      0,
    );

    expect(connection).toHaveBeenCalledWith({ command: 'list', projectDir: tempDir }, testIo.io);
    expect(testIo.stderr()).toBe(`Project: ${tempDir}\n`);
  });

  it('routes top-level status through doctor', async () => {
    const setup = vi.fn(async () => 0);
    const doctor = vi.fn(async () => 0);
    const statusIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', tempDir, 'status', '--json', '--no-input'], statusIo.io, { setup, doctor }),
    ).resolves.toBe(0);

    expect(setup).not.toHaveBeenCalled();
    expect(doctor).toHaveBeenCalledWith(
      { command: 'project', projectDir: tempDir, outputMode: 'json', inputMode: 'disabled', verbose: false },
      statusIo.io,
    );
    expect(statusIo.stderr()).toBe('');
  });

  it('routes top-level status without a project to setup doctor checks', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const originalCwd = process.cwd();
    const previousProjectDir = process.env.KTX_PROJECT_DIR;
    const tempCwd = await mkdtemp(join(tmpdir(), 'ktx-status-no-project-'));
    const doctor = vi.fn(async () => 0);
    const statusIo = makeIo();

    try {
      delete process.env.KTX_PROJECT_DIR;
      process.chdir(tempCwd);

      await expect(runKtxCli(['status', '--json', '--no-input'], statusIo.io, { doctor })).resolves.toBe(0);

      expect(doctor).toHaveBeenCalledWith(
        { command: 'setup', outputMode: 'json', inputMode: 'disabled', verbose: false },
        statusIo.io,
      );
      expect(statusIo.stderr()).toBe('');
    } finally {
      process.chdir(originalCwd);
      if (previousProjectDir === undefined) {
        delete process.env.KTX_PROJECT_DIR;
      } else {
        process.env.KTX_PROJECT_DIR = previousProjectDir;
      }
      await rm(tempCwd, { recursive: true, force: true });
    }
  });

  it('dispatches Anthropic setup flags to the setup runner', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--no-input',
          '--anthropic-api-key-env',
          'ANTHROPIC_API_KEY',
          '--anthropic-model',
          'claude-sonnet-4-6',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.1.0-rc.1',
        anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
        anthropicModel: 'claude-sonnet-4-6',
        skipLlm: false,
      }),
      setupIo.io,
    );
  });

  it('dispatches Vertex AI setup flags to the setup runner', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--no-input',
          '--llm-backend',
          'vertex',
          '--vertex-project',
          'local-gcp-project',
          '--vertex-location',
          'us-east5',
          '--anthropic-model',
          'claude-sonnet-4-6',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.1.0-rc.1',
        llmBackend: 'vertex',
        vertexProject: 'local-gcp-project',
        vertexLocation: 'us-east5',
        anthropicModel: 'claude-sonnet-4-6',
        skipLlm: false,
      }),
      setupIo.io,
    );
  });

  it('dispatches the provider-neutral LLM model setup flag to the setup runner', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--no-input',
          '--llm-backend',
          'claude-code',
          '--llm-model',
          'opus',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.1.0-rc.1',
        llmBackend: 'claude-code',
        llmModel: 'opus',
        skipLlm: false,
      }),
      setupIo.io,
    );
  });

  it('rejects conflicting Anthropic credential setup flags', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--anthropic-api-key-env',
          'ANTHROPIC_API_KEY',
          '--anthropic-api-key-file',
          '/tmp/anthropic-key',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(setupIo.stderr()).toContain('Choose only one Anthropic credential source');
  });

  it('dispatches embedding setup flags to the setup runner', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--no-input',
          '--skip-llm',
          '--embedding-backend',
          'openai',
          '--embedding-api-key-env',
          'OPENAI_API_KEY',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: tempDir,
        inputMode: 'disabled',
        skipLlm: true,
        embeddingBackend: 'openai',
        embeddingApiKeyEnv: 'OPENAI_API_KEY', // pragma: allowlist secret
        skipEmbeddings: false,
      }),
      setupIo.io,
    );
  });

  it('dispatches database setup flags to the setup runner', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          'setup',
          '--project-dir',
          '/tmp/project',
          '--no-input',
          '--yes',
          '--skip-llm',
          '--skip-embeddings',
          '--database',
          'postgres',
          '--new-database-connection-id',
          'warehouse',
          '--database-url',
          'env:DATABASE_URL',
          '--database-schema',
          'public',
          '--enable-query-history',
          '--query-history-window-days',
          '30',
          '--query-history-min-executions',
          '12',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: '/tmp/project',
        inputMode: 'disabled',
        yes: true,
        cliVersion: '0.1.0-rc.1',
        skipLlm: true,
        skipEmbeddings: true,
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        enableQueryHistory: true,
        queryHistoryWindowDays: 30,
        queryHistoryMinExecutions: 12,
        skipDatabases: false,
      }),
      setupIo.io,
    );
  });

  it('dispatches setup database connection ids that match former ingest subcommand names', async () => {
    const testIo = makeIo();
    const setup = vi.fn(async () => 0);

    await expect(
      runKtxCli(['setup', '--new-database-connection-id', 'status', '--no-input'], testIo.io, { setup }),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        databaseConnectionId: 'status',
      }),
      testIo.io,
    );
  });

  it('dispatches setup source flags', async () => {
    const setup = vi.fn(async () => 0);
    const testIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--no-input',
          '--source',
          'metabase',
          '--source-connection-id',
          'prod_metabase',
          '--source-url',
          'https://metabase.example.com',
          '--source-api-key-ref',
          'env:METABASE_API_KEY',
          '--source-warehouse-connection-id',
          'warehouse',
          '--metabase-database-id',
          '1',
          '--skip-llm',
          '--skip-embeddings',
          '--skip-databases',
        ],
        testIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: tempDir,
        source: 'metabase',
        sourceConnectionId: 'prod_metabase',
        sourceUrl: 'https://metabase.example.com',
        sourceApiKeyRef: 'env:METABASE_API_KEY', // pragma: allowlist secret
        sourceWarehouseConnectionId: 'warehouse',
        metabaseDatabaseId: 1,
      }),
      testIo.io,
    );
  });

  it('dispatches setup agent flags', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--agents',
          '--target',
          'codex',
          '--no-input',
          '--yes',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        agents: true,
        target: 'codex',
        agentScope: 'project',
        inputMode: 'disabled',
        yes: true,
      }),
      setupIo.io,
    );
  });

  it('rejects --local with non-Claude targets', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'setup', '--agents', '--target', 'cursor', '--local', '--no-input'],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(1);

    expect(setupIo.stderr()).toContain('--local is only supported with --target claude-code');
    expect(setup).not.toHaveBeenCalled();
  });

  it('rejects --local and --global together', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'setup', '--agents', '--target', 'claude-code', '--local', '--global', '--no-input'],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(1);

    expect(setupIo.stderr()).toContain('Choose only one agent scope: --local or --global.');
    expect(setup).not.toHaveBeenCalled();
  });

  it('rejects source-path with source-git-url', async () => {
    const setup = vi.fn(async () => 0);
    const testIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--no-input',
          '--source',
          'dbt',
          '--source-path',
          '/repo/dbt',
          '--source-git-url',
          'https://github.com/acme/dbt.git',
        ],
        testIo.io,
        { setup },
      ),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(testIo.stderr()).toContain('Choose only one source location');
  });

  it('rejects deterministic as a setup embedding backend', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', tempDir, 'setup', '--embedding-backend', 'deterministic'], setupIo.io, { setup }),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(setupIo.stderr()).toContain("invalid choice 'deterministic'");
  });

  it('rejects gateway as a setup embedding backend', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', tempDir, 'setup', '--embedding-backend', 'gateway'], setupIo.io, { setup }),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(setupIo.stderr()).toContain("invalid choice 'gateway'");
  });

  it('rejects conflicting embedding credential setup flags', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--embedding-backend',
          'openai',
          '--embedding-api-key-env',
          'OPENAI_API_KEY',
          '--embedding-api-key-file',
          '/tmp/openai-key',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(setupIo.stderr()).toContain('Choose only one embedding credential source');
  });

  it('rejects conflicting query-history setup flags', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', tempDir, 'setup', '--enable-query-history', '--disable-query-history'], setupIo.io, {
        setup,
      }),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(setupIo.stderr()).toContain(
      'Choose only one query-history action: --enable-query-history or --disable-query-history.',
    );
  });

  it('rejects the removed hidden agent command', async () => {
    const io = makeIo();

    await expect(runKtxCli(['agent'], io.io)).resolves.toBe(1);

    expect(io.stderr()).toContain("unknown command 'agent'");
    expect(io.stdout()).toBe('');
  });

  it('routes public SL query files with managed runtime policies', async () => {
    const autoIo = makeIo();
    const neverIo = makeIo();
    const conflictIo = makeIo();
    const sl = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'sl',
          'query',
          '--connection-id',
          'warehouse',
          '--query-file',
          '/tmp/query.json',
          '--yes',
        ],
        autoIo.io,
        { sl },
      ),
    ).resolves.toBe(0);

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'sl',
          'query',
          '--connection-id',
          'warehouse',
          '--query-file',
          '/tmp/query.json',
          '--no-input',
        ],
        neverIo.io,
        { sl },
      ),
    ).resolves.toBe(0);

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'sl',
          'query',
          '--connection-id',
          'warehouse',
          '--query-file',
          '/tmp/query.json',
          '--yes',
          '--no-input',
        ],
        conflictIo.io,
        { sl },
      ),
    ).resolves.toBe(1);

    expect(sl).toHaveBeenNthCalledWith(
      1,
      {
        command: 'query',
        projectDir: tempDir,
        connectionId: 'warehouse',
        queryFile: '/tmp/query.json',
        execute: false,
        format: 'json',
        cliVersion: '0.1.0-rc.1',
        runtimeInstallPolicy: 'auto',
      },
      autoIo.io,
    );
    expect(sl).toHaveBeenNthCalledWith(
      2,
      {
        command: 'query',
        projectDir: tempDir,
        connectionId: 'warehouse',
        queryFile: '/tmp/query.json',
        execute: false,
        format: 'json',
        cliVersion: '0.1.0-rc.1',
        runtimeInstallPolicy: 'never',
      },
      neverIo.io,
    );
    expect(conflictIo.stderr()).toContain('Choose only one runtime install mode: --yes or --no-input');
  });

  it('dispatches public connection subcommands through the existing connection implementation', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-connection-dispatch-'));
    await writeFile(join(tempDir, 'ktx.yaml'), '{}\n', 'utf-8');
    const connection = vi.fn(async () => 0);

    await expect(
      runKtxCli(['--project-dir', tempDir, 'connection', 'list'], makeIo().io, { connection }),
    ).resolves.toBe(0);

    const testIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, 'connection', 'test', 'warehouse'], testIo.io, {
        connection,
      }),
    ).resolves.toBe(0);

    expect(connection).toHaveBeenNthCalledWith(1, { command: 'list', projectDir: tempDir }, expect.anything());
    expect(connection).toHaveBeenNthCalledWith(
      2,
      {
        command: 'test',
        projectDir: tempDir,
        connectionId: 'warehouse',
      },
      expect.anything(),
    );

    await rm(tempDir, { recursive: true, force: true });
  });

  it('prints only list and test in connection help', async () => {
    const helpIo = makeIo();

    await expect(runKtxCli(['connection', '--help'], helpIo.io)).resolves.toBe(0);

    expect(helpIo.stdout()).toContain('Usage: ktx connection');
    expect(helpIo.stdout()).toContain('list');
    expect(helpIo.stdout()).toContain('test [options] [connectionId]');
    for (const removed of ['add', 'remove', 'map', 'mapping', 'metabase', 'notion']) {
      expect(helpIo.stdout()).not.toMatch(new RegExp(`\\b${removed}\\b`));
    }
    expect(helpIo.stderr()).toBe('');
  });

  it('rejects removed connection subcommands', async () => {
    for (const argv of [
      ['connection', 'add', 'postgres', 'warehouse'],
      ['connection', 'remove', 'warehouse'],
      ['connection', 'map', 'prod-metabase'],
      ['connection', 'mapping'],
      ['connection', 'metabase'],
      ['connection', 'notion'],
    ]) {
      const testIo = makeIo();

      await expect(runKtxCli(argv, testIo.io)).resolves.toBe(1);

      expect(testIo.stderr()).toMatch(/unknown command|error:/);
    }
  });

  it('rejects commands removed from the May 6 root surface', async () => {
    for (const argv of [
      ['init'],
      ['connect', 'list'],
      ['knowledge', 'list'],
      ['ask', 'What sources are connected?'],
    ]) {
      const testIo = makeIo();

      await expect(runKtxCli(argv, testIo.io)).resolves.toBe(1);

      expect(testIo.stderr()).toMatch(/unknown command|error:/);
    }
  });

  it('writes basic debug dispatch information when --debug is set', async () => {
    const testIo = makeIo();
    const connection = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', tempDir, '--debug', 'connection', 'list'], testIo.io, { connection }),
    ).resolves.toBe(0);

    expect(testIo.stderr()).toContain(`[debug] projectDir=${tempDir}`);
    expect(testIo.stderr()).toContain('[debug] dispatch=connection');
  });

  it.each([
    { argv: ['scan'] },
    { argv: ['scan', '--help'] },
    { argv: ['scan', 'warehouse'] },
    { argv: ['scan', 'warehouse', '--project-dir', '/tmp/project'] },
    { argv: ['scan', 'warehouse', '--mode', 'relationships'] },
  ])('rejects removed top-level scan command $argv', async ({ argv }) => {
    const testIo = makeIo();
    const publicIngest = vi.fn().mockResolvedValue(0);

    await expect(runKtxCli(argv, testIo.io, { publicIngest })).resolves.toBe(1);

    expect(testIo.stderr()).toMatch(/unknown command|error:/);
    expect(publicIngest).not.toHaveBeenCalled();
  });

  it('rejects removed public serve command options before dispatch', async () => {
    const serveIo = makeIo();

    await expect(
      runKtxCli(
        [
          'serve',
          '--mcp',
          'stdio',
          '--project-dir',
          tempDir,
          '--semantic-compute-url',
          'http://127.0.0.1:18080',
          '--execute-queries',
          '--memory-capture',
          '--memory-model',
          'openai/gpt-5.2',
        ],
        serveIo.io,
      ),
    ).resolves.toBe(1);

    expect(serveIo.stderr()).toMatch(/unknown command|error:/);
  });

  it('prints dev help for bare dev commands', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['dev'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx dev [options] [command]');
    expect(testIo.stdout()).toContain('Low-level project initialization');
    expect(testIo.stdout()).toContain('init');
    expect(testIo.stdout()).toContain('runtime');
    expect(testIo.stdout()).not.toContain('scan');
    expect(testIo.stdout()).not.toContain('ingest');
    expect(testIo.stdout()).not.toContain('mapping');
    expect(testIo.stdout()).not.toContain('model');
    expect(testIo.stdout()).not.toContain('knowledge');
    expect(testIo.stderr()).toBe('');
  });

  it('rejects removed dev command groups without invoking execution', async () => {
    for (const command of ['scan', 'ingest', 'mapping']) {
      const testIo = makeIo();
      const publicIngest = vi.fn().mockResolvedValue(0);
      const sl = vi.fn().mockResolvedValue(0);

      await expect(runKtxCli(['dev', command], testIo.io, { publicIngest, sl })).resolves.toBe(1);

      expect(testIo.stderr()).toMatch(/unknown command|error:/);
      expect(publicIngest).not.toHaveBeenCalled();
      expect(sl).not.toHaveBeenCalled();
    }
  });

  it('rejects removed reserved dev subcommands', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['dev', 'artifacts'], testIo.io)).resolves.toBe(1);

    expect(testIo.stderr()).toMatch(/unknown command|error:/);
  });

  it('rejects mutually exclusive public ingest output modes before invoking runners', async () => {
    const publicIngest = vi.fn(async () => 0);

    const testIo = makeIo();
    await expect(runKtxCli(['ingest', 'warehouse', '--json', '--plain'], testIo.io, { publicIngest })).resolves.toBe(
      1,
    );

    expect(testIo.stderr()).toMatch(/conflict|cannot be used/i);
    expect(publicIngest).not.toHaveBeenCalled();
  });

  it('does not expose root init after setup owns project creation', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['init'], testIo.io)).resolves.toBe(1);

    expect(testIo.stderr()).toContain("error: unknown command 'init'");
  });

  it('returns an error code for unknown commands', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['unknown'], testIo.io)).resolves.toBe(1);

    expect(testIo.stderr()).toContain("error: unknown command 'unknown'");
  });
});
