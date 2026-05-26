import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileIngestTraceWriter, ingestTracePathForJob, traceTimed } from '../../../src/context/ingest/ingest-trace.js';

describe('FileIngestTraceWriter', () => {
  it('persists structured trace events as JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-trace-'));
    const tracePath = ingestTracePathForJob(root, 'job-1');
    const trace = new FileIngestTraceWriter({
      tracePath,
      jobId: 'job-1',
      connectionId: 'metabase-main',
      sourceKey: 'metabase',
      level: 'debug',
    });

    await trace.event('debug', 'snapshot', 'input_snapshot', {
      baseSha: 'abc123',
      rawFileCount: 2,
      diffSummary: { added: 1, modified: 1, deleted: 0, unchanged: 3 },
    });

    const lines = (await readFile(tracePath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      schemaVersion: 1,
      jobId: 'job-1',
      connectionId: 'metabase-main',
      sourceKey: 'metabase',
      level: 'debug',
      phase: 'snapshot',
      event: 'input_snapshot',
      data: {
        baseSha: 'abc123',
        rawFileCount: 2,
        diffSummary: { added: 1, modified: 1, deleted: 0, unchanged: 3 },
      },
    });
    expect(typeof lines[0].at).toBe('string');
  });

  it('records timing and error context for postmortem inspection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T12:00:00.000Z'));
    const root = await mkdtemp(join(tmpdir(), 'ktx-trace-'));
    const tracePath = ingestTracePathForJob(root, 'job-2');
    const trace = new FileIngestTraceWriter({
      tracePath,
      jobId: 'job-2',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    await expect(
      traceTimed(trace, 'integration', 'apply_patch', { unitKey: 'wu-1' }, async () => {
        vi.advanceTimersByTime(17);
        throw new Error('patch conflict');
      }),
    ).rejects.toThrow('patch conflict');

    const lines = (await readFile(tracePath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.event)).toEqual(['apply_patch_started', 'apply_patch_failed']);
    expect(lines[1]).toMatchObject({
      level: 'error',
      phase: 'integration',
      data: { unitKey: 'wu-1' },
      error: { name: 'Error', message: 'patch conflict' },
    });
    expect(lines[1].durationMs).toBe(17);
    vi.useRealTimers();
  });

  it('uses the documented trace path layout', () => {
    expect(ingestTracePathForJob('/project/.ktx', 'job-3')).toBe('/project/.ktx/ingest-traces/job-3/trace.jsonl');
  });
});
