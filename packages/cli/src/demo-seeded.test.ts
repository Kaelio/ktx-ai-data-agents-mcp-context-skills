import { access, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSeededDemoProject } from './demo-assets.js';
import { runDemoSeeded } from './demo-seeded.js';

describe('demo seeded mode', () => {
  const projectDir = join(tmpdir(), `ktx-demo-seeded-${process.pid}`);

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('hydrates a complete seeded project with all asset directories', async () => {
    const result = await ensureSeededDemoProject({ projectDir, force: false });

    expect(result.projectDir).toBe(projectDir);
    await expect(access(join(projectDir, 'demo.db'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'ktx.yaml'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'manifest.json'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'semantic-layer/dbt-main/mart_arr_daily.yaml'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'semantic-layer/postgres-warehouse/mart_account_activity.yaml'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'knowledge/global/orbit-company-overview.md'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'links/provenance.json'))).resolves.toBeUndefined();
    await expect(access(join(projectDir, 'reports/seeded-demo-report.json'))).resolves.toBeUndefined();
  });

  it('does not load or call any LLM provider in seeded mode', async () => {
    const result = await runDemoSeeded({ projectDir });

    expect(result.replay.metadata?.mode).toBe('seeded');
    expect(result.replay.metadata?.timing).toBe('prebuilt');
    expect(result.inspect.mode).toBe('seeded');

    const config = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    expect(config).toContain('api_key: env:ANTHROPIC_API_KEY');
    expect(config).not.toContain('sk-ant-');
  });

  it('creates the project under /tmp by default', async () => {
    const result = await runDemoSeeded({ projectDir });
    expect(result.projectDir).toBe(projectDir);
  });

  it('replay metadata identifies mode honestly', async () => {
    const result = await runDemoSeeded({ projectDir });

    expect(result.replay.metadata).toMatchObject({
      mode: 'seeded',
      origin: 'packaged',
      timing: 'prebuilt',
    });
    expect(result.replay.runId).toBe('demo-seeded-orbit');
  });

  it('packaged seeded replay is honest and shows every source family', async () => {
    const result = await runDemoSeeded({ projectDir });
    const sourceEvents = result.replay.events.filter((event) => event.type === 'source_acquired');
    const adapters = sourceEvents.map((event) => event.adapter).sort();

    expect(result.replay.metadata).toMatchObject({
      mode: 'seeded',
      origin: 'packaged',
      timing: 'prebuilt',
      sourceReportPath: 'reports/seeded-demo-report.json',
    });
    expect(adapters).toEqual(['dbt_descriptions', 'live-database', 'looker', 'notion']);
    expect(result.replay.events).not.toContainEqual(
      expect.objectContaining({ type: 'stage_skipped', reason: expect.stringContaining('deterministic') }),
    );
    expect(JSON.stringify(result.replay)).not.toContain('LLM ran');
  });

  it('seeded animation shows all demo source families', async () => {
    const result = await runDemoSeeded({ projectDir });
    const adapters = result.replay.events
      .filter((e) => e.type === 'source_acquired')
      .map((e) => (e as { adapter: string }).adapter);

    expect(adapters).toContain('live-database');
    expect(adapters).toContain('dbt_descriptions');
    expect(adapters).toContain('looker');
    expect(adapters).toContain('notion');
  });

  it('SL YAML validates correctly', async () => {
    await ensureSeededDemoProject({ projectDir, force: false });
    const slYaml = await readFile(join(projectDir, 'semantic-layer/dbt-main/mart_arr_daily.yaml'), 'utf-8');
    expect(slYaml).toContain('name: mart_arr_daily');
    expect(slYaml).toContain('grain:');
    expect(slYaml).toContain('columns:');
    expect(slYaml).toContain('measures:');
    expect(slYaml).toContain('joins:');
  });

  it('wiki pages have valid frontmatter', async () => {
    await ensureSeededDemoProject({ projectDir, force: false });
    const wiki = await readFile(join(projectDir, 'knowledge/global/orbit-company-overview.md'), 'utf-8');
    expect(wiki).toContain('---');
    expect(wiki).toContain('summary:');
    expect(wiki).toContain('tags:');
    expect(wiki).toContain('refs:');
    expect(wiki).toContain('usage_mode: auto');
  });

  it('links are searchable through provenance file', async () => {
    await ensureSeededDemoProject({ projectDir, force: false });
    const raw = await readFile(join(projectDir, 'links/provenance.json'), 'utf-8');
    const links = JSON.parse(raw) as Array<{ id: string; artifactKind: string }>;
    expect(links.length).toBe(23);
    expect(links.some((l) => l.artifactKind === 'wiki')).toBe(true);
    expect(links.some((l) => l.artifactKind === 'sl')).toBe(true);
  });
});
