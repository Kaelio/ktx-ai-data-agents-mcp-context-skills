import { z } from 'zod';
import type { KtxEmbeddingPort } from '../core/index.js';
import { BaseTool, type ToolContext, type ToolOutput } from './base-tool.js';
import type { ContextEvidenceToolStorePort } from './context-evidence-tool-store.js';
import { ingestMetadataRequired, resolveIngestMetadata, type ToolFailure } from './context-ingest-metadata.js';

const contextEvidenceSearchInputSchema = z.object({
  query: z.string().min(1),
  connectionId: z.string().uuid().optional(),
  sourceKey: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(25).default(10),
  includeDeleted: z.boolean().default(false),
});

type ContextEvidenceSearchInput = z.infer<typeof contextEvidenceSearchInputSchema>;

interface ContextEvidenceSearchStructured {
  success: true;
  results: Array<{
    chunkId: string;
    documentId: string;
    externalId: string;
    title: string;
    path: string;
    url: string | null;
    snippet: string;
    score: number;
    matchReasons?: string[];
    lanes?: Array<{
      lane: string;
      status: 'available' | 'skipped' | 'failed';
      requestedCandidatePoolLimit: number;
      effectiveCandidatePoolLimit: number;
      returnedCandidateCount: number;
      weight: number;
      reason?: string;
    }>;
    citation: unknown;
    stableCitationKey: string;
    syncId: string;
    lastEditedAt: string | null;
  }>;
  totalFound: number;
}

export class ContextEvidenceSearchTool extends BaseTool<typeof contextEvidenceSearchInputSchema> {
  readonly name = 'context_evidence_search';

  constructor(
    private readonly store: ContextEvidenceToolStorePort,
    private readonly embeddingService: Pick<KtxEmbeddingPort, 'computeEmbedding'>,
  ) {
    super();
  }

  get description(): string {
    return (
      'Search the internal context evidence index for the current ingest source. ' +
      'Use this to research indexed evidence before writing candidates or curating wiki knowledge.'
    );
  }

  get inputSchema() {
    return contextEvidenceSearchInputSchema;
  }

  async call(
    input: ContextEvidenceSearchInput,
    context: ToolContext,
  ): Promise<ToolOutput<ContextEvidenceSearchStructured | ToolFailure>> {
    const ingest = resolveIngestMetadata(context);
    if (!ingest) {
      return ingestMetadataRequired();
    }

    let queryEmbedding: number[] | null = null;
    let embeddingUnhealthyReason: string | null = null;
    try {
      queryEmbedding = await this.embeddingService.computeEmbedding(input.query);
    } catch (error) {
      queryEmbedding = null;
      embeddingUnhealthyReason = error instanceof Error ? error.message : String(error);
    }

    const connectionId = input.connectionId ?? context.connectionId ?? context.session?.connectionId;
    if (!connectionId) {
      return {
        markdown: 'Error: no connectionId is available for context evidence search.',
        structured: {
          success: false,
          error: 'CONNECTION_REQUIRED',
          message: 'Provide connectionId or run this inside an ingest session with a connectionId.',
        },
      };
    }

    const results = await this.store.searchRRF({
      connectionId,
      sourceKey: input.sourceKey ?? ingest.sourceKey,
      queryEmbedding,
      queryText: input.query,
      limit: input.limit,
      includeDeleted: input.includeDeleted,
      currentRunId: ingest.runId,
    });

    const embeddingHealthSuffix = embeddingUnhealthyReason
      ? ` (semantic lane skipped: embedding_unhealthy:${embeddingUnhealthyReason})`
      : '';

    if (results.length === 0) {
      return {
        markdown: `No context evidence found for "${input.query}"${embeddingHealthSuffix}.`,
        structured: { success: true, results: [], totalFound: 0 },
      };
    }

    return {
      markdown: [
        `Found ${results.length} evidence chunk(s)${embeddingHealthSuffix}:`,
        '',
        ...results.map((result, index) => {
          const reasonLine =
            result.matchReasons && result.matchReasons.length > 0
              ? `   matchReasons: ${result.matchReasons.join(', ')}\n`
              : '';
          return (
            `${index + 1}. **${result.title}** (${result.path})\n` +
            `   chunkId: ${result.chunkId}\n` +
            `   stableCitationKey: ${result.stableCitationKey}\n` +
            reasonLine +
            `   snippet: ${result.snippet}`
          );
        }),
      ].join('\n'),
      structured: {
        success: true,
        totalFound: results.length,
        results: results.map((result) => ({
          ...result,
          ...(result.matchReasons ? { matchReasons: result.matchReasons } : {}),
          ...(result.lanes ? { lanes: result.lanes } : {}),
          lastEditedAt: result.lastEditedAt?.toISOString() ?? null,
        })),
      },
    };
  }
}
