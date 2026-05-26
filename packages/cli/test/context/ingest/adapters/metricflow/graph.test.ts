import { describe, expect, it } from 'vitest';
import { buildMetricFlowGraph } from '../../../../../src/context/ingest/adapters/metricflow/graph.js';
import type { ParsedMetricFlowProject } from '../../../../../src/context/ingest/adapters/metricflow/parse.js';

function project(parts: Partial<ParsedMetricFlowProject>): ParsedMetricFlowProject {
  return {
    semanticModels: parts.semanticModels ?? [],
    metrics: parts.metrics ?? [],
    allPaths: parts.allPaths ?? [],
    files: parts.files ?? [],
  };
}

describe('buildMetricFlowGraph', () => {
  it('puts each standalone semantic_model in its own component', () => {
    const graph = buildMetricFlowGraph(
      project({
        semanticModels: [
          {
            path: 'models/a.yml',
            name: 'a',
            modelRef: 'a',
            extendsFrom: [],
            measureNames: ['m1'],
            dimensionNames: [],
            entityNames: [],
            primaryEntities: [],
            foreignEntities: [],
            defaultTimeDimension: null,
          },
          {
            path: 'models/b.yml',
            name: 'b',
            modelRef: 'b',
            extendsFrom: [],
            measureNames: ['m2'],
            dimensionNames: [],
            entityNames: [],
            primaryEntities: [],
            foreignEntities: [],
            defaultTimeDimension: null,
          },
        ],
        allPaths: ['models/a.yml', 'models/b.yml'],
      }),
    );
    expect(graph.components).toHaveLength(2);
    const byPath = new Map(graph.components.flatMap((c) => c.paths.map((p) => [p, c.id])));
    expect(byPath.get('models/a.yml')).not.toBe(byPath.get('models/b.yml'));
  });

  it('unions two files when one semantic_model extends another', () => {
    const graph = buildMetricFlowGraph(
      project({
        semanticModels: [
          {
            path: 'models/orders.yml',
            name: 'orders',
            modelRef: 'orders',
            extendsFrom: [],
            measureNames: ['gross_amount'],
            dimensionNames: [],
            entityNames: [],
            primaryEntities: [],
            foreignEntities: [],
            defaultTimeDimension: null,
          },
          {
            path: 'models/orders_ext.yml',
            name: 'orders_ext',
            modelRef: 'orders_ext',
            extendsFrom: ['orders'],
            measureNames: ['refund_amount'],
            dimensionNames: [],
            entityNames: [],
            primaryEntities: [],
            foreignEntities: [],
            defaultTimeDimension: null,
          },
        ],
        allPaths: ['models/orders.yml', 'models/orders_ext.yml'],
      }),
    );
    expect(graph.components).toHaveLength(1);
    expect(graph.components[0].paths.sort()).toEqual(['models/orders.yml', 'models/orders_ext.yml']);
  });

  it('unions a metric-only file with the semantic_model files whose measures it references', () => {
    const graph = buildMetricFlowGraph(
      project({
        semanticModels: [
          {
            path: 'models/orders.yml',
            name: 'orders',
            modelRef: 'orders',
            extendsFrom: [],
            measureNames: ['gross_amount'],
            dimensionNames: [],
            entityNames: [],
            primaryEntities: [],
            foreignEntities: [],
            defaultTimeDimension: null,
          },
          {
            path: 'models/orders_ext.yml',
            name: 'orders_ext',
            modelRef: 'orders_ext',
            extendsFrom: ['orders'],
            measureNames: ['refund_amount'],
            dimensionNames: [],
            entityNames: [],
            primaryEntities: [],
            foreignEntities: [],
            defaultTimeDimension: null,
          },
        ],
        metrics: [
          {
            path: 'metrics/orders_final.yml',
            name: 'revenue',
            type: 'derived',
            measureRef: null,
            dependsOn: ['gross_amount', 'refund_amount'],
          },
        ],
        allPaths: ['metrics/orders_final.yml', 'models/orders.yml', 'models/orders_ext.yml'],
      }),
    );
    expect(graph.components).toHaveLength(1);
    expect(graph.components[0].paths.sort()).toEqual([
      'metrics/orders_final.yml',
      'models/orders.yml',
      'models/orders_ext.yml',
    ]);
  });

  it('leaves unrelated semantic_models in separate components (two disjoint groups)', () => {
    const graph = buildMetricFlowGraph(
      project({
        semanticModels: [
          {
            path: 'models/sales/orders.yml',
            name: 'orders',
            modelRef: 'orders',
            extendsFrom: [],
            measureNames: ['order_count'],
            dimensionNames: [],
            entityNames: [],
            primaryEntities: [],
            foreignEntities: [],
            defaultTimeDimension: null,
          },
          {
            path: 'models/marketing/campaigns.yml',
            name: 'campaigns',
            modelRef: 'campaigns',
            extendsFrom: [],
            measureNames: ['spend'],
            dimensionNames: [],
            entityNames: [],
            primaryEntities: [],
            foreignEntities: [],
            defaultTimeDimension: null,
          },
        ],
        allPaths: ['models/marketing/campaigns.yml', 'models/sales/orders.yml'],
      }),
    );
    expect(graph.components).toHaveLength(2);
  });

  it('returns components ordered lexicographically by their first-name-member', () => {
    const graph = buildMetricFlowGraph(
      project({
        semanticModels: [
          {
            path: 'models/z.yml',
            name: 'z_model',
            modelRef: 'z',
            extendsFrom: [],
            measureNames: ['m'],
            dimensionNames: [],
            entityNames: [],
            primaryEntities: [],
            foreignEntities: [],
            defaultTimeDimension: null,
          },
          {
            path: 'models/a.yml',
            name: 'a_model',
            modelRef: 'a',
            extendsFrom: [],
            measureNames: ['m'],
            dimensionNames: [],
            entityNames: [],
            primaryEntities: [],
            foreignEntities: [],
            defaultTimeDimension: null,
          },
        ],
        allPaths: ['models/a.yml', 'models/z.yml'],
      }),
    );
    expect(graph.components.map((c) => c.leadName)).toEqual(['a_model', 'z_model']);
  });

  it('metric that references an unknown measure still anchors its own file as a singleton', () => {
    const graph = buildMetricFlowGraph(
      project({
        metrics: [
          { path: 'metrics/dangling.yml', name: 'dangling', type: 'simple', measureRef: 'nowhere', dependsOn: [] },
        ],
        allPaths: ['metrics/dangling.yml'],
      }),
    );
    expect(graph.components).toHaveLength(1);
    expect(graph.components[0].paths).toEqual(['metrics/dangling.yml']);
    expect(graph.components[0].leadName).toBe('dangling');
  });

  it('transitive extends forms one component across 3 files', () => {
    const graph = buildMetricFlowGraph(
      project({
        semanticModels: [
          {
            path: 'a.yml',
            name: 'a',
            modelRef: 'a',
            extendsFrom: [],
            measureNames: [],
            dimensionNames: [],
            entityNames: [],
            primaryEntities: [],
            foreignEntities: [],
            defaultTimeDimension: null,
          },
          {
            path: 'b.yml',
            name: 'b',
            modelRef: 'b',
            extendsFrom: ['a'],
            measureNames: [],
            dimensionNames: [],
            entityNames: [],
            primaryEntities: [],
            foreignEntities: [],
            defaultTimeDimension: null,
          },
          {
            path: 'c.yml',
            name: 'c',
            modelRef: 'c',
            extendsFrom: ['b'],
            measureNames: [],
            dimensionNames: [],
            entityNames: [],
            primaryEntities: [],
            foreignEntities: [],
            defaultTimeDimension: null,
          },
        ],
        allPaths: ['a.yml', 'b.yml', 'c.yml'],
      }),
    );
    expect(graph.components).toHaveLength(1);
    expect(graph.components[0].paths.sort()).toEqual(['a.yml', 'b.yml', 'c.yml']);
  });
});
