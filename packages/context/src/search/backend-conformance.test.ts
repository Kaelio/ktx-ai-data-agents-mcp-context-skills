import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { SqliteContextEvidenceStore } from '../ingest/context-evidence/index.js';
import type { JsonValue } from '../ingest/ports.js';
import { initKtxProject, type KtxLocalProject } from '../project/index.js';
import { type LocalSlSourceSearchResult, searchLocalSlSources, writeLocalSlSource } from '../sl/local-sl.js';
import type { ContextEvidenceSearchResult } from '../tools/context-evidence-tool-store.js';
import {
  type LocalKnowledgeSearchResult,
  searchLocalKnowledgePages,
  writeLocalKnowledgePage,
} from '../wiki/local-knowledge.js';
import {
  assertSearchBackendCapabilities,
  assertSearchBackendConformanceCase,
  type SearchBackendConformanceResult,
} from './backend-conformance.js';
import type { SearchBackendCapabilities } from './types.js';

const SQLITE_SEARCH_CAPABILITIES = {
  fts: true,
  vector: false,
  fuzzy: false,
  jsonSearch: true,
  arraySearch: false,
} satisfies SearchBackendCapabilities;

const ORDERS_YAML = [
  'name: orders',
  'table: public.orders',
  'grain:',
  '  - order_id',
  'columns:',
  '  - name: order_id',
  '    type: string',
  '  - name: revenue',
  '    type: number',
  'measures:',
  '  - name: total_revenue',
  '    expr: sum(revenue)',
  '',
].join('\n');

const FINANCE_ORDERS_YAML = [
  'name: orders',
  'description: Finance orders used for invoice reconciliation.',
  'table: finance.orders',
  'grain:',
  '  - order_id',
  'columns:',
  '  - name: order_id',
  '    type: string',
  '  - name: invoice_status',
  '    type: string',
  '',
].join('\n');

class FakeEmbeddingPort {
  readonly maxBatchSize = 16;

  async computeEmbedding(text: string): Promise<number[]> {
    return text.toLowerCase().includes('semantic revenue') ? [1, 0] : [0, 1];
  }

  async computeEmbeddingsBulk(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.computeEmbedding(text)));
  }
}

function toSlConformanceResult(result: LocalSlSourceSearchResult): SearchBackendConformanceResult {
  return {
    id: `${result.connectionId}/${result.name}`,
    score: result.score ?? 0,
    matchReasons: result.matchReasons ?? [],
    lanes: result.lanes,
    dictionaryMatches: result.dictionaryMatches,
  };
}

function toWikiConformanceResult(result: LocalKnowledgeSearchResult): SearchBackendConformanceResult {
  return {
    id: result.key,
    score: result.score,
    matchReasons: result.matchReasons,
    lanes: result.lanes,
  };
}

function toContextConformanceResult(result: ContextEvidenceSearchResult): SearchBackendConformanceResult {
  return {
    id: `${result.externalId}:${result.stableCitationKey}`,
    score: result.score,
    matchReasons: result.matchReasons ?? [],
    lanes: result.lanes,
  };
}

async function seedSemanticLayerProject(project: KtxLocalProject): Promise<void> {
  await writeLocalSlSource(project, {
    connectionId: 'warehouse',
    sourceName: 'orders',
    yaml: ORDERS_YAML,
  });
  await writeLocalSlSource(project, {
    connectionId: 'finance',
    sourceName: 'orders',
    yaml: FINANCE_ORDERS_YAML,
  });
  await project.fileStore.writeFile(
    'raw-sources/warehouse/live-database/sync-1/enrichment/relationship-profile.json',
    `${JSON.stringify(
      {
        connectionId: 'warehouse',
        driver: 'postgres',
        sqlAvailable: true,
        queryCount: 2,
        tables: [],
        columns: {
          'orders.status': {
            table: { catalog: null, db: 'public', name: 'orders' },
            column: 'status',
            nativeType: 'text',
            normalizedType: 'string',
            rowCount: 10,
            nullCount: 0,
            distinctCount: 2,
            uniquenessRatio: 0.2,
            nullRate: 0,
            sampleValues: ['paid', 'refunded'],
            minTextLength: 4,
            maxTextLength: 8,
          },
        },
        warnings: [],
      },
      null,
      2,
    )}\n`,
    'ktx',
    'ktx@example.com',
    'Seed dictionary profile',
  );
}

async function seedWikiProject(project: KtxLocalProject): Promise<void> {
  await writeLocalKnowledgePage(project, {
    key: 'metrics-revenue',
    scope: 'GLOBAL',
    summary: 'Semantic revenue definition',
    content: 'Revenue is recognized when an order is paid.',
    tags: ['finance'],
    refs: ['semantic-layer/warehouse/orders.yaml'],
    slRefs: ['orders'],
  });
  await writeLocalKnowledgePage(project, {
    key: 'support-escalations',
    scope: 'GLOBAL',
    summary: 'Support escalation process',
    content: 'Escalations move urgent support tickets to the operations queue.',
    tags: ['operations'],
  });
}

async function seedContextDocument(
  subject: SqliteContextEvidenceStore,
  input: {
    runId?: string;
    syncId?: string;
    externalId?: string;
    title?: string;
    rawPath?: string;
    metadata?: JsonValue;
    publishState?: 'pending' | 'published';
    embedding?: number[] | null;
    content?: string;
    searchText?: string;
  } = {},
): Promise<{ documentId: string; chunkId: string }> {
  const runId = input.runId ?? 'run-1';
  const syncId = input.syncId ?? 'sync-1';
  const externalId = input.externalId ?? 'page-1';
  const title = input.title ?? 'Revenue Policy';
  const rawPath = input.rawPath ?? `pages/${externalId}/page.md`;
  const doc = await subject.upsertDocument({
    runId,
    connectionId: 'conn-1',
    sourceKey: 'notion',
    externalId,
    externalParentId: null,
    databaseId: null,
    dataSourceId: null,
    title,
    path: `Company Handbook / ${title}`,
    url: `https://notion.test/${externalId}`,
    objectType: 'page',
    lastEditedAt: new Date('2026-04-30T10:00:00.000Z'),
    lastEditedBy: 'user-1',
    rawPath,
    syncId,
    contentHash: `hash-${externalId}`,
    publishState: input.publishState ?? 'published',
    metadata: input.metadata ?? {},
  });
  await subject.replaceChunks(doc.id, [
    {
      chunkKey: 'intro',
      headingPath: ['Policy'],
      ordinal: 0,
      content: input.content ?? `${title} requires approval from the accountable owner.`,
      searchText: input.searchText ?? `${title} approval accountable owner`,
      embedding: input.embedding ?? [1, 0, 0],
      tokenCount: 8,
      citation: {
        source: 'notion',
        pageId: externalId,
        title,
        syncId,
        rawPath,
      },
      stableCitationKey: `notion:${externalId}:intro`,
      syncId,
      contentHash: `chunk-${externalId}`,
    },
  ]);

  const read = await subject.readDocumentByExternalId('conn-1', 'notion', externalId, runId);
  if (!read) {
    throw new Error(`seeded document ${externalId} was not readable`);
  }

  return { documentId: doc.id, chunkId: read.chunks[0].id };
}

describe('SQLite hybrid search backend conformance', () => {
  let tempDir: string;
  let project: KtxLocalProject;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-search-conformance-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project'), projectName: 'warehouse' });
    dbPath = join(tempDir, '.ktx', 'db.sqlite');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('documents SQLite search backend capabilities', () => {
    assertSearchBackendCapabilities({
      backendName: 'sqlite',
      capabilities: SQLITE_SEARCH_CAPABILITIES,
      expected: {
        fts: true,
        vector: false,
        fuzzy: false,
        jsonSearch: true,
        arraySearch: false,
      },
    });
  });

  it('keeps semantic-layer global ranking, dictionary evidence, and token fallback stable', async () => {
    await seedSemanticLayerProject(project);

    const global = await searchLocalSlSources(project, { query: 'orders', limit: 5 });
    assertSearchBackendConformanceCase({
      backendName: 'sqlite',
      surface: 'semantic-layer',
      caseName: 'global source ranking',
      results: global.map(toSlConformanceResult),
      expectedTopIds: ['finance/orders', 'warehouse/orders'],
      expectedReasonsById: {
        'finance/orders': ['lexical'],
        'warehouse/orders': ['lexical'],
      },
      expectedLanes: {
        lexical: { status: 'available' },
        semantic: { status: 'skipped', reason: 'embedding_unconfigured' },
      },
    });

    const dictionary = await searchLocalSlSources(project, {
      connectionId: 'warehouse',
      query: 'refunded',
      limit: 5,
    });
    assertSearchBackendConformanceCase({
      backendName: 'sqlite',
      surface: 'semantic-layer',
      caseName: 'dictionary source evidence',
      results: dictionary.map(toSlConformanceResult),
      expectedTopIds: ['warehouse/orders'],
      expectedReasonsById: {
        'warehouse/orders': ['dictionary'],
      },
      expectedLanes: {
        dictionary: { status: 'available' },
        semantic: { status: 'skipped', reason: 'embedding_unconfigured' },
      },
      expectedDictionaryMatchesById: {
        'warehouse/orders': [{ column: 'status', values: ['refunded'] }],
      },
    });

    const token = await searchLocalSlSources(project, {
      connectionId: 'warehouse',
      query: 'orders---',
      limit: 5,
    });
    assertSearchBackendConformanceCase({
      backendName: 'sqlite',
      surface: 'semantic-layer',
      caseName: 'token fallback reason',
      results: token.map(toSlConformanceResult),
      expectedTopIds: ['warehouse/orders'],
      expectedReasonsById: {
        'warehouse/orders': ['token'],
      },
      expectedLanes: {
        token: { status: 'available' },
      },
    });
  });

  it('keeps wiki lexical, semantic, and token behavior stable', async () => {
    await seedWikiProject(project);

    const lexical = await searchLocalKnowledgePages(project, {
      query: 'paid order',
      userId: 'local',
      limit: 5,
    });
    assertSearchBackendConformanceCase({
      backendName: 'sqlite',
      surface: 'wiki',
      caseName: 'lexical page ranking',
      results: lexical.map(toWikiConformanceResult),
      expectedTopIds: ['metrics-revenue'],
      expectedReasonsById: {
        'metrics-revenue': ['lexical'],
      },
      expectedLanes: {
        lexical: { status: 'available' },
        semantic: { status: 'skipped', reason: 'embedding_unconfigured' },
      },
    });

    const semantic = await searchLocalKnowledgePages(project, {
      query: 'semantic revenue',
      userId: 'local',
      limit: 5,
      embeddingService: new FakeEmbeddingPort(),
    });
    assertSearchBackendConformanceCase({
      backendName: 'sqlite',
      surface: 'wiki',
      caseName: 'semantic page ranking',
      results: semantic.map(toWikiConformanceResult),
      expectedTopIds: ['metrics-revenue'],
      expectedReasonsById: {
        'metrics-revenue': ['semantic'],
      },
      expectedLanes: {
        semantic: { status: 'available' },
      },
    });

    const token = await searchLocalKnowledgePages(project, {
      query: 'paid---',
      userId: 'local',
      limit: 5,
    });
    assertSearchBackendConformanceCase({
      backendName: 'sqlite',
      surface: 'wiki',
      caseName: 'token page fallback',
      results: token.map(toWikiConformanceResult),
      expectedTopIds: ['metrics-revenue'],
      expectedReasonsById: {
        'metrics-revenue': ['token'],
      },
      expectedLanes: {
        token: { status: 'available' },
      },
    });
  });

  it('keeps context-evidence lane fusion and token fallback stable', async () => {
    const subject = new SqliteContextEvidenceStore({ dbPath });
    await seedContextDocument(subject, {
      externalId: 'page-discount',
      title: 'Enterprise Discount Policy',
      content: 'Enterprise discounts require finance approval before quote approval.',
      searchText: 'enterprise discount finance approval quote',
      embedding: [1, 0, 0],
    });
    await seedContextDocument(subject, {
      externalId: 'page-owner',
      title: 'Accountable Owner Policy',
      content: 'Every policy has an accountable owner and review date.',
      searchText: 'accountable owner review date',
      embedding: [0.95, 0.05, 0],
    });
    await seedContextDocument(subject, {
      externalId: 'page-expense',
      title: 'Expense Policy',
      content: 'Expense reimbursement requires receipt review.',
      searchText: 'expense reimbursement receipt review',
      embedding: [0, 1, 0],
    });

    const fused = await subject.searchRRF({
      connectionId: 'conn-1',
      sourceKey: 'notion',
      queryEmbedding: [1, 0, 0],
      queryText: 'enterprise discount approval',
      limit: 2,
      includeDeleted: false,
    });
    assertSearchBackendConformanceCase({
      backendName: 'sqlite',
      surface: 'context-evidence',
      caseName: 'chunk lane fusion',
      results: fused.map(toContextConformanceResult),
      expectedTopIds: ['page-discount:notion:page-discount:intro'],
      expectedReasonsById: {
        'page-discount:notion:page-discount:intro': ['lexical', 'semantic', 'token'],
      },
      expectedLanes: {
        lexical: { status: 'available' },
        semantic: { status: 'available' },
        token: { status: 'available' },
      },
    });

    const tokenSubject = new SqliteContextEvidenceStore({ dbPath: join(tempDir, 'token.sqlite') });
    await seedContextDocument(tokenSubject, {
      externalId: 'page-cpp',
      title: 'C++ Warehouse Notes',
      content: 'C++ parser notes for warehouse extraction.',
      searchText: 'C++ parser warehouse extraction',
      embedding: null,
    });

    const token = await tokenSubject.searchRRF({
      connectionId: 'conn-1',
      sourceKey: 'notion',
      queryEmbedding: null,
      queryText: '++',
      limit: 5,
      includeDeleted: false,
    });
    assertSearchBackendConformanceCase({
      backendName: 'sqlite',
      surface: 'context-evidence',
      caseName: 'fts-empty token fallback',
      results: token.map(toContextConformanceResult),
      expectedTopIds: ['page-cpp:notion:page-cpp:intro'],
      expectedReasonsById: {
        'page-cpp:notion:page-cpp:intro': ['token'],
      },
      expectedLanes: {
        lexical: { status: 'skipped', reason: 'fts_query_empty' },
        semantic: { status: 'skipped', reason: 'embedding_unconfigured' },
        token: { status: 'available' },
      },
    });
  });
});
