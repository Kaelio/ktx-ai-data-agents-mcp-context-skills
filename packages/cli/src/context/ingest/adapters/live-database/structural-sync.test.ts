import { describe, expect, it } from 'vitest';
import { type LiveDatabaseSyncedSchema, planLiveDatabaseStructuralSync } from './structural-sync.js';

function idFactory(): () => string {
  let next = 1;
  return () => `id-${next++}`;
}

describe('planLiveDatabaseStructuralSync', () => {
  it('plans table and column creates, updates, deletes, and metadata invalidation', () => {
    const current: LiveDatabaseSyncedSchema = {
      connectionId: 'conn-1',
      tables: [
        {
          id: 'tbl-orders',
          name: 'orders',
          catalog: null,
          db: 'public',
          enabled: true,
          descriptions: { ai: 'Old AI order text', db: 'Old DB order text' },
          columns: [
            {
              id: 'col-order-id',
              name: 'id',
              type: 'number',
              nullable: false,
              primaryKey: true,
              parentColumnId: null,
              descriptions: { db: 'Order id' },
              embedding: [1, 2, 3],
              sampleValues: null,
              cardinality: null,
            },
            {
              id: 'col-order-total',
              name: 'total',
              type: 'number',
              nullable: true,
              primaryKey: false,
              parentColumnId: null,
              descriptions: { ai: 'Old AI total text', db: 'Old total text' },
              embedding: [4, 5, 6],
              sampleValues: ['10'],
              cardinality: 12,
            },
            {
              id: 'col-order-removed',
              name: 'removed',
              type: 'string',
              nullable: true,
              primaryKey: false,
              parentColumnId: null,
              descriptions: {},
              embedding: null,
              sampleValues: null,
              cardinality: null,
            },
          ],
        },
        {
          id: 'tbl-removed',
          name: 'removed_table',
          catalog: null,
          db: 'public',
          enabled: true,
          descriptions: {},
          columns: [
            {
              id: 'col-removed-id',
              name: 'id',
              type: 'number',
              nullable: false,
              primaryKey: true,
              parentColumnId: null,
              descriptions: {},
              embedding: null,
              sampleValues: null,
              cardinality: null,
            },
          ],
        },
      ],
      links: [
        {
          id: 'inferred-total-link',
          fromTableId: 'tbl-orders',
          fromColumnId: 'col-order-total',
          toTableId: 'tbl-orders',
          toColumnId: 'col-order-id',
          source: 'inferred',
          confidence: 0.7,
          relationshipType: 'MANY_TO_ONE',
          isPrimaryKeyReference: true,
        },
      ],
    };

    const plan = planLiveDatabaseStructuralSync({
      connectionId: 'conn-1',
      current,
      extracted: {
        connectionId: 'conn-1',
        tables: [
          {
            name: 'orders',
            catalog: null,
            db: 'public',
            dbComment: 'Fresh DB order text',
            columns: [
              {
                name: 'id',
                type: 'number',
                nullable: false,
                primaryKey: true,
                dbComment: 'Order id',
              },
              {
                name: 'total',
                type: 'string',
                nullable: false,
                primaryKey: false,
                dbComment: 'Fresh total text',
              },
              {
                name: 'created_at',
                type: 'time',
                nullable: false,
                primaryKey: false,
                dbComment: 'Creation timestamp',
              },
            ],
            foreignKeys: [],
          },
          {
            name: 'customers',
            catalog: null,
            db: 'public',
            dbComment: 'Customer table',
            columns: [
              {
                name: 'id',
                type: 'number',
                nullable: false,
                primaryKey: true,
                dbComment: null,
              },
            ],
            foreignKeys: [],
          },
        ],
      },
      idFactory: idFactory(),
    });

    expect(plan.stats).toEqual({
      tablesCreated: 1,
      tablesDeleted: 1,
      columnsCreated: 2,
      columnsDeleted: 2,
      columnsModified: 1,
      formalLinksCreated: 0,
      formalLinksDeleted: 0,
    });
    expect(plan.operations.deleteTableIds).toEqual(['tbl-removed']);
    expect(plan.operations.deleteColumnIds).toEqual(['col-order-removed']);
    expect(plan.operations.insertTables).toEqual([
      {
        id: 'id-2',
        connectionId: 'conn-1',
        name: 'customers',
        catalog: null,
        db: 'public',
        enabled: true,
      },
    ]);
    expect(plan.operations.insertColumns).toEqual([
      {
        id: 'id-1',
        tableId: 'tbl-orders',
        name: 'created_at',
        parentColumnId: null,
      },
      {
        id: 'id-3',
        tableId: 'id-2',
        name: 'id',
        parentColumnId: null,
      },
    ]);
    expect(plan.operations.touchColumnIds).toEqual(['col-order-total']);
    expect(plan.operations.invalidateColumnEmbeddingIds).toEqual(['col-order-total']);
    expect(plan.inferredLinksToValidate).toEqual(['inferred-total-link']);
    expect(plan.changes).toEqual({
      newTableIds: ['id-2'],
      newColumnIds: ['id-1', 'id-3'],
      tablesWithStructuralChanges: ['tbl-orders', 'id-2'],
      columnsWithTypeChange: ['col-order-total'],
      columnsWithDescriptionChange: ['col-order-total'],
      tablesWithDescriptionChange: ['tbl-orders'],
    });

    const orders = plan.schema.tables.find((table) => table.name === 'orders');
    expect(orders?.descriptions).toEqual({ db: 'Fresh DB order text' });
    expect(orders?.columns.map((column) => column.name)).toEqual(['id', 'total', 'created_at']);
    expect(orders?.columns.find((column) => column.name === 'total')).toMatchObject({
      id: 'col-order-total',
      type: 'string',
      nullable: false,
      primaryKey: false,
      descriptions: { db: 'Fresh total text' },
      embedding: null,
      sampleValues: ['10'],
      cardinality: 12,
    });
  });

  it('builds formal links from extracted foreign keys and preserves valid inferred links', () => {
    const current: LiveDatabaseSyncedSchema = {
      connectionId: 'conn-1',
      tables: [
        {
          id: 'tbl-orders',
          name: 'orders',
          catalog: null,
          db: 'public',
          enabled: true,
          descriptions: {},
          columns: [
            {
              id: 'col-orders-id',
              name: 'id',
              type: 'number',
              nullable: false,
              primaryKey: true,
              parentColumnId: null,
              descriptions: {},
              embedding: null,
              sampleValues: null,
              cardinality: null,
            },
            {
              id: 'col-orders-customer',
              name: 'customer_id',
              type: 'number',
              nullable: false,
              primaryKey: false,
              parentColumnId: null,
              descriptions: {},
              embedding: null,
              sampleValues: null,
              cardinality: null,
            },
          ],
        },
        {
          id: 'tbl-customers',
          name: 'customers',
          catalog: null,
          db: 'public',
          enabled: true,
          descriptions: {},
          columns: [
            {
              id: 'col-customers-id',
              name: 'id',
              type: 'number',
              nullable: false,
              primaryKey: true,
              parentColumnId: null,
              descriptions: {},
              embedding: null,
              sampleValues: null,
              cardinality: null,
            },
          ],
        },
      ],
      links: [
        {
          id: 'formal-existing',
          fromTableId: 'tbl-orders',
          fromColumnId: 'col-orders-customer',
          toTableId: 'tbl-customers',
          toColumnId: 'col-customers-id',
          source: 'formal',
          confidence: 1,
          relationshipType: 'MANY_TO_ONE',
          isPrimaryKeyReference: true,
        },
        {
          id: 'inferred-existing',
          fromTableId: 'tbl-orders',
          fromColumnId: 'col-orders-id',
          toTableId: 'tbl-customers',
          toColumnId: 'col-customers-id',
          source: 'inferred',
          confidence: 0.6,
          relationshipType: 'MANY_TO_ONE',
          isPrimaryKeyReference: true,
        },
      ],
    };

    const plan = planLiveDatabaseStructuralSync({
      connectionId: 'conn-1',
      current,
      extracted: {
        connectionId: 'conn-1',
        tables: [
          {
            name: 'orders',
            catalog: null,
            db: 'public',
            dbComment: null,
            columns: [
              { name: 'id', type: 'number', nullable: false, primaryKey: true, dbComment: null },
              { name: 'customer_id', type: 'number', nullable: false, primaryKey: false, dbComment: null },
            ],
            foreignKeys: [
              {
                fromTable: 'orders',
                fromColumn: 'customer_id',
                toTable: 'customers',
                toColumn: 'id',
              },
            ],
          },
          {
            name: 'customers',
            catalog: null,
            db: 'public',
            dbComment: null,
            columns: [{ name: 'id', type: 'number', nullable: false, primaryKey: true, dbComment: null }],
            foreignKeys: [],
          },
        ],
      },
      idFactory: idFactory(),
    });

    expect(plan.stats.formalLinksCreated).toBe(0);
    expect(plan.stats.formalLinksDeleted).toBe(0);
    expect(plan.schema.links.map((link) => link.id)).toEqual(['formal-existing', 'inferred-existing']);

    const planAfterForeignKeyRemoval = planLiveDatabaseStructuralSync({
      connectionId: 'conn-1',
      current,
      extracted: {
        connectionId: 'conn-1',
        tables: [
          {
            name: 'orders',
            catalog: null,
            db: 'public',
            dbComment: null,
            columns: [
              { name: 'id', type: 'number', nullable: false, primaryKey: true, dbComment: null },
              { name: 'customer_id', type: 'number', nullable: false, primaryKey: false, dbComment: null },
            ],
            foreignKeys: [],
          },
          {
            name: 'customers',
            catalog: null,
            db: 'public',
            dbComment: null,
            columns: [{ name: 'id', type: 'number', nullable: false, primaryKey: true, dbComment: null }],
            foreignKeys: [],
          },
        ],
      },
      idFactory: idFactory(),
    });

    expect(planAfterForeignKeyRemoval.stats.formalLinksDeleted).toBe(1);
    expect(planAfterForeignKeyRemoval.schema.links.map((link) => link.id)).toEqual(['inferred-existing']);

    const planAfterForeignKeyCreation = planLiveDatabaseStructuralSync({
      connectionId: 'conn-1',
      current: { ...current, links: [current.links[1]] },
      extracted: {
        connectionId: 'conn-1',
        tables: [
          {
            name: 'orders',
            catalog: null,
            db: 'public',
            dbComment: null,
            columns: [
              { name: 'id', type: 'number', nullable: false, primaryKey: true, dbComment: null },
              { name: 'customer_id', type: 'number', nullable: false, primaryKey: false, dbComment: null },
            ],
            foreignKeys: [
              {
                fromTable: 'orders',
                fromColumn: 'customer_id',
                toTable: 'customers',
                toColumn: 'id',
              },
            ],
          },
          {
            name: 'customers',
            catalog: null,
            db: 'public',
            dbComment: null,
            columns: [{ name: 'id', type: 'number', nullable: false, primaryKey: true, dbComment: null }],
            foreignKeys: [],
          },
        ],
      },
      idFactory: idFactory(),
    });

    expect(planAfterForeignKeyCreation.stats.formalLinksCreated).toBe(1);
    expect(planAfterForeignKeyCreation.schema.links[0]).toMatchObject({
      id: 'id-1',
      fromTableId: 'tbl-orders',
      fromColumnId: 'col-orders-customer',
      toTableId: 'tbl-customers',
      toColumnId: 'col-customers-id',
      source: 'formal',
      confidence: 1,
      relationshipType: 'MANY_TO_ONE',
      isPrimaryKeyReference: true,
    });
  });
});
