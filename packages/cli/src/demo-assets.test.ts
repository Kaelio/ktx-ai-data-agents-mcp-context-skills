import { access, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEMO_ADAPTER,
  DEMO_CONNECTION_ID,
  DEMO_FULL_JOB_ID,
  DEMO_REPLAY_FILE,
  defaultDemoProjectDir,
  ensureDemoProject,
  inspectDemoProjectState,
  loadPackagedDemoReplay,
  loadProjectDemoReplay,
  resetDemoProject,
} from './demo-assets.js';
import { writeDemoReplay } from './demo-replay-store.js';

const packagedDemoSource = 'packaged-orbit-demo';

function packagedDemoAssetPath(relativePath: string): string {
  return fileURLToPath(new URL(`../assets/demo/orbit/${relativePath}`, import.meta.url));
}

async function readPackagedJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(packagedDemoAssetPath(relativePath), 'utf-8')) as T;
}

describe('demo assets', () => {
  const projectDir = join(tmpdir(), `ktx-demo-assets-${process.pid}`);

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('resolves the default demo root under the OS temp directory', () => {
    const dir = defaultDemoProjectDir();
    expect(dir.startsWith(join(tmpdir(), 'ktx-demo-'))).toBe(true);
    expect(dir).toMatch(/ktx-demo-[a-f0-9]{8}$/);
  });

  it('exports the packaged Orbit demo identity', () => {
    expect(DEMO_CONNECTION_ID).toBe('orbit_demo');
    expect(DEMO_ADAPTER).toBe('live-database');
    expect(DEMO_REPLAY_FILE).toBe('replay.memory-flow.v1.json');
    expect(DEMO_FULL_JOB_ID).toBe('demo-full-ingest');
  });

  it('ships the seeded demo bundle required by the May 6 PRD', async () => {
    const manifest = await readPackagedJson<{
      demoAssetSchemaVersion: number;
      mode: string;
      source: string;
      sources: {
        warehouse: { tables: number; rowCounts: Record<string, number> };
        dbt: { models: number; sourceTables: number };
        bi: { explores: number; dashboards: number };
        notion: { pages: number };
      };
      name: string;
      displayName: string;
      generated: {
        semanticLayer: { path: string; sourceCount: number };
        knowledge: { pageCount: number };
        links: { linkCount: number };
      };
    }>('manifest.json');

    expect(manifest).toMatchObject({
      demoAssetSchemaVersion: 2,
      name: 'orbit',
      displayName: 'Orbit Demo',
      mode: 'seeded',
      source: packagedDemoSource,
    });
    expect(manifest.sources.warehouse.tables).toBeGreaterThanOrEqual(5);
    expect(manifest.sources.warehouse.tables).toBeLessThanOrEqual(10);
    expect(Object.keys(manifest.sources.warehouse.rowCounts).sort()).toEqual([
      'accounts',
      'arr_movements',
      'contracts',
      'invoices',
      'plans',
      'purchase_requests',
      'support_tickets',
      'users',
    ]);
    expect(manifest.sources.dbt.models).toBeGreaterThanOrEqual(3);
    expect(manifest.sources.dbt.models).toBeLessThanOrEqual(6);
    expect(manifest.sources.bi.explores).toBeGreaterThanOrEqual(2);
    expect(manifest.sources.bi.dashboards).toBeGreaterThanOrEqual(2);
    expect(manifest.sources.notion.pages).toBeGreaterThanOrEqual(5);
    expect(manifest.generated.semanticLayer.sourceCount).toBeGreaterThanOrEqual(40);
    expect(manifest.generated.knowledge.pageCount).toBeGreaterThanOrEqual(20);
    expect(manifest.generated.links.linkCount).toBeGreaterThanOrEqual(10);

    const dbStat = await stat(packagedDemoAssetPath('demo.db'));
    expect(dbStat.size).toBeGreaterThan(0);
    expect(dbStat.size).toBeLessThan(10 * 1024 * 1024);

    await expect(access(packagedDemoAssetPath('semantic-layer/dbt-main/mart_arr_daily.yaml'))).resolves.toBeUndefined();
    await expect(access(packagedDemoAssetPath('semantic-layer/postgres-warehouse/mart_account_activity.yaml'))).resolves.toBeUndefined();
    await expect(access(packagedDemoAssetPath('knowledge/global/orbit-company-overview.md'))).resolves.toBeUndefined();
    await expect(access(packagedDemoAssetPath('links/provenance.json'))).resolves.toBeUndefined();
    await expect(access(packagedDemoAssetPath('reports/seeded-demo-report.json'))).resolves.toBeUndefined();
  });

  it('initializes a flat demo project without writing literal credentials', async () => {
    const result = await ensureDemoProject({ projectDir, force: false });

    expect(result.projectDir).toBe(projectDir);
    await expect(access(join(projectDir, 'demo.db'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'state.sqlite'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'reports'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'semantic-layer'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'knowledge'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'replays', 'replay.memory-flow.v1.json'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'raw-sources'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, '_schema'))).rejects.toMatchObject({ code: 'ENOENT' });

    const config = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    expect(config).toContain('backend: anthropic');
    expect(config).toContain('api_key: env:ANTHROPIC_API_KEY');
    expect(config).not.toContain('sk-ant-');
  });

  it('rejects an existing demo project unless force is set', async () => {
    await ensureDemoProject({ projectDir, force: false });
    await expect(ensureDemoProject({ projectDir, force: false })).rejects.toThrow('Demo project already exists');
    await expect(ensureDemoProject({ projectDir, force: true })).resolves.toMatchObject({ projectDir });
  });

  it('loads packaged and copied demo replays', async () => {
    const packaged = await loadPackagedDemoReplay();
    expect(packaged.runId).toBe('demo-seeded-orbit');
    expect(packaged.connectionId).toBe('orbit_demo');
    expect(packaged.metadata?.mode).toBe('seeded');

    await ensureDemoProject({ projectDir, force: false });
    const copied = await loadProjectDemoReplay(projectDir);
    expect(copied).toEqual(packaged);
  });

  it('loads the latest local replay before the packaged replay', async () => {
    await ensureDemoProject({ projectDir, force: false });
    await writeDemoReplay(
      projectDir,
      {
        metadata: {
          schemaVersion: 1,
          mode: 'full',
          origin: 'captured',
          timing: 'captured',
          capturedAt: '2026-05-01T10:00:03.000Z',
          sourceReportId: null,
          sourceReportPath: 'raw-sources/orbit_demo/live-database/sync/scan-report.json',
          fallbackReason: null,
        },
        runId: 'demo-full-run',
        connectionId: 'orbit_demo',
        adapter: 'live-database',
        status: 'done',
        sourceDir: null,
        syncId: 'sync',
        reportPath: 'raw-sources/orbit_demo/live-database/sync/scan-report.json',
        errors: [],
        events: [{ type: 'report_created', runId: 'scan-run' }],
        plannedWorkUnits: [],
        details: { actions: [], provenance: [], transcripts: [] },
      },
      { label: 'full' },
    );

    await expect(loadProjectDemoReplay(projectDir)).resolves.toMatchObject({
      runId: 'demo-full-run',
      metadata: { mode: 'full', origin: 'captured' },
    });
  });

  it('reports missing, ready, and corrupted demo project state', async () => {
    await expect(inspectDemoProjectState(projectDir)).resolves.toEqual({
      status: 'missing',
      projectDir,
      missing: ['ktx.yaml', 'demo.db', 'state.sqlite', 'replays/replay.memory-flow.v1.json'],
    });

    await ensureDemoProject({ projectDir, force: false });
    await expect(inspectDemoProjectState(projectDir)).resolves.toEqual({
      status: 'ready',
      projectDir,
      missing: [],
    });

    await rm(join(projectDir, 'demo.db'), { force: true });
    await expect(inspectDemoProjectState(projectDir)).resolves.toEqual({
      status: 'corrupt',
      projectDir,
      missing: ['demo.db'],
    });
  });

  it('requires explicit force for demo reset and recreates packaged assets', async () => {
    await ensureDemoProject({ projectDir, force: false });
    await rm(join(projectDir, 'demo.db'), { force: true });

    await expect(resetDemoProject({ projectDir, force: false })).rejects.toThrow(
      `ktx setup demo reset is destructive; pass --force to recreate ${projectDir}`,
    );

    await expect(resetDemoProject({ projectDir, force: true })).resolves.toMatchObject({ projectDir });
    await expect(access(join(projectDir, 'demo.db'))).resolves.toBeUndefined();
    await expect(inspectDemoProjectState(projectDir)).resolves.toMatchObject({ status: 'ready' });
  });

  it('preserves a user-edited ktx.yaml across reset --force', async () => {
    await ensureDemoProject({ projectDir, force: false });
    const customConfig = [
      'project: ktx-demo-orbit',
      'connections:',
      `  ${DEMO_CONNECTION_ID}:`,
      '    driver: sqlite',
      `    path: ${JSON.stringify(join(projectDir, 'demo.db'))}`,
      '    readonly: true',
      'storage:',
      '  state: sqlite',
      '  search: sqlite-fts5',
      '  git:',
      '    auto_commit: true',
      '    author: ktx <ktx@example.com>',
      'llm:',
      '  provider:',
      '    backend: vertex',
      '    vertex:',
      '      project: example-gcp-project',
      '      location: us-east5',
      '  models:',
      '    default: claude-sonnet-4-6',
      'ingest:',
      '  adapters:',
      `    - ${DEMO_ADAPTER}`,
      '  embeddings:',
      '    backend: none',
      '    dimensions: 8',
      '  workUnits:',
      '    stepBudget: 40',
      '    maxConcurrency: 1',
      '    failureMode: continue',
      '',
    ].join('\n');
    await writeFile(join(projectDir, 'ktx.yaml'), customConfig, 'utf-8');

    await resetDemoProject({ projectDir, force: true });

    const preserved = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    expect(preserved).toBe(customConfig);
    expect(preserved).toContain('backend: vertex');
    expect(preserved).not.toContain('backend: anthropic');
    await expect(inspectDemoProjectState(projectDir)).resolves.toMatchObject({ status: 'ready' });
  });

  it('still writes the default ktx.yaml on reset when none exists', async () => {
    await resetDemoProject({ projectDir, force: true });
    const config = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    expect(config).toContain('backend: anthropic');
  });
});
