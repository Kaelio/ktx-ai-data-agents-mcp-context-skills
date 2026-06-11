import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageTriageService } from '../../../../src/context/ingest/page-triage/page-triage.service.js';

describe('PageTriageService', () => {
  let stagedDir: string;
  let repository: {
    setDocumentTriageLane: ReturnType<typeof vi.fn>;
    listDocumentChunksForLightExtraction: ReturnType<typeof vi.fn>;
    insertCandidate: ReturnType<typeof vi.fn>;
  };
  let service: PageTriageService;
  let triageSettings: {
    enabled: boolean;
    maxConcurrency: number;
    lightExtractionEnabled: boolean;
    classifierModel: string | null;
    lightExtractionMaxCandidates: number;
  };
  let promptService: { loadPrompt: ReturnType<typeof vi.fn<(name: string) => Promise<string>>> };
  let adapter: { triageSupported: true; getTriageSignals: ReturnType<typeof vi.fn> };
  let llmRuntime: {
    generateText: ReturnType<typeof vi.fn>;
    generateObject: ReturnType<typeof vi.fn>;
    runAgentLoop: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'page-triage-'));
    await mkdir(join(stagedDir, 'pages', 'page-1'), { recursive: true });
    await writeFile(
      join(stagedDir, 'pages', 'page-1', 'metadata.json'),
      JSON.stringify({
        objectType: 'page',
        id: 'page-1',
        title: 'Support Handoff',
        path: 'Company / Support Handoff',
        url: null,
        parentId: null,
        databaseId: null,
        dataSourceId: null,
        lastEditedAt: '2026-04-29T12:00:00.000Z',
        lastEditedBy: null,
        properties: { Status: 'Approved' },
      }),
      'utf-8',
    );
    await writeFile(
      join(stagedDir, 'pages', 'page-1', 'page.md'),
      '# Support Handoff\n\nSupport handoffs require a named customer owner.\n',
      'utf-8',
    );

    repository = {
      setDocumentTriageLane: vi.fn().mockResolvedValue(1),
      listDocumentChunksForLightExtraction: vi.fn().mockResolvedValue([
        {
          chunkId: '00000000-0000-0000-0000-000000000101',
          headingPath: ['Support Handoff'],
          ordinal: 0,
          content: 'Support handoffs require a named customer owner.',
          stableCitationKey: 'notion:page-1:support-handoff',
          citation: { source: 'notion', pageId: 'page-1' },
          rawPath: 'pages/page-1/page.md',
          title: 'Support Handoff',
          path: 'Company / Support Handoff',
          url: null,
          lastEditedAt: new Date('2026-04-29T12:00:00.000Z'),
        },
      ]),
      insertCandidate: vi
        .fn()
        .mockImplementation((input) =>
          Promise.resolve({ candidate_key: input.candidateKey, promotion_score: input.promotionScore }),
        ),
    };
    triageSettings = {
      enabled: true,
      maxConcurrency: 2,
      lightExtractionEnabled: true,
      classifierModel: null,
      lightExtractionMaxCandidates: 3,
    };
    adapter = {
      triageSupported: true,
      getTriageSignals: vi.fn().mockResolvedValue({ objectType: 'page', propertyHints: { Status: 'Approved' } }),
    };
    promptService = {
      loadPrompt: vi
        .fn<(name: string) => Promise<string>>()
        .mockImplementation((name) => Promise.resolve(`prompt:${name}`)),
    };
    llmRuntime = {
      generateText: vi.fn(),
      generateObject: vi.fn(),
      runAgentLoop: vi.fn(),
    };
    service = new PageTriageService({
      store: repository as any,
      llmRuntime: llmRuntime as any,
      settings: triageSettings,
      promptService: promptService as any,
    });
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('writes light-lane candidates and keeps the page out of full WorkUnits', async () => {
    llmRuntime.generateText
      .mockResolvedValueOnce(JSON.stringify({ lane: 'light', reason: 'short durable policy' }))
      .mockResolvedValueOnce(
        JSON.stringify({
          candidates: [
            {
              candidateKey: 'support-handoff-owner',
              topic: 'Support Handoff',
              assertion: 'Support handoffs require a named customer owner.',
              rationale: 'The staged Support Handoff page states the owner rule.',
              evidenceChunkIds: ['00000000-0000-0000-0000-000000000101'],
              suggestedPageKey: 'support-handoff',
              actionHint: 'create',
              durabilityScore: 3,
              authorityScore: 2,
              reuseScore: 3,
              noveltyScore: 2,
              riskScore: 0,
            },
          ],
        }),
      );

    const result = await service.triageRun({
      stagedDir,
      runId: 'run-1',
      connectionId: 'conn-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      jobId: 'job-1',
      diffSet: {
        added: ['pages/page-1/metadata.json', 'pages/page-1/page.md'],
        modified: [],
        deleted: [],
        unchanged: [],
      },
      adapter: adapter as any,
    });

    expect(result.enabled).toBe(true);
    expect(result.report).toEqual({
      pageCount: 1,
      skip: 0,
      light: 1,
      full: 0,
      classifierFailures: 0,
      lightExtractionFailures: 0,
    });
    expect(result.fullRawPaths.has('pages/page-1/page.md')).toBe(false);
    expect(adapter.getTriageSignals).toHaveBeenCalledWith(stagedDir, 'page-1');
    expect(llmRuntime.generateText).toHaveBeenCalledWith(expect.objectContaining({ role: 'triage' }));
    expect(repository.setDocumentTriageLane).toHaveBeenCalledWith('run-1', 'pages/page-1/page.md', 'light');
    expect(repository.insertCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        candidateKey: 'support-handoff-owner',
        lane: 'light',
        promotionScore: 10,
      }),
    );
  });

  it('does not classify named reusable sales scripts as skip', async () => {
    await writeFile(
      join(stagedDir, 'pages', 'page-1', 'metadata.json'),
      JSON.stringify({
        objectType: 'page',
        id: 'page-1',
        title: 'Cold Call Script',
        path: 'Sales / Cold Call Script',
        url: null,
        parentId: null,
        databaseId: null,
        dataSourceId: null,
        lastEditedAt: '2026-04-29T12:00:00.000Z',
        lastEditedBy: null,
        properties: { Team: 'Sales' },
      }),
      'utf-8',
    );
    await writeFile(
      join(stagedDir, 'pages', 'page-1', 'page.md'),
      [
        '# Cold Call Script',
        '',
        'Reusable outbound sequence:',
        '',
        '- Ask about current customer success expansion workflow.',
        '- Position ktx as AI search visibility for CS teams.',
        '- Close with a discovery call request.',
      ].join('\n'),
      'utf-8',
    );

    promptService.loadPrompt.mockImplementation((name: string) => {
      if (name === 'skills/page_triage_classifier') {
        return Promise.resolve(
          [
            'Reusable templates and scripts are durable knowledge regardless of subject matter.',
            'Date-titled standups are still skip; named templates and scripts are not.',
          ].join('\n'),
        );
      }
      return Promise.resolve(`prompt:${name}`);
    });
    llmRuntime.generateText
      .mockImplementationOnce((args: any) => {
        const systemText = args.system as string;
        const userText = args.prompt as string;
        expect(systemText).toContain(
          'Reusable templates and scripts are durable knowledge regardless of subject matter.',
        );
        expect(systemText).toContain('Date-titled standups are still skip; named templates and scripts are not.');
        expect(userText).toContain('Cold Call Script');
        expect(userText).not.toContain('Reusable templates and scripts are durable knowledge');
        return JSON.stringify({ lane: 'light', reason: 'reusable sales script' });
      })
      .mockResolvedValueOnce(
        JSON.stringify({
          candidates: [
            {
              candidateKey: 'cold-call-script',
              topic: 'Cold Call Script',
              assertion: 'Cold call outreach should position ktx around AI search visibility for CS teams.',
              rationale: 'The script gives a reusable outbound call sequence and positioning language.',
              evidenceChunkIds: ['00000000-0000-0000-0000-000000000101'],
              suggestedPageKey: 'cold-call-script',
              actionHint: 'create',
              durabilityScore: 3,
              authorityScore: 2,
              reuseScore: 3,
              noveltyScore: 2,
              riskScore: 0,
            },
          ],
        }),
      );

    const result = await service.triageRun({
      stagedDir,
      runId: 'run-1',
      connectionId: 'conn-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      jobId: 'job-1',
      diffSet: {
        added: ['pages/page-1/metadata.json', 'pages/page-1/page.md'],
        modified: [],
        deleted: [],
        unchanged: [],
      },
      adapter: adapter as any,
    });

    expect(result.report).toMatchObject({ pageCount: 1, skip: 0, light: 1, full: 0 });
    expect(repository.setDocumentTriageLane).toHaveBeenCalledWith('run-1', 'pages/page-1/page.md', 'light');
  });

  it('triages Notion data-source row pages without reading data-source metadata as page markdown', async () => {
    triageSettings.lightExtractionEnabled = false;

    await mkdir(join(stagedDir, 'data-sources', 'ds-1', 'rows', 'row-1'), { recursive: true });
    await writeFile(
      join(stagedDir, 'data-sources', 'ds-1', 'metadata.json'),
      JSON.stringify({
        objectType: 'data_source',
        id: 'ds-1',
        title: 'Product Docs',
        path: 'Product Docs',
      }),
      'utf-8',
    );
    await writeFile(
      join(stagedDir, 'data-sources', 'ds-1', 'rows', 'row-1', 'metadata.json'),
      JSON.stringify({
        objectType: 'data_source_row',
        id: 'row-1',
        title: 'Launch Policy',
        path: 'Product Docs / Launch Policy',
        dataSourceId: 'ds-1',
      }),
      'utf-8',
    );
    await writeFile(
      join(stagedDir, 'data-sources', 'ds-1', 'rows', 'row-1', 'page.md'),
      '# Launch Policy\n\nLaunches require a customer-facing rollback owner.\n',
      'utf-8',
    );

    llmRuntime.generateText.mockResolvedValue(JSON.stringify({ lane: 'full', reason: 'durable policy page' }));

    const result = await service.triageRun({
      stagedDir,
      runId: 'run-1',
      connectionId: 'conn-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      jobId: 'job-1',
      diffSet: {
        added: [
          'pages/page-1/metadata.json',
          'pages/page-1/page.md',
          'data-sources/ds-1/metadata.json',
          'data-sources/ds-1/rows/row-1/metadata.json',
          'data-sources/ds-1/rows/row-1/page.md',
        ],
        modified: [],
        deleted: [],
        unchanged: [],
      },
      adapter: adapter as any,
    });

    expect(result.report).toMatchObject({ pageCount: 2, skip: 0, light: 0, full: 2 });
    expect([...result.fullRawPaths].sort()).toEqual(
      expect.arrayContaining(['data-sources/ds-1/rows/row-1/page.md', 'pages/page-1/page.md']),
    );
    expect(result.fullRawPaths.has('data-sources/ds-1/metadata.json')).toBe(false);
    expect(repository.setDocumentTriageLane).toHaveBeenCalledWith(
      'run-1',
      'data-sources/ds-1/rows/row-1/page.md',
      'full',
    );
  });

  it('falls back to full when classifier output is malformed', async () => {
    llmRuntime.generateText.mockResolvedValueOnce('not-json');

    const result = await service.triageRun({
      stagedDir,
      runId: 'run-1',
      connectionId: 'conn-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      jobId: 'job-1',
      diffSet: { added: ['pages/page-1/page.md'], modified: [], deleted: [], unchanged: [] },
      adapter: adapter as any,
    });

    expect(result.report).toMatchObject({ pageCount: 1, skip: 0, light: 0, full: 1, classifierFailures: 1 });
    expect(result.fullRawPaths.has('pages/page-1/page.md')).toBe(true);
    expect(repository.setDocumentTriageLane).toHaveBeenCalledWith('run-1', 'pages/page-1/page.md', 'full');
  });

  it('promotes a light page to full when light extraction fails', async () => {
    llmRuntime.generateText
      .mockResolvedValueOnce(JSON.stringify({ lane: 'light', reason: 'short durable policy' }))
      .mockRejectedValueOnce(new Error('provider unavailable'));

    const result = await service.triageRun({
      stagedDir,
      runId: 'run-1',
      connectionId: 'conn-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      jobId: 'job-1',
      diffSet: { added: ['pages/page-1/page.md'], modified: [], deleted: [], unchanged: [] },
      adapter: adapter as any,
    });

    expect(result.report).toMatchObject({ pageCount: 1, skip: 0, light: 0, full: 1, lightExtractionFailures: 1 });
    expect(result.fullRawPaths.has('pages/page-1/page.md')).toBe(true);
    expect(repository.setDocumentTriageLane).toHaveBeenLastCalledWith('run-1', 'pages/page-1/page.md', 'full');
  });

  it('short-circuits when triage is disabled', async () => {
    triageSettings.enabled = false;

    const result = await service.triageRun({
      stagedDir,
      runId: 'run-1',
      connectionId: 'conn-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      jobId: 'job-1',
      diffSet: { added: ['pages/page-1/page.md'], modified: [], deleted: [], unchanged: [] },
      adapter: adapter as any,
    });

    expect(result).toEqual({ enabled: false, report: undefined, fullRawPaths: new Set<string>(), warnings: [] });
    expect(llmRuntime.generateText).not.toHaveBeenCalled();
    expect(repository.setDocumentTriageLane).not.toHaveBeenCalled();
  });
});
