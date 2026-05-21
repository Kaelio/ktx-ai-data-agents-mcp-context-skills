import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ParsedLookmlProject } from './parse.js';
import {
  LOOKML_FETCH_REPORT_FILE,
  LOOKML_MISMATCHED_MODELS_FILE,
  buildLookmlValidationArtifacts,
  readLookmlFetchReport,
  readLookmlMismatchedModelNames,
  writeLookmlValidationArtifacts,
} from './fetch-report.js';

function project(models: ParsedLookmlProject['models']): ParsedLookmlProject {
  return { models, views: [], dashboards: [], allPaths: models.map((m) => m.path) };
}

describe('LookML validation fetch report', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'lookml-report-'));
  });

  afterEach(async () => rm(stagedDir, { recursive: true, force: true }));

  it('emits partial warning artifacts for mismatched model connection names', async () => {
    const artifacts = buildLookmlValidationArtifacts(
      project([
        {
          path: 'b2b.model.lkml',
          name: 'b2b',
          includes: [],
          explores: ['orders'],
          connectionName: 'staging_pg',
        },
        {
          path: 'finance.model.lkml',
          name: 'finance',
          includes: [],
          explores: ['revenue'],
          connectionName: 'b2b_sandbox_bq',
        },
      ]),
      { expectedLookerConnectionName: 'b2b_sandbox_bq' },
    );

    expect(artifacts.mismatchedModelNames).toEqual(['b2b']);
    expect(artifacts.report.status).toBe('partial');
    expect(artifacts.report.warnings).toEqual([
      {
        rawPath: 'b2b.model.lkml',
        entityType: 'lookml_models',
        entityId: 'b2b',
        severity: 'warning',
        statusCode: null,
        message:
          'LookML model b2b declares connection staging_pg but this warehouse expects b2b_sandbox_bq; SL writes are disabled for this model.',
        retryRecommended: false,
        kind: 'lookml_connection_mismatch',
        details: { model: 'b2b', declared: 'staging_pg', expected: 'b2b_sandbox_bq' },
      },
    ]);
  });

  it('emits success when no expected connection is configured', () => {
    const artifacts = buildLookmlValidationArtifacts(
      project([
        {
          path: 'b2b.model.lkml',
          name: 'b2b',
          includes: [],
          explores: [],
          connectionName: 'staging_pg',
        },
      ]),
      { expectedLookerConnectionName: null },
    );

    expect(artifacts.mismatchedModelNames).toEqual([]);
    expect(artifacts.report).toEqual({
      status: 'success',
      retryRecommended: false,
      skipped: [],
      warnings: [],
    });
  });

  it('round-trips the fetch report and mismatched model sidecar', async () => {
    const artifacts = buildLookmlValidationArtifacts(
      project([
        {
          path: 'orders.model.lkml',
          name: 'orders',
          includes: [],
          explores: [],
          connectionName: 'wrong',
        },
      ]),
      { expectedLookerConnectionName: 'expected' },
    );

    await writeLookmlValidationArtifacts(stagedDir, artifacts);

    await expect(readFile(join(stagedDir, LOOKML_FETCH_REPORT_FILE), 'utf-8')).resolves.toContain(
      'lookml_connection_mismatch',
    );
    await expect(readFile(join(stagedDir, LOOKML_MISMATCHED_MODELS_FILE), 'utf-8')).resolves.toContain('orders');
    await expect(readLookmlFetchReport(stagedDir)).resolves.toEqual(artifacts.report);
    await expect(readLookmlMismatchedModelNames(stagedDir)).resolves.toEqual(new Set(['orders']));
  });
});
