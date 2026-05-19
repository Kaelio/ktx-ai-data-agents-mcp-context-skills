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

describe('admin Commander tree', () => {
  it('prints visible admin help with supported low-level command groups', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['admin', '--help'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx admin [options] [command]');
    for (const command of ['init', 'runtime', 'reindex']) {
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

  it('lists admin in root command rows', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['--help'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).not.toContain('Advanced:');
    expect(testIo.stdout()).toContain('admin');
    expect(testIo.stdout()).toMatch(/Low-level project initialization,\s+runtime,\s+and index management/);
    expect(testIo.stderr()).toBe('');
  });

  it('does not keep a dev alias', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['dev', '--help'], testIo.io)).resolves.toBe(1);

    expect(testIo.stderr()).toContain("unknown command 'dev'");
  });

  it('keeps project scaffolding under admin init', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-admin-init-'));
    const projectDir = join(tempDir, 'warehouse');
    const testIo = makeIo();

    try {
      await expect(runKtxCli(['admin', 'init', projectDir], testIo.io)).resolves.toBe(0);

      expect(testIo.stdout()).toContain(`Initialized KTX project at ${projectDir}`);
      await expect(readFile(join(projectDir, 'ktx.yaml'), 'utf-8')).resolves.not.toContain('project:');
      expect(testIo.stderr()).toBe('');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses global project-dir for admin init when the positional directory is omitted', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-admin-init-global-'));
    const projectDir = join(tempDir, 'global-init');
    const testIo = makeIo();

    try {
      await expect(
        runKtxCli(['--project-dir', projectDir, 'admin', 'init'], testIo.io),
      ).resolves.toBe(0);

      expect(testIo.stdout()).toContain(`Initialized KTX project at ${projectDir}`);
      expect(testIo.stderr()).toBe('');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prints config schema without requiring a KTX project directory', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-admin-schema-'));
    const missingProjectDir = join(tempDir, 'missing-project');
    const originalProjectDir = process.env.KTX_PROJECT_DIR;
    const testIo = makeIo();

    try {
      process.env.KTX_PROJECT_DIR = missingProjectDir;

      await expect(runKtxCli(['admin', 'schema'], testIo.io)).resolves.toBe(0);

      expect(JSON.parse(testIo.stdout())).toMatchObject({
        title: 'ktx.yaml',
        type: 'object',
      });
      expect(testIo.stderr()).toBe('');
    } finally {
      if (originalProjectDir === undefined) {
        delete process.env.KTX_PROJECT_DIR;
      } else {
        process.env.KTX_PROJECT_DIR = originalProjectDir;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects removed admin command groups', async () => {
    for (const argv of [
      ['admin', 'doctor', 'setup'],
      ['admin', 'runtime', 'doctor'],
      ['admin', 'runtime', 'prune', '--dry-run'],
      ['admin', 'scan', 'warehouse'],
      ['admin', 'ingest', 'run'],
      ['admin', 'mapping', 'list'],
      ['admin', 'completion', 'zsh'],
      ['admin', '__complete', '--shell', 'zsh', '--position', '2', '--', 'ktx', ''],
      ['admin', 'knowledge', 'list'],
      ['admin', 'model', 'list'],
      ['admin', 'artifacts'],
    ]) {
      const testIo = makeIo();

      await expect(runKtxCli(argv, testIo.io)).resolves.toBe(1);

      expect(testIo.stderr()).toMatch(/unknown command|error:/);
    }
  });

  it.each([
    {
      argv: ['admin', 'runtime', '--help'],
      expected: ['Usage: ktx admin runtime', 'install', 'start', 'stop', 'status'],
    },
  ])('prints generated nested help for $argv', async ({ argv, expected }) => {
    const io = makeIo();
    const doctor = vi.fn(async () => 0);

    await expect(runKtxCli(argv, io.io, { doctor })).resolves.toBe(0);

    for (const text of expected) {
      expect(io.stdout()).toContain(text);
    }
    if (argv.join(' ') === 'admin runtime --help') {
      expect(io.stdout()).not.toContain('prune');
      expect(io.stdout()).not.toContain('doctor');
    }
    expect(io.stderr()).toBe('');
    expect(doctor).not.toHaveBeenCalled();
  });

  it('rejects old adapter-backed ingest flags through public option parsing and keeps run out of ingest help', async () => {
    const helpIo = makeIo();
    const runIo = makeIo();
    const publicIngest = vi.fn(async () => 0);

    await expect(runKtxCli(['ingest', '--help'], helpIo.io, { publicIngest })).resolves.toBe(0);
    await expect(
      runKtxCli(
        ['ingest', 'run', '--connection-id', 'warehouse', '--adapter', 'metabase', '--project-dir', '/tmp/project'],
        runIo.io,
        { publicIngest },
      ),
    ).resolves.toBe(1);

    expect(helpIo.stdout()).not.toMatch(/^  run\s/m);
    expect(runIo.stderr()).toMatch(/unknown option '--connection-id'|error:/);
    expect(publicIngest).not.toHaveBeenCalled();
  });

  it.each([
    { argv: ['scan'] },
    { argv: ['scan', '--help'] },
    { argv: ['scan', 'warehouse'] },
    { argv: ['scan', 'warehouse', '--project-dir', '/tmp/project', '--dry-run'] },
    { argv: ['scan', 'warehouse', '--project-dir', '/tmp/project', '--mode', 'relationships'] },
  ])('rejects removed top-level scan command $argv', async ({ argv }) => {
    const io = makeIo();
    const publicIngest = vi.fn(async () => 0);

    await expect(runKtxCli(argv, io.io, { publicIngest })).resolves.toBe(1);

    expect(publicIngest).not.toHaveBeenCalled();
    expect(io.stderr()).toMatch(/unknown command|error:/);
  });

  it('rejects old adapter-backed top-level ingest flags without low-level ingest registration', async () => {
    const io = makeIo();
    const publicIngest = vi.fn(async () => 0);

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
        { publicIngest },
      ),
    ).resolves.toBe(1);

    expect(publicIngest).not.toHaveBeenCalled();
    expect(io.stderr()).toMatch(/unknown option '--connection-id'|error:/);
  });
});
