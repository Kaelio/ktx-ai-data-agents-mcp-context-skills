import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileIngestTraceWriter } from '../../../../src/context/ingest/ingest-trace.js';
import { resolveTextualConflict } from '../../../../src/context/ingest/isolated-diff/textual-conflict-resolver.js';

async function makeHarness() {
  const root = await mkdtemp(join(tmpdir(), 'ktx-textual-resolver-'));
  const workdir = join(root, 'workdir');
  const patchPath = join(root, 'failed.patch');
  const trace = new FileIngestTraceWriter({
    tracePath: join(root, 'trace.jsonl'),
    jobId: 'job-1',
    connectionId: 'warehouse',
    sourceKey: 'metabase',
    runId: 'run-1',
    syncId: 'sync-1',
    level: 'trace',
  });
  await mkdir(join(workdir, 'wiki/global'), { recursive: true });
  await writeFile(join(workdir, 'wiki/global/account.md'), 'accepted line\n', 'utf-8');
  await writeFile(
    patchPath,
    [
      'diff --git a/wiki/global/account.md b/wiki/global/account.md',
      'index 8877391..6f63f4d 100644',
      '--- a/wiki/global/account.md',
      '+++ b/wiki/global/account.md',
      '@@ -1 +1 @@',
      '-base line',
      '+proposal line',
      '',
    ].join('\n'),
    'utf-8',
  );
  return { root, workdir, patchPath, trace };
}

describe('resolveTextualConflict', () => {
  it('lets the repair agent read the failed patch and write only touched paths', async () => {
    const { workdir, patchPath, trace } = await makeHarness();
    const agentRunner = {
      runLoop: vi.fn(async (params: any) => {
        const current = await params.toolSet.read_repair_file.execute({ path: 'wiki/global/account.md' });
        expect(current.structured).toEqual({ path: 'wiki/global/account.md', exists: true });
        expect(current.markdown).toContain('accepted line');

        const patch = await params.toolSet.read_failed_patch.execute({});
        expect(patch.markdown).toContain('proposal line');

        await expect(
          params.toolSet.write_repair_file.execute({
            path: 'wiki/global/not-allowed.md',
            content: 'bad\n',
          }),
        ).rejects.toThrow(/repair path not allowed/);

        await params.toolSet.write_repair_file.execute({
          path: 'wiki/global/account.md',
          content: 'accepted line\nproposal line\n',
        });
        return { stopReason: 'natural' as const };
      }),
    };
    const verify = vi.fn(async () => ({ ok: true as const }));

    const result = await resolveTextualConflict({
      agentRunner,
      workdir,
      unitKey: 'wu-a',
      patchPath,
      touchedPaths: ['wiki/global/account.md'],
      trace,
      reason: 'patch failed: wiki/global/account.md',
      verify,
      maxAttempts: 1,
      stepBudget: 8,
    });

    expect(result).toEqual({
      status: 'repaired',
      attempts: 1,
      changedPaths: ['wiki/global/account.md'],
    });
    expect(verify).toHaveBeenCalledWith(['wiki/global/account.md']);
    await expect(readFile(join(workdir, 'wiki/global/account.md'), 'utf-8')).resolves.toBe(
      'accepted line\nproposal line\n',
    );
    expect(agentRunner.runLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRole: 'repair',
        stepBudget: 8,
        telemetryTags: expect.objectContaining({
          operationName: 'ingest-isolated-diff-textual-resolver',
          jobId: 'job-1',
          unitKey: 'wu-a',
        }),
      }),
    );
  });

  it('fails when the repair agent neither edits nor declares the patch redundant', async () => {
    const { workdir, patchPath, trace } = await makeHarness();
    const verify = vi.fn(async () => ({ ok: true as const }));
    const result = await resolveTextualConflict({
      agentRunner: { runLoop: vi.fn(async () => ({ stopReason: 'natural' as const })) },
      workdir,
      unitKey: 'wu-a',
      patchPath,
      touchedPaths: ['wiki/global/account.md'],
      trace,
      reason: 'patch failed: wiki/global/account.md',
      verify,
      maxAttempts: 1,
      stepBudget: 8,
    });

    expect(result).toEqual({
      status: 'failed',
      attempts: 1,
      reason: 'resolver completed without editing an allowed path or declaring the patch redundant',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('succeeds without edits when the agent declares the patch redundant and the gates verify', async () => {
    // Regression: two Notion pages produced creation patches for the same
    // wiki key. The second patch conflicts, the integration tree already
    // holds a complete page, and the correct resolution is no edit at all.
    const { workdir, patchPath, trace } = await makeHarness();
    const agentRunner = {
      runLoop: vi.fn(async (params: any) => {
        const declared = await params.toolSet.declare_patch_redundant.execute({
          reason: 'wiki/global/account.md already documents this page',
        });
        expect(declared.structured).toEqual({ reason: 'wiki/global/account.md already documents this page' });
        return { stopReason: 'natural' as const };
      }),
    };
    const verify = vi.fn(async () => ({ ok: true as const }));

    const result = await resolveTextualConflict({
      agentRunner,
      workdir,
      unitKey: 'wu-duplicate',
      patchPath,
      touchedPaths: ['wiki/global/account.md'],
      trace,
      reason: 'patch failed: wiki/global/account.md',
      verify,
      maxAttempts: 1,
      stepBudget: 8,
    });

    expect(result).toEqual({ status: 'repaired', attempts: 1, changedPaths: [] });
    expect(verify).toHaveBeenCalledWith([]);
    await expect(readFile(join(workdir, 'wiki/global/account.md'), 'utf-8')).resolves.toBe('accepted line\n');
    await expect(readFile(trace.tracePath, 'utf-8')).resolves.toContain('textual_conflict_resolver_repaired');
  });

  it('retries with the gate failure when verification rejects the first resolution', async () => {
    const { workdir, patchPath, trace } = await makeHarness();
    const agentRunner = {
      runLoop: vi.fn(async (params: any) => {
        await params.toolSet.write_repair_file.execute({
          path: 'wiki/global/account.md',
          content: 'accepted line\nproposal line\n',
        });
        return { stopReason: 'natural' as const };
      }),
    };
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'final artifact gates failed: stale sl_refs entry' })
      .mockResolvedValueOnce({ ok: true });

    const result = await resolveTextualConflict({
      agentRunner,
      workdir,
      unitKey: 'wu-retry',
      patchPath,
      touchedPaths: ['wiki/global/account.md'],
      trace,
      reason: 'patch failed: wiki/global/account.md',
      verify,
      maxAttempts: 2,
      stepBudget: 8,
    });

    expect(result).toEqual({
      status: 'repaired',
      attempts: 2,
      changedPaths: ['wiki/global/account.md'],
    });
    expect(agentRunner.runLoop).toHaveBeenCalledTimes(2);
    const secondPrompt = agentRunner.runLoop.mock.calls[1][0].userPrompt as string;
    expect(secondPrompt).toContain('final artifact gates failed: stale sl_refs entry');
  });

  it('fails when edits never pass verification', async () => {
    const { workdir, patchPath, trace } = await makeHarness();
    const agentRunner = {
      runLoop: vi.fn(async (params: any) => {
        await params.toolSet.write_repair_file.execute({
          path: 'wiki/global/account.md',
          content: 'still wrong\n',
        });
        return { stopReason: 'natural' as const };
      }),
    };
    const verify = vi.fn(async () => ({ ok: false as const, reason: 'final artifact gates failed' }));

    const result = await resolveTextualConflict({
      agentRunner,
      workdir,
      unitKey: 'wu-never-passes',
      patchPath,
      touchedPaths: ['wiki/global/account.md'],
      trace,
      reason: 'patch failed: wiki/global/account.md',
      verify,
      maxAttempts: 2,
      stepBudget: 8,
    });

    expect(result).toEqual({ status: 'failed', attempts: 2, reason: 'final artifact gates failed' });
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
