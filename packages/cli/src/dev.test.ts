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
    for (const command of ['init', 'doctor', 'scan', 'ingest', 'mapping']) {
      expect(testIo.stdout()).toContain(command);
    }
    for (const removed of [
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
      argv: ['dev', 'doctor', '--help'],
      expected: ['Usage: ktx dev doctor', '--json', '--no-input'],
    },
    {
      argv: ['dev', 'scan', '--help'],
      expected: [
        'Usage: ktx dev scan',
        '--mode <mode>',
        'structural',
        'relationships',
        '--dry-run',
        'status',
        'report',
        'relationships',
        'relationship-apply',
        'relationship-feedback',
        'relationship-calibration',
        'relationship-thresholds',
      ],
    },
    {
      argv: ['dev', 'scan', 'report', '--help'],
      expected: ['Usage: ktx dev scan report [options] <runId>', '<runId>', '--json'],
    },
    {
      argv: ['dev', 'scan', 'relationships', '--help'],
      expected: [
        'Usage: ktx dev scan relationships [options] <runId>',
        '--status <status>',
        '--limit <count>',
        '--accept <candidateId>',
        '--reject <candidateId>',
        '--note <text>',
        '--reviewer <name>',
        '--json',
      ],
    },
    {
      argv: ['dev', 'scan', 'relationship-apply', '--help'],
      expected: [
        'Usage: ktx dev scan relationship-apply [options] <runId>',
        '--all-accepted',
        '--candidate <candidateId>',
        '--dry-run',
      ],
    },
    {
      argv: ['dev', 'scan', 'relationship-thresholds', '--help'],
      expected: [
        'Usage: ktx dev scan relationship-thresholds [options]',
        '--connection <connectionId>',
        '--min-total-labels <count>',
        '--min-accepted-labels <count>',
        '--min-rejected-labels <count>',
        '--json',
      ],
    },
    {
      argv: ['dev', 'scan', 'relationship-feedback', '--help'],
      expected: [
        'Usage: ktx dev scan relationship-feedback [options]',
        '--connection <connectionId>',
        '--decision <decision>',
        '--json',
        '--jsonl',
      ],
    },
    {
      argv: ['dev', 'scan', 'relationship-calibration', '--help'],
      expected: [
        'Usage: ktx dev scan relationship-calibration [options]',
        '--connection <connectionId>',
        '--decision <decision>',
        '--accept-threshold <value>',
        '--review-threshold <value>',
        '--json',
      ],
    },
    {
      argv: ['dev', 'ingest', 'run', '--help'],
      expected: ['Usage: ktx dev ingest run [options]', '--connection-id <connectionId>', '--adapter <adapter>'],
    },
    {
      argv: ['dev', 'mapping', 'sync-state', 'set', '--help'],
      expected: ['Usage: ktx dev mapping sync-state set [options] <connectionId>', '--mode <mode>'],
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

  it('dispatches dev scan through Commander with injected dependencies', async () => {
    const scanIo = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(['dev', 'scan', 'warehouse', '--project-dir', '/tmp/project', '--dry-run'], scanIo.io, { scan }),
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
    expect(scanIo.stderr()).toBe('');
  });

  it('dispatches dev scan --mode relationships through Commander', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(['dev', 'scan', 'warehouse', '--project-dir', '/tmp/project', '--mode', 'relationships'], io.io, {
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
    expect(io.stderr()).toBe('');
  });

  it.each(['--enrich', '--detect-relationships'])('rejects removed scan shorthand option %s', async (option) => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(runKtxCli(['dev', 'scan', 'warehouse', option], io.io, { scan })).resolves.toBe(1);

    expect(scan).not.toHaveBeenCalled();
    expect(io.stderr()).toContain(`unknown option '${option}'`);
  });

  it('rejects dev scan without a connection id or subcommand', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(runKtxCli(['dev', 'scan', '--dry-run'], io.io, { scan })).resolves.toBe(1);

    expect(scan).not.toHaveBeenCalled();
    expect(io.stdout()).toContain('Usage: ktx dev scan');
    expect(io.stderr()).toContain('ktx dev scan requires <connectionId> or a subcommand');
  });

  it('rejects invalid scan modes before dispatch', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(runKtxCli(['dev', 'scan', 'warehouse', '--mode', 'deep'], io.io, { scan })).resolves.toBe(1);

    expect(scan).not.toHaveBeenCalled();
    expect(io.stderr()).toContain("argument 'deep' is invalid");
    expect(io.stderr()).toContain('Allowed choices are structural, enriched, relationships');
  });

  it('prints dev scan subcommand help with the canonical command name', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(runKtxCli(['dev', 'scan', 'report', '--help'], io.io, { scan })).resolves.toBe(0);

    expect(io.stdout()).toContain('--project-dir is inherited from `ktx dev scan`');
    expect(io.stdout()).not.toContain('--project-dir is inherited from `ktx scan`');
    expect(scan).not.toHaveBeenCalled();
  });

  it('dispatches dev scan report in human and json modes', async () => {
    const humanIo = makeIo();
    const jsonIo = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(['dev', 'scan', 'report', 'scan-run-1', '--project-dir', '/tmp/project'], humanIo.io, { scan }),
    ).resolves.toBe(0);
    await expect(
      runKtxCli(['dev', 'scan', 'report', 'scan-run-2', '--project-dir', '/tmp/project', '--json'], jsonIo.io, {
        scan,
      }),
    ).resolves.toBe(0);

    expect(scan).toHaveBeenNthCalledWith(
      1,
      { command: 'report', projectDir: '/tmp/project', runId: 'scan-run-1', json: false },
      humanIo.io,
    );
    expect(scan).toHaveBeenNthCalledWith(
      2,
      { command: 'report', projectDir: '/tmp/project', runId: 'scan-run-2', json: true },
      jsonIo.io,
    );
  });

  it('dispatches dev scan relationships with filters through Commander', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          'dev',
          'scan',
          'relationships',
          'scan-run-review',
          '--project-dir',
          '/tmp/project',
          '--status',
          'rejected',
          '--limit',
          '5',
          '--json',
        ],
        io.io,
        { scan },
      ),
    ).resolves.toBe(0);

    expect(scan).toHaveBeenCalledWith(
      {
        command: 'relationships',
        projectDir: '/tmp/project',
        runId: 'scan-run-review',
        status: 'rejected',
        json: true,
        limit: 5,
      },
      io.io,
    );
    expect(io.stderr()).toBe('');
  });

  it('dispatches dev scan relationship decision recording through Commander', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          'dev',
          'scan',
          'relationships',
          'scan-run-review',
          '--project-dir',
          '/tmp/project',
          '--accept',
          'orders:orders.customer_id->customers:customers.id',
          '--reviewer',
          'Andrey',
          '--note',
          'Looks right',
          '--json',
        ],
        io.io,
        { scan },
      ),
    ).resolves.toBe(0);

    expect(scan).toHaveBeenCalledWith(
      {
        command: 'relationshipDecision',
        projectDir: '/tmp/project',
        runId: 'scan-run-review',
        candidateId: 'orders:orders.customer_id->customers:customers.id',
        decision: 'accepted',
        reviewer: 'Andrey',
        note: 'Looks right',
        json: true,
      },
      io.io,
    );
    expect(io.stderr()).toBe('');
  });

  it.each(['--accept', '--reject'])('rejects empty relationship decision candidate ids for %s', async (option) => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(['dev', 'scan', 'relationships', 'scan-run-review', option, ''], io.io, { scan }),
    ).resolves.toBe(1);

    expect(scan).not.toHaveBeenCalled();
    expect(io.stderr()).toContain('must not be empty');
  });

  it('rejects relationship feedback JSON and JSONL output together', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(['dev', 'scan', 'relationship-feedback', '--json', '--jsonl'], io.io, { scan }),
    ).resolves.toBe(1);

    expect(scan).not.toHaveBeenCalled();
    expect(io.stderr()).toMatch(/conflict|cannot be used/i);
  });

  it('dispatches relationship apply command args', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          'dev',
          'scan',
          'relationship-apply',
          'scan-run-a',
          '--project-dir',
          '/tmp/project',
          '--candidate',
          'orders:orders.customer_id->customers:customers.id',
          '--dry-run',
          '--json',
        ],
        io.io,
        { scan },
      ),
    ).resolves.toBe(0);

    expect(scan).toHaveBeenCalledWith(
      {
        command: 'relationshipApply',
        projectDir: '/tmp/project',
        runId: 'scan-run-a',
        applyAllAccepted: false,
        candidateIds: ['orders:orders.customer_id->customers:customers.id'],
        dryRun: true,
        json: true,
      },
      io.io,
    );
  });

  it('dispatches scan relationship feedback command with filters and JSONL output', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          'dev',
          'scan',
          'relationship-feedback',
          '--project-dir',
          '/tmp/project',
          '--connection',
          'warehouse',
          '--decision',
          'accepted',
          '--jsonl',
        ],
        io.io,
        { scan },
      ),
    ).resolves.toBe(0);

    expect(scan).toHaveBeenCalledWith(
      {
        command: 'relationshipFeedback',
        projectDir: '/tmp/project',
        connectionId: 'warehouse',
        decision: 'accepted',
        json: false,
        jsonl: true,
      },
      io.io,
    );
  });

  it('dispatches scan relationship calibration command with thresholds', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          'dev',
          'scan',
          'relationship-calibration',
          '--project-dir',
          '/tmp/project',
          '--connection',
          'warehouse',
          '--decision',
          'rejected',
          '--accept-threshold',
          '0.9',
          '--review-threshold',
          '0.5',
          '--json',
        ],
        io.io,
        { scan },
      ),
    ).resolves.toBe(0);

    expect(scan).toHaveBeenCalledWith(
      {
        command: 'relationshipCalibration',
        projectDir: '/tmp/project',
        connectionId: 'warehouse',
        decision: 'rejected',
        acceptThreshold: 0.9,
        reviewThreshold: 0.5,
        json: true,
      },
      io.io,
    );
  });

  it('dispatches relationship threshold advice command args', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          'dev',
          'scan',
          'relationship-thresholds',
          '--project-dir',
          '/tmp/project',
          '--connection',
          'warehouse',
          '--min-total-labels',
          '12',
          '--min-accepted-labels',
          '4',
          '--min-rejected-labels',
          '3',
          '--json',
        ],
        io.io,
        { scan },
      ),
    ).resolves.toBe(0);

    expect(scan).toHaveBeenCalledWith(
      {
        command: 'relationshipThresholds',
        projectDir: '/tmp/project',
        connectionId: 'warehouse',
        minTotalLabels: 12,
        minAcceptedLabels: 4,
        minRejectedLabels: 3,
        json: true,
      },
      io.io,
    );
  });

  it('rejects invalid relationship calibration thresholds before dispatch', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(['dev', 'scan', 'relationship-calibration', '--accept-threshold', '1.5'], io.io, { scan }),
    ).resolves.toBe(1);

    expect(scan).not.toHaveBeenCalled();
    expect(io.stderr()).toContain('Allowed range is 0 through 1');
  });

  it('rejects relationship accept and reject options together before dispatch', async () => {
    const io = makeIo();
    const scan = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          'dev',
          'scan',
          'relationships',
          'scan-run-review',
          '--accept',
          'orders:orders.customer_id->customers:customers.id',
          '--reject',
          'orders:orders.customer_id->customers:customers.id',
        ],
        io.io,
        { scan },
      ),
    ).resolves.toBe(1);

    expect(scan).not.toHaveBeenCalled();
    expect(io.stderr()).toMatch(/conflict|cannot be used/i);
  });

  it('dispatches dev ingest run through the low-level ingest Commander registration', async () => {
    const io = makeIo();
    const ingest = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          'dev',
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
