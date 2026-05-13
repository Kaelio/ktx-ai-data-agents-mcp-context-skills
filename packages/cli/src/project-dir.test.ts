import { afterEach, describe, expect, it, vi } from 'vitest';
import { runKtxCli, type KtxCliDeps } from './index.js';

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

describe('project directory defaults', () => {
  afterEach(() => {
    delete process.env.KTX_PROJECT_DIR;
  });

  it('uses KTX_PROJECT_DIR when Commander-dispatched commands omit --project-dir', async () => {
    process.env.KTX_PROJECT_DIR = '/tmp/ktx-env-project';

    const connection = vi.fn(async () => 0);
    const doctor = vi.fn(async () => 0);
    const ingest = vi.fn(async () => 0);
    const scan = vi.fn(async () => 0);
    const setup = vi.fn(async () => 0);
    const agent = vi.fn(async () => 0);
    const deps: KtxCliDeps = { agent, connection, doctor, ingest, scan, setup };

    const cases: Array<{
      argv: string[];
      spy: ReturnType<typeof vi.fn>;
      expected: Record<string, unknown>;
      expectedStderr: string;
    }> = [
      {
        argv: ['connection', 'list'],
        spy: connection,
        expected: { command: 'list', projectDir: '/tmp/ktx-env-project' },
        expectedStderr: 'Project: /tmp/ktx-env-project\n',
      },
      {
        argv: ['status', '--no-input'],
        spy: doctor,
        expected: { command: 'project', projectDir: '/tmp/ktx-env-project' },
        expectedStderr: 'Project: /tmp/ktx-env-project\n',
      },
      {
        argv: ['ingest', 'status', 'run-1'],
        spy: ingest,
        expected: { command: 'status', projectDir: '/tmp/ktx-env-project', runId: 'run-1', outputMode: 'plain' },
        expectedStderr: 'Project: /tmp/ktx-env-project\n',
      },
      {
        argv: ['setup', '--no-input'],
        spy: setup,
        expected: { command: 'run', projectDir: '/tmp/ktx-env-project' },
        expectedStderr: 'Project: /tmp/ktx-env-project\n',
      },
      {
        argv: ['scan', 'warehouse'],
        spy: scan,
        expected: { command: 'run', projectDir: '/tmp/ktx-env-project', connectionId: 'warehouse' },
        expectedStderr: 'Project: /tmp/ktx-env-project\n',
      },
      {
        argv: ['agent', 'tools', '--json'],
        spy: agent,
        expected: { command: 'tools', projectDir: '/tmp/ktx-env-project' },
        expectedStderr: '',
      },
    ];

    for (const item of cases) {
      const testIo = makeIo();
      await expect(runKtxCli(item.argv, testIo.io, deps)).resolves.toBe(0);
      expect(item.spy).toHaveBeenLastCalledWith(expect.objectContaining(item.expected), testIo.io);
      expect(testIo.stderr()).toBe(item.expectedStderr);
    }
  });

  it('lets explicit global --project-dir override KTX_PROJECT_DIR before and after nested commands', async () => {
    process.env.KTX_PROJECT_DIR = '/tmp/ktx-env-project';

    const scan = vi.fn(async () => 0);
    const ingest = vi.fn(async () => 0);
    const scanIo = makeIo();
    const ingestIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', '/tmp/ktx-explicit-project', 'scan', 'warehouse'], scanIo.io, { scan }),
    ).resolves.toBe(0);
    await expect(
      runKtxCli(['ingest', 'status', 'run-1', '--project-dir=/tmp/ktx-explicit-project'], ingestIo.io, {
        ingest,
      }),
    ).resolves.toBe(0);

    expect(scan).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'run', projectDir: '/tmp/ktx-explicit-project' }),
      scanIo.io,
    );
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'status', projectDir: '/tmp/ktx-explicit-project' }),
      ingestIo.io,
    );
    expect(scanIo.stderr()).toBe('Project: /tmp/ktx-explicit-project\n');
    expect(ingestIo.stderr()).toBe('Project: /tmp/ktx-explicit-project\n');
  });

  it('uses nearest ancestor containing ktx.yaml when no explicit or environment project-dir exists', async () => {
    const { mkdir, realpath, writeFile } = await import('node:fs/promises');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const originalCwd = process.cwd();
    const root = await mkdtemp(join(tmpdir(), 'ktx-cli-nearest-project-'));
    const projectDir = join(root, 'warehouse');
    const nestedDir = join(projectDir, 'nested', 'deeper');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(projectDir, 'ktx.yaml'), 'project: warehouse\n', 'utf-8');
    const expectedProjectDir = await realpath(projectDir);

    const scan = vi.fn(async () => 0);
    const testIo = makeIo();

    try {
      process.chdir(nestedDir);
      await expect(runKtxCli(['scan', 'warehouse'], testIo.io, { scan })).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }

    expect(scan).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'run', projectDir: expectedProjectDir }),
      testIo.io,
    );
    expect(testIo.stderr()).toBe(`Project: ${expectedProjectDir}\n`);
  });
});
