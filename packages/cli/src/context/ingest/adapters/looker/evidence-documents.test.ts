import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLookerTriageSignals, writeLookerEvidenceDocuments } from './evidence-documents.js';

async function writeJson(root: string, relPath: string, value: unknown): Promise<void> {
  const target = join(root, relPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function readJson<T>(root: string, relPath: string): Promise<T> {
  return JSON.parse(await readFile(join(root, relPath), 'utf-8')) as T;
}

describe('Looker evidence documents', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'looker-evidence-docs-'));
    await writeJson(stagedDir, 'explores/b2b/sales_pipeline.json', {
      modelName: 'b2b',
      exploreName: 'sales_pipeline',
      label: 'Sales Pipeline',
      description: 'Pipeline analysis explore.',
      fields: {
        dimensions: [
          { name: 'opportunities.stage', label: 'Stage', type: 'string', sql: '${TABLE}.stage', description: null },
        ],
        measures: [
          {
            name: 'opportunities.arr',
            label: 'ARR',
            type: 'sum',
            sql: '${TABLE}.arr',
            description: 'Annual recurring revenue.',
          },
        ],
      },
      joins: [{ name: 'accounts', type: 'left_outer', relationship: 'many_to_one' }],
    });
    await writeJson(stagedDir, 'dashboards/10.json', {
      lookerId: '10',
      title: 'Sales Pipeline Overview',
      description: 'Executive dashboard for open pipeline ARR.',
      folderId: '7',
      ownerId: '3',
      updatedAt: '2026-04-30T10:00:00.000Z',
      tiles: [
        {
          id: '100',
          title: 'Open Pipeline ARR',
          lookId: null,
          query: {
            model: 'b2b',
            view: 'sales_pipeline',
            fields: ['opportunities.arr', 'opportunities.stage'],
            filters: { 'opportunities.stage': 'open' },
            sorts: ['opportunities.arr desc'],
            limit: '500',
          },
        },
      ],
    });
    await writeJson(stagedDir, 'looks/20.json', {
      lookerId: '20',
      title: 'Active Opportunity Pipeline',
      description: 'Saved Look for active opportunity pipeline review.',
      folderId: '7',
      ownerId: '3',
      updatedAt: '2026-04-30T11:00:00.000Z',
      query: {
        model: 'b2b',
        view: 'sales_pipeline',
        fields: ['opportunities.arr'],
        filters: { 'opportunities.stage': 'open' },
        sorts: [],
        limit: '500',
      },
    });
    await writeJson(stagedDir, 'signals/dashboard_usage.json', [
      {
        contentId: '10',
        queryCount30d: 80,
        uniqueUsers30d: 12,
        lastRunAt: '2026-04-30T09:00:00.000Z',
        topUsers: ['3'],
      },
    ]);
    await writeJson(stagedDir, 'signals/look_usage.json', [
      {
        contentId: '20',
        queryCount30d: 2,
        uniqueUsers30d: 1,
        lastRunAt: '2026-04-29T09:00:00.000Z',
        topUsers: ['3'],
      },
    ]);
    await writeJson(stagedDir, 'signals/scheduled_plans.json', [
      { contentId: '10', contentType: 'dashboard', isScheduled: true, scheduleCount: 2, recipientCount: 5 },
    ]);
    await writeJson(stagedDir, 'signals/favorites.json', [
      { contentId: '10', contentType: 'dashboard', favoriteCount: 4 },
    ]);
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('writes indexable metadata and markdown for explores, dashboards, and Looks', async () => {
    await writeLookerEvidenceDocuments(stagedDir);

    await expect(readJson(stagedDir, 'evidence/explores/b2b/sales_pipeline/metadata.json')).resolves.toMatchObject({
      objectType: 'looker_explore',
      id: 'looker:explore:b2b.sales_pipeline',
      title: 'Sales Pipeline',
      path: 'Looker / Explores / b2b.sales_pipeline',
      properties: {
        rawPath: 'explores/b2b/sales_pipeline.json',
        modelName: 'b2b',
        exploreName: 'sales_pipeline',
      },
    });
    await expect(readJson(stagedDir, 'evidence/dashboards/10/metadata.json')).resolves.toMatchObject({
      objectType: 'looker_dashboard',
      id: 'looker:dashboard:10',
      title: 'Sales Pipeline Overview',
      path: 'Looker / Dashboards / Sales Pipeline Overview',
      lastEditedAt: '2026-04-30T10:00:00.000Z',
      properties: {
        rawPath: 'dashboards/10.json',
        lookerId: '10',
      },
    });
    await expect(readJson(stagedDir, 'evidence/looks/20/metadata.json')).resolves.toMatchObject({
      objectType: 'looker_look',
      id: 'looker:look:20',
      title: 'Active Opportunity Pipeline',
      path: 'Looker / Looks / Active Opportunity Pipeline',
      properties: {
        rawPath: 'looks/20.json',
        lookerId: '20',
      },
    });

    const dashboardMarkdown = await readFile(join(stagedDir, 'evidence/dashboards/10/page.md'), 'utf-8');
    expect(dashboardMarkdown).toContain('# Sales Pipeline Overview');
    expect(dashboardMarkdown).toContain('Executive dashboard for open pipeline ARR.');
    expect(dashboardMarkdown).toContain('## Tile: Open Pipeline ARR');
    expect(dashboardMarkdown).toContain('- model: b2b');
    expect(dashboardMarkdown).toContain('- explore: sales_pipeline');
    expect(dashboardMarkdown).toContain('- opportunities.stage = open');
    expect(dashboardMarkdown).not.toContain('80');
    expect(dashboardMarkdown).not.toContain('queryCount30d');
    expect(dashboardMarkdown).not.toContain('recipient');
    expect(dashboardMarkdown).not.toContain('favorite');
    expect(dashboardMarkdown).not.toContain('owner');
  });

  it('returns usage-aware triage signals without exposing usage as document prose', async () => {
    await writeLookerEvidenceDocuments(stagedDir);

    await expect(getLookerTriageSignals(stagedDir, 'looker:dashboard:10')).resolves.toEqual({
      objectType: 'looker_dashboard',
      propertyHints: {
        contentType: 'dashboard',
        queryCount30d: '80',
        uniqueUsers30d: '12',
        isScheduled: 'true',
        favoriteCount: '4',
      },
      lastEditedAt: '2026-04-30T10:00:00.000Z',
    });
    await expect(getLookerTriageSignals(stagedDir, 'looker:look:20')).resolves.toEqual({
      objectType: 'looker_look',
      propertyHints: {
        contentType: 'look',
        queryCount30d: '2',
        uniqueUsers30d: '1',
        isScheduled: 'false',
        favoriteCount: '0',
      },
      lastEditedAt: '2026-04-30T11:00:00.000Z',
    });
  });
});
