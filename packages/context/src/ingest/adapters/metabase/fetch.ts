import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FetchContext, UnresolvedCardInfo } from '../../types.js';
import type { MetabaseClientFactory, MetabaseRuntimeClient } from './client-port.js';
import { computeFetchScope, type FetchScope } from './fetch-scope.js';
import { serializeCard } from './serialize-card.js';
import type { MetabaseSourceStateReader } from './source-state-port.js';
import {
  type MetabasePullConfig,
  parseMetabasePullConfig,
  STAGED_FILES,
  type StagedCollectionFile,
  type StagedDatabaseFile,
  type StagedSyncConfig,
} from './types.js';

class IngestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestInputError';
  }
}

interface MetabaseFetchLogger {
  log(message: string): void;
  warn(message: string): void;
}

const noopMetabaseFetchLogger: MetabaseFetchLogger = {
  log: () => undefined,
  warn: () => undefined,
};

export interface FetchMetabaseBundleParams {
  pullConfig: unknown;
  stagedDir: string;
  ctx: FetchContext;
  clientFactory: MetabaseClientFactory;
  sourceStateReader: MetabaseSourceStateReader;
  logger?: MetabaseFetchLogger;
}

interface CollectionNode {
  id: number | 'root';
  name: string;
  parentId: number | 'root' | null;
}

function buildCollectionIndex(
  tree: Awaited<ReturnType<MetabaseRuntimeClient['getCollectionTree']>>,
): Map<number | 'root', CollectionNode> {
  const index = new Map<number | 'root', CollectionNode>();
  function walk(nodes: typeof tree, parentId: number | 'root' | null): void {
    for (const n of nodes) {
      index.set(n.id, { id: n.id, name: n.name, parentId });
      const children = (n.children ?? []) as typeof tree;
      walk(children, n.id);
    }
  }
  walk(tree, null);
  return index;
}

function resolvePath(index: Map<number | 'root', CollectionNode>, collectionId: number | 'root'): string[] {
  const path: string[] = [];
  let cursor: number | 'root' | null = collectionId;
  const visited = new Set<number | 'root'>();
  while (cursor !== null && cursor !== 'root') {
    if (visited.has(cursor)) {
      break;
    }
    visited.add(cursor);
    const node = index.get(cursor);
    if (!node) {
      break;
    }
    path.unshift(node.name);
    cursor = node.parentId;
  }
  return path;
}

export async function fetchMetabaseBundle(params: FetchMetabaseBundleParams): Promise<void> {
  const pullConfig: MetabasePullConfig = parseMetabasePullConfig(params.pullConfig);
  const logger = params.logger ?? noopMetabaseFetchLogger;
  const syncState = await params.sourceStateReader.getSourceState(pullConfig.metabaseConnectionId);
  const mapping = syncState.mappings.find(
    (m) => m.metabaseDatabaseId === pullConfig.metabaseDatabaseId && m.syncEnabled,
  );
  if (!mapping?.targetConnectionId) {
    throw new IngestInputError(
      `no sync-enabled mapping for database ${pullConfig.metabaseDatabaseId} on Metabase connection ${pullConfig.metabaseConnectionId}`,
    );
  }
  if (mapping.targetConnectionId !== params.ctx.connectionId) {
    throw new IngestInputError(
      `mapping for database ${pullConfig.metabaseDatabaseId} does not point to connection ${params.ctx.connectionId} (points to ${mapping.targetConnectionId})`,
    );
  }
  if (mapping.metabaseDatabaseName === null) {
    throw new IngestInputError(
      `mapping for database ${pullConfig.metabaseDatabaseId} on Metabase connection ${pullConfig.metabaseConnectionId} is unhydrated; run \`ktx connection mapping refresh ${pullConfig.metabaseConnectionId}\` to populate metabaseDatabaseName before ingest.`,
    );
  }
  const mappingDatabaseName: string = mapping.metabaseDatabaseName;

  const client = await params.clientFactory.createClient(pullConfig, params.ctx);
  try {
    const stagedForScope: StagedSyncConfig = {
      metabaseConnectionId: pullConfig.metabaseConnectionId,
      metabaseDatabaseId: pullConfig.metabaseDatabaseId,
      syncMode: syncState.syncMode,
      selections: syncState.selections.map((s) => ({
        selectionType: s.selectionType,
        metabaseObjectId: s.metabaseObjectId,
      })),
      defaultTagNames: syncState.defaultTagNames,
      mapping: {
        metabaseDatabaseId: mapping.metabaseDatabaseId,
        metabaseDatabaseName: mappingDatabaseName,
        metabaseEngine: mapping.metabaseEngine,
        targetConnectionId: mapping.targetConnectionId,
      },
    };
    const scope = computeFetchScope(stagedForScope);

    const collectionTree = await client.getCollectionTree();
    const collectionIndex = buildCollectionIndex(collectionTree);

    await mkdir(join(params.stagedDir, STAGED_FILES.cardsDir), { recursive: true });
    await mkdir(join(params.stagedDir, STAGED_FILES.collectionsDir), { recursive: true });
    await mkdir(join(params.stagedDir, STAGED_FILES.databasesDir), { recursive: true });

    const cardIdsToFetch = await resolveCardIdsToFetch(client, scope, pullConfig.metabaseDatabaseId, logger);

    const referencedCollectionIds = new Set<number>();
    let writtenCards = 0;
    const fetched = new Set<number>();
    const queue: number[] = [...cardIdsToFetch];
    const unresolvedCards: UnresolvedCardInfo[] = [];

    while (queue.length > 0) {
      const cardId = queue.shift();
      if (cardId === undefined) {
        continue;
      }
      if (fetched.has(cardId)) {
        continue;
      }
      fetched.add(cardId);

      let fullCard: Awaited<ReturnType<MetabaseRuntimeClient['getCard']>>;
      try {
        fullCard = await client.getCard(cardId);
      } catch (e) {
        logger.warn(`failed to load card ${cardId}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (fullCard.database_id !== pullConfig.metabaseDatabaseId) {
        continue;
      }
      if (fullCard.archived) {
        continue;
      }
      const resolvedResult = await client.getResolvedSql(fullCard).then(
        (sql) => ({ ok: true as const, sql }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      if (!resolvedResult.ok || resolvedResult.sql === null) {
        const reason = classifyResolutionFailure(resolvedResult);
        const errorMessage = resolvedResult.ok
          ? undefined
          : resolvedResult.err instanceof Error
            ? resolvedResult.err.message
            : String(resolvedResult.err);
        unresolvedCards.push({
          cardId,
          name: fullCard.name,
          reason,
          errorMessage,
        });
        logger.warn(`[metabase.fetch] card ${cardId} ("${fullCard.name}") dropped; reason=${reason}`);
        continue;
      }
      const resolved = resolvedResult.sql;
      const collectionPath =
        fullCard.collection_id && fullCard.collection_id !== 'root'
          ? resolvePath(collectionIndex, fullCard.collection_id as number)
          : [];
      const staged = serializeCard({
        card: fullCard,
        resolvedSql: resolved.resolvedSql,
        templateTags: resolved.templateTags ?? [],
        collectionPath,
        resolutionStatus: resolved.resolutionStatus,
      });
      await writeFile(
        join(params.stagedDir, STAGED_FILES.cardsDir, `${fullCard.id}.json`),
        JSON.stringify(staged, null, 2),
        'utf-8',
      );
      writtenCards += 1;
      if (typeof fullCard.collection_id === 'number') {
        referencedCollectionIds.add(fullCard.collection_id);
      }

      if (scope.kind === 'explicit') {
        for (const refId of staged.referencedCardIds) {
          if (!fetched.has(refId)) {
            queue.push(refId);
          }
        }
      }
    }

    for (const colId of referencedCollectionIds) {
      const node = collectionIndex.get(colId);
      if (!node) {
        continue;
      }
      const file: StagedCollectionFile = {
        metabaseId: node.id,
        name: node.name,
        parentId: node.parentId ?? 'root',
      };
      await writeFile(
        join(params.stagedDir, STAGED_FILES.collectionsDir, `${colId}.json`),
        JSON.stringify(file, null, 2),
        'utf-8',
      );
    }

    const databaseFile: StagedDatabaseFile = {
      metabaseDatabaseId: mapping.metabaseDatabaseId,
      metabaseDatabaseName: mappingDatabaseName,
      metabaseEngine: mapping.metabaseEngine,
      targetConnectionId: mapping.targetConnectionId,
    };
    await writeFile(
      join(params.stagedDir, STAGED_FILES.databasesDir, `${mapping.metabaseDatabaseId}.json`),
      JSON.stringify(databaseFile, null, 2),
      'utf-8',
    );

    await writeFile(join(params.stagedDir, STAGED_FILES.syncConfig), JSON.stringify(stagedForScope, null, 2), 'utf-8');

    if (unresolvedCards.length > 0) {
      await writeFile(
        join(params.stagedDir, STAGED_FILES.unresolvedCards),
        JSON.stringify(unresolvedCards, null, 2),
        'utf-8',
      );
    }

    logger.log(
      `wrote ${writtenCards} cards for database ${pullConfig.metabaseDatabaseId} -> ${mapping.targetConnectionId} (scope=${scope.kind}); unresolved=${unresolvedCards.length}`,
    );
  } finally {
    await client.cleanup();
  }
}

function classifyResolutionFailure(
  r: { ok: true; sql: { resolvedSql: string } | null } | { ok: false; err: unknown },
): UnresolvedCardInfo['reason'] {
  if (r.ok && r.sql === null) {
    return 'api_500';
  }
  if (!r.ok) {
    const msg = r.err instanceof Error ? r.err.message : String(r.err);
    if (msg.includes('Cycle detected')) {
      return 'cycle';
    }
    if (msg.includes('no native query')) {
      return 'missing_native';
    }
  }
  return 'unknown';
}

/**
 * Resolve the initial set of card ids to fetch based on the scope. For `all`
 * and `all-except`, this fans out to `getAllCards()` and filters by
 * `database_id` + `excludeCardIds` / `excludeCollectionIds`. For `explicit`,
 * this walks the selection: direct item ids + members of selected collections
 * (via `getCollectionItems`). The closure over `{{#N}}` references is applied
 * later in the main fetch loop.
 */
async function resolveCardIdsToFetch(
  client: MetabaseRuntimeClient,
  scope: FetchScope,
  metabaseDatabaseId: number,
  logger: { warn(message: string): void },
): Promise<number[]> {
  if (scope.kind === 'all' || scope.kind === 'all-except') {
    const all = await client.getAllCards();
    const matching = all.filter((c) => !c.archived && c.database_id === metabaseDatabaseId);
    if (scope.kind === 'all') {
      return matching.map((c) => c.id);
    }
    return matching
      .filter((c) => !scope.excludeCardIds.has(c.id))
      .filter((c) => typeof c.collection_id !== 'number' || !scope.excludeCollectionIds.has(c.collection_id))
      .map((c) => c.id);
  }
  const ids = new Set<number>(scope.includeCardIds);
  for (const colId of scope.includeCollectionIds) {
    let items: Array<{ id: number; model: string }>;
    try {
      items = await client.getCollectionItems(colId);
    } catch (e) {
      logger.warn(`failed to list collection ${colId}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const item of items) {
      if (item.model === 'card' || item.model === 'dataset' || item.model === 'metric') {
        ids.add(item.id);
      }
    }
  }
  return [...ids];
}
