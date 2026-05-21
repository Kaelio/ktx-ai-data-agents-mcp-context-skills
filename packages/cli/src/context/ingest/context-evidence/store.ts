import type {
  ContextEvidenceDocumentRef,
  ReplaceContextEvidenceChunk,
  UpsertContextEvidenceDocument,
} from './types.js';

export interface ContextEvidenceIndexStorePort {
  upsertDocument(params: UpsertContextEvidenceDocument): Promise<ContextEvidenceDocumentRef>;
  replaceChunks(documentId: string, chunks: ReplaceContextEvidenceChunk[]): Promise<void>;
  countPublishedDocumentsByRawPaths(connectionId: string, sourceKey: string, rawPaths: string[]): Promise<number>;
  publishSync(
    connectionId: string,
    sourceKey: string,
    syncId: string,
    deletedMarkdownRawPaths: string[],
  ): Promise<{ documentsPublished: number; documentsDeleted: number }>;
}
