import { z } from 'zod';
import { BaseTool, type ToolContext, type ToolOutput } from './base-tool.js';
import { documentIdSchema } from './context-evidence-ids.js';
import type { ContextEvidenceToolStorePort } from './context-evidence-tool-store.js';
import { ingestMetadataRequired, resolveIngestMetadata, type ToolFailure } from './context-ingest-metadata.js';

const contextEvidenceNeighborsInputSchema = z.object({
  documentId: documentIdSchema,
  relation: z.enum(['parent', 'children', 'linked', 'backlinked', 'same_path']),
  limit: z.number().int().min(1).max(25).default(10),
});

type ContextEvidenceNeighborsInput = z.infer<typeof contextEvidenceNeighborsInputSchema>;

interface ContextEvidenceNeighborsStructured {
  success: true;
  results: Array<{
    documentId: string;
    externalId: string;
    title: string;
    path: string;
    relation: string;
    url: string | null;
    lastEditedAt: string | null;
  }>;
  totalFound: number;
}

export class ContextEvidenceNeighborsTool extends BaseTool<typeof contextEvidenceNeighborsInputSchema> {
  readonly name = 'context_evidence_neighbors';

  constructor(private readonly store: ContextEvidenceToolStorePort) {
    super();
  }

  get description(): string {
    return 'Find parent, child, linked, backlinked, or same-folder evidence documents for the current ingest source.';
  }

  get inputSchema() {
    return contextEvidenceNeighborsInputSchema;
  }

  async call(
    input: ContextEvidenceNeighborsInput,
    context: ToolContext,
  ): Promise<ToolOutput<ContextEvidenceNeighborsStructured | ToolFailure>> {
    const ingest = resolveIngestMetadata(context);
    if (!ingest) {
      return ingestMetadataRequired();
    }

    const connectionId = context.connectionId ?? context.session?.connectionId;
    if (!connectionId) {
      return {
        markdown: 'Error: no connectionId is available for context evidence neighbors.',
        structured: {
          success: false,
          error: 'CONNECTION_REQUIRED',
          message: 'Run this inside an ingest session with a connectionId.',
        },
      };
    }

    const results = await this.store.findNeighborDocuments({
      connectionId,
      sourceKey: ingest.sourceKey,
      documentId: input.documentId,
      relation: input.relation,
      limit: input.limit,
      currentRunId: ingest.runId,
    });

    if (results.length === 0) {
      return {
        markdown: `No ${input.relation} evidence documents found.`,
        structured: { success: true, results: [], totalFound: 0 },
      };
    }

    return {
      markdown: [
        `Found ${results.length} ${input.relation} evidence document(s):`,
        '',
        ...results.map(
          (result, index) => `${index + 1}. **${result.title}** (${result.path}) documentId=${result.documentId}`,
        ),
      ].join('\n'),
      structured: {
        success: true,
        totalFound: results.length,
        results: results.map((result) => ({
          ...result,
          lastEditedAt: result.lastEditedAt?.toISOString() ?? null,
        })),
      },
    };
  }
}
