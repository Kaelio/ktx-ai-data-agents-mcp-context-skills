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
    const publicIngest = vi.fn(async () => 0);
    const setup = vi.fn(async () => 0);
    const deps: KtxCliDeps = { connection, doctor, publicIngest, setup };

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
        argv: ['setup', '--no-input'],
        spy: setup,
        expected: { command: 'run', projectDir: '/tmp/ktx-env-project' },
        expectedStderr: '',
      },
      {
        argv: ['ingest', 'warehouse', '--no-input'],
        spy: publicIngest,
        expected: { command: 'run', projectDir: '/tmp/ktx-env-project', targetConnectionId: 'warehouse' },
        expectedStderr: 'Project: /tmp/ktx-env-project\n',
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

    const publicIngest = vi.fn(async () => 0);
    const beforeCommandIo = makeIo();
    const afterCommandIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', '/tmp/ktx-explicit-project', 'ingest', 'warehouse', '--no-input'], beforeCommandIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(0);
    await expect(
      runKtxCli(['ingest', 'warehouse', '--project-dir=/tmp/ktx-explicit-project', '--no-input'], afterCommandIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(0);

    expect(publicIngest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: 'run', projectDir: '/tmp/ktx-explicit-project' }),
      beforeCommandIo.io,
    );
    expect(publicIngest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ command: 'run', projectDir: '/tmp/ktx-explicit-project' }),
      afterCommandIo.io,
    );
    expect(beforeCommandIo.stderr()).toBe('Project: /tmp/ktx-explicit-project\n');
    expect(afterCommandIo.stderr()).toBe('Project: /tmp/ktx-explicit-project\n');
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

    const publicIngest = vi.fn(async () => 0);
    const testIo = makeIo();

    try {
      process.chdir(nestedDir);
      await expect(runKtxCli(['ingest', 'warehouse', '--no-input'], testIo.io, { publicIngest })).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }

    expect(publicIngest).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'run', projectDir: expectedProjectDir }),
      testIo.io,
    );
    expect(testIo.stderr()).toBe(`Project: ${expectedProjectDir}\n`);
  });
});
