import { constants as fsConstants } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { MemoryFlowReplayInput } from '@ktx/context/ingest/memory-flow';
import { loadPackagedDemoReplay } from './demo-assets.js';
import { DEMO_LATEST_REPLAY_FILE, loadLatestDemoReplay } from './demo-replay-store.js';
import { KTX_NEXT_STEP_COMMAND_WIDTH, KTX_NEXT_STEP_DIRECT_COMMANDS } from './next-steps.js';

type SeededInspectReadiness = 'missing' | 'ready' | 'corrupt';

export interface DemoSeededManifest {
  demoAssetSchemaVersion: number;
  name: string;
  displayName: string;
  mode: string;
  source?: string;
  sources: {
    warehouse: { label: string; path?: string; tables: number; rowCounts: Record<string, number> };
    dbt: { label: string; path?: string; models: number; sourceTables: number };
    bi: { label: string; path?: string; explores: number; dashboards: number };
    notion: { label: string; path?: string; pages: number };
  };
  generated: {
    semanticLayer: { path?: string; sourceCount: number };
    knowledge: { path?: string; pageCount: number };
    links: { path?: string; linkCount: number };
  };
}

export interface SeededInspectSummary {
  projectDir: string;
  mode: 'seeded';
  manifest: DemoSeededManifest;
  status: { status: SeededInspectReadiness; missing: string[] };
  sourceBundle: {
    warehouse: {
      label: string;
      path: string;
      tableCount: number;
      rowCounts: Record<string, number>;
      totalRows: number;
    };
    dbt: { label: string; path: string; modelCount: number; sourceTableCount: number };
    bi: { label: string; path: string; exploreCount: number; dashboardCount: number };
    notion: { label: string; path: string; pageCount: number };
  };
  generatedOutputs: {
    semanticLayer: { path: string; manifestSourceCount: number; fileCount: number };
    knowledge: { path: string; manifestPageCount: number; fileCount: number };
    links: { path: string; manifestLinkCount: number; linkCount: number };
    reports: { primaryPath: string; fileCount: number };
    replays: { primaryPath: string; latestPath: string; fileCount: number };
  };
  modeMetadata: {
    mode: 'seeded';
    source: 'packaged demo project';
    generatedContext: 'prebuilt from bundled assets';
    llmCalls: 'none';
    origin: string;
    timing: string;
    sourceReportId: string | null;
    sourceReportPath: string | null;
  };
  nextCommands: Array<{ command: string; description: string }>;
  latestReplay: MemoryFlowReplayInput | null;
}

const REQUIRED_SEEDED_PROJECT_PATHS = [
  'ktx.yaml',
  'demo.db',
  'state.sqlite',
  'manifest.json',
  join('replays', 'replay.memory-flow.v1.json'),
  join('semantic-layer', 'dbt-main', 'mart_arr_daily.yaml'),
  join('semantic-layer', 'postgres-warehouse', 'mart_account_activity.yaml'),
  join('knowledge', 'global', 'orbit-company-overview.md'),
  join('links', 'provenance.json'),
  join('reports', 'seeded-demo-report.json'),
] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadSeededManifest(projectDir: string): Promise<DemoSeededManifest> {
  const raw = await readFile(join(projectDir, 'manifest.json'), 'utf-8');
  return JSON.parse(raw) as DemoSeededManifest;
}

async function listFilesInDir(dir: string, ext?: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true });
    return entries
      .filter((entry): entry is string => typeof entry === 'string')
      .filter((entry) => !ext || entry.endsWith(ext))
      .sort();
  } catch {
    return [];
  }
}

async function inspectSeededProjectStatus(projectDir: string): Promise<{ status: SeededInspectReadiness; missing: string[] }> {
  const missing: string[] = [];
  for (const relativePath of REQUIRED_SEEDED_PROJECT_PATHS) {
    if (!(await exists(join(projectDir, relativePath)))) {
      missing.push(relativePath);
    }
  }

  if (missing.length === REQUIRED_SEEDED_PROJECT_PATHS.length) {
    return { status: 'missing', missing };
  }
  if (missing.length > 0) {
    return { status: 'corrupt', missing };
  }
  return { status: 'ready', missing: [] };
}

async function loadLinksCount(projectDir: string): Promise<number> {
  try {
    const raw = await readFile(join(projectDir, 'links', 'provenance.json'), 'utf-8');
    const links = JSON.parse(raw) as unknown[];
    return links.length;
  } catch {
    return 0;
  }
}

async function loadSeededReplay(projectDir: string): Promise<MemoryFlowReplayInput | null> {
  const latest = await loadLatestDemoReplay(projectDir);
  if (latest) {
    return latest;
  }

  try {
    return await loadPackagedDemoReplay();
  } catch {
    return null;
  }
}

function sourceBundleFromManifest(manifest: DemoSeededManifest): SeededInspectSummary['sourceBundle'] {
  const warehouse = manifest.sources.warehouse;
  const rowCounts = Object.fromEntries(Object.entries(warehouse.rowCounts).sort(([a], [b]) => a.localeCompare(b)));
  const totalRows = Object.values(rowCounts).reduce((total, count) => total + count, 0);

  return {
    warehouse: {
      label: warehouse.label,
      path: warehouse.path ?? 'demo.db',
      tableCount: warehouse.tables,
      rowCounts,
      totalRows,
    },
    dbt: {
      label: manifest.sources.dbt.label,
      path: manifest.sources.dbt.path ?? 'raw-sources/dbt',
      modelCount: manifest.sources.dbt.models,
      sourceTableCount: manifest.sources.dbt.sourceTables,
    },
    bi: {
      label: manifest.sources.bi.label,
      path: manifest.sources.bi.path ?? 'raw-sources/bi',
      exploreCount: manifest.sources.bi.explores,
      dashboardCount: manifest.sources.bi.dashboards,
    },
    notion: {
      label: manifest.sources.notion.label,
      path: manifest.sources.notion.path ?? 'raw-sources/notion',
      pageCount: manifest.sources.notion.pages,
    },
  };
}

function nextCommands(): SeededInspectSummary['nextCommands'] {
  return [...KTX_NEXT_STEP_DIRECT_COMMANDS];
}

function modeMetadataFromReplay(replay: MemoryFlowReplayInput | null): SeededInspectSummary['modeMetadata'] {
  return {
    mode: 'seeded',
    source: 'packaged demo project',
    generatedContext: 'prebuilt from bundled assets',
    llmCalls: 'none',
    origin: replay?.metadata?.origin ?? 'packaged',
    timing: replay?.metadata?.timing ?? 'prebuilt',
    sourceReportId: replay?.metadata?.sourceReportId ?? 'demo-seeded-report',
    sourceReportPath: replay?.metadata?.sourceReportPath ?? 'reports/seeded-demo-report.json',
  };
}

export async function inspectSeededProject(projectDir: string): Promise<SeededInspectSummary> {
  const root = resolve(projectDir);
  const manifest = await loadSeededManifest(root);
  const latestReplay = await loadSeededReplay(root);
  const semanticLayerPath = manifest.generated.semanticLayer.path ?? 'semantic-layer/orbit_demo';
  const knowledgePath = manifest.generated.knowledge.path ?? 'knowledge/global';
  const linksPath = join(manifest.generated.links.path ?? 'links', 'provenance.json');
  const reportFiles = await listFilesInDir(join(root, 'reports'), '.json');
  const replayFiles = await listFilesInDir(join(root, 'replays'), '.json');

  return {
    projectDir: root,
    mode: 'seeded',
    manifest,
    status: await inspectSeededProjectStatus(root),
    sourceBundle: sourceBundleFromManifest(manifest),
    generatedOutputs: {
      semanticLayer: {
        path: semanticLayerPath,
        manifestSourceCount: manifest.generated.semanticLayer.sourceCount,
        fileCount: (await listFilesInDir(join(root, semanticLayerPath), '.yaml')).length,
      },
      knowledge: {
        path: knowledgePath,
        manifestPageCount: manifest.generated.knowledge.pageCount,
        fileCount: (await listFilesInDir(join(root, knowledgePath), '.md')).length,
      },
      links: {
        path: linksPath,
        manifestLinkCount: manifest.generated.links.linkCount,
        linkCount: await loadLinksCount(root),
      },
      reports: {
        primaryPath: reportFiles[0] ? join('reports', reportFiles[0]) : 'reports/seeded-demo-report.json',
        fileCount: reportFiles.length,
      },
      replays: {
        primaryPath: join('replays', 'replay.memory-flow.v1.json'),
        latestPath: join('replays', DEMO_LATEST_REPLAY_FILE),
        fileCount: replayFiles.length,
      },
    },
    modeMetadata: modeMetadataFromReplay(latestReplay),
    nextCommands: nextCommands(),
    latestReplay,
  };
}

function rowCountPreview(rowCounts: Record<string, number>): string {
  return Object.entries(rowCounts)
    .map(([name, count]) => `${name} ${count}`)
    .join(', ');
}

function replayLine(summary: SeededInspectSummary): string {
  const metadata = summary.latestReplay?.metadata ?? summary.modeMetadata;
  return `Latest replay: ${metadata.mode} (${metadata.origin}, ${metadata.timing})`;
}

export function formatSeededInspect(summary: SeededInspectSummary): string {
  const source = summary.sourceBundle;
  const generated = summary.generatedOutputs;
  const lines = [`Demo project: ${summary.projectDir}`, `Status: ${summary.status.status}`];

  if (summary.status.missing.length > 0) {
    lines.push(`Missing: ${summary.status.missing.join(', ')}`);
  }

  lines.push(
    `Mode: seeded (pre-seeded demo project)`,
    `Source: ${summary.modeMetadata.source}`,
    `Generated context: ${summary.modeMetadata.generatedContext}`,
    `LLM calls: ${summary.modeMetadata.llmCalls}`,
    '',
    'Source bundle:',
    `  Warehouse: ${source.warehouse.tableCount} tables, ${source.warehouse.totalRows.toLocaleString()} rows`,
    `    Rows: ${rowCountPreview(source.warehouse.rowCounts)}`,
    `  dbt: ${source.dbt.modelCount} models, ${source.dbt.sourceTableCount} source tables`,
    `  BI: ${source.bi.exploreCount} explores, ${source.bi.dashboardCount} dashboards`,
    `  Notion: ${source.notion.pageCount} pages`,
    '',
    'Generated context:',
    `  Semantic-layer sources: ${generated.semanticLayer.manifestSourceCount} manifest, ${generated.semanticLayer.fileCount} files`,
    `  Knowledge pages: ${generated.knowledge.manifestPageCount} manifest, ${generated.knowledge.fileCount} files`,
    `  Evidence links: ${generated.links.manifestLinkCount} manifest, ${generated.links.linkCount} links`,
    '',
    `Report: ${generated.reports.primaryPath}`,
    `Replay: ${generated.replays.primaryPath}`,
    replayLine(summary),
    '',
    'What to do next:',
  );

  for (const command of summary.nextCommands) {
    lines.push(`  $ ${command.command.padEnd(KTX_NEXT_STEP_COMMAND_WIDTH)}  ${command.description}`);
  }

  lines.push('', `Your KTX project files are at: ${summary.projectDir}`, '');
  return lines.join('\n');
}
