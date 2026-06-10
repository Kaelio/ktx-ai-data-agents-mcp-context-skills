import { describe, expect, it } from 'vitest';
import {
  compareFinalizationDeclarations,
  deriveFinalizationTouchedSources,
  deriveFinalizationWikiPageKeys,
} from '../../../src/context/ingest/finalization-scope.js';

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
  it('resolves standalone files by the source diff, not the filename', () => {
    // The file carries a derived label (`signed_up-<hash>.yaml`); the source it
    // defines is the in-file `name:` (`SIGNED_UP`), visible only via the diff.
    const result = deriveFinalizationTouchedSources({
      changedPaths: ['semantic-layer/warehouse/signed_up-1a2b3c4d.yaml'],
      beforeSourcesByConnection: new Map([['warehouse', []]]),
      afterSourcesByConnection: new Map([
        ['warehouse', [{ name: 'SIGNED_UP', grain: [], columns: [], joins: [], measures: [] }]],
      ]),
    });
    expect(result).toEqual({
      touchedSources: [{ connectionId: 'warehouse', sourceName: 'SIGNED_UP' }],
      unresolvedPaths: [],
    });
  });

  it('resolves deleted standalone files by the name that disappeared', () => {
    const result = deriveFinalizationTouchedSources({
      changedPaths: ['semantic-layer/warehouse/signed_up-1a2b3c4d.yaml'],
      beforeSourcesByConnection: new Map([
        ['warehouse', [{ name: 'SIGNED_UP', grain: [], columns: [], joins: [], measures: [] }]],
      ]),
      afterSourcesByConnection: new Map([['warehouse', []]]),
    });
    expect(result).toEqual({
      touchedSources: [{ connectionId: 'warehouse', sourceName: 'SIGNED_UP' }],
      unresolvedPaths: [],
    });
  });

  it('flags standalone changes that produce no source diff', () => {
    const result = deriveFinalizationTouchedSources({
      changedPaths: ['semantic-layer/warehouse/orders.yaml'],
      beforeSourcesByConnection: new Map(),
      afterSourcesByConnection: new Map(),
    });
    expect(result).toEqual({
      touchedSources: [],
      unresolvedPaths: ['semantic-layer/warehouse/orders.yaml'],
    });
  });

  it('resolves aggregate _schema changes by comparing loaded source snapshots', () => {
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

    const result = deriveFinalizationTouchedSources({
      changedPaths: ['semantic-layer/warehouse/_schema/public.yaml'],
      beforeSourcesByConnection,
      afterSourcesByConnection,
    });

    expect(result).toEqual({
      touchedSources: [{ connectionId: 'warehouse', sourceName: 'orders' }],
      unresolvedPaths: [],
    });
  });

  it('flags aggregate _schema changes that cannot be resolved to logical sources', () => {
    const beforeSourcesByConnection = new Map([['warehouse', []]]);
    const afterSourcesByConnection = new Map([['warehouse', []]]);

    const result = deriveFinalizationTouchedSources({
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
