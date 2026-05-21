import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMetricFlowStagedDir } from './parse.js';

async function writeFixture(stagedDir: string, relPath: string, body: string): Promise<void> {
  const abs = join(stagedDir, relPath);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body, 'utf-8');
}

describe('parseMetricFlowStagedDir', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'mf-parse-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('extracts one semantic_model with its measures + dimensions + entities', async () => {
    await writeFixture(
      stagedDir,
      'models/orders.yml',
      [
        'semantic_models:',
        '  - name: orders',
        '    description: Order fact table.',
        "    model: ref('orders')",
        '    entities:',
        '      - name: order_id',
        '        type: primary',
        '      - name: customer_id',
        '        type: foreign',
        '    dimensions:',
        '      - name: ordered_at',
        '        type: time',
        '        type_params:',
        '          time_granularity: day',
        '    measures:',
        '      - name: order_count',
        '        agg: count',
        '        expr: order_id',
        '      - name: gross_amount',
        '        agg: sum',
        '        expr: amount',
        '',
      ].join('\n'),
    );
    const project = await parseMetricFlowStagedDir(stagedDir);
    expect(project.semanticModels).toHaveLength(1);
    const sm = project.semanticModels[0];
    expect(sm.path).toBe('models/orders.yml');
    expect(sm.name).toBe('orders');
    expect(sm.modelRef).toBe('orders');
    expect(sm.measureNames).toEqual(['gross_amount', 'order_count']);
    expect(sm.dimensionNames).toEqual(['ordered_at']);
    expect(sm.entityNames).toEqual(['customer_id', 'order_id']);
    expect(sm.primaryEntities).toEqual(['order_id']);
    expect(sm.foreignEntities).toEqual(['customer_id']);
    expect(sm.extendsFrom).toEqual([]);
    expect(project.files).toEqual([
      {
        path: 'models/orders.yml',
        content: expect.stringContaining('semantic_models:'),
      },
    ]);
  });

  it('captures `extends:` as a string OR a list', async () => {
    await writeFixture(
      stagedDir,
      'models/orders.yml',
      [
        'semantic_models:',
        '  - name: orders',
        "    model: ref('orders')",
        '    measures:',
        '      - {name: order_count, agg: count, expr: order_id}',
        '',
      ].join('\n'),
    );
    await writeFixture(
      stagedDir,
      'models/orders_ext_list.yml',
      [
        'semantic_models:',
        '  - name: orders_ext_list',
        "    model: ref('orders_ext')",
        '    extends: [orders]',
        '    measures:',
        '      - {name: refund_amount, agg: sum, expr: refund_amt}',
        '',
      ].join('\n'),
    );
    await writeFixture(
      stagedDir,
      'models/orders_ext_str.yml',
      [
        'semantic_models:',
        '  - name: orders_ext_str',
        "    model: ref('orders_ext')",
        '    extends: orders',
        '    measures:',
        '      - {name: refund_amount2, agg: sum, expr: refund_amt2}',
        '',
      ].join('\n'),
    );
    const project = await parseMetricFlowStagedDir(stagedDir);
    const list = project.semanticModels.find((sm) => sm.name === 'orders_ext_list');
    const str = project.semanticModels.find((sm) => sm.name === 'orders_ext_str');
    expect(list?.extendsFrom).toEqual(['orders']);
    expect(str?.extendsFrom).toEqual(['orders']);
  });

  it('extracts metrics with referenced measures for simple + derived + ratio + cumulative', async () => {
    await writeFixture(
      stagedDir,
      'metrics/core.yml',
      [
        'metrics:',
        '  - name: total_orders',
        '    type: simple',
        '    type_params:',
        '      measure: order_count',
        '  - name: revenue',
        '    type: derived',
        '    type_params:',
        '      expr: gross_amount - refund_amount',
        '      metrics:',
        '        - name: gross_amount',
        '        - name: refund_amount',
        '  - name: refund_rate',
        '    type: ratio',
        '    type_params:',
        '      numerator: refund_amount',
        '      denominator: gross_amount',
        '  - name: cum_revenue',
        '    type: cumulative',
        '    type_params:',
        '      measure: gross_amount',
        '      window: 7 days',
        '',
      ].join('\n'),
    );
    const project = await parseMetricFlowStagedDir(stagedDir);
    expect(project.metrics).toHaveLength(4);
    const byName = new Map(project.metrics.map((m) => [m.name, m]));
    expect(byName.get('total_orders')?.type).toBe('simple');
    expect(byName.get('total_orders')?.measureRef).toBe('order_count');
    expect(byName.get('revenue')?.type).toBe('derived');
    expect(byName.get('revenue')?.dependsOn.sort()).toEqual(['gross_amount', 'refund_amount']);
    expect(byName.get('refund_rate')?.type).toBe('ratio');
    expect(byName.get('refund_rate')?.dependsOn.sort()).toEqual(['gross_amount', 'refund_amount']);
    expect(byName.get('cum_revenue')?.type).toBe('cumulative');
    expect(byName.get('cum_revenue')?.measureRef).toBe('gross_amount');
  });

  it('returns empty arrays for a non-MetricFlow YAML (e.g. dbt_project.yml)', async () => {
    await writeFixture(stagedDir, 'dbt_project.yml', 'name: my_proj\nversion: "1.0.0"\n');
    const project = await parseMetricFlowStagedDir(stagedDir);
    expect(project.semanticModels).toEqual([]);
    expect(project.metrics).toEqual([]);
    expect(project.allPaths).toEqual(['dbt_project.yml']);
  });

  it('skips files that are not YAML (or fail to parse) without throwing', async () => {
    await writeFixture(stagedDir, 'broken.yml', '{ this is: not valid YAML :::');
    await writeFixture(stagedDir, 'other.txt', 'ignore me');
    const project = await parseMetricFlowStagedDir(stagedDir);
    expect(project.semanticModels).toEqual([]);
    expect(project.metrics).toEqual([]);
    // allPaths includes `.yml` / `.yaml` only, even when unparseable:
    expect(project.allPaths).toEqual(['broken.yml']);
  });

  it('allPaths is sorted deterministically', async () => {
    await writeFixture(stagedDir, 'models/z.yml', 'semantic_models: []\n');
    await writeFixture(stagedDir, 'models/a.yml', 'semantic_models: []\n');
    await writeFixture(stagedDir, 'metrics/b.yaml', 'metrics: []\n');
    const project = await parseMetricFlowStagedDir(stagedDir);
    expect(project.allPaths).toEqual(['metrics/b.yaml', 'models/a.yml', 'models/z.yml']);
  });

  it("extracts modelRef from ref('name') and source('src','table') and literal strings", async () => {
    await writeFixture(
      stagedDir,
      'models/a.yml',
      [
        'semantic_models:',
        '  - {name: a, model: "ref(\'orders\')", measures: [{name: c, agg: count, expr: id}]}',
        "  - {name: b, model: \"source('raw','orders_raw')\", measures: [{name: c, agg: count, expr: id}]}",
        '  - {name: c, model: plain_table, measures: [{name: c, agg: count, expr: id}]}',
        '',
      ].join('\n'),
    );
    const project = await parseMetricFlowStagedDir(stagedDir);
    const byName = new Map(project.semanticModels.map((s) => [s.name, s]));
    expect(byName.get('a')?.modelRef).toBe('orders');
    expect(byName.get('b')?.modelRef).toBe('orders_raw');
    expect(byName.get('c')?.modelRef).toBe('plain_table');
  });
});
