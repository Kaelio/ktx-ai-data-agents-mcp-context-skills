import { describe, expect, it } from 'vitest';
import { buildLookmlGraph } from './graph.js';
import type { ParsedLookmlProject } from './parse.js';

type LooseParsedLookmlProject = Omit<Partial<ParsedLookmlProject>, 'models' | 'views'> & {
  models?: Array<Omit<ParsedLookmlProject['models'][number], 'connectionName'> & { connectionName?: string | null }>;
  views?: Array<Omit<ParsedLookmlProject['views'][number], 'rawSqlTableName'> & { rawSqlTableName?: string | null }>;
};

const mkProject = (overrides: LooseParsedLookmlProject): ParsedLookmlProject => ({
  dashboards: [],
  allPaths: [],
  ...overrides,
  models: (overrides.models ?? []).map((model) => ({ connectionName: null, ...model })),
  views: (overrides.views ?? []).map((view) => ({ rawSqlTableName: null, ...view })),
});

describe('buildLookmlGraph', () => {
  it('assigns a single model as owner of all its included views', () => {
    const project = mkProject({
      models: [{ path: 'orders.model.lkml', name: 'orders', includes: ['views/*.view.lkml'], explores: ['orders'] }],
      views: [
        { path: 'views/orders.view.lkml', name: 'orders', extendsFrom: [] },
        { path: 'views/customers.view.lkml', name: 'customers', extendsFrom: [] },
      ],
      allPaths: ['orders.model.lkml', 'views/customers.view.lkml', 'views/orders.view.lkml'],
    });
    const graph = buildLookmlGraph(project);
    expect(graph.ownerByViewPath.get('views/orders.view.lkml')).toBe('orders');
    expect(graph.ownerByViewPath.get('views/customers.view.lkml')).toBe('orders');
    expect(graph.viewsIncludedByModel.get('orders')?.sort()).toEqual([
      'views/customers.view.lkml',
      'views/orders.view.lkml',
    ]);
  });

  it('assigns shared views to the lexicographically-first model that includes them', () => {
    const project = mkProject({
      models: [
        { path: 'marketing.model.lkml', name: 'marketing', includes: ['views/shared.view.lkml'], explores: [] },
        {
          path: 'orders.model.lkml',
          name: 'orders',
          includes: ['views/shared.view.lkml', 'views/orders.view.lkml'],
          explores: [],
        },
      ],
      views: [
        { path: 'views/shared.view.lkml', name: 'shared', extendsFrom: [] },
        { path: 'views/orders.view.lkml', name: 'orders', extendsFrom: [] },
      ],
      allPaths: ['marketing.model.lkml', 'orders.model.lkml', 'views/orders.view.lkml', 'views/shared.view.lkml'],
    });
    const graph = buildLookmlGraph(project);
    // "marketing" sorts before "orders", so marketing owns the shared view.
    expect(graph.ownerByViewPath.get('views/shared.view.lkml')).toBe('marketing');
    expect(graph.ownerByViewPath.get('views/orders.view.lkml')).toBe('orders');
    // Both models list the shared view in their include set:
    expect(graph.includersByViewPath.get('views/shared.view.lkml')?.sort()).toEqual(['marketing', 'orders']);
  });

  it('resolves transitive extends chains into dependency paths', () => {
    const project = mkProject({
      models: [{ path: 'orders.model.lkml', name: 'orders', includes: ['views/*.view.lkml'], explores: [] }],
      views: [
        { path: 'views/base.view.lkml', name: 'base', extendsFrom: [] },
        { path: 'views/orders.view.lkml', name: 'orders', extendsFrom: ['base'] },
        { path: 'views/orders_ext.view.lkml', name: 'orders_ext', extendsFrom: ['orders'] },
      ],
      allPaths: ['orders.model.lkml', 'views/base.view.lkml', 'views/orders.view.lkml', 'views/orders_ext.view.lkml'],
    });
    const graph = buildLookmlGraph(project);
    expect(graph.extendsAncestorsByViewName.get('orders_ext')?.sort()).toEqual(['base', 'orders']);
    expect(graph.extendsAncestorsByViewName.get('orders')?.sort()).toEqual(['base']);
    expect(graph.extendsAncestorsByViewName.get('base')?.sort()).toEqual([]);
  });

  it('resolves glob-style include patterns (views/*.view.lkml) against allPaths', () => {
    const project = mkProject({
      models: [{ path: 'orders.model.lkml', name: 'orders', includes: ['views/*.view.lkml'], explores: [] }],
      views: [
        { path: 'views/a.view.lkml', name: 'a', extendsFrom: [] },
        { path: 'views/sub/b.view.lkml', name: 'b', extendsFrom: [] },
      ],
      allPaths: ['orders.model.lkml', 'views/a.view.lkml', 'views/sub/b.view.lkml'],
    });
    const graph = buildLookmlGraph(project);
    // Single-star glob matches one path segment — "views/sub/b.view.lkml" is NOT matched.
    expect(graph.viewsIncludedByModel.get('orders')?.sort()).toEqual(['views/a.view.lkml']);
  });

  it('resolves double-star include patterns (views/**/*.view.lkml) recursively', () => {
    const project = mkProject({
      models: [{ path: 'orders.model.lkml', name: 'orders', includes: ['views/**/*.view.lkml'], explores: [] }],
      views: [
        { path: 'views/a.view.lkml', name: 'a', extendsFrom: [] },
        { path: 'views/sub/b.view.lkml', name: 'b', extendsFrom: [] },
      ],
      allPaths: ['orders.model.lkml', 'views/a.view.lkml', 'views/sub/b.view.lkml'],
    });
    const graph = buildLookmlGraph(project);
    expect(graph.viewsIncludedByModel.get('orders')?.sort()).toEqual(['views/a.view.lkml', 'views/sub/b.view.lkml']);
  });

  it('leaves a view ownerless when no model includes it', () => {
    const project = mkProject({
      models: [{ path: 'other.model.lkml', name: 'other', includes: ['views/included.view.lkml'], explores: [] }],
      views: [
        { path: 'views/included.view.lkml', name: 'included', extendsFrom: [] },
        { path: 'views/orphan.view.lkml', name: 'orphan', extendsFrom: [] },
      ],
      allPaths: ['other.model.lkml', 'views/included.view.lkml', 'views/orphan.view.lkml'],
    });
    const graph = buildLookmlGraph(project);
    expect(graph.ownerByViewPath.has('views/orphan.view.lkml')).toBe(false);
    expect(graph.ownerByViewPath.get('views/included.view.lkml')).toBe('other');
  });
});
