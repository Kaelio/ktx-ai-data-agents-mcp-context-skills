import type { ToolContext, ToolOutput } from './base-tool.js';
import type { IngestToolMetadata } from './tool-session.js';

export interface ToolFailure {
  success: false;
  error: string;
  message: string;
}

export function resolveIngestMetadata(context: ToolContext): IngestToolMetadata | null {
  return context.session?.ingest ?? context.ingest ?? null;
}

export function ingestMetadataRequired<T extends ToolFailure = ToolFailure>(): ToolOutput<T> {
  return {
    markdown: 'Error: this tool is only available inside an ingest WorkUnit or ingest reconciliation session.',
    structured: {
      success: false,
      error: 'INGEST_METADATA_REQUIRED',
      message: 'This tool requires ingest metadata on ToolContext or ToolSession.',
    } as T,
  };
}
