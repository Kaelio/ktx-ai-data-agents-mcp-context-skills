import { readFile } from 'node:fs/promises';
import { parseIngestReportSnapshot, type IngestReportSnapshot } from './context/ingest/index.js';

export async function readIngestReportSnapshotFile(reportFile: string): Promise<IngestReportSnapshot> {
  const raw = await readFile(reportFile, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ingest report file ${reportFile}: ${message}`);
  }

  try {
    return parseIngestReportSnapshot(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ingest report file ${reportFile}: ${message}`);
  }
}
