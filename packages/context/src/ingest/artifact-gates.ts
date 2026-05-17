import type { SemanticLayerService } from '../sl/index.js';
import type { TouchedSlSource } from '../tools/index.js';
import type { KnowledgeWikiService } from '../wiki/index.js';
import { findInvalidWikiBodyRefs } from './wiki-body-refs.js';

export interface TouchedValidationResult {
  invalidSources: string[];
  validSources: string[];
}

export interface FinalArtifactGateInput {
  connectionIds: string[];
  changedWikiPageKeys: string[];
  touchedSlSources: TouchedSlSource[];
  wikiService: KnowledgeWikiService;
  semanticLayerService: SemanticLayerService;
  validateTouchedSources(touched: TouchedSlSource[]): Promise<TouchedValidationResult>;
  tableExists(connectionId: string, tableRef: string): Promise<boolean>;
}

export interface ProvenanceRawPathValidationInput {
  rows: Array<{ rawPath: string }>;
  currentRawPaths: Set<string>;
  deletedRawPaths: Set<string>;
}

function bareSlRef(ref: string): string {
  const withoutConnection = ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref;
  return withoutConnection.split('.')[0] ?? withoutConnection;
}

async function validateWikiSlRefs(input: FinalArtifactGateInput): Promise<string[]> {
  const errors: string[] = [];
  const sourcesByConnection = new Map<string, Set<string>>();
  for (const connectionId of input.connectionIds) {
    const { sources } = await input.semanticLayerService.loadAllSources(connectionId);
    sourcesByConnection.set(connectionId, new Set(sources.map((source) => source.name)));
  }

  for (const pageKey of input.changedWikiPageKeys) {
    const page = await input.wikiService.readPage('GLOBAL', null, pageKey);
    if (!page) {
      continue;
    }
    for (const ref of page.frontmatter.sl_refs ?? []) {
      const sourceName = bareSlRef(ref);
      const connectionId = ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : null;
      const sourceSets = connectionId ? [sourcesByConnection.get(connectionId)] : [...sourcesByConnection.values()];
      if (!sourceSets.some((set) => set?.has(sourceName))) {
        errors.push(`${pageKey}: unknown sl_refs entry ${ref}`);
      }
    }
  }
  return errors;
}

export async function validateFinalIngestArtifacts(input: FinalArtifactGateInput): Promise<void> {
  const validation = await input.validateTouchedSources(input.touchedSlSources);
  const errors: string[] = validation.invalidSources.map((source) => `semantic-layer validation failed for ${source}`);
  errors.push(...(await validateWikiSlRefs(input)));

  for (const pageKey of input.changedWikiPageKeys) {
    const page = await input.wikiService.readPage('GLOBAL', null, pageKey);
    if (!page) {
      continue;
    }
    errors.push(
      ...(await findInvalidWikiBodyRefs({
        pageKey,
        body: page.content,
        visibleConnectionIds: input.connectionIds,
        loadSources: async (connectionId) => {
          const { sources } = await input.semanticLayerService.loadAllSources(connectionId);
          return sources;
        },
        tableExists: input.tableExists,
      })),
    );
  }

  if (errors.length > 0) {
    throw new Error(`final artifact gates failed:\n${errors.join('\n')}`);
  }
}

export function validateProvenanceRawPaths(input: ProvenanceRawPathValidationInput): void {
  for (const row of input.rows) {
    if (!input.currentRawPaths.has(row.rawPath) && !input.deletedRawPaths.has(row.rawPath)) {
      throw new Error(`provenance row references raw path outside this snapshot: ${row.rawPath}`);
    }
  }
}
