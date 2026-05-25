import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkMetricFlowProject } from '../../../../../src/context/ingest/adapters/metricflow/chunk.js';
import { parseMetricFlowStagedDir } from '../../../../../src/context/ingest/adapters/metricflow/parse.js';

const FIXTURES = resolve(__dirname, '../../../../fixtures/metricflow');
const SINGLE = join(FIXTURES, 'single-model');
const EXTENDS_CHAIN = join(FIXTURES, 'extends-chain');
const MULTI = join(FIXTURES, 'multi-component');
const DBT_MIXED = join(FIXTURES, 'dbt-mixed');

describe('chunkMetricFlowProject — first run', () => {
  it('single-model fixture emits one WU with the orders model + its metric file (collapsed via metric refs)', async () => {
    const project = await parseMetricFlowStagedDir(SINGLE);
    const result = chunkMetricFlowProject(project);
    expect(result.workUnits).toHaveLength(1);
    const wu = result.workUnits[0];
    expect(wu.unitKey).toBe('metricflow-orders');
    expect(wu.rawFiles).toEqual(['models/orders.yml']);
    expect(wu.dependencyPaths).toEqual([]);
    expect(wu.peerFileIndex).toEqual([]);
  });

  it('extends-chain fixture collapses orders + orders_ext + metrics/orders_final into ONE WU', async () => {
    const project = await parseMetricFlowStagedDir(EXTENDS_CHAIN);
    const result = chunkMetricFlowProject(project);
    expect(result.workUnits).toHaveLength(1);
    const wu = result.workUnits[0];
    expect(wu.unitKey).toBe('metricflow-orders');
    expect(wu.rawFiles.sort()).toEqual(['metrics/orders_final.yml', 'models/orders.yml', 'models/orders_ext.yml']);
    expect(wu.notes).toContain('orders');
    expect(wu.notes).toContain('orders_ext');
    expect(wu.notes).toContain('revenue');
  });

  it('multi-component fixture emits two disjoint WUs ordered by leadName', async () => {
    const project = await parseMetricFlowStagedDir(MULTI);
    const result = chunkMetricFlowProject(project);
    expect(result.workUnits).toHaveLength(2);
    expect(result.workUnits.map((wu) => wu.unitKey)).toEqual(['metricflow-campaigns', 'metricflow-orders']);
    expect(result.workUnits[0].rawFiles).toEqual(['models/marketing/campaigns.yml']);
    expect(result.workUnits[0].peerFileIndex).toEqual(['models/sales/orders.yml']);
    expect(result.workUnits[1].rawFiles).toEqual(['models/sales/orders.yml']);
    expect(result.workUnits[1].peerFileIndex).toEqual(['models/marketing/campaigns.yml']);
  });

  it('dbt-mixed fixture: non-MetricFlow YAML (dbt_project.yml) lands in peerFileIndex, not in any WU', async () => {
    const project = await parseMetricFlowStagedDir(DBT_MIXED);
    const result = chunkMetricFlowProject(project);
    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0].rawFiles).toEqual(['models/orders.yml']);
    expect(result.workUnits[0].peerFileIndex).toEqual(['dbt_project.yml']);
  });

  it('chunk is deterministic: two identical invocations return structurally-equal WUs', async () => {
    const p1 = await parseMetricFlowStagedDir(EXTENDS_CHAIN);
    const p2 = await parseMetricFlowStagedDir(EXTENDS_CHAIN);
    const r1 = chunkMetricFlowProject(p1);
    const r2 = chunkMetricFlowProject(p2);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('DiffSet re-sync: only WUs with a touched rawFile are kept', async () => {
    const project = await parseMetricFlowStagedDir(MULTI);
    const result = chunkMetricFlowProject(project, {
      diffSet: {
        added: [],
        modified: ['models/sales/orders.yml'],
        deleted: [],
        unchanged: ['models/marketing/campaigns.yml'],
      },
    });
    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0].unitKey).toBe('metricflow-orders');
    expect(result.workUnits[0].rawFiles).toEqual(['models/sales/orders.yml']);
    expect(result.workUnits[0].dependencyPaths).toEqual([]); // no unchanged sibling in this component
  });

  it('DiffSet re-sync: unchanged component siblings move from rawFiles into dependencyPaths', async () => {
    const project = await parseMetricFlowStagedDir(EXTENDS_CHAIN);
    const result = chunkMetricFlowProject(project, {
      diffSet: {
        added: [],
        modified: ['models/orders_ext.yml'], // only the extension file changed
        deleted: [],
        unchanged: ['models/orders.yml', 'metrics/orders_final.yml'],
      },
    });
    expect(result.workUnits).toHaveLength(1);
    const wu = result.workUnits[0];
    expect(wu.rawFiles).toEqual(['models/orders_ext.yml']);
    expect(wu.dependencyPaths.sort()).toEqual(['metrics/orders_final.yml', 'models/orders.yml']);
  });

  it('DiffSet re-sync: all-unchanged yields zero WUs', async () => {
    const project = await parseMetricFlowStagedDir(EXTENDS_CHAIN);
    const result = chunkMetricFlowProject(project, {
      diffSet: {
        added: [],
        modified: [],
        deleted: [],
        unchanged: ['models/orders.yml', 'models/orders_ext.yml', 'metrics/orders_final.yml'],
      },
    });
    expect(result.workUnits).toEqual([]);
    expect(result.eviction).toBeUndefined();
  });

  it('DiffSet re-sync: deleted files produce an EvictionUnit', async () => {
    const project = await parseMetricFlowStagedDir(MULTI);
    const result = chunkMetricFlowProject(project, {
      diffSet: {
        added: [],
        modified: [],
        deleted: ['models/marketing/campaigns.yml'],
        unchanged: ['models/sales/orders.yml'],
      },
    });
    expect(result.workUnits).toEqual([]);
    expect(result.eviction).toEqual({
      deletedRawPaths: ['models/marketing/campaigns.yml'],
    });
  });
});
