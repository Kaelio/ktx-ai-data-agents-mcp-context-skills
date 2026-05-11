import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ChunkResult, DiffSet, UnresolvedCardInfo, WorkUnit } from '../../types.js';
import {
  STAGED_FILES,
  type StagedCardFile,
  type StagedSyncConfig,
  stagedCardFileSchema,
  stagedSyncConfigSchema,
} from './types.js';

interface LoadedProject {
  /** Parsed sync config. `null` means the file is malformed — chunker treats as no-match. */
  syncConfig: StagedSyncConfig | null;
  /** Map raw_path (e.g. `cards/1.json`) → parsed card. Malformed files excluded. */
  cardsByPath: Map<string, StagedCardFile>;
  /** Every file under stagedDir, sorted. */
  allPaths: string[];
}

const CARDS_RE = /^cards\/\d+\.json$/;

async function walkStagedDir(stagedDir: string): Promise<string[]> {
  const entries = await readdir(stagedDir, { withFileTypes: true, recursive: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const abs = join(entry.parentPath, entry.name);
    paths.push(relative(stagedDir, abs).replace(/\\/g, '/'));
  }
  paths.sort();
  return paths;
}

async function loadProject(stagedDir: string): Promise<LoadedProject> {
  const allPaths = await walkStagedDir(stagedDir);
  let syncConfig: StagedSyncConfig | null = null;
  try {
    const body = await readFile(join(stagedDir, STAGED_FILES.syncConfig), 'utf-8');
    syncConfig = stagedSyncConfigSchema.parse(JSON.parse(body));
  } catch {
    syncConfig = null;
  }
  const cardsByPath = new Map<string, StagedCardFile>();
  for (const path of allPaths) {
    if (!CARDS_RE.test(path)) {
      continue;
    }
    try {
      const body = await readFile(join(stagedDir, path), 'utf-8');
      const parsed = stagedCardFileSchema.parse(JSON.parse(body));
      cardsByPath.set(path, parsed);
    } catch {
      // Malformed card — skip; it will still contribute to `skipped` provenance via the runner.
    }
  }
  return { syncConfig, cardsByPath, allPaths };
}

function cardMatchesSyncConfig(card: StagedCardFile, config: StagedSyncConfig): boolean {
  if (card.databaseId !== config.metabaseDatabaseId) {
    return false;
  }
  if (card.archived) {
    return false;
  }
  if (config.syncMode === 'ALL' || (config.syncMode === 'ONLY' && config.selections.length === 0)) {
    return true;
  }
  const selectedCollections = new Set(
    config.selections.filter((s) => s.selectionType === 'collection').map((s) => s.metabaseObjectId),
  );
  const selectedItems = new Set(
    config.selections.filter((s) => s.selectionType === 'item').map((s) => s.metabaseObjectId),
  );
  const isInSelection =
    selectedItems.has(card.metabaseId) ||
    (card.collectionId !== null &&
      card.collectionId !== 'root' &&
      selectedCollections.has(card.collectionId as number));
  if (config.syncMode === 'ONLY') {
    return isInSelection;
  }
  if (config.syncMode === 'EXCEPT') {
    return !isInSelection;
  }
  const _exhaustive: never = config.syncMode;
  return _exhaustive;
}

interface ChunkOptions {
  diffSet?: DiffSet;
}

/**
 * Emit WorkUnits for a staged Metabase bundle.
 *
 *   First run (no diffSet): one WU per collection of matching cards. Each WU's
 *                           rawFiles include the card paths + the collection file +
 *                           the database file + sync-config.json. Cards that fail
 *                           the sync-config filter do NOT land in any WU — the
 *                           runner will record them as `action_type='skipped'`.
 *
 *   Re-sync (diffSet): keep only WUs with at least one changed card; move unchanged
 *                      component members to `dependencyPaths`. Emit a single
 *                      `EvictionUnit` for `diffSet.deleted`.
 *
 * Cross-card `{{#N}}` references widen `dependencyPaths` (the referenced card's JSON
 * is read by the WU agent for context, even when it lives in a different collection).
 */
async function loadUnresolvedCards(stagedDir: string): Promise<UnresolvedCardInfo[] | undefined> {
  try {
    const body = await readFile(join(stagedDir, STAGED_FILES.unresolvedCards), 'utf-8');
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      return parsed as UnresolvedCardInfo[];
    }
  } catch {
    // sidecar absent or malformed — treat as none
  }
  return undefined;
}

export async function chunkMetabaseStagedDir(stagedDir: string, opts: ChunkOptions = {}): Promise<ChunkResult> {
  const project = await loadProject(stagedDir);
  const unresolvedCards = await loadUnresolvedCards(stagedDir);
  if (!project.syncConfig) {
    return { workUnits: [], unresolvedCards };
  }
  const firstRunUnits = emitFirstRunWorkUnits(project);
  if (!opts.diffSet) {
    return { workUnits: firstRunUnits, unresolvedCards };
  }
  const diffResult = applyDiffSet(firstRunUnits, project, opts.diffSet);
  return { ...diffResult, unresolvedCards };
}

function emitFirstRunWorkUnits(project: LoadedProject): WorkUnit[] {
  const { syncConfig, cardsByPath, allPaths } = project;
  if (!syncConfig) {
    return [];
  }

  const matchingCardsByCollection = new Map<number | 'root', string[]>();
  const matchingCards = new Map<string, StagedCardFile>();
  const pathByCardId = new Map<number, string>();
  for (const [path, card] of cardsByPath) {
    pathByCardId.set(card.metabaseId, path);
    if (!cardMatchesSyncConfig(card, syncConfig)) {
      continue;
    }
    matchingCards.set(path, card);
    const bucket = card.collectionId ?? 'root';
    const list = matchingCardsByCollection.get(bucket) ?? [];
    list.push(path);
    matchingCardsByCollection.set(bucket, list);
  }

  const collectionIds = [...matchingCardsByCollection.keys()].sort((a, b) => {
    if (a === 'root') {
      return -1;
    }
    if (b === 'root') {
      return 1;
    }
    return (a as number) - (b as number);
  });

  const units: WorkUnit[] = [];
  for (const colId of collectionIds) {
    const cardPaths = (matchingCardsByCollection.get(colId) ?? []).sort();
    const collectionFile = colId === 'root' ? null : `collections/${colId}.json`;
    const databaseFile = `databases/${syncConfig.metabaseDatabaseId}.json`;
    // Per-collection files: included in rawFiles so they participate in touched-check.
    const rawFiles = [...cardPaths, ...(collectionFile ? [collectionFile] : [])].sort();
    // Shared control files: readable by the agent for context, but mutations to them
    // must NOT fan out work across every collection (see applyDiffSet below).
    const sharedControlDeps = [databaseFile, STAGED_FILES.syncConfig];

    // Dependency widening — cards that reference other cards via `{{#N}}`.
    const depPaths = new Set<string>(sharedControlDeps);
    for (const cardPath of cardPaths) {
      const card = matchingCards.get(cardPath);
      if (!card) {
        continue;
      }
      for (const refId of card.referencedCardIds) {
        const refPath = pathByCardId.get(refId);
        if (!refPath) {
          continue;
        }
        if (rawFiles.includes(refPath)) {
          continue;
        }
        depPaths.add(refPath);
      }
    }

    const rawFilesSet = new Set(rawFiles);
    const peerFileIndex = allPaths.filter((p) => !rawFilesSet.has(p) && !depPaths.has(p)).sort();

    const unitKey = `metabase-col-${colId}`;
    const displayLabel = `Metabase collection ${colId}`;
    const notes = `${displayLabel} — ${cardPaths.length} card${cardPaths.length === 1 ? '' : 's'}`;
    units.push({
      unitKey,
      displayLabel,
      rawFiles,
      peerFileIndex,
      dependencyPaths: [...depPaths].sort(),
      notes,
    });
  }
  return units;
}

function applyDiffSet(firstRunUnits: WorkUnit[], project: LoadedProject, diffSet: DiffSet): ChunkResult {
  const touched = new Set([...diffSet.added, ...diffSet.modified]);
  const kept: WorkUnit[] = [];
  for (const wu of firstRunUnits) {
    const anyTouched = wu.rawFiles.some((p) => touched.has(p));
    if (!anyTouched) {
      continue;
    }
    const changedFiles: string[] = [];
    const unchangedComponentFiles: string[] = [];
    for (const p of wu.rawFiles) {
      if (touched.has(p)) {
        changedFiles.push(p);
      } else {
        unchangedComponentFiles.push(p);
      }
    }
    const combinedDeps = new Set<string>([...wu.dependencyPaths, ...unchangedComponentFiles]);
    kept.push({ ...wu, rawFiles: changedFiles.sort(), dependencyPaths: [...combinedDeps].sort() });
  }
  // `project` is reserved — future strategies may widen across collections.
  void project;
  const eviction = diffSet.deleted.length > 0 ? { deletedRawPaths: [...diffSet.deleted].sort() } : undefined;
  return { workUnits: kept, eviction };
}
