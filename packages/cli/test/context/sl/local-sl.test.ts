import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../../../src/context/project/project.js';
import {
  listLocalSlSources,
  readLocalSlSource,
  resolveLocalSlSource,
  searchLocalSlSources,
  validateLocalSlSource,
} from '../../../src/context/sl/local-sl.js';
import { seedSlSourceFile } from './sl-source-seeding.test-utils.js';

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
    project = await initKtxProject({ projectDir: join(tempDir, 'project') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes, reads, lists, and validates semantic-layer sources', async () => {
    const write = await seedSlSourceFile(project, {
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

  it('resolves a scoped source by connection id', async () => {
    await seedSlSourceFile(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: ORDERS_YAML,
    });

    await expect(
      resolveLocalSlSource(project, {
        connectionId: 'warehouse',
        sourceName: 'orders',
      }),
    ).resolves.toEqual({
      kind: 'found',
      source: expect.objectContaining({
        connectionId: 'warehouse',
        name: 'orders',
        path: 'semantic-layer/warehouse/orders.yaml',
        yaml: ORDERS_YAML,
      }),
    });
  });

  it('returns not-found for a missing scoped source', async () => {
    await seedSlSourceFile(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: ORDERS_YAML,
    });

    await expect(
      resolveLocalSlSource(project, {
        connectionId: 'warehouse',
        sourceName: 'missing_orders',
      }),
    ).resolves.toEqual({ kind: 'not-found' });
  });

  it('resolves a unique source name across all connections', async () => {
    await seedSlSourceFile(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: ORDERS_YAML,
    });
    await seedSlSourceFile(project, {
      connectionId: 'analytics',
      sourceName: 'tickets',
      yaml: SUPPORT_YAML,
    });

    await expect(
      resolveLocalSlSource(project, {
        sourceName: 'tickets',
      }),
    ).resolves.toEqual({
      kind: 'found',
      source: expect.objectContaining({
        connectionId: 'analytics',
        name: 'tickets',
        path: 'semantic-layer/analytics/tickets.yaml',
        yaml: SUPPORT_YAML,
      }),
    });
  });

  it('returns not-found for a missing unscoped source', async () => {
    await seedSlSourceFile(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: ORDERS_YAML,
    });

    await expect(resolveLocalSlSource(project, { sourceName: 'missing_orders' })).resolves.toEqual({
      kind: 'not-found',
    });
  });

  it('reports sorted ambiguous connection ids for duplicate source names', async () => {
    await seedSlSourceFile(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: ORDERS_YAML,
    });
    await seedSlSourceFile(project, {
      connectionId: 'analytics',
      sourceName: 'orders',
      yaml: ORDERS_YAML,
    });

    await expect(resolveLocalSlSource(project, { sourceName: 'orders' })).resolves.toEqual({
      kind: 'ambiguous',
      connectionIds: ['analytics', 'warehouse'],
    });
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

  it('reads manifest-backed scan sources whose warehouse identifiers are uppercase', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/PUBLIC.yaml',
      `tables:
  SIGNED_UP:
    table: PUBLIC.SIGNED_UP
    columns:
      - name: ID
        type: number
        pk: true
      - name: EMAIL
        type: string
`,
      'ktx',
      'ktx@example.com',
      'Add uppercase manifest shard',
    );

    await expect(readLocalSlSource(project, { connectionId: 'warehouse', sourceName: 'SIGNED_UP' })).resolves.toEqual(
      expect.objectContaining({
        connectionId: 'warehouse',
        name: 'SIGNED_UP',
        path: 'semantic-layer/warehouse/_schema/PUBLIC.yaml#SIGNED_UP',
        yaml: expect.stringContaining('table: PUBLIC.SIGNED_UP'),
      }),
    );
  });

  it('reads manifest-backed sources whose names are not filename-safe', async () => {
    // Snowflake and Postgres unquoted identifiers allow `$`; manifest keys
    // carry the warehouse name verbatim, so the lookup must accept it.
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/PUBLIC.yaml',
      `tables:
  EVENT$LOG:
    table: PUBLIC.EVENT$LOG
    columns:
      - name: ID
        type: number
        pk: true
`,
      'ktx',
      'ktx@example.com',
      'Add manifest shard with dollar-sign table name',
    );

    await expect(readLocalSlSource(project, { connectionId: 'warehouse', sourceName: 'EVENT$LOG' })).resolves.toEqual(
      expect.objectContaining({
        connectionId: 'warehouse',
        name: 'EVENT$LOG',
        path: 'semantic-layer/warehouse/_schema/PUBLIC.yaml#EVENT$LOG',
        yaml: expect.stringContaining('table: PUBLIC.EVENT$LOG'),
      }),
    );
  });

  it('reads a manifest-backed source while a sibling standalone file has broken YAML', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/PUBLIC.yaml',
      `tables:
  SIGNED_UP:
    table: PUBLIC.SIGNED_UP
    columns:
      - name: ID
        type: number
        pk: true
`,
      'ktx',
      'ktx@example.com',
      'Add manifest shard',
    );
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      'name: orders\nmeasures:\n  - name: revenue\n    expr: [unterminated\n',
      'ktx',
      'ktx@example.com',
      'seed a sibling source mid-edit with broken YAML',
    );

    await expect(readLocalSlSource(project, { connectionId: 'warehouse', sourceName: 'SIGNED_UP' })).resolves.toEqual(
      expect.objectContaining({
        name: 'SIGNED_UP',
        yaml: expect.stringContaining('table: PUBLIC.SIGNED_UP'),
      }),
    );

    // The broken sibling stays visible in listings instead of hiding or
    // failing the whole connection.
    await expect(listLocalSlSources(project, { connectionId: 'warehouse' })).resolves.toEqual([
      expect.objectContaining({ name: 'orders', columnCount: 0 }),
      expect.objectContaining({ name: 'SIGNED_UP', columnCount: 1 }),
    ]);
  });

  it('returns the raw YAML of a standalone source whose content no longer parses', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      'name: orders\nmeasures:\n  - name: revenue\n    expr: [unterminated\n',
      'ktx',
      'ktx@example.com',
      'seed a source mid-edit with broken YAML',
    );

    await expect(readLocalSlSource(project, { connectionId: 'warehouse', sourceName: 'orders' })).resolves.toEqual(
      expect.objectContaining({
        connectionId: 'warehouse',
        name: 'orders',
        path: 'semantic-layer/warehouse/orders.yaml',
        yaml: expect.stringContaining('[unterminated'),
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
    await seedSlSourceFile(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: ORDERS_YAML,
    });
    await seedSlSourceFile(project, {
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
    await seedSlSourceFile(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: ORDERS_YAML,
    });
    await seedSlSourceFile(project, {
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
    await seedSlSourceFile(project, {
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
    await seedSlSourceFile(project, {
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

  it('reports schema validation errors for invalid YAML', async () => {
    const invalidYaml = ['name: broken', 'table: public.orders', 'columns: []', ''].join('\n');

    await expect(validateLocalSlSource(invalidYaml)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringContaining('grain')]),
    });
  });

  it('reports overlay columns that are not computed columns', async () => {
    const invalidYaml = [
      'name: orders',
      'columns:',
      '  - name: status',
      '    descriptions:',
      '      user: Order status.',
      '',
    ].join('\n');

    await expect(
      validateLocalSlSource(invalidYaml, { project, connectionId: 'warehouse', sourceName: 'orders' }),
    ).resolves.toEqual({
      valid: false,
      errors: expect.arrayContaining([expect.stringContaining('columns.0.type')]),
    });
  });

  it('never derives a file path from a traversal-style source name', async () => {
    // Reads match names against loaded records, so a traversal-style name is
    // simply not found; the writer-side guarantee (derived filenames contain
    // no separators) is covered by the source-files tests.
    await expect(
      readLocalSlSource(project, {
        connectionId: 'warehouse',
        sourceName: '../orders',
      }),
    ).resolves.toBeNull();
  });

  it('reads a source from a human-renamed file by its in-file name', async () => {
    // The filename is a derived label, not identity: a file renamed by a human
    // still resolves under the `name:` it declares.
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/custom-file-name.yaml',
      ORDERS_YAML,
      'ktx',
      'ktx@example.com',
      'Seed source at a human-chosen filename',
    );

    await expect(
      readLocalSlSource(project, { connectionId: 'warehouse', sourceName: 'orders' }),
    ).resolves.toMatchObject({
      connectionId: 'warehouse',
      name: 'orders',
      path: 'semantic-layer/warehouse/custom-file-name.yaml',
      yaml: ORDERS_YAML,
    });

    await expect(
      readLocalSlSource(project, { connectionId: 'warehouse', sourceName: 'custom-file-name' }),
    ).resolves.toBeNull();
  });
});
