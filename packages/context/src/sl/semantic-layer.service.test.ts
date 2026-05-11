import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  composeOverlay,
  enrichColumnsFromManifest,
  findDanglingSegmentRefs,
  projectManifestEntry,
  SemanticLayerService,
} from './semantic-layer.service.js';
import { sourceDefinitionSchema } from './schemas.js';
import type { SemanticLayerSource } from './types.js';

const pythonPort = {
  validateSources: vi.fn(),
  generateSources: vi.fn(),
  query: vi.fn(),
};

function connectionCatalog(connectionType = 'SNOWFLAKE') {
  return {
    listEnabledConnections: vi.fn().mockResolvedValue([]),
    getConnectionById: vi.fn().mockResolvedValue({ id: 'conn-1', name: 'conn-1', connectionType }),
    executeQuery: vi.fn(),
  };
}

const baseTable: SemanticLayerSource = {
  name: 'fct_labs',
  grain: ['lab_order_id'],
  table: 'analytics.fct_labs',
  columns: [
    { name: 'lab_order_id', type: 'string' },
    { name: 'admin_user_id', type: 'string' },
    { name: 'lab_type', type: 'string' },
  ],
  joins: [],
  measures: [],
};

describe('composeOverlay', () => {
  it('carries top-level segments from overlay into the composed source', () => {
    const overlay = {
      name: 'fct_labs',
      segments: [{ name: 'byol', expr: "lab_type = 'byol'", description: 'BYOL cohort' }],
    };
    const composed = composeOverlay(baseTable, overlay);
    expect(composed.segments).toHaveLength(1);
    expect(composed.segments?.[0].name).toBe('byol');
    expect(composed.segments?.[0].expr).toBe("lab_type = 'byol'");
  });

  it('preserves measure-level segments references', () => {
    const overlay = {
      name: 'fct_labs',
      segments: [{ name: 'byol', expr: "lab_type = 'byol'" }],
      measures: [
        {
          name: 'byol_subscriber_count',
          expr: 'count(distinct admin_user_id)',
          segments: ['byol'],
          description: 'BYOL subscribers',
        },
      ],
    };
    const composed = composeOverlay(baseTable, overlay);
    expect(composed.measures).toHaveLength(1);
    expect(composed.measures[0].segments).toEqual(['byol']);
  });

  it('leaves base segments unchanged when overlay does not specify segments', () => {
    const baseWithSegments: SemanticLayerSource = {
      ...baseTable,
      segments: [{ name: 'pre_existing', expr: 'is_paid = true' }],
    };
    const overlay = { name: 'fct_labs', description: 'no segments here' };
    const composed = composeOverlay(baseWithSegments, overlay);
    expect(composed.segments).toEqual([{ name: 'pre_existing', expr: 'is_paid = true' }]);
  });

  it('replaces base segments when overlay provides its own (even an empty array)', () => {
    const baseWithSegments: SemanticLayerSource = {
      ...baseTable,
      segments: [{ name: 'pre_existing', expr: 'is_paid = true' }],
    };
    const overlay = { name: 'fct_labs', segments: [] };
    const composed = composeOverlay(baseWithSegments, overlay);
    expect(composed.segments).toEqual([]);
  });

  it('throws on unknown top-level overlay keys with a pointed error', () => {
    const overlay = { name: 'fct_labs', frobnicate: true };
    expect(() => composeOverlay(baseTable, overlay)).toThrow(
      /overlay for 'fct_labs' has unhandled keys \[frobnicate\]/,
    );
  });

  it('lists every unknown key in the error message, not just the first', () => {
    const overlay = { name: 'fct_labs', foo: 1, bar: 2 };
    expect(() => composeOverlay(baseTable, overlay)).toThrow(/foo, bar/);
  });

  it('still handles existing known keys without regression', () => {
    const overlay = {
      name: 'fct_labs',
      description: 'patient lab orders',
      exclude_columns: ['admin_user_id'],
      columns: [{ name: 'is_byol', type: 'boolean', expr: "lab_type = 'byol'" }],
      measures: [{ name: 'count_all', expr: 'count(*)' }],
    };
    const composed = composeOverlay(baseTable, overlay);
    expect(composed.columns.find((c) => c.name === 'admin_user_id')).toBeUndefined();
    expect(composed.columns.find((c) => c.name === 'is_byol')).toBeDefined();
    expect(composed.measures).toHaveLength(1);
  });

  it('merges overlay descriptions (plural) with base descriptions keyed by source', () => {
    const baseWithDescriptions: SemanticLayerSource = {
      ...baseTable,
      descriptions: { db: 'scan-derived description', ai: 'AI description' },
    };
    const overlay = {
      name: 'fct_labs',
      descriptions: { dbt: 'dbt description', ai: 'AI description (overridden)' },
    };
    const composed = composeOverlay(baseWithDescriptions, overlay);
    expect(composed.descriptions).toEqual({
      db: 'scan-derived description',
      ai: 'AI description (overridden)',
      dbt: 'dbt description',
    });
  });

  it('replaces manifest usage only when an overlay explicitly provides usage', () => {
    const baseWithUsage: SemanticLayerSource = {
      ...baseTable,
      usage: {
        narrative: 'Orders are commonly queried by lifecycle status.',
        frequencyTier: 'high',
        commonFilters: ['status'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      },
    };

    expect(composeOverlay(baseWithUsage, { name: 'fct_labs', measures: [] }).usage).toEqual(baseWithUsage.usage);

    const composed = composeOverlay(baseWithUsage, {
      name: 'fct_labs',
      usage: {
        narrative: 'Overlay-curated usage note.',
        frequencyTier: 'mid',
        commonFilters: ['created_at'],
        commonGroupBys: ['created_at'],
        commonJoins: [],
      },
    });

    expect(composed.usage).toEqual({
      narrative: 'Overlay-curated usage note.',
      frequencyTier: 'mid',
      commonFilters: ['created_at'],
      commonGroupBys: ['created_at'],
      commonJoins: [],
    });
  });
});

describe('enrichColumnsFromManifest', () => {
  const manifest: SemanticLayerSource = {
    name: 'CONSIGNMENTS',
    table: 'ANALYTICS.MARTS.CONSIGNMENTS',
    grain: ['CONSIGNED_ITEM_ID'],
    columns: [
      {
        name: 'CONSIGNED_ITEM_ID',
        type: 'string',
        descriptions: { ai: 'Unique identifier for the consigned item record.' },
      },
      {
        name: 'CASH_ADV_AMOUNT',
        type: 'number',
        descriptions: { ai: 'Amount of cash advance disbursed to consigners.' },
      },
      {
        name: 'CONSIGNMENT_CREATED_AT',
        type: 'time',
        role: 'time',
        descriptions: { ai: 'Timestamp when the consignment was created.' },
      },
    ],
    joins: [],
    measures: [],
  };

  it('fills blank type and descriptions on source columns from the manifest', () => {
    const source: SemanticLayerSource = {
      name: 'aav_consignments',
      sql: 'SELECT CONSIGNED_ITEM_ID, CASH_ADV_AMOUNT FROM MARTS.CONSIGNMENTS WHERE ...',
      inherits_columns_from: 'CONSIGNMENTS',
      grain: ['CONSIGNED_ITEM_ID'],
      columns: [
        { name: 'CONSIGNED_ITEM_ID', type: '' },
        { name: 'CASH_ADV_AMOUNT', type: '' },
      ],
      joins: [],
      measures: [],
    };
    const enriched = enrichColumnsFromManifest(source, manifest);
    expect(enriched.columns[0]).toEqual({
      name: 'CONSIGNED_ITEM_ID',
      type: 'string',
      descriptions: { ai: 'Unique identifier for the consigned item record.' },
    });
    expect(enriched.columns[1]).toEqual({
      name: 'CASH_ADV_AMOUNT',
      type: 'number',
      descriptions: { ai: 'Amount of cash advance disbursed to consigners.' },
    });
  });

  it('preserves a local description if the source already declared one', () => {
    const source: SemanticLayerSource = {
      name: 'aav_consignments',
      sql: 'SELECT CONSIGNED_ITEM_ID FROM ...',
      inherits_columns_from: 'CONSIGNMENTS',
      grain: ['CONSIGNED_ITEM_ID'],
      columns: [
        {
          name: 'CONSIGNED_ITEM_ID',
          type: 'string',
          descriptions: { ai: 'AAV-specific note: always non-null in this filtered view.' },
        },
      ],
      joins: [],
      measures: [],
    };
    const enriched = enrichColumnsFromManifest(source, manifest);
    expect(enriched.columns[0].descriptions).toEqual({
      ai: 'AAV-specific note: always non-null in this filtered view.',
    });
  });

  it('passes through columns absent from the manifest unchanged', () => {
    const source: SemanticLayerSource = {
      name: 'aav_consignments',
      sql: 'SELECT ALT_VALUE_COMBINED, my_derived FROM ...',
      inherits_columns_from: 'CONSIGNMENTS',
      grain: ['CONSIGNED_ITEM_ID'],
      columns: [{ name: 'my_derived', type: 'number', expr: 'CASH_ADV_AMOUNT * 2' }],
      joins: [],
      measures: [],
    };
    const enriched = enrichColumnsFromManifest(source, manifest);
    expect(enriched.columns[0]).toEqual({
      name: 'my_derived',
      type: 'number',
      expr: 'CASH_ADV_AMOUNT * 2',
    });
  });

  it('copies role from the manifest when the source omits it', () => {
    const source: SemanticLayerSource = {
      name: 'aav_consignments',
      sql: 'SELECT CONSIGNMENT_CREATED_AT FROM ...',
      inherits_columns_from: 'CONSIGNMENTS',
      grain: ['CONSIGNED_ITEM_ID'],
      columns: [{ name: 'CONSIGNMENT_CREATED_AT', type: '' }],
      joins: [],
      measures: [],
    };
    const enriched = enrichColumnsFromManifest(source, manifest);
    expect(enriched.columns[0].role).toBe('time');
    expect(enriched.columns[0].type).toBe('time');
  });

  it('returns the source unchanged when manifestEntry is null/undefined', () => {
    const source: SemanticLayerSource = {
      name: 'aav_consignments',
      sql: 'SELECT FOO FROM ...',
      grain: ['FOO'],
      columns: [{ name: 'FOO', type: '' }],
      joins: [],
      measures: [],
    };
    const enriched = enrichColumnsFromManifest(source, null);
    expect(enriched).toEqual(source);
  });
});

describe('sourceDefinitionSchema', () => {
  it('preserves dbt structural metadata fields used by manifest-backed SL readers', () => {
    const result = sourceDefinitionSchema.safeParse({
      name: 'orders',
      descriptions: { dbt: 'Order facts from dbt.' },
      table: 'public.orders',
      grain: ['id'],
      columns: [
        {
          name: 'status',
          type: 'string',
          descriptions: { dbt: 'Order lifecycle status.' },
          constraints: { dbt: { not_null: true, unique: true } },
          enum_values: { dbt: ['placed', 'shipped'] },
          tests: {
            dbt: [{ name: 'accepted_values', package: 'dbt' }],
            dbt_by_package: { dbt: ['accepted_values'] },
          },
        },
      ],
      joins: [],
      measures: [],
      tags: { dbt: ['mart', 'finance'] },
      freshness: { dbt: { loaded_at_field: 'updated_at', raw: { warn_after: { count: 12, period: 'hour' } } } },
      default_time_dimension: { dbt: 'updated_at' },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.descriptions).toEqual({ dbt: 'Order facts from dbt.' });
    expect(result.data.columns[0]).toMatchObject({
      descriptions: { dbt: 'Order lifecycle status.' },
      constraints: { dbt: { not_null: true, unique: true } },
      enum_values: { dbt: ['placed', 'shipped'] },
      tests: {
        dbt: [{ name: 'accepted_values', package: 'dbt' }],
        dbt_by_package: { dbt: ['accepted_values'] },
      },
    });
    expect(result.data.tags).toEqual({ dbt: ['mart', 'finance'] });
    expect(result.data.freshness).toEqual({
      dbt: { loaded_at_field: 'updated_at', raw: { warn_after: { count: 12, period: 'hour' } } },
    });
  });

  it('accepts historic SQL usage on standalone sources', () => {
    const result = sourceDefinitionSchema.safeParse({
      name: 'orders',
      table: 'public.orders',
      grain: ['id'],
      columns: [{ name: 'id', type: 'string' }],
      joins: [],
      measures: [],
      usage: {
        narrative: 'Orders are queried for fulfillment and revenue analysis.',
        frequencyTier: 'high',
        commonFilters: ['status', 'created_at'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
        externalOwner: 'analytics',
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.usage).toMatchObject({
      narrative: 'Orders are queried for fulfillment and revenue analysis.',
      frequencyTier: 'high',
      commonFilters: ['status', 'created_at'],
      commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      externalOwner: 'analytics',
    });
  });
});

describe('projectManifestEntry', () => {
  it('projects manifest usage onto the semantic-layer source', () => {
    const source = projectManifestEntry('orders', {
      table: 'public.orders',
      usage: {
        narrative: 'Orders are frequently filtered by status.',
        frequencyTier: 'high',
        commonFilters: ['status'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      },
      columns: [
        { name: 'id', type: 'string', pk: true },
        { name: 'status', type: 'string' },
      ],
    });

    expect(source.usage).toEqual({
      narrative: 'Orders are frequently filtered by status.',
      frequencyTier: 'high',
      commonFilters: ['status'],
      commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
    });
  });
});

describe('findManifestEntryByTableRef', () => {
  let configService: {
    listFiles: Mock<(dir: string, recursive?: boolean) => Promise<{ files: string[] }>>;
    readFile: Mock<(path: string) => Promise<{ content: string }>>;
  };
  let service: SemanticLayerService;

  beforeEach(() => {
    configService = {
      listFiles: vi.fn<(dir: string, recursive?: boolean) => Promise<{ files: string[] }>>().mockResolvedValue({
        files: ['semantic-layer/conn-1/_schema/marts.yaml'],
      }),
      readFile: vi.fn<(path: string) => Promise<{ content: string }>>().mockResolvedValue({
        content: [
          'tables:',
          '  CONSIGNMENTS:',
          '    table: ANALYTICS.MARTS.CONSIGNMENTS',
          '    columns:',
          '      - { name: CONSIGNED_ITEM_ID, type: string, pk: true }',
        ].join('\n'),
      }),
    };
    service = new SemanticLayerService(configService as never, connectionCatalog(), pythonPort);
  });

  it('finds by exact bare manifest key', async () => {
    const entry = await service.findManifestEntryByTableRef('conn-1', 'CONSIGNMENTS');
    expect(entry?.name).toBe('CONSIGNMENTS');
  });

  it('finds by fully-qualified table path', async () => {
    const entry = await service.findManifestEntryByTableRef('conn-1', 'ANALYTICS.MARTS.CONSIGNMENTS');
    expect(entry?.name).toBe('CONSIGNMENTS');
  });

  it('finds by schema-qualified suffix', async () => {
    const entry = await service.findManifestEntryByTableRef('conn-1', 'MARTS.CONSIGNMENTS');
    expect(entry?.name).toBe('CONSIGNMENTS');
  });

  it('matches case-insensitively on table path', async () => {
    const entry = await service.findManifestEntryByTableRef('conn-1', 'analytics.marts.consignments');
    expect(entry?.name).toBe('CONSIGNMENTS');
  });

  it('returns null when nothing matches', async () => {
    const entry = await service.findManifestEntryByTableRef('conn-1', 'NOT_A_TABLE');
    expect(entry).toBeNull();
  });
});

describe('loadAllSources — standalone enrichment via inherits_columns_from', () => {
  let configService: {
    listFiles: Mock<(dir: string, recursive?: boolean) => Promise<{ files: string[] }>>;
    readFile: Mock<(path: string) => Promise<{ content: string }>>;
  };
  let service: SemanticLayerService;

  beforeEach(() => {
    configService = {
      listFiles: vi.fn<(dir: string, recursive?: boolean) => Promise<{ files: string[] }>>(),
      readFile: vi.fn<(path: string) => Promise<{ content: string }>>(),
    };
    service = new SemanticLayerService(configService as never, connectionCatalog(), pythonPort);
  });

  it('preserves dbt metadata when projecting manifest-backed sources', async () => {
    const schemaPath = 'semantic-layer/conn-1/_schema/marts.yaml';
    configService.listFiles.mockImplementation((dir: string) => {
      if (dir === 'semantic-layer/conn-1' || dir === 'semantic-layer/conn-1/_schema') {
        return Promise.resolve({ files: [schemaPath] });
      }
      return Promise.resolve({ files: [] });
    });
    configService.readFile.mockResolvedValue({
      content: [
        'tables:',
        '  orders:',
        '    table: public.orders',
        '    tags: { dbt: [mart] }',
        '    freshness:',
        '      dbt:',
        '        loaded_at_field: updated_at',
        '    columns:',
        '      - name: status',
        '        type: string',
        '        constraints: { dbt: { not_null: true } }',
        '        enum_values: { dbt: [placed, shipped] }',
        '        tests:',
        '          dbt:',
        '            - { name: accepted_values, package: dbt }',
      ].join('\n'),
    });

    const sources = await service.loadAllSources('conn-1');

    expect(sources[0]).toMatchObject({
      name: 'orders',
      tags: { dbt: ['mart'] },
      freshness: { dbt: { loaded_at_field: 'updated_at' } },
      columns: [
        {
          name: 'status',
          constraints: { dbt: { not_null: true } },
          enum_values: { dbt: ['placed', 'shipped'] },
          tests: { dbt: [{ name: 'accepted_values', package: 'dbt' }] },
        },
      ],
    });
  });

  it('fills blank columns on a standalone source from the manifest entry it points at', async () => {
    const schemaPath = 'semantic-layer/conn-1/_schema/marts.yaml';
    const standalonePath = 'semantic-layer/conn-1/aav_consignments.yaml';

    configService.listFiles.mockImplementation((dir: string) => {
      if (dir === 'semantic-layer/conn-1') {
        return Promise.resolve({ files: [schemaPath, standalonePath] });
      }
      if (dir === 'semantic-layer/conn-1/_schema') {
        return Promise.resolve({ files: [schemaPath] });
      }
      return Promise.resolve({ files: [] });
    });
    configService.readFile.mockImplementation((path: string) => {
      if (path === schemaPath) {
        return Promise.resolve({
          content: [
            'tables:',
            '  CONSIGNMENTS:',
            '    table: ANALYTICS.MARTS.CONSIGNMENTS',
            '    columns:',
            '      - name: CONSIGNED_ITEM_ID',
            '        type: string',
            '        descriptions: { ai: "Unique consigned-item id." }',
            '      - name: CASH_ADV_AMOUNT',
            '        type: number',
            '        descriptions: { ai: "Cash advance amount." }',
          ].join('\n'),
        });
      }
      if (path === standalonePath) {
        return Promise.resolve({
          content: [
            'name: aav_consignments',
            'sql: |',
            '  SELECT CONSIGNED_ITEM_ID, CASH_ADV_AMOUNT FROM ANALYTICS.MARTS.CONSIGNMENTS WHERE x',
            'inherits_columns_from: CONSIGNMENTS',
            'grain: [CONSIGNED_ITEM_ID]',
            'columns:',
            '  - { name: CONSIGNED_ITEM_ID }',
            '  - { name: CASH_ADV_AMOUNT }',
          ].join('\n'),
        });
      }
      return Promise.reject(new Error(`Unexpected readFile: ${path}`));
    });

    const sources = await service.loadAllSources('conn-1');
    const aav = sources.find((s) => s.name === 'aav_consignments');
    expect(aav).toBeDefined();
    expect(aav?.columns).toEqual([
      { name: 'CONSIGNED_ITEM_ID', type: 'string', descriptions: { ai: 'Unique consigned-item id.' } },
      { name: 'CASH_ADV_AMOUNT', type: 'number', descriptions: { ai: 'Cash advance amount.' } },
    ]);
  });

  it('accepts a fully-qualified path in inherits_columns_from', async () => {
    const schemaPath = 'semantic-layer/conn-1/_schema/marts.yaml';
    const standalonePath = 'semantic-layer/conn-1/aav_consignments.yaml';
    configService.listFiles.mockImplementation((dir: string) => {
      if (dir === 'semantic-layer/conn-1') {
        return Promise.resolve({ files: [schemaPath, standalonePath] });
      }
      if (dir === 'semantic-layer/conn-1/_schema') {
        return Promise.resolve({ files: [schemaPath] });
      }
      return Promise.resolve({ files: [] });
    });
    configService.readFile.mockImplementation((path: string) => {
      if (path === schemaPath) {
        return Promise.resolve({
          content: [
            'tables:',
            '  CONSIGNMENTS:',
            '    table: ANALYTICS.MARTS.CONSIGNMENTS',
            '    columns:',
            '      - { name: CONSIGNED_ITEM_ID, type: string }',
          ].join('\n'),
        });
      }
      return Promise.resolve({
        content: [
          'name: aav_consignments',
          'sql: SELECT 1',
          'inherits_columns_from: ANALYTICS.MARTS.CONSIGNMENTS',
          'grain: [CONSIGNED_ITEM_ID]',
          'columns:',
          '  - { name: CONSIGNED_ITEM_ID }',
        ].join('\n'),
      });
    });

    const sources = await service.loadAllSources('conn-1');
    const aav = sources.find((s) => s.name === 'aav_consignments');
    expect(aav?.columns[0].type).toBe('string');
  });

  it('passes the source through unchanged if inherits_columns_from misses', async () => {
    const standalonePath = 'semantic-layer/conn-1/aav_consignments.yaml';
    configService.listFiles.mockImplementation((dir: string) => {
      if (dir === 'semantic-layer/conn-1') {
        return Promise.resolve({ files: [standalonePath] });
      }
      return Promise.resolve({ files: [] });
    });
    configService.readFile.mockResolvedValue({
      content: [
        'name: aav_consignments',
        'sql: SELECT 1',
        'inherits_columns_from: NO_SUCH_TABLE',
        'grain: [FOO]',
        'columns:',
        '  - { name: FOO, type: string }',
      ].join('\n'),
    });

    const sources = await service.loadAllSources('conn-1');
    const aav = sources.find((s) => s.name === 'aav_consignments');
    expect(aav?.columns).toEqual([{ name: 'FOO', type: 'string' }]);
  });

  it('normalizes legacy flat source and column descriptions when loading standalone files', async () => {
    const standalonePath = 'semantic-layer/conn-1/orders.yaml';
    configService.listFiles.mockResolvedValue({ files: [standalonePath] });
    configService.readFile.mockResolvedValue({
      content: [
        'name: orders',
        'description: Finance orders used for invoice reconciliation.',
        'table: public.orders',
        'grain: [id]',
        'columns:',
        '  - name: id',
        '    type: string',
        '    description: Stable order identifier.',
      ].join('\n'),
    });

    const sources = await service.loadAllSources('conn-1');

    expect(sources[0]).toMatchObject({
      name: 'orders',
      descriptions: { user: 'Finance orders used for invoice reconciliation.' },
      columns: [{ name: 'id', type: 'string', descriptions: { user: 'Stable order identifier.' } }],
    });
  });
});

describe('validateWithProposedSource', () => {
  let configService: {
    listFiles: Mock<(dir: string, recursive?: boolean) => Promise<{ files: string[] }>>;
    readFile: Mock<(path: string) => Promise<{ content: string }>>;
  };
  let service: SemanticLayerService;

  beforeEach(() => {
    pythonPort.validateSources.mockReset();
    configService = {
      listFiles: vi.fn<(dir: string, recursive?: boolean) => Promise<{ files: string[] }>>().mockResolvedValue({
        files: [],
      }),
      readFile: vi.fn<(path: string) => Promise<{ content: string }>>(),
    };
    service = new SemanticLayerService(configService as never, connectionCatalog('BIGQUERY'), pythonPort);
  });

  it('uses the connection warehouse dialect, not hardcoded postgres', async () => {
    pythonPort.validateSources.mockResolvedValue({
      data: { errors: [], warnings: [] },
    });

    await service.validateWithProposedSource('conn-1', {
      name: 'std',
      table: 'analytics.std',
      grain: ['id'],
      columns: [{ name: 'id', type: 'number' }],
      joins: [],
      measures: [],
    });

    expect(pythonPort.validateSources).toHaveBeenCalledWith(
      expect.objectContaining({
        dialect: 'bigquery',
      }),
    );
  });

  it('composes a bare overlay with its manifest base before validating', async () => {
    const schemaPath = 'semantic-layer/conn-1/_schema/core.yaml';
    const listFilesImpl = (dir: string): Promise<{ files: string[] }> => {
      if (dir === 'semantic-layer/conn-1') {
        return Promise.resolve({ files: [schemaPath, 'semantic-layer/conn-1/fct_orders.yaml'] });
      }
      if (dir === 'semantic-layer/conn-1/_schema') {
        return Promise.resolve({ files: [schemaPath] });
      }
      return Promise.resolve({ files: [] });
    };
    const readFileImpl = (path: string): Promise<{ content: string }> => {
      if (path === schemaPath) {
        return Promise.resolve({
          content: [
            'tables:',
            '  fct_orders:',
            '    table: analytics.fct_orders',
            '    columns:',
            '      - { name: id, type: string, pk: true }',
            '      - { name: amount, type: number }',
          ].join('\n'),
        });
      }
      if (path === 'semantic-layer/conn-1/fct_orders.yaml') {
        return Promise.resolve({ content: 'name: fct_orders\nmeasures: []\n' });
      }
      return Promise.reject(new Error(`Unexpected readFile: ${path}`));
    };
    configService.listFiles.mockImplementation(listFilesImpl);
    configService.readFile.mockImplementation(readFileImpl);

    pythonPort.validateSources.mockResolvedValue({
      data: { errors: [], warnings: [] },
    });

    const overlay: SemanticLayerSource = {
      name: 'fct_orders',
      grain: ['id'],
      columns: [],
      joins: [],
      measures: [{ name: 'total_amount', expr: 'sum(amount)' }],
    };

    await service.validateWithProposedSource('conn-1', overlay);

    expect(pythonPort.validateSources).toHaveBeenCalledTimes(1);
    const sources = (pythonPort.validateSources.mock.calls[0][0]?.sources ?? []) as Array<Record<string, unknown>>;
    const composed = sources.find((s) => s.name === 'fct_orders');
    expect(composed).toBeDefined();
    expect(composed?.table).toBe('analytics.fct_orders');
    expect(composed?.measures).toEqual([{ name: 'total_amount', expr: 'sum(amount)' }]);
  });

  it('returns a pointed error when a bare overlay has no manifest base', async () => {
    configService.listFiles.mockResolvedValue({ files: [] });

    const overlay: SemanticLayerSource = {
      name: 'orphan',
      grain: [],
      columns: [],
      joins: [],
      measures: [],
    };

    const result = await service.validateWithProposedSource('conn-1', overlay);
    expect(result.errors[0]).toMatch(/Overlay 'orphan' has no matching manifest entry/);
    expect(pythonPort.validateSources).not.toHaveBeenCalled();
  });
});

describe('findDanglingSegmentRefs', () => {
  it('returns empty when every measure segment resolves', () => {
    const source = {
      segments: [{ name: 'byol' }, { name: 'paid' }],
      measures: [
        { name: 'byol_count', segments: ['byol'] },
        { name: 'paid_count', segments: ['paid', 'byol'] },
      ],
    };
    expect(findDanglingSegmentRefs(source)).toEqual([]);
  });

  it('flags measures whose segment reference does not exist on the source', () => {
    const source = {
      segments: [{ name: 'byol' }],
      measures: [{ name: 'broken', segments: ['byol', 'missing'] }],
    };
    const refs = findDanglingSegmentRefs(source);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatch(/measure 'broken' references unknown segment 'missing'/);
  });

  it('flags when a source has zero segments but measures reference one', () => {
    const source = {
      measures: [{ name: 'broken', segments: ['byol'] }],
    };
    const refs = findDanglingSegmentRefs(source);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatch(/unknown segment 'byol'/);
  });

  it('is a no-op for sources with no measures or no segment references', () => {
    expect(findDanglingSegmentRefs({ measures: [{ name: 'simple', expr: 'count(*)' }] })).toEqual([]);
    expect(findDanglingSegmentRefs({})).toEqual([]);
  });
});
