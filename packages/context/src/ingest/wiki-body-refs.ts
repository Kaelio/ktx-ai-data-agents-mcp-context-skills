import type { SemanticLayerSource } from '../sl/index.js';

export type WikiBodyRef =
  | { kind: 'sl_entity'; connectionId: string | null; sourceName: string; entityName: string }
  | { kind: 'sl_source'; connectionId: string | null; sourceName: string }
  | { kind: 'table'; connectionId: string | null; tableRef: string };

export interface WikiBodyRefValidationInput {
  pageKey: string;
  body: string;
  visibleConnectionIds: string[];
  loadSources(connectionId: string): Promise<SemanticLayerSource[]>;
  tableExists(connectionId: string, tableRef: string): Promise<boolean>;
}

const inlineCodePattern = /`([^`\n]+)`/g;

function visibleLinesOutsideFences(body: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) {
      lines.push(line);
    }
  }
  return lines;
}

function parseConnectionScoped(value: string): { connectionId: string | null; body: string } {
  const slash = value.indexOf('/');
  if (slash <= 0) {
    return { connectionId: null, body: value };
  }
  return { connectionId: value.slice(0, slash), body: value.slice(slash + 1) };
}

function isIdentifierToken(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function parseWikiBodyRefs(body: string): WikiBodyRef[] {
  const refs: WikiBodyRef[] = [];
  for (const line of visibleLinesOutsideFences(body)) {
    for (const match of line.matchAll(inlineCodePattern)) {
      const token = (match[1] ?? '').trim();
      if (!token) {
        continue;
      }
      const scoped = parseConnectionScoped(token);
      if (scoped.body.startsWith('source:')) {
        const sourceName = scoped.body.slice('source:'.length).trim();
        if (sourceName) {
          refs.push({ kind: 'sl_source', connectionId: scoped.connectionId, sourceName });
        }
        continue;
      }
      if (scoped.body.startsWith('table:')) {
        const tableRef = scoped.body.slice('table:'.length).trim();
        if (tableRef) {
          refs.push({ kind: 'table', connectionId: scoped.connectionId, tableRef });
        }
        continue;
      }
      const parts = scoped.body.split('.');
      if (parts.length === 2 && isIdentifierToken(parts[0] ?? '') && isIdentifierToken(parts[1] ?? '')) {
        refs.push({
          kind: 'sl_entity',
          connectionId: scoped.connectionId,
          sourceName: parts[0],
          entityName: parts[1],
        });
      }
    }
  }
  return refs;
}

function entityNames(source: SemanticLayerSource): Set<string> {
  return new Set([
    ...(source.measures ?? []).map((measure) => measure.name),
    ...(source.columns ?? []).map((column) => column.name),
    ...(source.segments ?? []).map((segment) => segment.name),
  ]);
}

export async function findInvalidWikiBodyRefs(input: WikiBodyRefValidationInput): Promise<string[]> {
  const errors: string[] = [];
  const sourceCache = new Map<string, SemanticLayerSource[]>();
  const loadSources = async (connectionId: string): Promise<SemanticLayerSource[]> => {
    const cached = sourceCache.get(connectionId);
    if (cached) {
      return cached;
    }
    const sources = await input.loadSources(connectionId);
    sourceCache.set(connectionId, sources);
    return sources;
  };

  const findSource = async (
    connectionIds: string[],
    sourceName: string,
  ): Promise<{ connectionId: string; source: SemanticLayerSource } | null> => {
    for (const connectionId of connectionIds) {
      const source = (await loadSources(connectionId)).find((candidate) => candidate.name === sourceName);
      if (source) {
        return { connectionId, source };
      }
    }
    return null;
  };

  for (const ref of parseWikiBodyRefs(input.body)) {
    const connectionIds = ref.connectionId ? [ref.connectionId] : input.visibleConnectionIds;
    if (ref.kind === 'table') {
      const found = await Promise.all(connectionIds.map((connectionId) => input.tableExists(connectionId, ref.tableRef)));
      if (!found.some(Boolean)) {
        errors.push(`${input.pageKey}: unknown raw table ${ref.connectionId ? `${ref.connectionId}/` : ''}${ref.tableRef}`);
      }
      continue;
    }

    const found = await findSource(connectionIds, ref.sourceName);
    if (!found) {
      if (ref.kind === 'sl_source') {
        errors.push(
          `${input.pageKey}: unknown semantic-layer source ${ref.connectionId ? `${ref.connectionId}/` : ''}${ref.sourceName}`,
        );
      }
      continue;
    }
    if (ref.kind === 'sl_entity' && !entityNames(found.source).has(ref.entityName)) {
      errors.push(`${input.pageKey}: unknown semantic-layer entity ${ref.sourceName}.${ref.entityName}`);
    }
  }

  return errors;
}
