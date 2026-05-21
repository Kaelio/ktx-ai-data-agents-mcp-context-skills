import { z } from 'zod';

const UUID_BODY = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

const CHUNK_ID_PATTERN = new RegExp(`^ctxchunk-${UUID_BODY}$`);
const DOCUMENT_ID_PATTERN = new RegExp(`^ctxdoc-${UUID_BODY}$`);

export const chunkIdSchema = z
  .string()
  .regex(CHUNK_ID_PATTERN, 'Use a chunkId returned by context_evidence_search (format: "ctxchunk-<uuid>").')
  .describe('A chunkId from context_evidence_search results, e.g. "ctxchunk-<uuid>".');

export const documentIdSchema = z
  .string()
  .regex(DOCUMENT_ID_PATTERN, 'Use a documentId returned by context_evidence_search or context_evidence_neighbors (format: "ctxdoc-<uuid>").')
  .describe('A documentId from context_evidence_search or context_evidence_neighbors results, e.g. "ctxdoc-<uuid>".');
