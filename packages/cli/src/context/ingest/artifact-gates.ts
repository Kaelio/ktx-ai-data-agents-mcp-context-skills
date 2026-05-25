import type { SemanticLayerService } from '../../context/sl/semantic-layer.service.js';
import type { TouchedSlSource } from '../../context/tools/touched-sl-sources.js';
import type { KnowledgeWikiService } from '../../context/wiki/knowledge-wiki.service.js';
import { findMissingWikiRefs } from '../wiki/wiki-ref-validation.js';
import { findInvalidWikiBodyRefs } from './wiki-body-refs.js';

interface TouchedValidationResult {
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

function normalizeRawPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function parseSlRef(ref: string): { connectionId: string | null; sourceName: string; entityName: string | null } {
  const withoutConnection = ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref;
  const connectionId = ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : null;
  const [sourceName = '', entityName = null] = withoutConnection.split('.', 2);
  return { connectionId, sourceName, entityName };
}

function slEntityNames(source: Awaited<ReturnType<SemanticLayerService['loadAllSources']>>['sources'][number]): Set<string> {
  return new Set([
    ...(source.measures ?? []).map((measure) => measure.name),
    ...(source.columns ?? []).map((column) => column.name),
    ...(source.segments ?? []).map((segment) => segment.name),
  ]);
}

function uniqueTouchedSources(sources: TouchedSlSource[]): TouchedSlSource[] {
  const seen = new Set<string>();
  const unique: TouchedSlSource[] = [];
  for (const source of sources) {
    const key = `${source.connectionId}:${source.sourceName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(source);
  }
  return unique.sort((left, right) => {
    const byConnection = left.connectionId.localeCompare(right.connectionId);
    return byConnection === 0 ? left.sourceName.localeCompare(right.sourceName) : byConnection;
  });
}

async function expandTouchedSlSourcesWithDirectJoinNeighbors(input: FinalArtifactGateInput): Promise<TouchedSlSource[]> {
  const expanded = [...input.touchedSlSources];
  const touchedByConnection = new Map<string, Set<string>>();
  for (const source of input.touchedSlSources) {
    const bucket = touchedByConnection.get(source.connectionId) ?? new Set<string>();
    bucket.add(source.sourceName);
    touchedByConnection.set(source.connectionId, bucket);
  }

  for (const connectionId of input.connectionIds) {
    const touched = touchedByConnection.get(connectionId);
    if (!touched || touched.size === 0) {
      continue;
    }
    const { sources } = await input.semanticLayerService.loadAllSources(connectionId);
    for (const source of sources) {
      const sourceIsTouched = touched.has(source.name);
      if (sourceIsTouched) {
        for (const join of source.joins ?? []) {
          expanded.push({ connectionId, sourceName: join.to });
        }
      }
      if ((source.joins ?? []).some((join) => touched.has(join.to))) {
        expanded.push({ connectionId, sourceName: source.name });
      }
    }
  }

  return uniqueTouchedSources(expanded);
}

async function validateWikiSlRefs(input: FinalArtifactGateInput): Promise<string[]> {
  const errors: string[] = [];
  const sourcesByConnection = new Map<string, Awaited<ReturnType<SemanticLayerService['loadAllSources']>>['sources']>();
  for (const connectionId of input.connectionIds) {
    const { sources } = await input.semanticLayerService.loadAllSources(connectionId);
    sourcesByConnection.set(connectionId, sources);
  }

  for (const pageKey of input.changedWikiPageKeys) {
    const page = await input.wikiService.readPage('GLOBAL', null, pageKey);
    if (!page) {
      continue;
    }
    for (const ref of page.frontmatter.sl_refs ?? []) {
      const parsed = parseSlRef(ref);
      const candidateConnections = parsed.connectionId ? [parsed.connectionId] : input.connectionIds;
      let source: Awaited<ReturnType<SemanticLayerService['loadAllSources']>>['sources'][number] | undefined;
      for (const connectionId of candidateConnections) {
        source = sourcesByConnection.get(connectionId)?.find((candidate) => candidate.name === parsed.sourceName);
        if (source) {
          break;
        }
      }
      if (!source) {
        errors.push(`${pageKey}: unknown sl_refs entry ${ref}`);
        continue;
      }
      if (parsed.entityName && !slEntityNames(source).has(parsed.entityName)) {
        errors.push(`${pageKey}: unknown sl_refs entity ${ref}`);
      }
    }
  }
  return errors;
}

async function validateWikiRefs(input: FinalArtifactGateInput): Promise<string[]> {
  const dangling: string[] = [];
  for (const pageKey of input.changedWikiPageKeys) {
    const page = await input.wikiService.readPage('GLOBAL', null, pageKey);
    if (!page) {
      continue;
    }
    const missingRefs = await findMissingWikiRefs({
      wikiService: input.wikiService,
      scope: 'GLOBAL',
      scopeId: null,
      pageKey,
      refs: page.frontmatter.refs,
      content: page.content,
    });
    for (const missingRef of missingRefs) {
      dangling.push(`${pageKey} -> ${missingRef}`);
    }
  }
  return dangling;
}

export async function validateFinalIngestArtifacts(input: FinalArtifactGateInput): Promise<void> {
  const touchedWithDependencies = await expandTouchedSlSourcesWithDirectJoinNeighbors(input);
  const validation = await input.validateTouchedSources(touchedWithDependencies);
  const errors: string[] = validation.invalidSources.map((source) => `semantic-layer validation failed for ${source}`);
  errors.push(...(await validateWikiSlRefs(input)));
  const danglingWikiRefs = await validateWikiRefs(input);
  if (danglingWikiRefs.length > 0) {
    errors.push(`wiki references target missing page(s): ${danglingWikiRefs.join(', ')}`);
  }

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
  const currentRawPaths = new Set([...input.currentRawPaths].map(normalizeRawPath));
  const deletedRawPaths = new Set([...input.deletedRawPaths].map(normalizeRawPath));
  for (const row of input.rows) {
    const rawPath = normalizeRawPath(row.rawPath);
    if (!currentRawPaths.has(rawPath) && !deletedRawPaths.has(rawPath)) {
      throw new Error(`provenance row references raw path outside this snapshot: ${row.rawPath}`);
    }
  }
}
