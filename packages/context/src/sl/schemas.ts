import { z } from 'zod';

// Literal vocabularies — kept in lockstep with the Python Pydantic model at
// python-service/ktx-sl/semantic_layer/models.py (SourceColumn / ColumnRole /
// ColumnVisibility / JoinDeclaration). If these diverge, YAMLs can pass
// TypeScript validation at ingest time but fail Python loading at query time.
const columnTypeValues = ['string', 'number', 'time', 'boolean'] as const;
const columnRoleValues = ['time', 'default'] as const;
const columnVisibilityValues = ['public', 'internal', 'hidden'] as const;
const joinRelationshipValues = ['many_to_one', 'one_to_many', 'one_to_one'] as const;

const slMeasureDefinitionSchema = z.object({
  name: z.string().min(1),
  expr: z.string().min(1),
  filter: z.string().optional(),
  segments: z.array(z.string().min(1)).optional(),
  description: z.string().optional(),
});

const segmentDefinitionSchema = z.object({
  name: z.string().min(1),
  expr: z.string().min(1),
  description: z.string().optional(),
});

const descriptionsSchema = z.record(z.string(), z.string().min(1));

const defaultTimeDimensionDbtSchema = z.object({
  dbt: z.string().optional(),
});

const dbtColumnConstraintsSchema = z.object({
  not_null: z.boolean().optional(),
  unique: z.boolean().optional(),
});

const dbtDataTestRefSchema = z.object({
  name: z.string().min(1),
  package: z.string().min(1),
  kwargs: z.record(z.string(), z.unknown()).optional(),
});

const dbtColumnTestsSchema = z.object({
  dbt: z.array(dbtDataTestRefSchema).optional(),
  dbt_by_package: z.record(z.string(), z.array(z.string().min(1))).optional(),
});

const sourceKeyedStringArraySchema = z.object({
  dbt: z.array(z.string().min(1)).optional(),
});

const sourceKeyedColumnConstraintsSchema = z.object({
  dbt: dbtColumnConstraintsSchema.optional(),
});

const freshnessDbtSchema = z.object({
  raw: z.unknown().optional(),
  loaded_at_field: z.string().nullable().optional(),
});

const sourceFreshnessSchema = z.object({
  dbt: freshnessDbtSchema.optional(),
});

const joinDeclarationSchema = z.object({
  to: z.string().min(1),
  on: z.string().min(1),
  relationship: z.enum(joinRelationshipValues),
  alias: z.string().optional(),
});

const sourceColumnSchema = z.object({
  name: z.string().min(1),
  // type/description optional on standalone sources: compose-time enrichment fills them
  // from the manifest entry named in `inherits_columns_from`. If the agent does not set
  // `inherits_columns_from`, or the column is not in the manifest, type must be present
  // — surfaced by sl_validate.
  type: z.enum(columnTypeValues).optional(),
  role: z.enum(columnRoleValues).optional(),
  visibility: z.enum(columnVisibilityValues).optional(),
  description: z.string().optional(),
  descriptions: descriptionsSchema.optional(),
  expr: z.string().optional(),
  constraints: sourceKeyedColumnConstraintsSchema.optional(),
  enum_values: sourceKeyedStringArraySchema.optional(),
  tests: dbtColumnTestsSchema.optional(),
});

/** Overlay column: type requires expr (structural types are inherited from manifest). */
const overlayColumnSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(columnTypeValues).optional(),
    role: z.enum(columnRoleValues).optional(),
    visibility: z.enum(columnVisibilityValues).optional(),
    description: z.string().optional(),
    descriptions: descriptionsSchema.optional(),
    expr: z.string().optional(),
  })
  .refine((col) => !col.type || col.expr, {
    message: "Overlay column with 'type' must also have 'expr' (only computed columns may specify a type)",
  });

/** Standalone source: has `table` or `sql`, requires grain + columns. */
export const sourceDefinitionSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    descriptions: descriptionsSchema.optional(),
    // Accepted for documentation parity with the Python spec; behavior is driven
    // by the `table` / `sql` fields, not by this discriminator.
    source_type: z.enum(['table', 'sql']).optional(),
    table: z.string().optional(),
    sql: z.string().optional(),
    // Manifest key (e.g. "CONSIGNMENTS") whose column metadata fills any blank
    // type/descriptions/role on this source's columns at compose time. Lets the
    // agent write `columns: [{name: FOO}]` instead of redeclaring known fields.
    // Lookup is fuzzy: bare key, fully-qualified table path, or any suffix all match.
    inherits_columns_from: z.string().optional(),
    grain: z.array(z.string()).min(1),
    columns: z.array(sourceColumnSchema).default([]),
    joins: z.array(joinDeclarationSchema).default([]),
    measures: z.array(slMeasureDefinitionSchema).default([]),
    segments: z.array(segmentDefinitionSchema).optional(),
    default_time_dimension: defaultTimeDimensionDbtSchema.optional(),
    tags: sourceKeyedStringArraySchema.optional(),
    freshness: sourceFreshnessSchema.optional(),
  })
  .strict()
  .refine((s) => (s.table || s.sql) && !(s.table && s.sql), {
    message: "Standalone source must have exactly one of 'table' or 'sql' (not both)",
  });

/** Overlay source: no table/sql, all fields optional except name. */
export const sourceOverlaySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    descriptions: z.record(z.string(), z.string()).optional(),
    grain: z.array(z.string()).optional(),
    columns: z.array(overlayColumnSchema).optional(),
    joins: z.array(joinDeclarationSchema).optional(),
    measures: z.array(slMeasureDefinitionSchema).optional(),
    segments: z.array(segmentDefinitionSchema).optional(),
    exclude_columns: z.array(z.string()).optional(),
    disable_joins: z.array(z.string()).optional(),
    default_time_dimension: defaultTimeDimensionDbtSchema.optional(),
  })
  .strict();

/** Returns true if the source data is an overlay (no table/sql field). */
export function isOverlaySource(source: Record<string, unknown>): boolean {
  return !source.table && !source.sql;
}
