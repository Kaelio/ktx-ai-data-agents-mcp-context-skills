import { execFileSync } from 'node:child_process';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { resolvedSourceSchema } from '../../../src/context/sl/schemas.js';
import { toResolvedWire } from '../../../src/context/sl/semantic-layer.service.js';
import type { SemanticLayerSource } from '../../../src/context/sl/types.js';

function loadPythonSourceDefinitionSchema(): Record<string, unknown> | null {
  try {
    const stdout = execFileSync('uv', ['run', 'python', '-m', 'semantic_layer', 'dump-schema'], {
      cwd: new URL('../../../..', import.meta.url),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const sourceDefinitionJsonSchema = loadPythonSourceDefinitionSchema();

const fixtures: SemanticLayerSource[] = [
  {
    name: 'orders',
    table: 'public.orders',
    grain: ['id'],
    columns: [
      { name: 'id', type: 'number' },
      {
        name: 'status',
        type: 'string',
        descriptions: { dbt: 'Order lifecycle status.' },
        constraints: { dbt: { not_null: true } },
        enum_values: { dbt: ['placed', 'shipped'] },
        tests: { dbt: [{ name: 'accepted_values', package: 'dbt' }] },
      },
    ],
    joins: [{ to: 'customers', on: 'orders.customer_id = customers.id', relationship: 'many_to_one' }],
    measures: [{ name: 'order_count', expr: 'count(id)' }],
    segments: [{ name: 'paid', expr: "status = 'paid'" }],
    default_time_dimension: { dbt: 'created_at' },
    tags: { dbt: ['mart'] },
    freshness: { dbt: { loaded_at_field: 'updated_at' } },
  },
  {
    name: 'aav_orders',
    sql: 'select id, status from public.orders where status = paid',
    grain: ['id'],
    columns: [{ name: 'id', type: 'number' }],
    joins: [],
    measures: [],
  },
];

describe.skipIf(sourceDefinitionJsonSchema === null)('resolved source JSON Schema contract', () => {
  it('keeps TS resolved-source fixtures accepted by the Python SourceDefinition schema', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(sourceDefinitionJsonSchema as Record<string, unknown>);

    for (const fixture of fixtures) {
      const wire = toResolvedWire(fixture);
      expect(resolvedSourceSchema.safeParse(wire).success).toBe(true);
      expect(validate(wire), JSON.stringify(validate.errors, null, 2)).toBe(true);
    }
  });
});
