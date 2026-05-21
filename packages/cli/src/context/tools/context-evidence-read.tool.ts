import { z } from 'zod';
import { BaseTool, type ToolContext, type ToolOutput } from './base-tool.js';
import { chunkIdSchema, documentIdSchema } from './context-evidence-ids.js';
import type { ContextEvidenceToolStorePort } from './context-evidence-tool-store.js';
import { ingestMetadataRequired, resolveIngestMetadata, type ToolFailure } from './context-ingest-metadata.js';

const contextEvidenceReadInputSchema = z
  .object({
    chunkId: chunkIdSchema.optional(),
    documentId: documentIdSchema.optional(),
    externalId: z.string().min(1).optional(),
    includeNeighborChunks: z.boolean().default(false),
  })
  .refine((input) => [input.chunkId, input.documentId, input.externalId].filter(Boolean).length === 1, {
    message: 'Provide exactly one of chunkId, documentId, or externalId.',
  });

type ContextEvidenceReadInput = z.infer<typeof contextEvidenceReadInputSchema>;

interface ContextEvidenceReadStructured {
  success: true;
  found: boolean;
  documentId?: string;
  chunkId?: string;
  externalId?: string;
  title?: string;
  path?: string;
  url?: string | null;
  content?: string;
  citation?: unknown;
}

export class ContextEvidenceReadTool extends BaseTool<typeof contextEvidenceReadInputSchema> {
  readonly name = 'context_evidence_read';

  constructor(private readonly store: ContextEvidenceToolStorePort) {
    super();
  }

  get description(): string {
    return 'Read a context evidence chunk or document by chunkId, documentId, or externalId.';
  }

  get inputSchema() {
    return contextEvidenceReadInputSchema;
  }

  async call(
    input: ContextEvidenceReadInput,
    context: ToolContext,
  ): Promise<ToolOutput<ContextEvidenceReadStructured | ToolFailure>> {
    const ingest = resolveIngestMetadata(context);
    if (!ingest) {
      return ingestMetadataRequired();
    }

    if (input.chunkId) {
      const connectionId = context.connectionId ?? context.session?.connectionId;
      if (!connectionId) {
        return {
          markdown: 'Error: no connectionId is available for evidence read.',
          structured: { success: false, error: 'CONNECTION_REQUIRED', message: 'Run inside an ingest session.' },
        };
      }
      const found = await this.store.readChunkById(input.chunkId, connectionId, ingest.sourceKey, ingest.runId);
      if (!found) {
        return {
          markdown: `No evidence chunk found for ${input.chunkId}.`,
          structured: { success: true, found: false },
        };
      }
      if (input.includeNeighborChunks) {
        const document = await this.store.readDocumentById(
          found.document.id,
          connectionId,
          ingest.sourceKey,
          ingest.runId,
        );
        const content = document?.chunks.map((chunk) => chunk.content).join('\n\n') ?? found.chunk.content;
        return {
          markdown: `## ${found.document.title}\n\n${content}`,
          structured: {
            success: true,
            found: true,
            documentId: found.document.id,
            chunkId: found.chunk.id,
            externalId: found.document.external_id,
            title: found.document.title,
            path: found.document.path,
            url: found.document.url,
            content,
            citation: found.chunk.citation,
          },
        };
      }
      return {
        markdown: `## ${found.document.title}\n\n${found.chunk.content}`,
        structured: {
          success: true,
          found: true,
          documentId: found.document.id,
          chunkId: found.chunk.id,
          externalId: found.document.external_id,
          title: found.document.title,
          path: found.document.path,
          url: found.document.url,
          content: found.chunk.content,
          citation: found.chunk.citation,
        },
      };
    }

    const connectionId = context.connectionId ?? context.session?.connectionId;
    if (!connectionId) {
      return {
        markdown: 'Error: no connectionId is available for evidence read.',
        structured: { success: false, error: 'CONNECTION_REQUIRED', message: 'Run inside an ingest session.' },
      };
    }
    let document: Awaited<ReturnType<ContextEvidenceToolStorePort['readDocumentById']>>;
    if (input.documentId) {
      document = await this.store.readDocumentById(input.documentId, connectionId, ingest.sourceKey, ingest.runId);
    } else if (input.externalId) {
      document = await this.store.readDocumentByExternalId(
        connectionId,
        ingest.sourceKey,
        input.externalId,
        ingest.runId,
      );
    } else {
      return { markdown: 'No evidence document found.', structured: { success: true, found: false } };
    }

    if (!document) {
      return { markdown: 'No evidence document found.', structured: { success: true, found: false } };
    }

    const content = document.chunks.map((chunk) => chunk.content).join('\n\n');
    return {
      markdown: `## ${document.document.title}\n\n${content}`,
      structured: {
        success: true,
        found: true,
        documentId: document.document.id,
        externalId: document.document.external_id,
        title: document.document.title,
        path: document.document.path,
        url: document.document.url,
        content,
      },
    };
  }
}
