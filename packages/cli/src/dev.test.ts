import { describe, expect, it, vi } from 'vitest';
import { runKtxCli } from './index.js';

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

describe('dev Commander tree', () => {
  it('prints visible dev help with only supported low-level command groups', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['dev', '--help'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx dev [options] [command]');
    for (const command of ['init', 'runtime']) {
      expect(testIo.stdout()).toContain(command);
    }
    for (const removed of [
      'doctor',
      'scan',
      'ingest',
      'mapping',
      'knowledge',
      'model',
      'replay',
      'report',
      'status',
      'artifacts',
      'config',
      'tools',
      'daemon',
    ]) {
      expect(testIo.stdout()).not.toContain(`${removed} `);
    }
    expect(testIo.stderr()).toBe('');
  });

  it('keeps dev callable while hiding it from root command rows', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['--help'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Advanced:');
    expect(testIo.stdout()).toContain('ktx dev');
    expect(testIo.stdout()).not.toContain('dev                              Low-level diagnostics');
    expect(testIo.stderr()).toBe('');
  });

  it('keeps project scaffolding under dev init', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-dev-init-'));
    const projectDir = join(tempDir, 'warehouse');
    const testIo = makeIo();

    try {
      await expect(runKtxCli(['dev', 'init', projectDir, '--name', 'warehouse'], testIo.io)).resolves.toBe(0);

      expect(testIo.stdout()).toContain(`Initialized KTX project at ${projectDir}`);
      await expect(readFile(join(projectDir, 'ktx.yaml'), 'utf-8')).resolves.toContain('project: warehouse');
      expect(testIo.stderr()).toBe('');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses global project-dir for dev init when the positional directory is omitted', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-dev-init-global-'));
    const projectDir = join(tempDir, 'global-init');
    const testIo = makeIo();

    try {
      await expect(
        runKtxCli(['--project-dir', projectDir, 'dev', 'init', '--name', 'global-init'], testIo.io),
      ).resolves.toBe(0);

      expect(testIo.stdout()).toContain(`Initialized KTX project at ${projectDir}`);
      expect(testIo.stderr()).toBe('');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects removed dev command groups', async () => {
    for (const argv of [
      ['dev', 'doctor', 'setup'],
      ['dev', 'runtime', 'doctor'],
      ['dev', 'scan', 'warehouse'],
      ['dev', 'ingest', 'run'],
      ['dev', 'mapping', 'list'],
      ['dev', 'completion', 'zsh'],
      ['dev', '__complete', '--shell', 'zsh', '--position', '2', '--', 'ktx', ''],
      ['dev', 'knowledge', 'list'],
      ['dev', 'model', 'list'],
      ['dev', 'artifacts'],
    ]) {
      const testIo = makeIo();

      await expect(runKtxCli(argv, testIo.io)).resolves.toBe(1);

      expect(testIo.stderr()).toMatch(/unknown command|error:/);
    }
  });

  it.each([
    {
      argv: ['dev', 'runtime', '--help'],
      expected: ['Usage: ktx dev runtime', 'install', 'start', 'stop', 'status', 'prune'],
    },
    {
      argv: ['scan', '--help'],
      expected: ['Usage: ktx scan [options] <connectionId>', '--mode <mode>', 'structural', 'relationships', '--dry-run'],
    },
    {
      argv: ['ingest', 'run', '--help'],
      expected: ['Usage: ktx ingest run [options]', '--connection-id <connectionId>', '--adapter <adapter>'],
    },
  ])('prints generated nested help for $argv', async ({ argv, expected }) => {
    const io = makeIo();
    const doctor = vi.fn(async () => 0);
    const ingest = vi.fn(async () => 0);
    const scan = vi.fn(async () => 0);

    await expect(runKtxCli(argv, io.io, { doctor, ingest, scan })).resolves.toBe(0);

    for (const text of expected) {
      expect(io.stdout()).toContain(text);
    }
    expect(io.stderr()).toBe('');
    expect(doctor).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it('dispatches top-level scan through Commander with injected dependencies', async () => {
    const scanIo = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(['scan', 'warehouse', '--project-dir', '/tmp/project', '--dry-run'], scanIo.io, { scan }),
    ).resolves.toBe(0);

    expect(scan).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: '/tmp/project',
        connectionId: 'warehouse',
        mode: 'structural',
        detectRelationships: false,
        dryRun: true,
        databaseIntrospectionUrl: undefined,
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'prompt',
      },
      scanIo.io,
    );
    expect(scanIo.stderr()).toBe('Project: /tmp/project\n');
  });

  it('dispatches top-level scan --mode relationships through Commander', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(['scan', 'warehouse', '--project-dir', '/tmp/project', '--mode', 'relationships'], io.io, {
        scan,
      }),
    ).resolves.toBe(0);

    expect(scan).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: '/tmp/project',
        connectionId: 'warehouse',
        mode: 'relationships',
        detectRelationships: true,
        dryRun: false,
        databaseIntrospectionUrl: undefined,
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'prompt',
      },
      io.io,
    );
    expect(io.stderr()).toBe('Project: /tmp/project\n');
  });

  it.each(['--enrich', '--detect-relationships'])('rejects removed scan shorthand option %s', async (option) => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(runKtxCli(['scan', 'warehouse', option], io.io, { scan })).resolves.toBe(1);

    expect(scan).not.toHaveBeenCalled();
    expect(io.stderr()).toContain(`unknown option '${option}'`);
  });

  it('rejects scan without a connection id', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(runKtxCli(['scan', '--dry-run'], io.io, { scan })).resolves.toBe(1);

    expect(scan).not.toHaveBeenCalled();
    expect(io.stderr()).toMatch(/missing required argument/i);
  });

  it('rejects invalid scan modes before dispatch', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(runKtxCli(['scan', 'warehouse', '--mode', 'deep'], io.io, { scan })).resolves.toBe(1);

    expect(scan).not.toHaveBeenCalled();
    expect(io.stderr()).toContain("argument 'deep' is invalid");
    expect(io.stderr()).toContain('Allowed choices are structural, enriched, relationships');
  });

  it.each([
    ['scan', 'report', 'scan-run-1'],
    ['scan', 'relationships', 'scan-run-1'],
  ])('rejects removed scan subcommand %s %s', async (command, subcommand, runId) => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(runKtxCli([command, subcommand, runId], io.io, { scan })).resolves.toBe(1);

    expect(scan).not.toHaveBeenCalled();
    expect(io.stderr()).toMatch(/too many arguments|unknown command|error:/);
  });

  it('dispatches top-level ingest run through the low-level ingest Commander registration', async () => {
    const io = makeIo();
    const ingest = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          'ingest',
          'run',
          '--connection-id',
          'warehouse',
          '--adapter',
          'metabase',
          '--project-dir',
          '/tmp/project',
          '--json',
        ],
        io.io,
        { ingest },
      ),
    ).resolves.toBe(0);

    expect(ingest).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: '/tmp/project',
        connectionId: 'warehouse',
        adapter: 'metabase',
        sourceDir: undefined,
        databaseIntrospectionUrl: undefined,
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'prompt',
        outputMode: 'json',
      },
      io.io,
    );
    expect(io.stderr()).toBe('');
  });
});
