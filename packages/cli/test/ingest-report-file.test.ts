import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readIngestReportSnapshotFile } from '../src/ingest-report-file.js';

function reportSnapshot() {
  return {
    id: 'report-1',
    runId: 'run-1',
    jobId: 'job-1',
    connectionId: 'warehouse',
    sourceKey: 'metabase',
    createdAt: '2026-04-30T12:00:00.000Z',
    body: {
      syncId: 'sync-1',
      diffSummary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
      commitSha: null,
      workUnits: [],
      failedWorkUnits: [],
      reconciliationSkipped: true,
      conflictsResolved: [],
      evictionsApplied: [],
      unmappedFallbacks: [],
      evictionInputs: [],
      unresolvedCards: [],
      supersededBy: null,
      overrideOf: null,
      provenanceRows: [],
      toolTranscripts: [],
    },
  };
}

describe('readIngestReportSnapshotFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-report-file-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads and parses an ingest report JSON file', async () => {
    const reportPath = join(tempDir, 'report.json');
    await writeFile(reportPath, `${JSON.stringify(reportSnapshot(), null, 2)}\n`, 'utf-8');

    const report = await readIngestReportSnapshotFile(reportPath);

    expect(report).toMatchObject({
      id: 'report-1',
      runId: 'run-1',
      jobId: 'job-1',
      connectionId: 'warehouse',
      sourceKey: 'metabase',
    });
  });

  it('reports invalid JSON with the file path', async () => {
    const reportPath = join(tempDir, 'invalid.json');
    await writeFile(reportPath, '{not json', 'utf-8');

    await expect(readIngestReportSnapshotFile(reportPath)).rejects.toThrow(
      `Invalid JSON in ingest report file ${reportPath}`,
    );
  });

  it('reports schema failures with the file path', async () => {
    const reportPath = join(tempDir, 'wrong-shape.json');
    await writeFile(reportPath, JSON.stringify({ id: 'report-1' }), 'utf-8');

    await expect(readIngestReportSnapshotFile(reportPath)).rejects.toThrow(
      `Invalid ingest report file ${reportPath}`,
    );
  });
});
