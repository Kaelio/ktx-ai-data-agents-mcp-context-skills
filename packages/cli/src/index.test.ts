import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      version: '0.0.0-private',
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
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('prints version information', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['--version'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toBe('@ktx/cli 0.0.0-private\n');
    expect(testIo.stderr()).toBe('');
  });

  it('prints the public command surface in root help', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['--help'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx [options] [command]');
    for (const command of ['setup', 'connection', 'ingest', 'wiki', 'sl', 'status']) {
      expect(testIo.stdout()).toContain(`${command}`);
    }
    for (const removed of ['demo', 'init', 'connect', 'scan', 'ask', 'knowledge', 'agent', 'completion', 'runtime', 'serve']) {
      expect(testIo.stdout()).not.toContain(`${removed} [`);
      expect(testIo.stdout()).not.toContain(`${removed} `);
    }
    expect(testIo.stdout()).toContain('--project-dir <path>');
    expect(testIo.stdout()).toContain('KTX_PROJECT_DIR');
    expect(testIo.stdout()).toContain('--debug');
    expect(testIo.stdout()).not.toContain('--' + 'verbose');
    expect(testIo.stdout()).toContain('Advanced:');
    expect(testIo.stdout()).toContain('ktx dev');
    expect(testIo.stderr()).toBe('');
  });

  it('routes runtime management commands with the CLI package version', async () => {
    const runtime = vi.fn(async () => 0);
    const installIo = makeIo();
    const startIo = makeIo();
    const stopIo = makeIo();
    const stopAllIo = makeIo();
    const statusIo = makeIo();
    const doctorIo = makeIo();
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
    await expect(runKtxCli(['dev', 'runtime', 'doctor'], doctorIo.io, { runtime })).resolves.toBe(0);
    await expect(runKtxCli(['dev', 'runtime', 'prune', '--dry-run'], pruneIo.io, { runtime })).resolves.toBe(0);

    expect(runtime).toHaveBeenNthCalledWith(
      1,
      {
        command: 'install',
        cliVersion: '0.0.0-private',
        feature: 'local-embeddings',
        force: true,
      },
      installIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      2,
      {
        command: 'start',
        cliVersion: '0.0.0-private',
        feature: 'local-embeddings',
        force: true,
      },
      startIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      3,
      {
        command: 'stop',
        cliVersion: '0.0.0-private',
        all: false,
      },
      stopIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      4,
      {
        command: 'stop',
        cliVersion: '0.0.0-private',
        all: true,
      },
      stopAllIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      5,
      {
        command: 'status',
        cliVersion: '0.0.0-private',
        json: true,
      },
      statusIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      6,
      {
        command: 'doctor',
        cliVersion: '0.0.0-private',
        json: false,
      },
      doctorIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      7,
      {
        command: 'prune',
        cliVersion: '0.0.0-private',
        dryRun: true,
        yes: false,
      },
      pruneIo.io,
    );
    for (const io of [installIo, startIo, stopIo, stopAllIo, statusIo, doctorIo, pruneIo]) {
      expect(io.stderr()).toBe('');
    }
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

  it('skips the project directory line for JSON and TUI output modes', async () => {
    const publicIngest = vi.fn(async () => 0);
    const ingest = vi.fn(async () => 0);
    const jsonIo = makeIo();
    const vizIo = makeIo({ stdoutIsTty: true });

    await expect(runKtxCli(['--project-dir', tempDir, 'ingest', '--all', '--json'], jsonIo.io, { publicIngest }))
      .resolves.toBe(0);
    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'dev', 'ingest', 'status', 'run-1', '--viz'],
        vizIo.io,
        { ingest },
      ),
    ).resolves.toBe(0);

    expect(jsonIo.stderr()).toBe('');
    expect(vizIo.stderr()).toBe('');
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
        cliVersion: '0.0.0-private',
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
        cliVersion: '0.0.0-private',
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
        cliVersion: '0.0.0-private',
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

  it('documents setup as a bare command without subcommands', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['setup', '--help'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx setup [options]');
    expect(testIo.stdout()).not.toContain('Commands:');
    expect(testIo.stdout()).not.toContain('setup demo');
    expect(testIo.stdout()).not.toContain('setup context');
    expect(testIo.stdout()).not.toContain('--skip-llm');
    expect(testIo.stdout()).not.toContain('--skip-embeddings');
    expect(testIo.stdout()).not.toContain('--embedding-model');
    expect(testIo.stdout()).not.toContain('--embedding-dimensions');
    expect(testIo.stdout()).not.toContain('--embedding-base-url');
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
    await initKtxProject({ projectDir, projectName: 'warehouse' });
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
          cliVersion: '0.0.0-private',
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
      await writeFile(join(tempDir, 'ktx.yaml'), 'project: revenue\nconnections: {}\n', 'utf-8');
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

  it('prints a zsh completion function', async () => {
    const testIo = makeIo();
    const zshWords = '$' + '{words[@]}';

    await expect(runKtxCli(['dev', 'completion', 'zsh'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toContain('#compdef ktx');
    expect(testIo.stdout()).toContain('KTX_COMPLETION_COMMAND:-ktx');
    expect(testIo.stdout()).toContain(`dev __complete --shell zsh --position "$CURRENT" -- "${zshWords}"`);
    expect(testIo.stdout()).toContain('compdef _ktx ktx');
    expect(testIo.stderr()).toBe('');
  });

  it('installs zsh completions into the user zsh config directory', async () => {
    const testIo = makeIo();
    const previousHome = process.env.HOME;
    const previousZdotdir = process.env.ZDOTDIR;
    const tempHome = await mkdtemp(join(tmpdir(), 'ktx-completion-home-'));

    try {
      process.env.HOME = tempHome;
      delete process.env.ZDOTDIR;

      await expect(runKtxCli(['dev', 'completion', 'zsh', '--install'], testIo.io)).resolves.toBe(0);

      const completionFile = await readFile(join(tempHome, '.zfunc', '_ktx'), 'utf-8');
      const zshrc = await readFile(join(tempHome, '.zshrc'), 'utf-8');
      expect(completionFile).toContain('#compdef ktx');
      expect(zshrc).toContain('# >>> ktx completion >>>');
      expect(zshrc).toContain('_ktx_completion_command()');
      expect(zshrc).toContain('"name": "ktx-workspace"');
      expect(zshrc).toContain('scripts/run-ktx.mjs');
      expect(zshrc).toContain("export KTX_COMPLETION_COMMAND='$(_ktx_completion_command)'");
      expect(zshrc).toContain('setopt complete_aliases');
      expect(zshrc).toContain('fpath=("$HOME/.zfunc" $fpath)');
      expect(zshrc).toContain('autoload -Uz compinit');
      expect(zshrc).toContain('compinit');
      expect(testIo.stdout()).toContain('Installed zsh completion:');
      expect(testIo.stdout()).toContain('Restart your shell or run: source ~/.zshrc');
      expect(testIo.stderr()).toBe('');
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR;
      } else {
        process.env.ZDOTDIR = previousZdotdir;
      }
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('updates zsh completion install block idempotently before existing compinit', async () => {
    const firstIo = makeIo();
    const secondIo = makeIo();
    const previousHome = process.env.HOME;
    const previousZdotdir = process.env.ZDOTDIR;
    const tempHome = await mkdtemp(join(tmpdir(), 'ktx-completion-home-'));

    try {
      process.env.HOME = tempHome;
      delete process.env.ZDOTDIR;
      await writeFile(join(tempHome, '.zshrc'), 'export EDITOR=vim\nautoload -Uz compinit\ncompinit\n', 'utf-8');

      await expect(runKtxCli(['dev', 'completion', 'zsh', '--install'], firstIo.io)).resolves.toBe(0);
      await expect(runKtxCli(['dev', 'completion', 'zsh', '--install'], secondIo.io)).resolves.toBe(0);

      const zshrc = await readFile(join(tempHome, '.zshrc'), 'utf-8');
      expect(zshrc.match(/# >>> ktx completion >>>/g)).toHaveLength(1);
      expect(zshrc.indexOf('fpath=("$HOME/.zfunc" $fpath)')).toBeLessThan(zshrc.indexOf('autoload -Uz compinit'));
      expect(zshrc.match(/_ktx_completion_command\(\)/g)).toHaveLength(1);
      expect(zshrc.match(/^compinit$/gm)).toHaveLength(1);
      expect(secondIo.stdout()).toContain('Updated zsh config:');
      expect(firstIo.stderr()).toBe('');
      expect(secondIo.stderr()).toBe('');
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR;
      } else {
        process.env.ZDOTDIR = previousZdotdir;
      }
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('completes root and nested Commander command names', async () => {
    const rootIo = makeIo();
    const connectionIo = makeIo();

    await expect(
      runKtxCli(['dev', '__complete', '--shell', 'zsh', '--position', '2', '--', 'ktx', 'co'], rootIo.io),
    ).resolves.toBe(0);
    await expect(
      runKtxCli(
        ['dev', '__complete', '--shell', 'zsh', '--position', '3', '--', 'ktx', 'connection', 'm'],
        connectionIo.io,
      ),
    ).resolves.toBe(0);

    expect(rootIo.stdout()).toContain('connection:Add, list, test, and map data sources');
    expect(rootIo.stdout()).not.toContain('__complete');
    expect(connectionIo.stdout()).toContain('map:Refresh and validate BI-to-warehouse mappings');
    expect(connectionIo.stdout()).toContain('mapping:Manage Metabase warehouse mappings');
    expect(rootIo.stderr()).toBe('');
    expect(connectionIo.stderr()).toBe('');
  });

  it('completes options and Commander choices', async () => {
    const optionIo = makeIo();
    const choiceIo = makeIo();

    await expect(
      runKtxCli(
        ['dev', '__complete', '--shell', 'zsh', '--position', '4', '--', 'ktx', 'connection', 'add', '--cr'],
        optionIo.io,
      ),
    ).resolves.toBe(0);
    await expect(
      runKtxCli(
        [
          'dev',
          '__complete',
          '--shell',
          'zsh',
          '--position',
          '7',
          '--',
          'ktx',
          'connection',
          'add',
          'notion',
          'docs',
          '--crawl-mode',
          '',
        ],
        choiceIo.io,
      ),
    ).resolves.toBe(0);

    expect(optionIo.stdout()).toContain('--crawl-mode:Notion crawl mode');
    expect(choiceIo.stdout()).toContain('all_accessible');
    expect(choiceIo.stdout()).toContain('selected_roots');
    expect(optionIo.stderr()).toBe('');
    expect(choiceIo.stderr()).toBe('');
  });

  it('rejects removed serve commands', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['--project-dir', tempDir, 'serve', '--mcp', 'stdio', '--user-id', 'agent'], testIo.io))
      .resolves.toBe(1);

    expect(testIo.stderr()).toMatch(/unknown command|error:/);
  });

  it('routes public ingest through the public ingest parser', async () => {
    const testIo = makeIo();
    const ingest = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', '/tmp/project', 'ingest', 'warehouse'], testIo.io, { publicIngest: ingest }),
    ).resolves.toBe(0);

    expect(ingest).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: '/tmp/project',
        targetConnectionId: 'warehouse',
        all: false,
        json: false,
        inputMode: 'auto',
      },
      testIo.io,
    );
  });

  it('prints public ingest watch help from Commander', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn(async () => 0);
    const lowLevelIngest = vi.fn(async () => 0);

    await expect(
      runKtxCli(['ingest', 'watch', '--help'], testIo.io, { publicIngest, ingest: lowLevelIngest }),
    ).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx ingest watch [options] [runId]');
    expect(testIo.stdout()).toContain('[runId]');
    expect(testIo.stdout()).toContain('--project-dir <path>');
    expect(testIo.stdout()).toContain('--json');
    expect(testIo.stdout()).toContain('--no-input');
    expect(testIo.stderr()).toBe('');
    expect(publicIngest).not.toHaveBeenCalled();
    expect(lowLevelIngest).not.toHaveBeenCalled();
  });

  it('dispatches public ingest status and watch through Commander', async () => {
    const statusIo = makeIo();
    const watchIo = makeIo();
    const publicIngest = vi.fn(async () => 0);

    await expect(
      runKtxCli(['--project-dir', tempDir, 'ingest', 'status', 'run-1', '--json', '--no-input'], statusIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(0);
    await expect(
      runKtxCli(['--project-dir', tempDir, 'ingest', 'watch', '--no-input'], watchIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(0);

    expect(publicIngest).toHaveBeenNthCalledWith(
      1,
      {
        command: 'status',
        projectDir: tempDir,
        runId: 'run-1',
        json: true,
        inputMode: 'disabled',
      },
      statusIo.io,
    );
    expect(publicIngest).toHaveBeenNthCalledWith(
      2,
      {
        command: 'watch',
        projectDir: tempDir,
        json: false,
        inputMode: 'disabled',
      },
      watchIo.io,
    );
    expect(statusIo.stderr()).toBe('');
    expect(watchIo.stderr()).toBe('');
  });

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

  it('prints public ingest help without invoking ingest execution', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn();
    const lowLevelIngest = vi.fn();

    await expect(runKtxCli(['ingest', '--help'], testIo.io, { publicIngest, ingest: lowLevelIngest })).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx ingest [options] [connectionId]');
    expect(testIo.stdout()).toContain('Build and refresh KTX context from configured sources');
    expect(testIo.stdout()).toContain('status');
    expect(testIo.stdout()).toContain('watch');
    expect(testIo.stdout()).toContain('ktx ingest --all [options]');
    expect(testIo.stdout()).toContain('ktx ingest status [runId] [options]');
    expect(testIo.stdout()).toContain('ktx ingest watch [runId] [options]');
    expect(testIo.stdout()).not.toContain('ktx ingest replay <runId> [options]');
    expect(testIo.stdout()).toContain('--no-input');
    expect(testIo.stdout()).not.toContain('--adapter');
    expect(testIo.stderr()).toBe('');
    expect(publicIngest).not.toHaveBeenCalled();
    expect(lowLevelIngest).not.toHaveBeenCalled();
  });

  it('reserves public ingest run while keeping dev ingest run available', async () => {
    const publicRunIo = makeIo();
    const publicHelpIo = makeIo();
    const devRunIo = makeIo();
    const publicIngest = vi.fn(async () => 0);
    const lowLevelIngest = vi.fn(async () => 0);

    await expect(runKtxCli(['ingest', 'run'], publicRunIo.io, { publicIngest, ingest: lowLevelIngest })).resolves.toBe(
      1,
    );
    expect(publicRunIo.stderr()).toMatch(/invalid argument|reserved|run/i);
    expect(publicIngest).not.toHaveBeenCalled();

    await expect(
      runKtxCli(['ingest', 'run', '--help'], publicHelpIo.io, { publicIngest, ingest: lowLevelIngest }),
    ).resolves.toBe(0);
    expect(publicHelpIo.stdout()).toContain('Usage: ktx ingest [options] [connectionId]');
    expect(publicHelpIo.stdout()).not.toContain('Usage: ktx ingest ' + 'run');

    await expect(
      runKtxCli(['dev', 'ingest', 'run', '--connection-id', 'warehouse', '--adapter', 'metabase'], devRunIo.io, {
        publicIngest,
        ingest: lowLevelIngest,
      }),
    ).resolves.toBe(0);
    expect(lowLevelIngest).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'run', connectionId: 'warehouse', adapter: 'metabase' }),
      expect.anything(),
    );
  });

  it('rejects removed dev doctor while keeping ingest parser cases under dev', async () => {
    const doctor = vi.fn(async () => 0);
    const ingest = vi.fn(async () => 0);
    const doctorIo = makeIo();
    const ingestRunIo = makeIo();
    const ingestReplayHelpIo = makeIo();

    await expect(runKtxCli(['dev', 'doctor', 'setup', '--json', '--no-input'], doctorIo.io, { doctor })).resolves.toBe(1);
    await expect(
      runKtxCli(
        [
          'dev',
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
        { ingest },
      ),
    ).resolves.toBe(0);
    await expect(runKtxCli(['dev', 'ingest', 'replay', '--help'], ingestReplayHelpIo.io, { ingest })).resolves.toBe(0);

    expect(doctor).not.toHaveBeenCalled();
    expect(ingest).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: tempDir,
        connectionId: 'warehouse',
        adapter: 'fake',
        sourceDir: tempDir,
        databaseIntrospectionUrl: undefined,
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'prompt',
        debugLlmRequestFile: `${tempDir}/debug.jsonl`,
        outputMode: 'json',
        inputMode: 'disabled',
      },
      ingestRunIo.io,
    );
    expect(ingestReplayHelpIo.stdout()).toContain('Usage: ktx dev ingest replay [options] <runId>');
    expect(ingestReplayHelpIo.stdout()).toContain('<runId>');
    expect(doctorIo.stderr()).toMatch(/unknown command|error:/);
    expect(ingestRunIo.stderr()).toBe('');
    expect(ingestReplayHelpIo.stderr()).toBe('');
  });

  it('routes ingest managed runtime install policy separately from visualization input mode', async () => {
    const autoIo = makeIo();
    const nonInteractiveIo = makeIo();
    const ingest = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          'dev',
          'ingest',
          'run',
          '--project-dir',
          tempDir,
          '--connection-id',
          'warehouse',
          '--adapter',
          'looker',
          '--yes',
        ],
        autoIo.io,
        { ingest },
      ),
    ).resolves.toBe(0);
    await expect(
      runKtxCli(
        [
          'dev',
          'ingest',
          'run',
          '--project-dir',
          tempDir,
          '--connection-id',
          'warehouse',
          '--adapter',
          'looker',
          '--yes',
          '--no-input',
        ],
        nonInteractiveIo.io,
        { ingest },
      ),
    ).resolves.toBe(0);

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'auto',
      }),
      autoIo.io,
    );
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'auto',
        inputMode: 'disabled',
      }),
      nonInteractiveIo.io,
    );
    expect(nonInteractiveIo.stderr()).toBe(`Project: ${tempDir}\n`);
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
      { command: 'project', projectDir: tempDir, outputMode: 'json', inputMode: 'disabled' },
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
        { command: 'setup', outputMode: 'json', inputMode: 'disabled' },
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
        cliVersion: '0.0.0-private',
        anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
        anthropicModel: 'claude-sonnet-4-6',
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
          '--enable-historic-sql',
          '--historic-sql-window-days',
          '30',
          '--historic-sql-min-executions',
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
        cliVersion: '0.0.0-private',
        skipLlm: true,
        skipEmbeddings: true,
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        enableHistoricSql: true,
        historicSqlWindowDays: 30,
        historicSqlMinExecutions: 12,
        skipDatabases: false,
      }),
      setupIo.io,
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
          '--project',
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

  it('rejects conflicting Historic SQL setup flags', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', tempDir, 'setup', '--enable-historic-sql', '--disable-historic-sql'], setupIo.io, {
        setup,
      }),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(setupIo.stderr()).toContain('Choose only one Historic SQL action');
  });

  it('registers hidden agent help and tools discovery without showing agent in root help', async () => {
    const helpIo = makeIo();
    const toolsIo = makeIo();
    const agent = vi.fn(async () => 0);

    await expect(runKtxCli(['agent', '--help'], helpIo.io, { agent })).resolves.toBe(0);
    await expect(
      runKtxCli(['--project-dir', tempDir, 'agent', 'tools', '--json'], toolsIo.io, { agent }),
    ).resolves.toBe(0);

    expect(helpIo.stdout()).toContain('Usage: ktx agent');
    expect(toolsIo.stderr()).toBe('');
    expect(agent).toHaveBeenCalledWith({ command: 'tools', projectDir: tempDir, json: true }, toolsIo.io);
  });

  it('dispatches full hidden agent commands without exposing agent in root help', async () => {
    const agent = vi.fn(async () => 0);
    const cases = [
      {
        argv: ['--project-dir', tempDir, 'agent', 'context', '--json'],
        args: { command: 'context', projectDir: tempDir, json: true },
      },
      {
        argv: [
          '--project-dir',
          tempDir,
          'agent',
          'sl',
          'list',
          '--json',
          '--connection-id',
          'warehouse',
          '--query',
          'orders',
        ],
        args: { command: 'sl-list', projectDir: tempDir, json: true, connectionId: 'warehouse', query: 'orders' },
      },
      {
        argv: ['--project-dir', tempDir, 'agent', 'sl', 'read', 'orders', '--json', '--connection-id', 'warehouse'],
        args: { command: 'sl-read', projectDir: tempDir, json: true, sourceName: 'orders', connectionId: 'warehouse' },
      },
      {
        argv: [
          '--project-dir',
          tempDir,
          'agent',
          'sl',
          'query',
          '--json',
          '--connection-id',
          'warehouse',
          '--query-file',
          '/tmp/query.json',
          '--execute',
          '--max-rows',
          '100',
        ],
        args: {
          command: 'sl-query',
          projectDir: tempDir,
          json: true,
          connectionId: 'warehouse',
          queryFile: '/tmp/query.json',
          execute: true,
          maxRows: 100,
          cliVersion: '0.0.0-private',
          runtimeInstallPolicy: 'prompt',
        },
      },
      {
        argv: ['--project-dir', tempDir, 'agent', 'wiki', 'search', 'revenue', '--json', '--limit', '5'],
        args: { command: 'wiki-search', projectDir: tempDir, json: true, query: 'revenue', limit: 5 },
      },
      {
        argv: ['--project-dir', tempDir, 'agent', 'wiki', 'read', 'page-1', '--json'],
        args: { command: 'wiki-read', projectDir: tempDir, json: true, pageId: 'page-1' },
      },
      {
        argv: [
          '--project-dir',
          tempDir,
          'agent',
          'sql',
          'execute',
          '--json',
          '--connection-id',
          'warehouse',
          '--sql-file',
          '/tmp/query.sql',
          '--max-rows',
          '100',
        ],
        args: {
          command: 'sql-execute',
          projectDir: tempDir,
          json: true,
          connectionId: 'warehouse',
          sqlFile: '/tmp/query.sql',
          maxRows: 100,
        },
      },
    ];

    for (const entry of cases) {
      const io = makeIo();
      await expect(runKtxCli(entry.argv, io.io, { agent })).resolves.toBe(0);
      expect(agent).toHaveBeenLastCalledWith(entry.args, io.io);
      expect(io.stderr()).toBe('');
    }

    const helpIo = makeIo();
    await expect(runKtxCli(['--help'], helpIo.io, { agent })).resolves.toBe(0);
    expect(helpIo.stdout()).not.toContain('agent ');
  });

  it('routes hidden agent SL query managed runtime policies', async () => {
    const autoIo = makeIo();
    const neverIo = makeIo();
    const conflictIo = makeIo();
    const agent = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'agent',
          'sl',
          'query',
          '--json',
          '--connection-id',
          'warehouse',
          '--query-file',
          '/tmp/query.json',
          '--yes',
        ],
        autoIo.io,
        { agent },
      ),
    ).resolves.toBe(0);

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'agent',
          'sl',
          'query',
          '--json',
          '--connection-id',
          'warehouse',
          '--query-file',
          '/tmp/query.json',
          '--no-input',
        ],
        neverIo.io,
        { agent },
      ),
    ).resolves.toBe(0);

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'agent',
          'sl',
          'query',
          '--json',
          '--connection-id',
          'warehouse',
          '--query-file',
          '/tmp/query.json',
          '--yes',
          '--no-input',
        ],
        conflictIo.io,
        { agent },
      ),
    ).resolves.toBe(1);

    expect(agent).toHaveBeenNthCalledWith(
      1,
      {
        command: 'sl-query',
        projectDir: tempDir,
        json: true,
        connectionId: 'warehouse',
        queryFile: '/tmp/query.json',
        execute: false,
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'auto',
      },
      autoIo.io,
    );
    expect(agent).toHaveBeenNthCalledWith(
      2,
      {
        command: 'sl-query',
        projectDir: tempDir,
        json: true,
        connectionId: 'warehouse',
        queryFile: '/tmp/query.json',
        execute: false,
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'never',
      },
      neverIo.io,
    );
    expect(conflictIo.stderr()).toContain('Choose only one runtime install mode: --yes or --no-input');
  });

  it('prints semantic-layer hybrid search metadata from the hidden agent sl list command', async () => {
    const agent = vi.fn(async (args, io) => {
      expect(args).toEqual({
        command: 'sl-list',
        projectDir: tempDir,
        json: true,
        connectionId: 'warehouse',
        query: 'paid',
      });
      io.stdout.write(
        `${JSON.stringify(
          {
            sources: [
              {
                connectionId: 'warehouse',
                connectionName: 'warehouse',
                name: 'orders',
                columnCount: 2,
                measureCount: 1,
                joinCount: 0,
                score: 0.03278688524590164,
                matchReasons: ['dictionary'],
                dictionaryMatches: [{ column: 'status', values: ['paid'] }],
              },
            ],
            totalSources: 1,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    });
    const io = makeIo();

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'agent', 'sl', 'list', '--json', '--connection-id', 'warehouse', '--query', 'paid'],
        io.io,
        { agent },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toEqual({
      sources: [
        expect.objectContaining({
          connectionId: 'warehouse',
          name: 'orders',
          matchReasons: ['dictionary'],
          dictionaryMatches: [{ column: 'status', values: ['paid'] }],
        }),
      ],
      totalSources: 1,
    });
  });

  it('prints wiki hybrid search metadata from the hidden agent wiki search command', async () => {
    const agent = vi.fn(async (args, io) => {
      expect(args).toEqual({
        command: 'wiki-search',
        projectDir: tempDir,
        json: true,
        query: 'paid order',
        limit: 5,
      });
      io.stdout.write(
        `${JSON.stringify(
          {
            results: [
              {
                key: 'metrics-revenue',
                path: 'knowledge/global/metrics-revenue.md',
                scope: 'GLOBAL',
                summary: 'Revenue metric definition',
                score: 0.02459016393442623,
                matchReasons: ['lexical', 'token'],
              },
            ],
            totalFound: 1,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    });
    const io = makeIo();

    await expect(
      runKtxCli(['--project-dir', tempDir, 'agent', 'wiki', 'search', 'paid order', '--json', '--limit', '5'], io.io, {
        agent,
      }),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toEqual({
      results: [
        expect.objectContaining({
          key: 'metrics-revenue',
          path: 'knowledge/global/metrics-revenue.md',
          matchReasons: ['lexical', 'token'],
        }),
      ],
      totalFound: 1,
    });
  });

  it('dispatches public connection subcommands through the existing connection implementation', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-connection-dispatch-'));
    const connection = vi.fn(async () => 0);

    await expect(
      runKtxCli(['--project-dir', tempDir, 'connection', 'list'], makeIo().io, { connection }),
    ).resolves.toBe(0);

    const removeIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, 'connection', 'remove', 'warehouse', '--force', '--no-input'], removeIo.io, {
        connection,
      }),
    ).resolves.toBe(0);

    const mapIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, 'connection', 'map', 'prod-metabase', '--json'], mapIo.io, {
        connection,
      }),
    ).resolves.toBe(0);

    expect(connection).toHaveBeenNthCalledWith(1, { command: 'list', projectDir: tempDir }, expect.anything());
    expect(connection).toHaveBeenNthCalledWith(
      2,
      {
        command: 'remove',
        projectDir: tempDir,
        connectionId: 'warehouse',
        force: true,
        inputMode: 'disabled',
      },
      expect.anything(),
    );
    expect(connection).toHaveBeenNthCalledWith(
      3,
      {
        command: 'map',
        projectDir: tempDir,
        sourceConnectionId: 'prod-metabase',
        json: true,
      },
      expect.anything(),
    );

    await rm(tempDir, { recursive: true, force: true });
  });

  it('prints help for connection metabase setup', async () => {
    const helpIo = makeIo();

    await expect(runKtxCli(['connection', 'metabase', 'setup', '--help'], helpIo.io)).resolves.toBe(0);

    expect(helpIo.stdout()).toContain('Usage: ktx connection metabase setup');
    for (const option of [
      '--id <connectionId>',
      '--url <url>',
      '--api-key <key>',
      '--username <email>',
      '--password <password>',
      '--mint-api-key',
      '--map <metabaseDatabaseId=targetConnectionId>',
      '--sync <metabaseDatabaseId>',
      '--sync-mode <mode>',
      '--run-ingest',
      '--yes',
      '--no-input',
    ]) {
      expect(helpIo.stdout()).toContain(option);
    }
    expect(helpIo.stdout()).toContain('Guided equivalent of:');
    for (const line of [
      'ktx connection mapping refresh <connectionId> --auto-accept',
      'ktx connection mapping set <connectionId> databaseMappings <id>=<target>',
      'ktx connection mapping set-sync-enabled <connectionId> <id> --enabled true',
      'ktx ingest <connectionId>',
    ]) {
      expect(helpIo.stdout()).toContain(line);
    }
    expect(helpIo.stderr()).toBe('');
  });

  it('dispatches connection metabase setup through Commander', async () => {
    const connectionMetabaseSetup = vi.fn(async () => 0);
    const fakeMetabaseCredential = 'mb_example';
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          'connection',
          'metabase',
          'setup',
          '--project-dir',
          tempDir,
          '--id',
          'metabase',
          '--url',
          'http://metabase.example.test:3000',
          '--api-key',
          'mb_example',
          '--map',
          '2=orbit',
          '--sync',
          '2',
          '--yes',
          '--no-input',
        ],
        setupIo.io,
        { connectionMetabaseSetup },
      ),
    ).resolves.toBe(0);

    expect(connectionMetabaseSetup).toHaveBeenCalledWith(
      {
        command: 'setup',
        projectDir: tempDir,
        connectionId: 'metabase',
        url: 'http://metabase.example.test:3000',
        apiKey: fakeMetabaseCredential,
        mintApiKey: false,
        mappings: [{ metabaseDatabaseId: 2, targetConnectionId: 'orbit' }],
        syncEnabledDatabaseIds: [2],
        syncMode: 'ALL',
        runIngest: false,
        yes: true,
        inputMode: 'disabled',
      },
      expect.anything(),
    );
    expect(setupIo.stderr()).toBe(`Project: ${tempDir}\n`);
  });

  it('validates connection metabase setup option values before runner dispatch', async () => {
    const connectionMetabaseSetup = vi.fn(async () => 0);

    for (const argv of [
      [
        'connection',
        'metabase',
        'setup',
        '--project-dir',
        tempDir,
        '--url',
        'http://metabase.example.test:3000',
        '--api-key',
        'mb_example',
        '--map',
        'nope=orbit',
      ],
      [
        'connection',
        'metabase',
        'setup',
        '--project-dir',
        tempDir,
        '--url',
        'http://metabase.example.test:3000',
        '--api-key',
        'mb_example',
        '--map',
        '2=../orbit',
      ],
      [
        'connection',
        'metabase',
        'setup',
        '--project-dir',
        tempDir,
        '--url',
        'http://metabase.example.test:3000',
        '--api-key',
        'mb_example',
        '--sync',
        'nope',
      ],
      [
        'connection',
        'metabase',
        'setup',
        '--project-dir',
        tempDir,
        '--url',
        'http://metabase.example.test:3000',
        '--api-key',
        'mb_example',
        '--sync-mode',
        'BAD',
      ],
      [
        'connection',
        'metabase',
        'setup',
        '--project-dir',
        tempDir,
        '--url',
        'http://metabase.example.test:3000',
        '--api-key',
        'mb_example',
        '--mint-api-key',
        '--api-key',
        'also_bad',
      ],
    ]) {
      const testIo = makeIo();
      await expect(runKtxCli(argv, testIo.io, { connectionMetabaseSetup })).resolves.toBe(1);
      expect(testIo.stderr()).toMatch(/map|sync|sync-mode|conflict|cannot be used|invalid|integer|choices/i);
    }

    expect(connectionMetabaseSetup).not.toHaveBeenCalled();
  });

  it('rejects commands removed from the May 6 root surface', async () => {
    for (const argv of [
      ['init'],
      ['connect', 'list'],
      ['scan', 'warehouse'],
      ['knowledge', 'list'],
      ['ask', 'What sources are connected?'],
    ]) {
      const testIo = makeIo();

      await expect(runKtxCli(argv, testIo.io)).resolves.toBe(1);

      expect(testIo.stderr()).toMatch(/unknown command|error:/);
    }
  });

  it('dispatches connection add options through Commander', async () => {
    const testIo = makeIo();
    const connection = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          'connection',
          'add',
          'notion',
          'notion-main',
          '--project-dir',
          tempDir,
          '--token-env',
          'NOTION_TOKEN',
          '--crawl-mode',
          'selected_roots',
          '--root-page-id',
          'page-1',
          '--root-database-id',
          'database-1',
          '--max-pages',
          '80',
        ],
        testIo.io,
        { connection },
      ),
    ).resolves.toBe(0);

    expect(connection).toHaveBeenCalledWith(
      {
        command: 'add',
        projectDir: tempDir,
        driver: 'notion',
        connectionId: 'notion-main',
        url: undefined,
        schemas: [],
        readonly: false,
        force: false,
        allowLiteralCredentials: false,
        notion: {
          authTokenRef: 'env:NOTION_TOKEN',
          crawlMode: 'selected_roots',
          rootPageIds: ['page-1'],
          rootDatabaseIds: ['database-1'],
          rootDataSourceIds: [],
          maxPagesPerRun: 80,
          maxKnowledgeCreatesPerRun: undefined,
          maxKnowledgeUpdatesPerRun: undefined,
        },
      },
      testIo.io,
    );
    expect(testIo.stderr()).toBe(`Project: ${tempDir}\n`);
  });

  it('prints generated connection notion pick help without invoking execution', async () => {
    const helpCases = [
      ['connection', 'notion', '--help'],
      ['connection', 'notion', 'pick', '--help'],
      ['connection', 'notion', 'pick', 'notion-main', '--help'],
    ];

    for (const argv of helpCases) {
      const testIo = makeIo();
      const connectionNotion = vi.fn(async () => 0);

      await expect(runKtxCli(argv, testIo.io, { connectionNotion })).resolves.toBe(0);

      expect(testIo.stdout()).toContain('Usage: ktx connection notion');
      expect(testIo.stdout()).toContain('pick');
      expect(testIo.stderr()).toBe('');
      expect(connectionNotion).not.toHaveBeenCalled();
    }
  });

  it('dispatches connection notion pick through Commander', async () => {
    const testIo = makeIo();
    const connectionNotion = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'connection',
          'notion',
          'pick',
          'notion-main',
          '--no-input',
          '--root-page-id',
          '11111111222233334444555555555555',
          '--root-page-id',
          '11111111-2222-3333-4444-555555555555',
        ],
        testIo.io,
        { connectionNotion },
      ),
    ).resolves.toBe(0);

    expect(connectionNotion).toHaveBeenCalledWith(
      {
        command: 'pick',
        projectDir: tempDir,
        connectionId: 'notion-main',
        mode: 'non-interactive',
        rootPageIds: ['11111111-2222-3333-4444-555555555555'],
      },
      testIo.io,
    );
    expect(testIo.stderr()).toBe(`Project: ${tempDir}\n`);
  });

  it('ignores connection notion pick root page flags in interactive mode', async () => {
    const testIo = makeIo();
    const connectionNotion = vi.fn(async () => 0);

    await expect(
      runKtxCli(['connection', 'notion', 'pick', 'notion-main', '--root-page-id', 'not-a-uuid'], testIo.io, {
        connectionNotion,
      }),
    ).resolves.toBe(0);

    expect(connectionNotion).toHaveBeenCalledWith(
      {
        command: 'pick',
        projectDir: expect.any(String),
        connectionId: 'notion-main',
        mode: 'interactive',
      },
      testIo.io,
    );
    expect(testIo.stderr()).toBe('');
  });

  it('rejects connection notion pick no-input mode without root page ids', async () => {
    const testIo = makeIo();
    const connectionNotion = vi.fn(async () => 0);

    await expect(
      runKtxCli(['connection', 'notion', 'pick', 'notion-main', '--no-input'], testIo.io, { connectionNotion }),
    ).resolves.toBe(1);

    expect(connectionNotion).not.toHaveBeenCalled();
    expect(testIo.stderr()).toContain('connection notion pick --no-input requires at least one --root-page-id');
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

  it('routes low-level scan through ktx dev with top-level project-dir', async () => {
    const testIo = makeIo();
    const scan = vi.fn().mockResolvedValue(0);

    await expect(runKtxCli(['--project-dir', tempDir, 'dev', 'scan', 'warehouse'], testIo.io, { scan })).resolves.toBe(
      0,
    );

    expect(scan).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: tempDir,
        connectionId: 'warehouse',
        mode: 'structural',
        detectRelationships: false,
        dryRun: false,
        databaseIntrospectionUrl: undefined,
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'prompt',
      },
      testIo.io,
    );
  });

  it('routes scan managed runtime install policies', async () => {
    const autoIo = makeIo();
    const neverIo = makeIo();
    const conflictIo = makeIo();
    const scan = vi.fn().mockResolvedValue(0);

    await expect(runKtxCli(['--project-dir', tempDir, 'dev', 'scan', 'warehouse', '--yes'], autoIo.io, { scan }))
      .resolves.toBe(0);
    await expect(runKtxCli(['--project-dir', tempDir, 'dev', 'scan', 'warehouse', '--no-input'], neverIo.io, { scan }))
      .resolves.toBe(0);
    await expect(
      runKtxCli(['--project-dir', tempDir, 'dev', 'scan', 'warehouse', '--yes', '--no-input'], conflictIo.io, {
        scan,
      }),
    ).resolves.toBe(1);

    expect(scan).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: 'run',
        runtimeInstallPolicy: 'auto',
      }),
      autoIo.io,
    );
    expect(scan).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'run',
        runtimeInstallPolicy: 'never',
      }),
      neverIo.io,
    );
    expect(conflictIo.stderr()).toContain('Choose only one runtime install mode: --yes or --no-input');
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
    expect(testIo.stdout()).toContain('Low-level diagnostics');
    expect(testIo.stdout()).toContain('scan');
    expect(testIo.stdout()).toContain('ingest');
    expect(testIo.stdout()).toContain('mapping');
    expect(testIo.stdout()).not.toContain('model');
    expect(testIo.stdout()).not.toContain('knowledge');
    expect(testIo.stderr()).toBe('');
  });

  it('prints dev command help without invoking low-level execution', async () => {
    for (const [command, expected] of [
      ['scan', ['Usage: ktx dev scan', '--dry-run', 'status', 'report']],
      ['ingest', ['Usage: ktx dev ingest', 'run', 'replay']],
      ['mapping', ['Usage: ktx dev mapping', 'sync-state', 'validate']],
    ] as const) {
      const testIo = makeIo();
      const scan = vi.fn().mockResolvedValue(0);
      const sl = vi.fn().mockResolvedValue(0);

      await expect(runKtxCli(['dev', command, '--help'], testIo.io, { scan, sl })).resolves.toBe(0);

      for (const text of expected) {
        expect(testIo.stdout()).toContain(text);
      }
      expect(testIo.stderr()).toBe('');
      expect(scan).not.toHaveBeenCalled();
      expect(sl).not.toHaveBeenCalled();
    }
  });

  it('prints dev scan subcommand help without invoking scan execution', async () => {
    const testIo = makeIo();
    const scan = vi.fn().mockResolvedValue(0);

    await expect(runKtxCli(['dev', 'scan', 'report', '--help'], testIo.io, { scan })).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx dev scan report [options] <runId>');
    expect(testIo.stderr()).toBe('');
    expect(scan).not.toHaveBeenCalled();
  });

  it('rejects removed reserved dev subcommands', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['dev', 'artifacts'], testIo.io)).resolves.toBe(1);

    expect(testIo.stderr()).toMatch(/unknown command|error:/);
  });

  it('rejects mutually exclusive output modes before invoking runners', async () => {
    const ingest = vi.fn(async () => 0);

    for (const argv of [
      ['dev', 'ingest', 'run', '--connection-id', 'warehouse', '--adapter', 'fake', '--json', '--plain'],
      ['dev', 'ingest', 'status', 'run-1', '--json', '--viz'],
    ]) {
      const testIo = makeIo();
      await expect(runKtxCli(argv, testIo.io, { ingest })).resolves.toBe(1);
      expect(testIo.stderr()).toMatch(/conflict|cannot be used/i);
    }

    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects mutually exclusive credential and scan mode options before invoking runners', async () => {
    const connection = vi.fn(async () => 0);
    const scan = vi.fn(async () => 0);

    const tokenIo = makeIo();
    await expect(
      runKtxCli(
        [
          'connection',
          'add',
          'notion',
          'notion-main',
          '--token-env',
          'NOTION_TOKEN',
          '--token-file',
          '/tmp/notion-token',
          '--root-page-id',
          '11111111111111111111111111111111',
        ],
        tokenIo.io,
        { connection },
      ),
    ).resolves.toBe(1);
    expect(tokenIo.stderr()).toMatch(/conflict|cannot be used/i);

    expect(connection).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it('validates connection mapping set syntax before runner domain validation', async () => {
    const badFieldIo = makeIo();
    await expect(
      runKtxCli(['connection', 'mapping', 'set', 'prod-metabase', 'invalidMappings', '1=warehouse'], badFieldIo.io),
    ).resolves.toBe(1);
    expect(badFieldIo.stderr()).toContain('databaseMappings or connectionMappings');

    for (const assignment of ['missing-equals', '=warehouse', '1=']) {
      const testIo = makeIo();
      await expect(
        runKtxCli(['connection', 'mapping', 'set', 'prod-metabase', 'databaseMappings', assignment], testIo.io),
      ).resolves.toBe(1);
      expect(testIo.stderr()).toContain('non-empty <key>=<value>');
    }
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
