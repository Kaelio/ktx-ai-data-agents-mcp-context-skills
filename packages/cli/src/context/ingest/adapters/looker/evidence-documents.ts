import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { TriageSignals } from '../../types.js';
import {
  STAGED_FILES,
  type StagedDashboardFile,
  type StagedExploreFile,
  type StagedLookerSignalsFile,
  type StagedLookFile,
  stagedDashboardFileSchema,
  stagedExploreFileSchema,
  stagedLookerSignalsFileSchema,
  stagedLookFileSchema,
} from './types.js';

type JsonObject = Record<string, unknown>;

interface EvidenceDocument {
  relDir: string;
  metadata: JsonObject;
  markdown: string;
}

export async function writeLookerEvidenceDocuments(stagedDir: string): Promise<void> {
  const paths = await walkJson(stagedDir);
  const signals = await readSignals(stagedDir);
  const documents: EvidenceDocument[] = [];

  for (const relPath of paths) {
    if (/^explores\/[^/]+\/[^/]+\.json$/.test(relPath)) {
      const explore = await readJson(stagedDir, relPath, stagedExploreFileSchema);
      documents.push(renderExploreEvidence(relPath, explore));
      continue;
    }
    if (/^dashboards\/[^/]+\.json$/.test(relPath)) {
      const dashboard = await readJson(stagedDir, relPath, stagedDashboardFileSchema);
      documents.push(renderDashboardEvidence(relPath, dashboard));
      continue;
    }
    if (/^looks\/[^/]+\.json$/.test(relPath)) {
      const look = await readJson(stagedDir, relPath, stagedLookFileSchema);
      documents.push(renderLookEvidence(relPath, look));
    }
  }

  for (const document of documents) {
    await writeJson(stagedDir, join(document.relDir, 'metadata.json'), document.metadata);
    await writeText(stagedDir, join(document.relDir, 'page.md'), document.markdown);
  }

  await writeJson(stagedDir, join(STAGED_FILES.evidenceRoot, 'signals-summary.json'), {
    dashboardUsageCount: signals.dashboardUsage.length,
    lookUsageCount: signals.lookUsage.length,
    scheduledPlanCount: signals.scheduledPlans.length,
    favoriteCount: signals.favorites.length,
  });
}

export async function getLookerTriageSignals(stagedDir: string, externalId: string): Promise<TriageSignals> {
  const signals = await readSignals(stagedDir);
  const dashboardId = /^looker:dashboard:(.+)$/.exec(externalId)?.[1];
  if (dashboardId) {
    const dashboard = await readOptionalJson(
      stagedDir,
      `dashboards/${safePathSegment(dashboardId)}.json`,
      stagedDashboardFileSchema,
    );
    const usage = signals.dashboardUsage.find((item) => item.contentId === dashboardId);
    const schedule = signals.scheduledPlans.find(
      (item) => item.contentType === 'dashboard' && item.contentId === dashboardId,
    );
    const favorite = signals.favorites.find(
      (item) => item.contentType === 'dashboard' && item.contentId === dashboardId,
    );
    return {
      objectType: 'looker_dashboard',
      lastEditedAt: dashboard?.updatedAt ?? usage?.lastRunAt ?? undefined,
      propertyHints: {
        contentType: 'dashboard',
        queryCount30d: String(usage?.queryCount30d ?? 0),
        uniqueUsers30d: String(usage?.uniqueUsers30d ?? 0),
        isScheduled: String(schedule?.isScheduled ?? false),
        favoriteCount: String(favorite?.favoriteCount ?? 0),
      },
    };
  }

  const lookId = /^looker:look:(.+)$/.exec(externalId)?.[1];
  if (lookId) {
    const look = await readOptionalJson(stagedDir, `looks/${safePathSegment(lookId)}.json`, stagedLookFileSchema);
    const usage = signals.lookUsage.find((item) => item.contentId === lookId);
    const schedule = signals.scheduledPlans.find((item) => item.contentType === 'look' && item.contentId === lookId);
    const favorite = signals.favorites.find((item) => item.contentType === 'look' && item.contentId === lookId);
    return {
      objectType: 'looker_look',
      lastEditedAt: look?.updatedAt ?? usage?.lastRunAt ?? undefined,
      propertyHints: {
        contentType: 'look',
        queryCount30d: String(usage?.queryCount30d ?? 0),
        uniqueUsers30d: String(usage?.uniqueUsers30d ?? 0),
        isScheduled: String(schedule?.isScheduled ?? false),
        favoriteCount: String(favorite?.favoriteCount ?? 0),
      },
    };
  }

  const explore = /^looker:explore:([^.]+)\.(.+)$/.exec(externalId);
  if (explore) {
    return {
      objectType: 'looker_explore',
      propertyHints: {
        contentType: 'explore',
        modelName: explore[1],
        exploreName: explore[2],
      },
    };
  }

  return { objectType: 'looker_runtime' };
}

function renderExploreEvidence(rawPath: string, explore: StagedExploreFile): EvidenceDocument {
  const title = explore.label ?? `${explore.modelName}.${explore.exploreName}`;
  const relDir = join(
    STAGED_FILES.evidenceRoot,
    'explores',
    safePathSegment(explore.modelName),
    safePathSegment(explore.exploreName),
  );
  const lines = [
    `# ${title}`,
    '',
    explore.description ? explore.description : '',
    '',
    '## Explore',
    '',
    `- model: ${explore.modelName}`,
    `- explore: ${explore.exploreName}`,
    '',
    '## Dimensions',
    '',
    ...fieldLines(explore.fields.dimensions),
    '',
    '## Measures',
    '',
    ...fieldLines(explore.fields.measures),
    '',
    '## Joins',
    '',
    ...(explore.joins.length === 0
      ? ['- none']
      : explore.joins.map((item) => `- ${item.name}${item.relationship ? ` (${item.relationship})` : ''}`)),
  ];
  return {
    relDir,
    metadata: {
      objectType: 'looker_explore',
      id: `looker:explore:${explore.modelName}.${explore.exploreName}`,
      title,
      path: `Looker / Explores / ${explore.modelName}.${explore.exploreName}`,
      url: null,
      parentId: null,
      databaseId: null,
      dataSourceId: null,
      lastEditedAt: null,
      lastEditedBy: null,
      properties: {
        rawPath,
        modelName: explore.modelName,
        exploreName: explore.exploreName,
      },
    },
    markdown: normalizeMarkdown(lines),
  };
}

function renderDashboardEvidence(rawPath: string, dashboard: StagedDashboardFile): EvidenceDocument {
  const relDir = join(STAGED_FILES.evidenceRoot, 'dashboards', safePathSegment(dashboard.lookerId));
  const lines = [
    `# ${dashboard.title}`,
    '',
    dashboard.description ?? '',
    '',
    '## Dashboard Queries',
    '',
    ...dashboard.tiles.flatMap((tile) => [
      `## Tile: ${tile.title ?? tile.id}`,
      '',
      ...(tile.query ? queryLines(tile.query) : ['- no inline query captured']),
      '',
    ]),
  ];
  return {
    relDir,
    metadata: {
      objectType: 'looker_dashboard',
      id: `looker:dashboard:${dashboard.lookerId}`,
      title: dashboard.title,
      path: `Looker / Dashboards / ${dashboard.title}`,
      url: null,
      parentId: dashboard.folderId,
      databaseId: null,
      dataSourceId: null,
      lastEditedAt: dashboard.updatedAt,
      lastEditedBy: null,
      properties: {
        rawPath,
        lookerId: dashboard.lookerId,
      },
    },
    markdown: normalizeMarkdown(lines),
  };
}

function renderLookEvidence(rawPath: string, look: StagedLookFile): EvidenceDocument {
  const relDir = join(STAGED_FILES.evidenceRoot, 'looks', safePathSegment(look.lookerId));
  const lines = [
    `# ${look.title}`,
    '',
    look.description ?? '',
    '',
    '## Look Query',
    '',
    ...(look.query ? queryLines(look.query) : ['- no query captured']),
  ];
  return {
    relDir,
    metadata: {
      objectType: 'looker_look',
      id: `looker:look:${look.lookerId}`,
      title: look.title,
      path: `Looker / Looks / ${look.title}`,
      url: null,
      parentId: look.folderId,
      databaseId: null,
      dataSourceId: null,
      lastEditedAt: look.updatedAt,
      lastEditedBy: null,
      properties: {
        rawPath,
        lookerId: look.lookerId,
      },
    },
    markdown: normalizeMarkdown(lines),
  };
}

function fieldLines(
  fields: Array<{
    name: string;
    label: string | null;
    type: string | null;
    sql: string | null;
    description: string | null;
  }>,
): string[] {
  if (fields.length === 0) {
    return ['- none'];
  }
  return fields.map((field) => {
    const parts = [
      field.name,
      field.label ? `label: ${field.label}` : null,
      field.type ? `type: ${field.type}` : null,
      field.description ? `description: ${field.description}` : null,
    ].filter(Boolean);
    return `- ${parts.join('; ')}`;
  });
}

function queryLines(query: StagedDashboardFile['tiles'][number]['query']): string[] {
  if (!query) {
    return ['- no query captured'];
  }
  return [
    `- model: ${query.model}`,
    `- explore: ${query.view}`,
    '',
    '### Fields',
    '',
    ...(query.fields.length === 0 ? ['- none'] : query.fields.map((field) => `- ${field}`)),
    '',
    '### Filters',
    '',
    ...filterLines(query.filters),
  ];
}

function filterLines(filters: Record<string, unknown>): string[] {
  const entries = Object.entries(filters).filter(
    ([, value]) => value !== null && value !== undefined && String(value).trim() !== '',
  );
  if (entries.length === 0) {
    return ['- none'];
  }
  return entries.map(([field, value]) => `- ${field} = ${String(value)}`);
}

async function readSignals(stagedDir: string): Promise<StagedLookerSignalsFile> {
  const [dashboardUsage, lookUsage, scheduledPlans, favorites] = await Promise.all([
    readOptionalArray(stagedDir, STAGED_FILES.signals.dashboardUsage),
    readOptionalArray(stagedDir, STAGED_FILES.signals.lookUsage),
    readOptionalArray(stagedDir, STAGED_FILES.signals.scheduledPlans),
    readOptionalArray(stagedDir, STAGED_FILES.signals.favorites),
  ]);
  return stagedLookerSignalsFileSchema.parse({ dashboardUsage, lookUsage, scheduledPlans, favorites });
}

async function readOptionalArray(stagedDir: string, relPath: string): Promise<unknown[]> {
  try {
    const parsed = JSON.parse(await readFile(join(stagedDir, relPath), 'utf-8')) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function readOptionalJson<T>(
  stagedDir: string,
  relPath: string,
  schema: { parse(value: unknown): T },
): Promise<T | null> {
  try {
    return await readJson(stagedDir, relPath, schema);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function readJson<T>(stagedDir: string, relPath: string, schema: { parse(value: unknown): T }): Promise<T> {
  return schema.parse(JSON.parse(await readFile(join(stagedDir, relPath), 'utf-8')));
}

async function writeJson(stagedDir: string, relPath: string, value: unknown): Promise<void> {
  await writeText(stagedDir, relPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(stagedDir: string, relPath: string, body: string): Promise<void> {
  const target = join(stagedDir, relPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body, 'utf-8');
}

async function walkJson(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const absPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await walkJson(root, absPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.json')) {
      paths.push(relative(root, absPath).replace(/\\/g, '/'));
    }
  }
  return paths.sort();
}

function safePathSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`Unsafe Looker evidence path segment: ${value}`);
  }
  return value;
}

function normalizeMarkdown(lines: string[]): string {
  return `${lines
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n')
    .trim()}\n`;
}
