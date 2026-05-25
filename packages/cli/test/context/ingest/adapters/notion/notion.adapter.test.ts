import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffSetService } from '../../../../../src/context/ingest/diff-set.service.js';
import { NOTION_ORG_KNOWLEDGE_WARNING } from '../../../../../src/context/ingest/adapters/notion/chunk.js';
import { NotionSourceAdapter } from '../../../../../src/context/ingest/adapters/notion/notion.adapter.js';

describe('NotionSourceAdapter', () => {
  let stagedDir: string;
  let adapter: NotionSourceAdapter;
  let onPullSucceeded: ReturnType<typeof vi.fn<(ctx: any) => Promise<void>>>;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'notion-adapter-'));
    onPullSucceeded = vi.fn().mockResolvedValue(undefined);
    adapter = new NotionSourceAdapter({ onPullSucceeded: async (ctx) => onPullSucceeded(ctx) });
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  async function writePage(id: string, title: string, body = 'Durable rule.\n'): Promise<void> {
    await mkdir(join(stagedDir, 'pages', id), { recursive: true });
    await writeFile(
      join(stagedDir, 'pages', id, 'metadata.json'),
      JSON.stringify({
        objectType: 'page',
        id,
        title,
        path: `Company / ${title}`,
        url: null,
        parentId: null,
        databaseId: null,
        dataSourceId: null,
        lastEditedAt: null,
        lastEditedBy: null,
        properties: {},
      }),
      'utf-8',
    );
    await writeFile(join(stagedDir, 'pages', id, 'page.md'), `# ${title}\n\n${body}`, 'utf-8');
    await writeFile(join(stagedDir, 'pages', id, 'blocks.json'), '[]\n', 'utf-8');
  }

  it('declares Notion source behavior', () => {
    expect(adapter.source).toBe('notion');
    expect(adapter.skillNames).toEqual(['notion_synthesize']);
    expect(adapter.reconcileSkillNames).toEqual([]);
    expect(adapter.evidenceIndexing).toBe('documents');
    expect(adapter.triageSupported).toBe(true);
  });

  it('returns configured target warehouse connection ids', async () => {
    const adapter = new NotionSourceAdapter({
      targetConnectionIds: ['warehouse', 'warehouse', 'analytics'],
    });

    await expect(adapter.listTargetConnectionIds?.(stagedDir)).resolves.toEqual(['analytics', 'warehouse']);
  });

  it('returns structural triage signals for a staged Notion page', async () => {
    await mkdir(join(stagedDir, 'pages', 'page-1'), { recursive: true });
    await writeFile(
      join(stagedDir, 'pages', 'page-1', 'metadata.json'),
      JSON.stringify({
        objectType: 'data_source_row',
        id: 'page-1',
        title: '2026-04-29 Daily Sync',
        path: 'Company / Daily Syncs / 2026-04-29 Daily Sync',
        url: null,
        parentId: 'parent-page',
        databaseId: 'database-1',
        dataSourceId: 'data-source-1',
        lastEditedAt: '2026-04-29T12:00:00.000Z',
        lastEditedBy: 'Jane Doe',
        properties: {
          Status: 'Complete',
          Owner: 'Ops',
          Count: 3,
          Nested: { ignored: true },
        },
      }),
      'utf-8',
    );

    await expect(adapter.getTriageSignals?.(stagedDir, 'page-1')).resolves.toEqual({
      parentType: 'data_source_id',
      objectType: 'data_source_row',
      isDateTitled: true,
      lastEditedAt: '2026-04-29T12:00:00.000Z',
      propertyHints: {
        Count: '3',
        Owner: 'Ops',
        Status: 'Complete',
      },
    });
  });

  it('detects a Notion staged dir from manifest source', async () => {
    await writeFile(
      join(stagedDir, 'manifest.json'),
      JSON.stringify({ source: 'notion', apiVersion: '2026-03-11' }),
      'utf-8',
    );
    expect(await adapter.detect(stagedDir)).toBe(true);
  });

  it('does not delete prior pages omitted by a capped partial snapshot', async () => {
    await writeFile(
      join(stagedDir, 'manifest.json'),
      JSON.stringify({
        source: 'notion',
        apiVersion: '2026-03-11',
        crawlMode: 'selected_roots',
        rootPageIds: ['page-1', 'page-2'],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        fetchedAt: '2026-04-28T00:00:00.000Z',
        pageCount: 1,
        databaseCount: 0,
        dataSourceCount: 0,
        capped: true,
        continuedFromCursor: false,
        partialSnapshot: true,
        maxPagesPerRun: 1,
        maxKnowledgeCreatesPerRun: 25,
        maxKnowledgeUpdatesPerRun: 20,
        skipped: [],
        warnings: ['maxPagesPerRun reached at 1'],
      }),
      'utf-8',
    );
    await writePage('page-1', 'Revenue Recognition');

    const scope = await adapter.describeScope(stagedDir);
    const diffSetService = new DiffSetService({
      findLatestHashesForCompletedSyncs: vi.fn().mockResolvedValue(
        new Map([
          ['manifest.json', 'old-manifest'],
          ['pages/page-1/page.md', 'same'],
          ['pages/page-2/page.md', 'prior-page-two'],
        ]),
      ),
    } as never);
    const diff = await diffSetService.compute(
      'conn-1',
      'notion',
      new Map([
        ['manifest.json', 'new-manifest'],
        ['pages/page-1/page.md', 'same'],
      ]),
      scope.isPathInScope.bind(scope),
    );

    expect(diff.deleted).toEqual([]);
  });

  it('does not delete prior pages omitted by an uncapped all_accessible cursor continuation', async () => {
    await writeFile(
      join(stagedDir, 'manifest.json'),
      JSON.stringify({
        source: 'notion',
        apiVersion: '2026-03-11',
        crawlMode: 'all_accessible',
        rootPageIds: [],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        fetchedAt: '2026-04-28T00:00:00.000Z',
        pageCount: 1,
        databaseCount: 0,
        dataSourceCount: 0,
        capped: false,
        continuedFromCursor: true,
        partialSnapshot: true,
        maxPagesPerRun: 100,
        maxKnowledgeCreatesPerRun: 25,
        maxKnowledgeUpdatesPerRun: 20,
        nextSuccessfulCursor: null,
        skipped: [],
        warnings: [],
      }),
      'utf-8',
    );
    await writePage('page-2', 'Later Page');

    const scope = await adapter.describeScope(stagedDir);
    const diffSetService = new DiffSetService({
      findLatestHashesForCompletedSyncs: vi.fn().mockResolvedValue(
        new Map([
          ['manifest.json', 'old-manifest'],
          ['pages/page-1/page.md', 'prior-page-one'],
          ['pages/page-2/page.md', 'same'],
        ]),
      ),
    } as never);
    const diff = await diffSetService.compute(
      'conn-1',
      'notion',
      new Map([
        ['manifest.json', 'new-manifest'],
        ['pages/page-2/page.md', 'same'],
      ]),
      scope.isPathInScope.bind(scope),
    );

    expect(diff.deleted).toEqual([]);
  });

  it('chunks changed pages into candidate-extraction work units', async () => {
    await writeFile(
      join(stagedDir, 'manifest.json'),
      JSON.stringify({
        source: 'notion',
        apiVersion: '2026-03-11',
        crawlMode: 'selected_roots',
        rootPageIds: ['page-1'],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        fetchedAt: '2026-04-28T00:00:00.000Z',
        pageCount: 1,
        databaseCount: 0,
        dataSourceCount: 0,
        capped: false,
        continuedFromCursor: false,
        partialSnapshot: false,
        maxPagesPerRun: 100,
        maxKnowledgeCreatesPerRun: 25,
        maxKnowledgeUpdatesPerRun: 20,
        skipped: [],
        warnings: [],
      }),
      'utf-8',
    );
    await writePage('page-1', 'Revenue Recognition');

    const result = await adapter.chunk(stagedDir, {
      added: ['pages/page-1/page.md', 'pages/page-1/metadata.json'],
      modified: [],
      deleted: [],
      unchanged: ['manifest.json', 'pages/page-1/blocks.json'],
    });

    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0]).toMatchObject({
      unitKey: 'notion-page-page-1',
      rawFiles: ['pages/page-1/metadata.json', 'pages/page-1/page.md'],
      dependencyPaths: ['manifest.json', 'pages/page-1/blocks.json'],
    });
    expect(result.workUnits[0].notes).toContain('Synthesize durable wiki and SL knowledge');
    expect(result.workUnits[0].notes).toContain('emit_unmapped_fallback');
    expect(result.workUnits[0].notes).toContain('discover_data');
    expect(result.workUnits[0].notes).toContain('entity_details');
    expect(result.workUnits[0].notes).toContain('use reason no_physical_table rather than no_connection_mapping');
    expect(result.workUnits[0].notes).toContain('Do not create SL sources under the Notion connection');
    expect(result.workUnits[0].notes).toContain(
      'Wiki keys must be flat slugs like orbit-company-overview, not orbit/company-overview',
    );
    expect(result.reconcileNotes).toEqual([
      'Notion maxKnowledgeCreatesPerRun=25',
      'Notion maxKnowledgeUpdatesPerRun=20',
      'Notion dataSourceCount is Notion-only; use discover_data/entity_details for warehouse/dbt mapping decisions.',
      'Reconcile Notion wiki pages sharing tables/sl_refs before creating distinct artifacts.',
    ]);
    expect(result.contextReport).toEqual({ capped: false, warnings: [NOTION_ORG_KNOWLEDGE_WARNING] });
  });

  it('chunks retried pages when failed provenance makes unchanged raw files look added again', async () => {
    await writeFile(
      join(stagedDir, 'manifest.json'),
      JSON.stringify({
        source: 'notion',
        apiVersion: '2026-03-11',
        crawlMode: 'selected_roots',
        rootPageIds: ['page-1'],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        fetchedAt: '2026-04-28T00:00:00.000Z',
        pageCount: 1,
        databaseCount: 0,
        dataSourceCount: 0,
        capped: false,
        continuedFromCursor: false,
        partialSnapshot: false,
        maxPagesPerRun: 100,
        maxKnowledgeCreatesPerRun: 25,
        maxKnowledgeUpdatesPerRun: 20,
        skipped: [],
        warnings: [],
      }),
      'utf-8',
    );
    await writePage('page-1', 'Retry Me');

    const result = await adapter.chunk(stagedDir, {
      added: ['pages/page-1/metadata.json', 'pages/page-1/page.md'],
      modified: [],
      deleted: [],
      unchanged: ['manifest.json', 'pages/page-1/blocks.json'],
    });

    expect(result.workUnits.map((workUnit) => workUnit.unitKey)).toEqual(['notion-page-page-1']);
  });

  it('reports malformed manifests with a Notion-specific error', async () => {
    await writeFile(join(stagedDir, 'manifest.json'), '{bad json', 'utf-8');

    await expect(adapter.chunk(stagedDir)).rejects.toThrow(/Invalid Notion manifest/);
  });

  it('splits oversized changed pages into span-scoped work units', async () => {
    await writeFile(
      join(stagedDir, 'manifest.json'),
      JSON.stringify({
        source: 'notion',
        apiVersion: '2026-03-11',
        crawlMode: 'selected_roots',
        rootPageIds: ['page-1'],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        fetchedAt: '2026-04-28T00:00:00.000Z',
        pageCount: 1,
        databaseCount: 0,
        dataSourceCount: 0,
        capped: false,
        continuedFromCursor: false,
        partialSnapshot: false,
        maxPagesPerRun: 100,
        maxKnowledgeCreatesPerRun: 5,
        maxKnowledgeUpdatesPerRun: 20,
        skipped: [],
        warnings: [],
      }),
      'utf-8',
    );
    await writePage(
      'page-1',
      'Giant Parent',
      Array.from({ length: 2600 }, (_, i) => `Line ${i + 1}: durable context.`).join('\n'),
    );

    const result = await adapter.chunk(stagedDir, {
      added: ['pages/page-1/page.md', 'pages/page-1/metadata.json'],
      modified: [],
      deleted: [],
      unchanged: ['manifest.json', 'pages/page-1/blocks.json'],
    });

    expect(result.workUnits.length).toBeGreaterThan(1);
    expect(result.workUnits[0]).toMatchObject({
      unitKey: 'notion-page-page-1-part-1',
      rawFiles: ['pages/page-1/metadata.json', 'pages/page-1/page.md'],
    });
    expect(result.workUnits[0].notes).toContain('Use read_raw_span');
    expect(result.workUnits[0].notes).toMatch(/lines 1-\d+/);
    expect(result.workUnits.at(-1)?.notes).toMatch(/lines \d+-2602/);
    expect(result.contextReport?.warnings).toContain(
      'Oversized Notion page split into span-scoped work units: Company / Giant Parent',
    );
  });

  it('persists the manifest continuation cursor after successful pulls', async () => {
    const completedAt = new Date('2026-04-28T01:00:00.000Z');
    const nextSuccessfulCursor = JSON.stringify({ phase: 'all_accessible_pages', cursor: 'cursor-2' });
    await writeFile(
      join(stagedDir, 'manifest.json'),
      JSON.stringify({
        source: 'notion',
        apiVersion: '2026-03-11',
        crawlMode: 'all_accessible',
        rootPageIds: [],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        fetchedAt: '2026-04-28T00:00:00.000Z',
        pageCount: 1,
        databaseCount: 0,
        dataSourceCount: 0,
        capped: true,
        continuedFromCursor: false,
        partialSnapshot: true,
        maxPagesPerRun: 1,
        maxKnowledgeCreatesPerRun: 5,
        maxKnowledgeUpdatesPerRun: 20,
        nextSuccessfulCursor,
        skipped: [],
        warnings: ['maxPagesPerRun reached at 1'],
      }),
      'utf-8',
    );

    await adapter.onPullSucceeded({
      connectionId: 'conn-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      trigger: 'scheduled_pull',
      completedAt,
      stagedDir,
    });

    expect(onPullSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn-1', completedAt, nextSuccessfulCursor }),
    );
  });
});
