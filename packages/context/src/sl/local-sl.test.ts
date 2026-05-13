import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../project/index.js';
import {
  listLocalSlSources,
  readLocalSlSource,
  searchLocalSlSources,
  validateLocalSlSource,
  writeLocalSlSource,
} from './local-sl.js';

const ORDERS_YAML = [
  'name: orders',
  'table: public.orders',
  'grain:',
  '  - order_id',
  'columns:',
  '  - name: order_id',
  '    type: string',
  '  - name: revenue',
  '    type: number',
  'measures:',
  '  - name: total_revenue',
  '    expr: sum(revenue)',
  '',
].join('\n');

const SUPPORT_YAML = [
  'name: tickets',
  'descriptions:',
  '  user: Support tickets grouped by priority.',
  'table: public.tickets',
  'grain:',
  '  - ticket_id',
  'columns:',
  '  - name: ticket_id',
  '    type: string',
  '  - name: priority',
  '    type: string',
  'measures:',
  '  - name: ticket_count',
  '    expr: count(*)',
  '',
].join('\n');

describe('local semantic-layer helpers', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-sl-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project'), projectName: 'warehouse' });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes, reads, lists, and validates semantic-layer sources', async () => {
    const write = await writeLocalSlSource(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: ORDERS_YAML,
    });

    expect(write.path).toBe('semantic-layer/warehouse/orders.yaml');

    await expect(
      readLocalSlSource(project, { connectionId: 'warehouse', sourceName: 'orders' }),
    ).resolves.toMatchObject({
      connectionId: 'warehouse',
      name: 'orders',
      path: 'semantic-layer/warehouse/orders.yaml',
      yaml: ORDERS_YAML,
    });

    await expect(listLocalSlSources(project, { connectionId: 'warehouse' })).resolves.toEqual([
      {
        columnCount: 2,
        connectionId: 'warehouse',
        joinCount: 0,
        measureCount: 1,
        name: 'orders',
        path: 'semantic-layer/warehouse/orders.yaml',
      },
    ]);

    await expect(validateLocalSlSource(ORDERS_YAML)).resolves.toEqual({ valid: true, errors: [] });
  });

  it('validates table-backed sources against matching physical manifests when project context is provided', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/postgres-warehouse/_schema/orbit_analytics.yaml',
      `tables:
  int_active_contract_arr:
    table: orbit_analytics.int_active_contract_arr
    columns:
      - { name: contract_id, type: string }
      - { name: contract_arr_cents, type: number }
`,
      'ktx',
      'ktx@example.com',
      'Add warehouse manifest',
    );

    const invalidDbtSource = [
      'name: int_active_contract_arr',
      'table: orbit_analytics.int_active_contract_arr',
      'grain: [contract_id]',
      'columns:',
      '  - { name: contract_id, type: string }',
      '  - { name: arr_cents, type: number }',
      'measures:',
      '  - { name: arr, expr: sum(arr_cents) }',
      '',
    ].join('\n');

    const result = await validateLocalSlSource(invalidDbtSource, { project, connectionId: 'dbt-main' });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('arr_cents');
    expect(result.errors.join('\n')).toContain('absent from physical table');
  });

  it('lists and reads manifest-backed scan sources as queryable sources', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      `tables:
  payments:
    table: public.payments
    columns:
      - name: payment_id
        type: number
        pk: true
      - name: amount
        type: number
`,
      'ktx',
      'ktx@example.com',
      'Add manifest shard',
    );

    await expect(listLocalSlSources(project, { connectionId: 'warehouse' })).resolves.toEqual([
      {
        columnCount: 2,
        connectionId: 'warehouse',
        joinCount: 0,
        measureCount: 0,
        name: 'payments',
        path: 'semantic-layer/warehouse/_schema/public.yaml#payments',
      },
    ]);

    await expect(readLocalSlSource(project, { connectionId: 'warehouse', sourceName: 'payments' })).resolves.toEqual(
      expect.objectContaining({
        columnCount: 2,
        connectionId: 'warehouse',
        joinCount: 0,
        measureCount: 0,
        name: 'payments',
        path: 'semantic-layer/warehouse/_schema/public.yaml#payments',
        yaml: expect.stringContaining('table: public.payments'),
      }),
    );
  });

  it('expands manifest-backed scan sources when listing all connections', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      `tables:
  payments:
    table: public.payments
    columns:
      - name: payment_id
        type: number
        pk: true
      - name: amount
        type: number
`,
      'ktx',
      'ktx@example.com',
      'Add manifest shard',
    );

    await expect(listLocalSlSources(project)).resolves.toEqual([
      {
        columnCount: 2,
        connectionId: 'warehouse',
        joinCount: 0,
        measureCount: 0,
        name: 'payments',
        path: 'semantic-layer/warehouse/_schema/public.yaml#payments',
      },
    ]);
  });

  it('searches local semantic-layer source text through SQLite FTS', async () => {
    await writeLocalSlSource(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: ORDERS_YAML,
    });
    await writeLocalSlSource(project, {
      connectionId: 'warehouse',
      sourceName: 'tickets',
      yaml: SUPPORT_YAML,
    });

    const results = await searchLocalSlSources(project, { connectionId: 'warehouse', query: 'total revenue' });

    expect(results).toEqual([
      expect.objectContaining({
        connectionId: 'warehouse',
        name: 'orders',
        path: 'semantic-layer/warehouse/orders.yaml',
        score: expect.any(Number),
      }),
    ]);
    expect(results[0]?.score).toBeGreaterThan(0);
    await expect(access(join(project.projectDir, '.ktx/db.sqlite'))).resolves.toBeUndefined();
  });

  it('searches historic SQL usage and returns frequency tier plus FTS snippet', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      `tables:
  orders:
    table: public.orders
    usage:
      narrative: Analysts inspect paid order lifecycle by customer segment.
      frequencyTier: high
      commonFilters:
        - status
        - created_at
      commonGroupBys:
        - customer_segment
      commonJoins:
        - table: public.customers
          on:
            - customer_id
    columns:
      - name: order_id
        type: string
      - name: status
        type: string
`,
      'ktx',
      'ktx@example.com',
      'Add usage-backed manifest shard',
    );

    const results = await searchLocalSlSources(project, {
      connectionId: 'warehouse',
      query: 'paid lifecycle customer segment',
    });

    expect(results).toEqual([
      expect.objectContaining({
        connectionId: 'warehouse',
        name: 'orders',
        path: 'semantic-layer/warehouse/_schema/public.yaml#orders',
        frequencyTier: 'high',
        snippet: expect.stringContaining('<mark>'),
        matchReasons: expect.arrayContaining(['lexical']),
      }),
    ]);
    expect(results[0]?.snippet).toContain('lifecycle');
  });

  it('searches all connections with one global hybrid ranking pass', async () => {
    await writeLocalSlSource(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: ORDERS_YAML,
    });
    await writeLocalSlSource(project, {
      connectionId: 'finance',
      sourceName: 'orders',
      yaml: [
        'name: orders',
        'descriptions:',
        '  user: Finance orders used for invoice reconciliation.',
        'table: finance.orders',
        'grain:',
        '  - order_id',
        'columns:',
        '  - name: order_id',
        '    type: string',
        '  - name: invoice_status',
        '    type: string',
        '',
      ].join('\n'),
    });

    const results = await searchLocalSlSources(project, { query: 'orders' });

    expect(results.map((result) => `${result.connectionId}/${result.name}`)).toEqual([
      'finance/orders',
      'warehouse/orders',
    ]);
    expect(results[0]).toMatchObject({
      score: expect.any(Number),
      matchReasons: expect.arrayContaining(['lexical']),
      lanes: expect.arrayContaining([expect.objectContaining({ lane: 'lexical', status: 'available' })]),
    });
  });

  it('returns dictionary evidence when collected sample values explain a match', async () => {
    await writeLocalSlSource(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: ORDERS_YAML,
    });
    await project.fileStore.writeFile(
      'raw-sources/warehouse/live-database/sync-1/enrichment/relationship-profile.json',
      `${JSON.stringify(
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          sqlAvailable: true,
          queryCount: 2,
          tables: [],
          columns: {
            'orders.status': {
              table: { catalog: null, db: 'public', name: 'orders' },
              column: 'status',
              nativeType: 'text',
              normalizedType: 'string',
              rowCount: 10,
              nullCount: 0,
              distinctCount: 2,
              uniquenessRatio: 0.2,
              nullRate: 0,
              sampleValues: ['paid', 'refunded'],
              minTextLength: 4,
              maxTextLength: 8,
            },
          },
          warnings: [],
        },
        null,
        2,
      )}\n`,
      'ktx',
      'ktx@example.com',
      'Seed dictionary profile',
    );

    const results = await searchLocalSlSources(project, { connectionId: 'warehouse', query: 'refunded' });

    expect(results).toEqual([
      expect.objectContaining({
        connectionId: 'warehouse',
        name: 'orders',
        matchReasons: ['dictionary'],
        dictionaryMatches: [{ column: 'status', values: ['refunded'] }],
      }),
    ]);
  });

  it('adds the token lane alongside lexical matches for normalized query terms', async () => {
    await writeLocalSlSource(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: ORDERS_YAML,
    });

    const results = await searchLocalSlSources(project, { connectionId: 'warehouse', query: 'orders---' });

    expect(results[0]).toMatchObject({
      connectionId: 'warehouse',
      name: 'orders',
      matchReasons: expect.arrayContaining(['token']),
    });
  });

  it('reports schema validation errors without writing invalid YAML', async () => {
    const invalidYaml = ['name: broken', 'table: public.orders', 'columns: []', ''].join('\n');

    await expect(validateLocalSlSource(invalidYaml)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringContaining('grain')]),
    });

    await expect(
      writeLocalSlSource(project, {
        connectionId: 'warehouse',
        sourceName: 'broken',
        yaml: invalidYaml,
      }),
    ).rejects.toThrow('Invalid semantic-layer source');
  });

  it('rejects unsafe source paths', async () => {
    await expect(
      readLocalSlSource(project, {
        connectionId: 'warehouse',
        sourceName: '../orders',
      }),
    ).rejects.toThrow('Unsafe semantic-layer source name');
  });
});
