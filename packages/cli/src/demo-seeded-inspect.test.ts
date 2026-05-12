import { access, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDemoSeeded } from './demo-seeded.js';
import { formatSeededInspect, inspectSeededProject } from './demo-seeded-inspect.js';
import { KTX_NEXT_STEP_DIRECT_COMMANDS } from './next-steps.js';

describe('seeded demo inspect contract', () => {
  const projectDir = join(tmpdir(), `ktx-demo-seeded-inspect-${process.pid}`);

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('reports the PRD source inventory, generated outputs, status, metadata, and next commands', async () => {
    await runDemoSeeded({ projectDir });
    const inspect = await inspectSeededProject(projectDir);

    expect(inspect).toMatchObject({
      projectDir,
      mode: 'seeded',
      status: { status: 'ready', missing: [] },
      modeMetadata: {
        mode: 'seeded',
        source: 'packaged demo project',
        generatedContext: 'prebuilt from bundled assets',
        llmCalls: 'none',
        origin: 'packaged',
        timing: 'prebuilt',
        sourceReportId: 'demo-seeded-report',
        sourceReportPath: 'reports/seeded-demo-report.json',
      },
      sourceBundle: {
        warehouse: {
          label: 'Warehouse',
          path: 'demo.db',
          tableCount: 8,
          totalRows: 11234,
          rowCounts: {
            accounts: 210,
            arr_movements: 720,
            contracts: 320,
            invoices: 3000,
            plans: 4,
            purchase_requests: 5200,
            support_tickets: 520,
            users: 1260,
          },
        },
        dbt: { label: 'dbt', path: 'raw-sources/dbt', modelCount: 3, sourceTableCount: 8 },
        bi: { label: 'BI', path: 'raw-sources/bi', exploreCount: 5, dashboardCount: 2 },
        notion: { label: 'Notion', path: 'raw-sources/notion', pageCount: 8 },
      },
      generatedOutputs: {
        semanticLayer: { path: 'semantic-layer', manifestSourceCount: 46, fileCount: 46 },
        knowledge: { path: 'knowledge/global', manifestPageCount: 28, fileCount: 28 },
        links: { path: 'links/provenance.json', manifestLinkCount: 23, linkCount: 23 },
        reports: { primaryPath: 'reports/seeded-demo-report.json', fileCount: 1 },
        replays: { primaryPath: 'replays/replay.memory-flow.v1.json', latestPath: 'replays/latest.memory-flow.v1.json' },
      },
      nextCommands: KTX_NEXT_STEP_DIRECT_COMMANDS,
    });

    expect(inspect.generatedOutputs.replays.fileCount).toBeGreaterThanOrEqual(3);
    await expect(access(join(projectDir, inspect.generatedOutputs.reports.primaryPath))).resolves.toBeUndefined();
    await expect(access(join(projectDir, inspect.generatedOutputs.replays.primaryPath))).resolves.toBeUndefined();
    await expect(access(join(projectDir, inspect.generatedOutputs.replays.latestPath))).resolves.toBeUndefined();
  });

  it('formats seeded inspect from the normalized contract', async () => {
    await runDemoSeeded({ projectDir });
    const output = formatSeededInspect(await inspectSeededProject(projectDir));

    expect(output).toContain(`Demo project: ${projectDir}`);
    expect(output).toContain('Status: ready');
    expect(output).toContain('Mode: seeded (pre-seeded demo project)');
    expect(output).toContain('Source: packaged demo project');
    expect(output).toContain('Generated context: prebuilt from bundled assets');
    expect(output).toContain('LLM calls: none');
    expect(output).toContain('Warehouse: 8 tables, 11,234 rows');
    expect(output).toContain('Rows: accounts 210, arr_movements 720, contracts 320, invoices 3000');
    expect(output).toContain('dbt: 3 models, 8 source tables');
    expect(output).toContain('BI: 5 explores, 2 dashboards');
    expect(output).toContain('Notion: 8 pages');
    expect(output).toContain('Semantic-layer sources: 46 manifest, 46 files');
    expect(output).toContain('Knowledge pages: 28 manifest, 28 files');
    expect(output).toContain('Evidence links: 23 manifest, 23 links');
    expect(output).toContain('Report: reports/seeded-demo-report.json');
    expect(output).toContain('Replay: replays/replay.memory-flow.v1.json');
    expect(output).toContain('Latest replay: seeded (packaged, prebuilt)');
    expect(output).toContain('  $ ktx agent tools --json');
    expect(output).toContain('  $ ktx agent context --json');
    expect(output).not.toContain('ktx serve --mcp stdio --user-id local');
    expect(output).not.toContain('ktx ask');
    expect(output).not.toContain('deterministic mode');
  });

  it('reports missing seeded paths without reading stale counts as ready', async () => {
    await runDemoSeeded({ projectDir });
    await rm(join(projectDir, 'links', 'provenance.json'));

    const inspect = await inspectSeededProject(projectDir);

    expect(inspect.status).toEqual({ status: 'corrupt', missing: ['links/provenance.json'] });
    expect(formatSeededInspect(inspect)).toContain('Status: corrupt');
    expect(formatSeededInspect(inspect)).toContain('Missing: links/provenance.json');
  });

  it('keeps provenance link counts tied to the project file', async () => {
    await runDemoSeeded({ projectDir });

    const inspect = await inspectSeededProject(projectDir);
    const raw = await readFile(join(projectDir, 'links', 'provenance.json'), 'utf-8');
    const links = JSON.parse(raw) as unknown[];

    expect(inspect.generatedOutputs.links.linkCount).toBe(links.length);
    expect(inspect.generatedOutputs.links.linkCount).toBe(23);
  });
});
