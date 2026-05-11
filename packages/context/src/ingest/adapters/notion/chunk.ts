import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ChunkResult, DiffSet, ScopeDescriptor, WorkUnit } from '../../types.js';
import { notionManifestSchema, notionMetadataSchema } from './types.js';

const MAX_NOTION_WORK_UNIT_CHARS = 40_000;
export const NOTION_ORG_KNOWLEDGE_WARNING =
  'Anything accessible to this Notion integration can become organization knowledge.';
const NOTION_SL_WRITE_GUIDANCE =
  'Write wiki entries with wiki_write. Only write or edit SL sources after sl_discover/sl_read_source confirms a mapped non-Notion target source; if no mapped target exists, emit_unmapped_fallback and keep the fact wiki-only. Do not create SL sources under the Notion connection just because a page mentions a warehouse table.';

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
    .sort();
}

function safeUnitKey(path: string): string {
  return `notion-${path
    .replace(/^pages\//, 'page/')
    .replace(/\/page\.md$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}`;
}

function splitLineRanges(content: string, maxChars: number): Array<{ startLine: number; endLine: number }> {
  const rawLines = content.split('\n');
  const lines = rawLines.length > 0 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  let startLine = 1;
  let currentChars = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const lineChars = lines[index].length + 1;
    if (currentChars > 0 && currentChars + lineChars > maxChars) {
      ranges.push({ startLine, endLine: index });
      startLine = index + 1;
      currentChars = 0;
    }
    currentChars += lineChars;
  }

  if (startLine <= lines.length) {
    ranges.push({ startLine, endLine: lines.length });
  }

  return ranges.length > 0 ? ranges : [{ startLine: 1, endLine: 1 }];
}

async function readManifest(stagedDir: string) {
  try {
    return notionManifestSchema.parse(JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8')));
  } catch (error) {
    throw new Error(`Invalid Notion manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function chunkNotionStagedDir(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
  const files = await walk(stagedDir);
  const manifest = await readManifest(stagedDir);
  const touched = diffSet ? new Set([...diffSet.added, ...diffSet.modified]) : null;
  const workUnits: WorkUnit[] = [];
  const warnings: string[] = [];

  for (const pagePath of files.filter((path) => path.endsWith('/page.md'))) {
    const metadataPath = pagePath.replace(/\/page\.md$/, '/metadata.json');
    const blockPath = pagePath.replace(/\/page\.md$/, '/blocks.json');
    const primary = [metadataPath, pagePath].filter((path) => files.includes(path));
    if (touched && !primary.some((path) => touched.has(path))) {
      continue;
    }

    const metadata = notionMetadataSchema.parse(JSON.parse(await readFile(join(stagedDir, metadataPath), 'utf-8')));
    const rawFiles = touched ? primary.filter((path) => touched.has(path)).sort() : primary.sort();
    const dependencyPaths = ['manifest.json', files.includes(blockPath) ? blockPath : null]
      .filter((path): path is string => typeof path === 'string' && !rawFiles.includes(path))
      .sort();
    const excluded = new Set([...rawFiles, ...dependencyPaths]);
    const peerFileIndex = files.filter((path) => !excluded.has(path)).sort();
    const pageContent = await readFile(join(stagedDir, pagePath), 'utf-8');
    const unitKey = safeUnitKey(pagePath);

    if (rawFiles.includes(pagePath) && pageContent.length > MAX_NOTION_WORK_UNIT_CHARS) {
      warnings.push(`Oversized Notion page split into span-scoped work units: ${metadata.path}`);
      const ranges = splitLineRanges(pageContent, MAX_NOTION_WORK_UNIT_CHARS);
      for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index];
        workUnits.push({
          unitKey: `${unitKey}-part-${index + 1}`,
          displayLabel: `${metadata.path} (part ${index + 1} of ${ranges.length})`,
          rawFiles,
          dependencyPaths,
          peerFileIndex,
          notes: `Synthesize durable wiki and SL knowledge from this Notion page span only. Use read_raw_span on ${pagePath} for lines ${range.startLine}-${range.endLine}; do not call read_raw_file for oversized pages. ${NOTION_SL_WRITE_GUIDANCE} Cite evidence chunk/page IDs.`,
        });
      }
      continue;
    }

    workUnits.push({
      unitKey,
      displayLabel: metadata.path,
      rawFiles,
      dependencyPaths,
      peerFileIndex,
      notes:
        `Synthesize durable wiki and SL knowledge from this Notion page. ${NOTION_SL_WRITE_GUIDANCE} Cite evidence chunk/page IDs.`,
    });
  }

  return {
    workUnits,
    eviction: diffSet && diffSet.deleted.length > 0 ? { deletedRawPaths: [...diffSet.deleted].sort() } : undefined,
    reconcileNotes: [
      `Notion maxKnowledgeCreatesPerRun=${manifest.maxKnowledgeCreatesPerRun}`,
      `Notion maxKnowledgeUpdatesPerRun=${manifest.maxKnowledgeUpdatesPerRun}`,
    ],
    contextReport: {
      capped: manifest.capped,
      warnings: [...new Set([NOTION_ORG_KNOWLEDGE_WARNING, ...manifest.warnings, ...warnings])],
    },
  };
}

export async function describeNotionScope(stagedDir: string): Promise<ScopeDescriptor> {
  const manifest = await readManifest(stagedDir);
  const files = await walk(stagedDir);
  const presentPaths = new Set(files);
  const partialSnapshot = manifest.partialSnapshot || manifest.capped;
  const scopeKey = JSON.stringify({
    crawlMode: manifest.crawlMode,
    rootPageIds: [...manifest.rootPageIds].sort(),
    rootDatabaseIds: [...manifest.rootDatabaseIds].sort(),
    rootDataSourceIds: [...manifest.rootDataSourceIds].sort(),
    partialSnapshot,
  });
  const fingerprint = createHash('sha256').update(scopeKey).digest('hex');
  return {
    fingerprint,
    isPathInScope: (rawPath) => {
      if (partialSnapshot) {
        return presentPaths.has(rawPath);
      }
      return (
        rawPath === 'manifest.json' ||
        rawPath.startsWith('pages/') ||
        rawPath.startsWith('databases/') ||
        rawPath.startsWith('data-sources/')
      );
    },
  };
}
