import { access, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEMO_ADAPTER,
  DEMO_CONNECTION_ID,
  DEMO_REPLAY_FILE,
  defaultDemoProjectDir,
  ensureDemoProject,
  ensureSeededDemoProject,
} from './demo-assets.js';

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

  it('copies the seeded project assets used by the setup wizard tour', async () => {
    await ensureSeededDemoProject({ projectDir, force: false });

    await expect(access(join(projectDir, 'semantic-layer', 'dbt-main', 'mart_arr_daily.yaml'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'knowledge', 'global', 'orbit-company-overview.md'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'links', 'provenance.json'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'reports', 'seeded-demo-report.json'))).resolves.toBeUndefined();
  });
});
