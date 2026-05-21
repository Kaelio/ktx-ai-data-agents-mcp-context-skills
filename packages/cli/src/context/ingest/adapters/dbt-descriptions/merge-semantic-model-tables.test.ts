import { describe, expect, it } from 'vitest';
import type { ParsedSemanticModel } from '../metricflow/deep-parse.js';
import { mergeSemanticModelTables } from './merge-semantic-model-tables.js';
import type { DbtSchemaParseResult } from './parse-schema.js';

const semanticModel: ParsedSemanticModel = {
  name: 'orders_semantic',
  description: 'Order facts',
  modelRef: 'fct_orders',
  dimensions: [
    { name: 'status', column: 'status', type: 'categorical', description: 'Order status' },
    { name: 'ordered_at', column: 'ordered_at', type: 'time' },
  ],
  measures: [],
  entities: [],
  defaultTimeDimension: null,
};

describe('mergeSemanticModelTables', () => {
  it('adds missing MetricFlow model refs as dbt model tables', () => {
    const input: DbtSchemaParseResult = { projectName: null, dbtVersion: null, tables: [], relationships: [] };

    expect(mergeSemanticModelTables(input, [semanticModel])).toEqual({
      projectName: null,
      dbtVersion: null,
      relationships: [],
      tables: [
        {
          name: 'fct_orders',
          description: 'Order facts',
          database: null,
          schema: null,
          resourceType: 'model',
          columns: [
            { name: 'status', description: 'Order status', dataType: null },
            { name: 'ordered_at', description: null, dataType: 'TIMESTAMP' },
          ],
        },
      ],
    });
  });

  it('does not add a duplicate table when schema parsing already found the model ref', () => {
    const input: DbtSchemaParseResult = {
      projectName: null,
      dbtVersion: null,
      relationships: [],
      tables: [
        {
          name: 'FCT_ORDERS',
          description: 'Existing',
          database: null,
          schema: null,
          resourceType: 'model',
          columns: [],
        },
      ],
    };

    expect(mergeSemanticModelTables(input, [semanticModel]).tables).toHaveLength(1);
  });
});
