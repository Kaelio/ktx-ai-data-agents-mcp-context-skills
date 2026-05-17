import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileIngestTraceWriter } from '../ingest-trace.js';
import { resolveTextualConflict } from './textual-conflict-resolver.js';

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
        const current = await params.toolSet.read_integration_file.execute({ path: 'wiki/global/account.md' });
        expect(current.structured).toEqual({ path: 'wiki/global/account.md', exists: true });
        expect(current.markdown).toContain('accepted line');

        const patch = await params.toolSet.read_failed_patch.execute({});
        expect(patch.markdown).toContain('proposal line');

        await expect(
          params.toolSet.write_integration_file.execute({
            path: 'wiki/global/not-allowed.md',
            content: 'bad\n',
          }),
        ).rejects.toThrow(/resolver path not allowed/);

        await params.toolSet.write_integration_file.execute({
          path: 'wiki/global/account.md',
          content: 'accepted line\nproposal line\n',
        });
        return { stopReason: 'natural' };
      }),
    };

    const result = await resolveTextualConflict({
      agentRunner,
      workdir,
      unitKey: 'wu-a',
      patchPath,
      touchedPaths: ['wiki/global/account.md'],
      trace,
      reason: 'patch failed: wiki/global/account.md',
      maxAttempts: 1,
      stepBudget: 8,
    });

    expect(result).toEqual({
      status: 'repaired',
      attempts: 1,
      changedPaths: ['wiki/global/account.md'],
    });
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

  it('fails when the repair agent completes without editing any touched path', async () => {
    const { workdir, patchPath, trace } = await makeHarness();
    const result = await resolveTextualConflict({
      agentRunner: { runLoop: vi.fn(async () => ({ stopReason: 'natural' })) },
      workdir,
      unitKey: 'wu-a',
      patchPath,
      touchedPaths: ['wiki/global/account.md'],
      trace,
      reason: 'patch failed: wiki/global/account.md',
      maxAttempts: 1,
      stepBudget: 8,
    });

    expect(result).toEqual({
      status: 'failed',
      attempts: 1,
      reason: 'resolver completed without editing an allowed path',
    });
  });
});
