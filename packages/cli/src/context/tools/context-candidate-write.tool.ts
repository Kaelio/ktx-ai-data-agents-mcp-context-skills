import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { KtxEmbeddingPort } from '../../context/core/embedding.js';
import { buildContextCandidateEmbeddingText } from '../../context/ingest/context-candidates/embedding-text.js';
import { BaseTool, type ToolContext, type ToolOutput } from './base-tool.js';
import { chunkIdSchema } from './context-evidence-ids.js';
import type { ContextEvidenceToolStorePort } from './context-evidence-tool-store.js';
import { ingestMetadataRequired, resolveIngestMetadata, type ToolFailure } from './context-ingest-metadata.js';

const scoreSchema = z.number().int().min(0).max(3);

const contextCandidateWriteInputSchema = z.object({
  candidateKey: z.string().min(1).max(160),
  topic: z.string().min(1).max(200),
  assertion: z.string().min(1).max(500),
  rationale: z.string().min(1).max(1000),
  evidenceChunkIds: z.array(chunkIdSchema).min(1),
  suggestedPageKey: z.string().min(1).max(120).optional(),
  actionHint: z.enum(['create', 'update', 'merge', 'conflict', 'skip']),
  durabilityScore: scoreSchema,
  authorityScore: scoreSchema,
  reuseScore: scoreSchema,
  noveltyScore: scoreSchema,
  riskScore: scoreSchema,
});

type ContextCandidateWriteInput = z.infer<typeof contextCandidateWriteInputSchema>;

interface ContextCandidateWriteStructured {
  success: boolean;
  error?: string;
  message?: string;
  candidateKey?: string;
  promotionScore?: number;
  status?: string;
}

export class ContextCandidateWriteTool extends BaseTool<typeof contextCandidateWriteInputSchema> {
  readonly name = 'context_candidate_write';

  constructor(
    private readonly store: ContextEvidenceToolStorePort,
    private readonly embeddingService: Pick<KtxEmbeddingPort, 'computeEmbedding'>,
  ) {
    super();
  }

  get description(): string {
    return 'Write a durable knowledge candidate from indexed context evidence. Use this during ingest candidate extraction instead of wiki_write.';
  }

  get inputSchema() {
    return contextCandidateWriteInputSchema;
  }

  async call(
    input: ContextCandidateWriteInput,
    context: ToolContext,
  ): Promise<ToolOutput<ContextCandidateWriteStructured | ToolFailure>> {
    const ingest = resolveIngestMetadata(context);
    if (!ingest) {
      return ingestMetadataRequired();
    }

    const connectionId = context.connectionId ?? context.session?.connectionId;
    if (!connectionId) {
      return {
        markdown: 'Error: no connectionId is available for candidate write.',
        structured: {
          success: false,
          error: 'CONNECTION_REQUIRED',
          message: 'Run this inside an ingest session with a connectionId.',
        },
      };
    }

    if (input.evidenceChunkIds.length === 0) {
      return {
        markdown: 'Error: candidates require at least one evidence chunk.',
        structured: { success: false, error: 'EVIDENCE_REQUIRED', message: 'Provide one or more evidenceChunkIds.' },
      };
    }

    const chunks = await this.store.readChunksByIds(
      input.evidenceChunkIds,
      connectionId,
      ingest.sourceKey,
      ingest.runId,
    );
    if (chunks.length !== input.evidenceChunkIds.length) {
      const found = new Set(chunks.map((chunk) => chunk.chunkId));
      const missing = input.evidenceChunkIds.filter((id) => !found.has(id));
      return {
        markdown: `Error: evidence chunks not found or not visible: ${missing.join(', ')}`,
        structured: {
          success: false,
          error: 'EVIDENCE_NOT_FOUND',
          message: `Missing evidence chunk ids: ${missing.join(', ')}`,
        },
      };
    }

    const promotionScore =
      input.durabilityScore + input.authorityScore + input.reuseScore + input.noveltyScore - input.riskScore;
    const status = input.actionHint === 'conflict' ? 'conflict' : input.actionHint === 'skip' ? 'rejected' : 'pending';
    const evidenceRefs = chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      stableCitationKey: chunk.stableCitationKey,
      syncId: chunk.syncId,
      rawPath: chunk.rawPath,
      title: chunk.title,
      path: chunk.path,
      url: chunk.url,
      lastEditedAt: chunk.lastEditedAt?.toISOString() ?? null,
      snippetHash: createHash('sha256').update(chunk.content).digest('hex'),
      citation: chunk.citation,
    }));
    const embedding = await this.computeCandidateEmbedding(input);

    try {
      const candidate = await this.store.insertCandidate({
        runId: ingest.runId,
        connectionId,
        sourceKey: ingest.sourceKey,
        candidateKey: input.candidateKey,
        topic: input.topic,
        assertion: input.assertion,
        rationale: input.rationale,
        evidenceChunkIds: input.evidenceChunkIds,
        evidenceRefs,
        suggestedPageKey: input.suggestedPageKey ?? null,
        actionHint: input.actionHint,
        durabilityScore: input.durabilityScore,
        authorityScore: input.authorityScore,
        reuseScore: input.reuseScore,
        noveltyScore: input.noveltyScore,
        riskScore: input.riskScore,
        promotionScore,
        status,
        rejectionReason: input.actionHint === 'skip' ? 'Extractor marked this candidate as skip.' : null,
        embedding,
      });

      return {
        markdown: `Candidate "${candidate.candidate_key}" saved with promotion score ${candidate.promotion_score}.`,
        structured: {
          success: true,
          candidateKey: candidate.candidate_key,
          promotionScore: candidate.promotion_score,
          status: candidate.status,
        },
      };
    } catch (error) {
      return {
        markdown: `Error: candidate "${input.candidateKey}" could not be saved.`,
        structured: {
          success: false,
          error: 'CANDIDATE_WRITE_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async computeCandidateEmbedding(
    input: Pick<ContextCandidateWriteInput, 'topic' | 'assertion'>,
  ): Promise<number[] | null> {
    try {
      return await this.embeddingService.computeEmbedding(buildContextCandidateEmbeddingText(input));
    } catch (error) {
      this.logger.warn(
        `Candidate embedding generation failed for topic "${input.topic}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}
