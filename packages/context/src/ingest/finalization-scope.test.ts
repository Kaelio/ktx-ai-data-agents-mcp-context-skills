import { describe, expect, it } from 'vitest';
import {
  compareFinalizationDeclarations,
  deriveFinalizationTouchedSources,
  deriveFinalizationWikiPageKeys,
} from './finalization-scope.js';

describe('deriveFinalizationWikiPageKeys', () => {
  it('maps changed global wiki markdown paths to page keys', () => {
    expect(
      deriveFinalizationWikiPageKeys([
        'wiki/global/historic-sql-orders.md',
        'wiki/global/nested/page.md',
        'README.md',
      ]),
    ).toEqual(['historic-sql-orders']);
  });
});

describe('deriveFinalizationTouchedSources', () => {
  it('maps standalone semantic-layer files directly', async () => {
    const result = await deriveFinalizationTouchedSources({
      changedPaths: ['semantic-layer/warehouse/orders.yaml'],
      beforeSourcesByConnection: new Map(),
      afterSourcesByConnection: new Map(),
    });
    expect(result).toEqual({
      touchedSources: [{ connectionId: 'warehouse', sourceName: 'orders' }],
      unresolvedPaths: [],
    });
  });

  it('resolves aggregate _schema changes by comparing loaded source snapshots', async () => {
    const beforeSourcesByConnection = new Map([
      [
        'warehouse',
        [
          {
            name: 'orders',
            grain: ['order_id'],
            columns: [{ name: 'order_id', type: 'string' }],
            joins: [],
            measures: [],
            usage: {
              narrative: 'old',
              frequencyTier: 'low' as const,
              commonFilters: [],
              commonJoins: [],
            },
          },
        ],
      ],
    ]);
    const afterSourcesByConnection = new Map([
      [
        'warehouse',
        [
          {
            name: 'orders',
            grain: ['order_id'],
            columns: [{ name: 'order_id', type: 'string' }],
            joins: [],
            measures: [],
            usage: {
              narrative: 'new',
              frequencyTier: 'high' as const,
              commonFilters: [],
              commonJoins: [],
            },
          },
        ],
      ],
    ]);

    const result = await deriveFinalizationTouchedSources({
      changedPaths: ['semantic-layer/warehouse/_schema/public.yaml'],
      beforeSourcesByConnection,
      afterSourcesByConnection,
    });

    expect(result).toEqual({
      touchedSources: [{ connectionId: 'warehouse', sourceName: 'orders' }],
      unresolvedPaths: [],
    });
  });

  it('flags aggregate _schema changes that cannot be resolved to logical sources', async () => {
    const beforeSourcesByConnection = new Map([['warehouse', []]]);
    const afterSourcesByConnection = new Map([['warehouse', []]]);

    const result = await deriveFinalizationTouchedSources({
      changedPaths: ['semantic-layer/warehouse/_schema/public.yaml'],
      beforeSourcesByConnection,
      afterSourcesByConnection,
    });

    expect(result).toEqual({
      touchedSources: [],
      unresolvedPaths: ['semantic-layer/warehouse/_schema/public.yaml'],
    });
  });
});

describe('compareFinalizationDeclarations', () => {
  it('reports missing and extra adapter declarations', () => {
    expect(
      compareFinalizationDeclarations({
        declaredTouchedSources: [{ connectionId: 'warehouse', sourceName: 'orders' }],
        derivedTouchedSources: [{ connectionId: 'warehouse', sourceName: 'customers' }],
        declaredChangedWikiPageKeys: ['orders'],
        derivedChangedWikiPageKeys: ['orders', 'patterns'],
      }),
    ).toEqual([
      {
        artifactKind: 'sl',
        key: 'warehouse:customers',
        direction: 'missing_from_adapter_declaration',
      },
      {
        artifactKind: 'sl',
        key: 'warehouse:orders',
        direction: 'extra_in_adapter_declaration',
      },
      {
        artifactKind: 'wiki',
        key: 'patterns',
        direction: 'missing_from_adapter_declaration',
      },
    ]);
  });
});
