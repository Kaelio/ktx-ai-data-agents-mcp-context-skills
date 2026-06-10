import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { finalGateRepairPaths, repairFinalGateFailure } from '../../../src/context/ingest/final-gate-repair.js';
import { FileIngestTraceWriter } from '../../../src/context/ingest/ingest-trace.js';

async function makeHarness() {
  const root = await mkdtemp(join(tmpdir(), 'ktx-final-gate-repair-'));
  const workdir = join(root, 'workdir');
  await mkdir(join(workdir, 'wiki/global'), { recursive: true });
  await mkdir(join(workdir, 'semantic-layer/warehouse'), { recursive: true });
  await writeFile(
    join(workdir, 'wiki/global/account-segments.md'),
    '---\nsummary: Account segments\nusage_mode: auto\n---\n\nARR uses `mart_account_segments.total_contract_arr_cents`.\n',
    'utf-8',
  );
  await writeFile(
    join(workdir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
    'name: mart_account_segments\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
    'utf-8',
  );
  const trace = new FileIngestTraceWriter({
    tracePath: join(root, 'trace.jsonl'),
    jobId: 'job-1',
    connectionId: 'warehouse',
    sourceKey: 'metabase',
    runId: 'run-1',
    syncId: 'sync-1',
    level: 'trace',
  });
  return { root, workdir, trace };
}

describe('finalGateRepairPaths', () => {
  it('derives sorted, deduplicated wiki and semantic-layer file paths', () => {
    expect(
      finalGateRepairPaths({
        changedWikiPageKeys: ['account-segments', 'overview', 'account-segments'],
        touchedSlSourcePaths: [
          'semantic-layer/warehouse/mart_account_segments.yaml',
          'semantic-layer/warehouse/orders.yaml',
          'semantic-layer/warehouse/orders.yaml',
        ],
      }),
    ).toEqual([
      'semantic-layer/warehouse/mart_account_segments.yaml',
      'semantic-layer/warehouse/orders.yaml',
      'wiki/global/account-segments.md',
      'wiki/global/overview.md',
    ]);
  });
});

describe('repairFinalGateFailure', () => {
  it('lets the repair agent read gate errors and edit only allowed files', async () => {
    const { workdir, trace } = await makeHarness();
    const agentRunner = {
      runLoop: vi.fn(async (params: any) => {
        const error = await params.toolSet.read_gate_error.execute({});
        expect(error.markdown).toContain('total_contract_arr_cents');

        const page = await params.toolSet.read_repair_file.execute({
          path: 'wiki/global/account-segments.md',
        });
        expect(page.markdown).toContain('total_contract_arr_cents');

        await expect(
          params.toolSet.write_repair_file.execute({
            path: 'wiki/global/other.md',
            content: 'not allowed',
          }),
        ).rejects.toThrow(/gate repair path not allowed/);

        await params.toolSet.write_repair_file.execute({
          path: 'wiki/global/account-segments.md',
          content: page.markdown.replace('total_contract_arr_cents', 'total_contract_arr'),
        });
        return { stopReason: 'natural' as const };
      }),
    };

    const result = await repairFinalGateFailure({
      agentRunner,
      workdir,
      gateError:
        'final artifact gates failed:\naccount-segments: unknown semantic-layer entity mart_account_segments.total_contract_arr_cents',
      allowedPaths: ['wiki/global/account-segments.md'],
      trace,
      repairKind: 'final_artifact_gate',
      maxAttempts: 1,
      stepBudget: 8,
    });

    expect(result).toEqual({
      status: 'repaired',
      attempts: 1,
      changedPaths: ['wiki/global/account-segments.md'],
    });
    await expect(readFile(join(workdir, 'wiki/global/account-segments.md'), 'utf-8')).resolves.toContain(
      'total_contract_arr',
    );
    await expect(readFile(trace.tracePath, 'utf-8')).resolves.toContain('gate_repair_repaired');
    expect(agentRunner.runLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRole: 'repair',
        stepBudget: 8,
        telemetryTags: expect.objectContaining({
          operationName: 'ingest-isolated-diff-gate-repair',
          repairKind: 'final_artifact_gate',
        }),
      }),
    );
  });

  it('returns failed when the repair agent edits no allowed file', async () => {
    const { workdir, trace } = await makeHarness();
    const result = await repairFinalGateFailure({
      agentRunner: { runLoop: vi.fn(async () => ({ stopReason: 'natural' as const })) },
      workdir,
      gateError: 'final artifact gates failed:\naccount-segments: unknown semantic-layer entity',
      allowedPaths: ['wiki/global/account-segments.md'],
      trace,
      repairKind: 'final_artifact_gate',
      maxAttempts: 1,
      stepBudget: 8,
    });

    expect(result).toEqual({
      status: 'failed',
      attempts: 1,
      reason: 'gate repair completed without editing an allowed path',
    });
    await expect(readFile(trace.tracePath, 'utf-8')).resolves.toContain('gate_repair_failed');
  });
});
