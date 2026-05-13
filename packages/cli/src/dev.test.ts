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
      ['dev', 'runtime', 'prune', '--dry-run'],
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
      expected: ['Usage: ktx dev runtime', 'install', 'start', 'stop', 'status'],
    },
  ])('prints generated nested help for $argv', async ({ argv, expected }) => {
    const io = makeIo();
    const doctor = vi.fn(async () => 0);
    const ingest = vi.fn(async () => 0);

    await expect(runKtxCli(argv, io.io, { doctor, ingest })).resolves.toBe(0);

    for (const text of expected) {
      expect(io.stdout()).toContain(text);
    }
    if (argv.join(' ') === 'dev runtime --help') {
      expect(io.stdout()).not.toContain('prune');
      expect(io.stdout()).not.toContain('doctor');
    }
    expect(io.stderr()).toBe('');
    expect(doctor).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('keeps legacy adapter-backed ingest run callable but hidden from ingest help', async () => {
    const helpIo = makeIo();
    const runIo = makeIo();
    const ingest = vi.fn(async () => 0);

    await expect(runKtxCli(['ingest', '--help'], helpIo.io, { ingest })).resolves.toBe(0);
    await expect(
      runKtxCli(
        ['ingest', 'run', '--connection-id', 'warehouse', '--adapter', 'metabase', '--project-dir', '/tmp/project'],
        runIo.io,
        { ingest },
      ),
    ).resolves.toBe(0);

    expect(helpIo.stdout()).not.toMatch(/^  run\s/m);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'run', connectionId: 'warehouse', adapter: 'metabase' }),
      runIo.io,
    );
  });

  it.each([
    { argv: ['scan'] },
    { argv: ['scan', '--help'] },
    { argv: ['scan', 'warehouse'] },
    { argv: ['scan', 'warehouse', '--project-dir', '/tmp/project', '--dry-run'] },
    { argv: ['scan', 'warehouse', '--project-dir', '/tmp/project', '--mode', 'relationships'] },
  ])('rejects removed top-level scan command $argv', async ({ argv }) => {
    const io = makeIo();
    const ingest = vi.fn(async () => 0);

    await expect(runKtxCli(argv, io.io, { ingest })).resolves.toBe(1);

    expect(ingest).not.toHaveBeenCalled();
    expect(io.stderr()).toMatch(/unknown command|error:/);
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
