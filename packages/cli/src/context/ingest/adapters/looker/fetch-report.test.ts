import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLookerFetchReport, writeLookerFetchReport } from './fetch-report.js';

describe('Looker staged fetch report', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'looker-fetch-report-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('returns null when a staged bundle has no fetch report', async () => {
    await expect(readLookerFetchReport(stagedDir)).resolves.toBeNull();
  });

  it('round-trips partial fetch issues', async () => {
    await writeLookerFetchReport(stagedDir, {
      status: 'partial',
      retryRecommended: true,
      skipped: [
        {
          rawPath: 'dashboards/10.json',
          entityType: 'dashboard',
          entityId: '10',
          severity: 'error',
          statusCode: 429,
          message: 'Looker API rate limit remained after retry',
          retryRecommended: true,
        },
      ],
      warnings: [
        {
          rawPath: 'signals/dashboard_usage.json',
          entityType: 'signals',
          entityId: null,
          severity: 'warning',
          statusCode: 403,
          message: 'system__activity unavailable',
          retryRecommended: false,
        },
      ],
    });

    await expect(readLookerFetchReport(stagedDir)).resolves.toEqual({
      status: 'partial',
      retryRecommended: true,
      skipped: [
        {
          rawPath: 'dashboards/10.json',
          entityType: 'dashboard',
          entityId: '10',
          severity: 'error',
          statusCode: 429,
          message: 'Looker API rate limit remained after retry',
          retryRecommended: true,
        },
      ],
      warnings: [
        {
          rawPath: 'signals/dashboard_usage.json',
          entityType: 'signals',
          entityId: null,
          severity: 'warning',
          statusCode: 403,
          message: 'system__activity unavailable',
          retryRecommended: false,
        },
      ],
    });
  });
});
