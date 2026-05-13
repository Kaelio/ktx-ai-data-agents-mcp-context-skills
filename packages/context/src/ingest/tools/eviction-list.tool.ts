import { tool } from 'ai';
import { z } from 'zod';
import type { IngestProvenancePort } from '../ports.js';

export interface EvictionListDeps {
  provenance: IngestProvenancePort;
  connectionId: string;
  sourceKey: string;
  deletedRawPaths: string[];
}

export function createEvictionListTool(deps: EvictionListDeps) {
  return tool({
    description:
      'List every artifact that the most recent completed sync produced from a now-deleted raw file. Remove each listed artifact and record the decision with emit_eviction_decision so the ingest report lists every deleted-source decision.',
    inputSchema: z.object({}),
    execute: async () => {
      if (deps.deletedRawPaths.length === 0) {
        return '(empty) — no files were deleted since the last sync';
      }
      const map = await deps.provenance.findLatestArtifactsForRawPaths(
        deps.connectionId,
        deps.sourceKey,
        deps.deletedRawPaths,
      );
      return [...map.entries()]
        .map(([path, rows]) => {
          if (rows.length === 0) {
            return `- raw_path: ${path}\n  artifacts: (none)`;
          }
          const artifactLines = rows
            .map((r) => `  - kind: ${r.artifact_kind} key: ${r.artifact_key} (last action: ${r.action_type})`)
            .join('\n');
          return `- raw_path: ${path}\n  artifacts:\n${artifactLines}`;
        })
        .join('\n');
    },
  });
}
