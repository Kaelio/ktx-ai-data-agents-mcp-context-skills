import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { KtxMessageBuilder, type KtxLlmProvider } from '@ktx/llm';
import { generateText, type ToolSet } from 'ai';
import pLimit from 'p-limit';
import { z } from 'zod';
import { type KtxLogger, noopLogger } from '../../core/index.js';
import type { PromptService } from '../../prompts/index.js';
import type { InsertContextCandidateInput } from '../context-candidates/index.js';
import type { JsonValue } from '../ports.js';
import type { DiffSet, SourceAdapter, TriageLane, TriageSignals } from '../types.js';

const scoreSchema = z.number().int().min(0).max(3);
const triageOutputSchema = z.object({
  lane: z.enum(['skip', 'light', 'full']),
  reason: z.string().optional(),
});
const lightCandidateSchema = z.object({
  candidateKey: z.string().min(1).max(160),
  topic: z.string().min(1).max(200),
  assertion: z.string().min(1).max(500),
  rationale: z.string().min(1).max(1000),
  evidenceChunkIds: z.array(z.string().min(1)).min(1),
  suggestedPageKey: z.string().min(1).max(120).optional(),
  actionHint: z.enum(['create', 'update', 'merge', 'conflict', 'skip']),
  durabilityScore: scoreSchema,
  authorityScore: scoreSchema,
  reuseScore: scoreSchema,
  noveltyScore: scoreSchema,
  riskScore: scoreSchema,
});
const lightOutputSchema = z.object({
  candidates: z.array(lightCandidateSchema).default([]),
});

interface StagedTriageDocument {
  externalId: string;
  title: string;
  path: string;
  metadataRawPath: string;
  markdownRawPath: string;
  markdown: string;
}

export interface PageTriageReport {
  pageCount: number;
  skip: number;
  light: number;
  full: number;
  classifierFailures: number;
  lightExtractionFailures: number;
}

interface PageTriageRunResult {
  enabled: boolean;
  report?: PageTriageReport;
  fullRawPaths: Set<string>;
  warnings: string[];
}

export interface PageTriageRunArgs {
  stagedDir: string;
  runId: string;
  connectionId: string;
  sourceKey: string;
  syncId: string;
  jobId: string;
  diffSet: DiffSet;
  adapter: Pick<SourceAdapter, 'triageSupported' | 'getTriageSignals'>;
}

export interface PageTriageEvidenceChunk {
  chunkId: string;
  headingPath: string[];
  ordinal: number;
  content: string;
  stableCitationKey: string;
  citation: JsonValue;
  rawPath: string;
  title: string;
  path: string;
  url: string | null;
  lastEditedAt: Date | null;
}

export interface PageTriageStorePort {
  setDocumentTriageLane(runId: string, rawPath: string, lane: TriageLane): Promise<number>;
  listDocumentChunksForLightExtraction(runId: string, rawPath: string): Promise<PageTriageEvidenceChunk[]>;
  insertCandidate(input: InsertContextCandidateInput): Promise<unknown>;
}

export interface PageTriageSettings {
  enabled: boolean;
  maxConcurrency: number;
  lightExtractionEnabled: boolean;
  classifierModel: string | null;
  lightExtractionMaxCandidates: number;
}

export interface PageTriageServiceDeps {
  store: PageTriageStorePort;
  llmProvider: KtxLlmProvider;
  settings: PageTriageSettings;
  promptService: PromptService;
  logger?: KtxLogger;
  generateText?: typeof generateText;
}

export class PageTriageService {
  private readonly logger: KtxLogger;
  private readonly runGenerateText: typeof generateText;

  constructor(private readonly deps: PageTriageServiceDeps) {
    this.logger = deps.logger ?? noopLogger;
    this.runGenerateText = deps.generateText ?? generateText;
  }

  async triageRun(args: PageTriageRunArgs): Promise<PageTriageRunResult> {
    const config = this.deps.settings;
    if (!config.enabled || !args.adapter.triageSupported) {
      return { enabled: false, report: undefined, fullRawPaths: new Set<string>(), warnings: [] };
    }

    const documents = await this.collectChangedDocuments(args.stagedDir, args.diffSet);
    const report: PageTriageReport = {
      pageCount: documents.length,
      skip: 0,
      light: 0,
      full: 0,
      classifierFailures: 0,
      lightExtractionFailures: 0,
    };
    const fullRawPaths = new Set<string>();
    const warnings: string[] = [];
    const limit = pLimit(config.maxConcurrency);
    const startedAt = Date.now();

    await Promise.all(
      documents.map((document) =>
        limit(async () => {
          const outcome = await this.triageDocument(args, document, warnings);
          report.classifierFailures += outcome.classifierFailed ? 1 : 0;
          report.lightExtractionFailures += outcome.lightExtractionFailed ? 1 : 0;
          report[outcome.lane] += 1;

          if (outcome.lane === 'full') {
            fullRawPaths.add(document.metadataRawPath);
            fullRawPaths.add(document.markdownRawPath);
          }
        }),
      ),
    );

    this.logger.log(
      `Stage 2.5 triage took ${Date.now() - startedAt}ms (${config.maxConcurrency} max concurrent classifier calls)`,
    );
    this.logger.log(`Triage lanes: ${report.skip} skip, ${report.light} light, ${report.full} full`);

    return { enabled: true, report, fullRawPaths, warnings };
  }

  private async triageDocument(
    args: PageTriageRunArgs,
    document: StagedTriageDocument,
    warnings: string[],
  ): Promise<{ lane: TriageLane; classifierFailed: boolean; lightExtractionFailed: boolean }> {
    const config = this.deps.settings;
    let lane: TriageLane = 'full';
    let classifierFailed = false;
    let lightExtractionFailed = false;

    try {
      const signals = await this.getSignals(args, document, warnings);
      const classifierSystem = await this.buildClassifierSystem();
      const classifierUser = this.buildClassifierUser(document, signals);
      const modelText = await this.callModel({
        operationName: 'page-triage',
        system: classifierSystem,
        prompt: classifierUser,
        sourceKey: args.sourceKey,
        jobId: args.jobId,
        unitKey: document.markdownRawPath,
      });
      lane = triageOutputSchema.parse(this.parseJson(modelText)).lane;
      if (lane === 'light' && !config.lightExtractionEnabled) {
        lane = 'full';
      }
    } catch (error) {
      classifierFailed = true;
      lane = 'full';
      warnings.push(
        `Triage classifier failed for ${document.markdownRawPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await this.deps.store.setDocumentTriageLane(args.runId, document.markdownRawPath, lane);

    if (lane !== 'light') {
      return { lane, classifierFailed, lightExtractionFailed };
    }

    try {
      await this.extractLightCandidates(args, document);
      return { lane: 'light', classifierFailed, lightExtractionFailed };
    } catch (error) {
      lightExtractionFailed = true;
      warnings.push(
        `Light extraction failed for ${document.markdownRawPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.deps.store.setDocumentTriageLane(args.runId, document.markdownRawPath, 'full');
      return { lane: 'full', classifierFailed, lightExtractionFailed };
    }
  }

  private async getSignals(
    args: PageTriageRunArgs,
    document: StagedTriageDocument,
    warnings: string[],
  ): Promise<TriageSignals | undefined> {
    if (!args.adapter.getTriageSignals) {
      return undefined;
    }

    try {
      return await args.adapter.getTriageSignals(args.stagedDir, document.externalId);
    } catch (error) {
      warnings.push(
        `Triage signals failed for ${document.markdownRawPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  private async extractLightCandidates(args: PageTriageRunArgs, document: StagedTriageDocument): Promise<void> {
    const chunks = await this.deps.store.listDocumentChunksForLightExtraction(args.runId, document.markdownRawPath);
    if (chunks.length === 0) {
      throw new Error('no indexed chunks available for light extraction');
    }

    const system = await this.buildLightExtractionSystem();
    const user = this.buildLightExtractionUser(document, chunks);
    const text = await this.callModel({
      operationName: 'light-extraction',
      system,
      prompt: user,
      sourceKey: args.sourceKey,
      jobId: args.jobId,
      unitKey: document.markdownRawPath,
    });
    const output = lightOutputSchema.parse(this.parseJson(text));
    const maxCandidates = this.deps.settings.lightExtractionMaxCandidates;

    for (const [index, candidate] of output.candidates.slice(0, maxCandidates).entries()) {
      const evidenceChunkIds = this.validEvidenceChunkIds(candidate.evidenceChunkIds, chunks);
      const promotionScore =
        candidate.durabilityScore +
        candidate.authorityScore +
        candidate.reuseScore +
        candidate.noveltyScore -
        candidate.riskScore;
      const status =
        candidate.actionHint === 'conflict' ? 'conflict' : candidate.actionHint === 'skip' ? 'rejected' : 'pending';

      await this.deps.store.insertCandidate({
        runId: args.runId,
        connectionId: args.connectionId,
        sourceKey: args.sourceKey,
        candidateKey: this.stableCandidateKey(candidate.candidateKey, document.externalId, index),
        topic: candidate.topic,
        assertion: candidate.assertion,
        rationale: candidate.rationale,
        evidenceChunkIds,
        evidenceRefs: this.evidenceRefs(evidenceChunkIds, chunks),
        suggestedPageKey: candidate.suggestedPageKey ?? null,
        actionHint: candidate.actionHint,
        durabilityScore: candidate.durabilityScore,
        authorityScore: candidate.authorityScore,
        reuseScore: candidate.reuseScore,
        noveltyScore: candidate.noveltyScore,
        riskScore: candidate.riskScore,
        promotionScore,
        status,
        rejectionReason: candidate.actionHint === 'skip' ? 'not_durable' : null,
        lane: 'light',
      });
    }
  }

  private validEvidenceChunkIds(candidateIds: string[], chunks: PageTriageEvidenceChunk[]): string[] {
    const available = new Set(chunks.map((chunk) => chunk.chunkId));
    const valid = candidateIds.filter((chunkId) => available.has(chunkId));
    return valid.length > 0 ? valid : [chunks[0].chunkId];
  }

  private evidenceRefs(chunkIds: string[], chunks: PageTriageEvidenceChunk[]): JsonValue {
    const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
    return chunkIds.flatMap((chunkId) => {
      const chunk = byId.get(chunkId);
      if (!chunk) {
        return [];
      }
      return [
        {
          chunkId: chunk.chunkId,
          stableCitationKey: chunk.stableCitationKey,
          syncId: this.syncIdFromCitation(chunk.citation),
          rawPath: chunk.rawPath,
          title: chunk.title,
          path: chunk.path,
          url: chunk.url,
          lastEditedAt: chunk.lastEditedAt?.toISOString() ?? null,
          snippetHash: createHash('sha256').update(chunk.content).digest('hex'),
          citation: chunk.citation,
        },
      ];
    });
  }

  private syncIdFromCitation(citation: JsonValue): string | null {
    if (citation && typeof citation === 'object' && !Array.isArray(citation)) {
      const syncId = (citation as Record<string, JsonValue>).syncId;
      return typeof syncId === 'string' ? syncId : null;
    }
    return null;
  }

  private async callModel(params: {
    operationName: 'page-triage' | 'light-extraction';
    system: string;
    prompt: string;
    sourceKey: string;
    jobId: string;
    unitKey: string;
  }): Promise<string> {
    const model = this.deps.llmProvider.getModel('triage');
    const built = new KtxMessageBuilder(this.deps.llmProvider).wrapSimple({
      system: params.system,
      messages: [{ role: 'user', content: params.prompt }],
      tools: {},
      model,
    });
    const result = await this.runGenerateText({
      model,
      temperature: 0,
      messages: built.messages,
      tools: built.tools as ToolSet,
    });
    return result.text;
  }

  private async buildClassifierSystem(): Promise<string> {
    return this.deps.promptService.loadPrompt('skills/page_triage_classifier');
  }

  private buildClassifierUser(document: StagedTriageDocument, signals: TriageSignals | undefined): string {
    return [
      '<page>',
      `externalId: ${document.externalId}`,
      `title: ${document.title}`,
      `path: ${document.path}`,
      `rawPath: ${document.markdownRawPath}`,
      '</page>',
      '<signals>',
      JSON.stringify(signals ?? {}, null, 2),
      '</signals>',
      '<excerpt>',
      document.markdown.slice(0, 2048),
      '</excerpt>',
    ].join('\n');
  }

  private async buildLightExtractionSystem(): Promise<string> {
    const base = await this.deps.promptService.loadPrompt('skills/light_extraction');
    return `${base}\n\nMaximum candidates: ${this.deps.settings.lightExtractionMaxCandidates}`;
  }

  private buildLightExtractionUser(document: StagedTriageDocument, chunks: PageTriageEvidenceChunk[]): string {
    return [
      '<page>',
      `externalId: ${document.externalId}`,
      `title: ${document.title}`,
      `path: ${document.path}`,
      `rawPath: ${document.markdownRawPath}`,
      '</page>',
      '<chunks>',
      JSON.stringify(
        chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          headingPath: chunk.headingPath,
          stableCitationKey: chunk.stableCitationKey,
          content: chunk.content,
        })),
        null,
        2,
      ),
      '</chunks>',
      '<markdown>',
      document.markdown,
      '</markdown>',
    ].join('\n');
  }

  private parseJson(text: string): unknown {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    return JSON.parse(fenced ? fenced[1] : trimmed);
  }

  private stableCandidateKey(candidateKey: string, externalId: string, index: number): string {
    const normalized = candidateKey
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
    if (normalized) {
      return normalized;
    }
    const digest = createHash('sha256').update(`${externalId}:${index}`).digest('hex').slice(0, 12);
    return `light-${digest}`;
  }

  private async collectChangedDocuments(stagedDir: string, diffSet: DiffSet): Promise<StagedTriageDocument[]> {
    const touched = new Set([...diffSet.added, ...diffSet.modified]);
    const entries = await readdir(stagedDir, { withFileTypes: true, recursive: true });
    const markdownPaths = entries
      .filter((entry) => entry.isFile() && entry.name === 'page.md')
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
    const documents: StagedTriageDocument[] = [];

    for (const markdownPath of markdownPaths) {
      const metadataPath = join(dirname(markdownPath), 'metadata.json');
      const metadataRawPath = this.toRawPath(stagedDir, metadataPath);
      const markdownRawPath = this.toRawPath(stagedDir, markdownPath);
      if (!touched.has(metadataRawPath) && !touched.has(markdownRawPath)) {
        continue;
      }

      let metadataRaw: string;
      try {
        metadataRaw = await readFile(metadataPath, 'utf-8');
      } catch (error) {
        this.logger.debug(
          `Skipping triage document ${markdownRawPath}: missing sibling metadata.json (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        continue;
      }

      const metadata = JSON.parse(metadataRaw) as {
        id?: string;
        title?: string;
        path?: string;
      };
      const markdown = await readFile(markdownPath, 'utf-8');
      if (!metadata.id || !metadata.title) {
        continue;
      }

      documents.push({
        externalId: metadata.id,
        title: metadata.title,
        path: metadata.path ?? metadata.title,
        metadataRawPath,
        markdownRawPath,
        markdown,
      });
    }

    return documents;
  }

  private toRawPath(stagedDir: string, fullPath: string): string {
    return relative(stagedDir, fullPath).split('\\').join('/');
  }
}
