import { z } from 'zod';
import { BaseTool, type ToolContext, type ToolOutput } from './base-tool.js';
import type { ContextEvidenceToolStorePort } from './context-evidence-tool-store.js';
import { ingestMetadataRequired, resolveIngestMetadata, type ToolFailure } from './context-ingest-metadata.js';

const contextCandidateMarkInputSchema = z.object({
  candidateKey: z.string().min(1),
  status: z.enum(['pending', 'promoted', 'merged', 'rejected', 'conflict']),
  rejectionReason: z.string().max(500).nullable().default(null),
});

type ContextCandidateMarkInput = z.infer<typeof contextCandidateMarkInputSchema>;

interface ContextCandidateMarkStructured {
  success: boolean;
  error?: string;
  candidateKey?: string;
  status?: string;
}

export class ContextCandidateMarkTool extends BaseTool<typeof contextCandidateMarkInputSchema> {
  readonly name = 'context_candidate_mark';

  constructor(private readonly store: ContextEvidenceToolStorePort) {
    super();
  }

  get description(): string {
    return 'Mark a context knowledge candidate after curator reconciliation promotes, merges, rejects, or keeps it as a conflict.';
  }

  get inputSchema() {
    return contextCandidateMarkInputSchema;
  }

  async call(
    input: ContextCandidateMarkInput,
    context: ToolContext,
  ): Promise<ToolOutput<ContextCandidateMarkStructured | ToolFailure>> {
    const ingest = resolveIngestMetadata(context);
    if (!ingest) {
      return ingestMetadataRequired();
    }

    const updated = await this.store.updateCandidateStatus({
      runId: ingest.runId,
      candidateKey: input.candidateKey,
      status: input.status,
      rejectionReason: input.rejectionReason,
    });

    if (!updated) {
      return {
        markdown: `No candidate found with key "${input.candidateKey}".`,
        structured: { success: false, error: 'CANDIDATE_NOT_FOUND', candidateKey: input.candidateKey },
      };
    }

    return {
      markdown: `Candidate "${updated.candidate_key}" marked ${updated.status}.`,
      structured: { success: true, candidateKey: updated.candidate_key, status: updated.status },
    };
  }
}
