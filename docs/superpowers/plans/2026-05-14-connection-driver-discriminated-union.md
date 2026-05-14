# Connection Driver Discriminated Union Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the loose `connectionSchema` in `packages/context/src/project/config.ts` with a Zod 4 discriminated union keyed on `driver`, so that every driver's documented connection fields — including the `mappings` block — appear in the JSON schema emitted by `ktx dev schema`.

**Architecture:** Add a new module `packages/context/src/project/driver-schemas.ts` that defines one `z.looseObject({ driver: z.literal('x'), ... })` per supported driver and combines them with `z.discriminatedUnion('driver', [...])`. Reuse the existing Metabase/Looker/LookML mapping shapes from `mappings-yaml-schema.ts` by exporting them. Wire the union into `config.ts`. Each per-driver shape stays `looseObject` so today's existing yaml configs with extra fields keep parsing.

**Tech Stack:** TypeScript (Node 22+, ESM, `NodeNext`), Zod 4 (`^4.4.3`), Vitest, pnpm workspace.

---

## File Structure

**Create:**
- `packages/context/src/project/driver-schemas.ts` — per-driver Zod schemas + the discriminated union and exported types.
- `packages/context/src/project/driver-schemas.test.ts` — unit tests for each driver schema and the union.

**Modify:**
- `packages/context/src/project/mappings-yaml-schema.ts` — export the three mapping shapes (`metabaseMappingsSchema`, `lookerMappingsSchema`, `lookmlMappingsSchema`) with `.describe()` annotations and a small description on each field so they surface meaningfully in JSON Schema.
- `packages/context/src/project/config.ts:209-214` — replace `connectionSchema` with the discriminated union imported from `driver-schemas.ts`. Update `KtxProjectConnectionConfig` (line `272`) to be `z.infer<typeof connectionSchema>` — still works because `connectionSchema` is the union name we keep.
- `packages/context/src/project/index.ts` — re-export `KtxConnectionConfig` per-driver type aliases if useful (optional; only if tests need them).
- `packages/context/src/project/config.test.ts` — add a test that the JSON schema now describes `mappings` for metabase/looker/lookml.

**No changes needed:**
- `packages/context/src/project/mappings-yaml-schema.ts` parsing helpers (`parseMetabaseMappingBootstrap`, etc.) keep working because `KtxProjectConnectionConfig` still has loose-object semantics per driver.
- Doc files in `docs-site/` already show the `mappings` blocks correctly.

---

## Drivers In Scope

The discriminated union enumerates the drivers actually used in code, fixtures, and docs (no `fake`/test-only driver — none exist in fixtures, verified via `grep "driver:\s*fake"`).

Warehouse drivers (read `driver`, `url`; nothing else schema-modeled — kept `looseObject` so warehouse-specific overrides like `historicSql`/`context.queryHistory` pass through):
- `postgres`, `postgresql` (separate literals; KTX normalizes `postgresql` → `postgres` at runtime, but ktx.yaml accepts both)
- `mysql`
- `snowflake`
- `bigquery`
- `sqlite`
- `clickhouse`
- `sqlserver`

Context-source drivers (model documented fields):
- `metabase` — `api_url`, `api_key`, `api_key_ref`, `network_proxy`/`networkProxy`, `mappings` (metabaseMappingsSchema).
- `looker` — `base_url`, `client_id`, `client_secret`, `client_secret_ref`, `mappings` (lookerMappingsSchema).
- `lookml` — `repoUrl` (camelCase intentional — matches code at `setup-sources.ts:1466`), `branch`, `path`, `auth_token_ref`, `mappings` (lookmlMappingsSchema).
- `notion` — `auth_token`, `auth_token_ref`, `crawl_mode` (`'selected_roots' | 'all_accessible'`), `root_page_ids`, `root_database_ids`, `root_data_source_ids`, `max_pages_per_run`, `max_knowledge_creates_per_run`, `max_knowledge_updates_per_run`.
- `dbt` — `source_dir`, `repo_url`, `branch`, `path`, `auth_token_ref`, `profiles_path`, `target`, `project_name`.
- `metricflow` — `metricflow` (nested object: `repoUrl`, `branch`, `path`, `auth_token_ref`).

Why not strict-object: existing warehouse connections may carry `historicSql` / `context.queryHistory` blocks and other driver-tunable fields not modeled here. `looseObject` preserves the current pass-through behavior while still surfacing the documented fields in JSON Schema.

---

## Task 1: Export and describe mapping shapes

Make the three existing mapping schemas reusable and documented.

**Files:**
- Modify: `packages/context/src/project/mappings-yaml-schema.ts:4-31`
- Test: `packages/context/src/project/mappings-yaml-schema.test.ts` (no behavior change — existing tests must still pass)

- [ ] **Step 1: Add a failing test that imports the new exports**

Append to `packages/context/src/project/mappings-yaml-schema.test.ts` (inside the existing `describe` block):

```typescript
import {
  metabaseMappingsSchema,
  lookerMappingsSchema,
  lookmlMappingsSchema,
} from './mappings-yaml-schema.js';

// ...inside describe(...)

it('exports mapping shapes that parse documented examples', () => {
  expect(metabaseMappingsSchema.parse({ databaseMappings: { '1': 'wh' } })).toMatchObject({
    databaseMappings: { '1': 'wh' },
    syncMode: 'ALL',
  });
  expect(lookerMappingsSchema.parse({ connectionMappings: { x: 'wh' } })).toEqual({
    connectionMappings: { x: 'wh' },
  });
  expect(lookmlMappingsSchema.parse({ expectedLookerConnectionName: 'x' })).toEqual({
    expectedLookerConnectionName: 'x',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ktx/context exec vitest run src/project/mappings-yaml-schema.test.ts`
Expected: FAIL with `metabaseMappingsSchema is not exported` or equivalent module-resolution error.

- [ ] **Step 3: Add `export` and `.describe()` to the three schemas**

In `packages/context/src/project/mappings-yaml-schema.ts`, change the three internal `const` declarations:

```typescript
export const metabaseMappingsSchema = z
  .object({
    databaseMappings: z
      .record(z.string(), stringTargetSchema)
      .default({})
      .describe('Map of Metabase database ID (positive integer string) to KTX connection ID. Use null to explicitly unmap.'),
    syncEnabled: z
      .record(z.string(), z.boolean())
      .default({})
      .describe('Per-Metabase-database sync toggle, keyed by Metabase database ID string.'),
    syncMode: metabaseSyncModeSchema
      .default('ALL')
      .describe('Sync scope: ALL ingests every mapped DB; ONLY restricts to syncEnabled=true; EXCEPT excludes syncEnabled=true.'),
    selections: metabaseSelectionsSchema
      .default({ collections: [], items: [] })
      .describe('Optional Metabase collection and item IDs to scope ingest.'),
    defaultTagNames: z
      .array(z.string().min(1))
      .default([])
      .describe('Default tag names applied to ingested Metabase artifacts.'),
  })
  .describe('Metabase database-to-warehouse mapping and sync configuration.');

export const lookerMappingsSchema = z
  .object({
    connectionMappings: z
      .record(z.string().min(1), stringTargetSchema)
      .default({})
      .describe('Map of Looker connection name to KTX connection ID. Use null to explicitly unmap.'),
  })
  .describe('Looker connection-to-warehouse mapping configuration.');

export const lookmlMappingsSchema = z
  .object({
    expectedLookerConnectionName: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe('Looker connection name that LookML models must declare; mismatches block sl_write_source at ingest time.'),
  })
  .describe('LookML connection-name expectation for ingest gating.');
```

Leave `metabaseSyncModeSchema`, `metabaseSelectionsSchema`, `stringTargetSchema`, and `positiveIntegerValueSchema` private (no need to export). Leave all parsing helpers (`parseMetabaseMappingBootstrap` etc.) unchanged — they keep working because `.describe()` does not change runtime behavior.

- [ ] **Step 4: Run test to verify it passes and existing tests still pass**

Run: `pnpm --filter @ktx/context exec vitest run src/project/mappings-yaml-schema.test.ts`
Expected: PASS for all tests including the new one.

- [ ] **Step 5: Type-check the package**

Run: `pnpm --filter @ktx/context run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/project/mappings-yaml-schema.ts packages/context/src/project/mappings-yaml-schema.test.ts
git commit -m "refactor(context): export and describe mapping shape schemas"
```

---

## Task 2: Create the driver-schemas module — warehouse drivers

Add the new module with the seven warehouse driver schemas first. Smaller surface, easier to validate.

**Files:**
- Create: `packages/context/src/project/driver-schemas.ts`
- Test: `packages/context/src/project/driver-schemas.test.ts`

- [ ] **Step 1: Write failing tests for warehouse driver schemas**

Create `packages/context/src/project/driver-schemas.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { connectionConfigSchema } from './driver-schemas.js';

describe('connectionConfigSchema (driver discriminated union)', () => {
  it.each([
    ['postgres', 'postgres://user:pass@host:5432/db'],
    ['postgresql', 'postgresql://user:pass@host:5432/db'],
    ['mysql', 'mysql://user:pass@host:3306/db'],
    ['snowflake', 'snowflake://account/db'],
    ['bigquery', 'bigquery://project/dataset'],
    ['sqlite', 'sqlite:///tmp/db.sqlite'],
    ['clickhouse', 'clickhouse://host:8123/db'],
    ['sqlserver', 'sqlserver://host:1433;database=db'],
  ])('parses %s warehouse connection', (driver, url) => {
    expect(connectionConfigSchema.parse({ driver, url })).toMatchObject({ driver, url });
  });

  it('preserves unknown warehouse fields via looseObject passthrough', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'postgres',
      url: 'postgres://x',
      historicSql: { enabled: true },
      context: { queryHistory: { enabled: false } },
    });
    expect(parsed).toMatchObject({
      driver: 'postgres',
      historicSql: { enabled: true },
      context: { queryHistory: { enabled: false } },
    });
  });

  it('rejects an unknown driver', () => {
    expect(() => connectionConfigSchema.parse({ driver: 'nope', url: 'x' })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ktx/context exec vitest run src/project/driver-schemas.test.ts`
Expected: FAIL — `driver-schemas.js` not found.

- [ ] **Step 3: Create `driver-schemas.ts` with warehouse drivers only**

Create `packages/context/src/project/driver-schemas.ts`:

```typescript
import * as z from 'zod';

const warehouseDrivers = [
  'postgres',
  'postgresql',
  'mysql',
  'snowflake',
  'bigquery',
  'sqlite',
  'clickhouse',
  'sqlserver',
] as const;

function warehouseConnectionSchema(driver: (typeof warehouseDrivers)[number]) {
  return z
    .looseObject({
      driver: z.literal(driver),
      url: z
        .string()
        .min(1)
        .optional()
        .describe('Warehouse connection URL or DSN; may contain environment-variable references like env:DATABASE_URL.'),
    })
    .describe(`${driver} warehouse connection. Additional driver-tunable fields (e.g. historicSql, context.queryHistory) are accepted and passed through.`);
}

export const connectionConfigSchema = z.discriminatedUnion(
  'driver',
  warehouseDrivers.map(warehouseConnectionSchema),
);

export type KtxConnectionConfig = z.infer<typeof connectionConfigSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ktx/context exec vitest run src/project/driver-schemas.test.ts`
Expected: PASS for all eight warehouse drivers + passthrough + unknown-driver rejection.

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @ktx/context run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/project/driver-schemas.ts packages/context/src/project/driver-schemas.test.ts
git commit -m "feat(context): add driver-schemas module with warehouse drivers"
```

---

## Task 3: Add Metabase, Looker, LookML driver schemas (the mapping-bearing ones)

These are the most important drivers — they're why we're doing this refactor.

**Files:**
- Modify: `packages/context/src/project/driver-schemas.ts`
- Modify: `packages/context/src/project/driver-schemas.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/context/src/project/driver-schemas.test.ts`:

```typescript
describe('connectionConfigSchema — context source drivers with mappings', () => {
  it('parses a metabase connection with mappings', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'metabase',
      api_url: 'https://metabase.example.com',
      api_key_ref: 'env:METABASE_API_KEY',
      mappings: {
        databaseMappings: { '3': 'prod-warehouse' },
        syncEnabled: { '3': true },
        syncMode: 'ONLY',
      },
    });
    expect(parsed).toMatchObject({
      driver: 'metabase',
      api_url: 'https://metabase.example.com',
      mappings: {
        databaseMappings: { '3': 'prod-warehouse' },
        syncMode: 'ONLY',
      },
    });
  });

  it('parses a looker connection with connectionMappings', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'looker',
      base_url: 'https://looker.example.com',
      client_id: 'abc',
      client_secret_ref: 'env:LOOKER_CLIENT_SECRET',
      mappings: { connectionMappings: { bigquery_prod: 'wh' } },
    });
    expect(parsed.mappings).toEqual({ connectionMappings: { bigquery_prod: 'wh' } });
  });

  it('parses a lookml connection with expectedLookerConnectionName', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'lookml',
      repoUrl: 'https://github.com/acme/looker.git',
      branch: 'main',
      mappings: { expectedLookerConnectionName: 'bigquery_prod' },
    });
    expect(parsed.mappings).toEqual({ expectedLookerConnectionName: 'bigquery_prod' });
  });

  it('rejects metabase mapping with non-integer database key', () => {
    expect(() =>
      connectionConfigSchema.parse({
        driver: 'metabase',
        api_url: 'https://x',
        mappings: { databaseMappings: { 'abc': 'wh' } },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ktx/context exec vitest run src/project/driver-schemas.test.ts`
Expected: FAIL — `driver: 'metabase'` is not in the discriminated union.

- [ ] **Step 3: Extend `driver-schemas.ts` with metabase/looker/lookml schemas**

Edit `packages/context/src/project/driver-schemas.ts` — add imports and the three new schemas, and include them in the union:

```typescript
import * as z from 'zod';
import {
  lookerMappingsSchema,
  lookmlMappingsSchema,
  metabaseMappingsSchema,
} from './mappings-yaml-schema.js';

// ... (warehouseDrivers + warehouseConnectionSchema stay as-is) ...

const positiveIntKeyMessage = (field: string) =>
  `${field} keys must be positive-integer strings (e.g. "1", "42")`;

const positiveIntKeyRegex = /^[1-9]\d*$/;

const metabaseMappingsStrictSchema = metabaseMappingsSchema.superRefine((value, ctx) => {
  for (const key of Object.keys(value.databaseMappings ?? {})) {
    if (!positiveIntKeyRegex.test(key)) {
      ctx.addIssue({ code: 'custom', path: ['databaseMappings', key], message: positiveIntKeyMessage('databaseMappings') });
    }
  }
  for (const key of Object.keys(value.syncEnabled ?? {})) {
    if (!positiveIntKeyRegex.test(key)) {
      ctx.addIssue({ code: 'custom', path: ['syncEnabled', key], message: positiveIntKeyMessage('syncEnabled') });
    }
  }
});

const metabaseConnectionSchema = z
  .looseObject({
    driver: z.literal('metabase'),
    api_url: z.string().url().describe('Metabase instance API URL (e.g. https://metabase.example.com).'),
    api_key: z.string().min(1).optional().describe('Literal Metabase API key. Prefer api_key_ref for safety.'),
    api_key_ref: z
      .string()
      .min(1)
      .optional()
      .describe('Reference to Metabase API key (e.g. env:METABASE_API_KEY or file:/path).'),
    network_proxy: z
      .looseObject({})
      .optional()
      .describe('Optional network proxy configuration (snake_case form).'),
    networkProxy: z
      .looseObject({})
      .optional()
      .describe('Optional network proxy configuration (camelCase form).'),
    mappings: metabaseMappingsStrictSchema.optional().describe('Metabase database-to-warehouse mappings and sync configuration.'),
  })
  .describe('Metabase context-source connection.');

const lookerConnectionSchema = z
  .looseObject({
    driver: z.literal('looker'),
    base_url: z.string().url().describe('Looker instance base URL (e.g. https://looker.example.com).'),
    client_id: z.string().min(1).describe('Looker OAuth client ID.'),
    client_secret: z.string().min(1).optional().describe('Literal Looker OAuth client secret. Prefer client_secret_ref.'),
    client_secret_ref: z
      .string()
      .min(1)
      .optional()
      .describe('Reference to Looker OAuth client secret (e.g. env:LOOKER_CLIENT_SECRET).'),
    mappings: lookerMappingsSchema.optional().describe('Looker connection-name to KTX warehouse mappings.'),
  })
  .describe('Looker context-source connection.');

const lookmlConnectionSchema = z
  .looseObject({
    driver: z.literal('lookml'),
    repoUrl: z
      .string()
      .min(1)
      .describe('Git URL of the LookML project (https, ssh, or file:). Field is camelCase by convention.'),
    branch: z.string().min(1).optional().describe('Git branch (default "main" downstream).'),
    path: z.string().optional().describe('Subdirectory within the repo when the LookML project lives in a monorepo.'),
    auth_token_ref: z.string().min(1).optional().describe('Reference to Git auth token for private repos (e.g. env:GITHUB_TOKEN).'),
    mappings: lookmlMappingsSchema.optional().describe('LookML expected-connection mapping for ingest gating.'),
  })
  .describe('LookML context-source connection.');

export const connectionConfigSchema = z.discriminatedUnion(
  'driver',
  [
    ...warehouseDrivers.map(warehouseConnectionSchema),
    metabaseConnectionSchema,
    lookerConnectionSchema,
    lookmlConnectionSchema,
  ],
);
```

Important: the existing `parseMetabaseMappingBootstrap` in `mappings-yaml-schema.ts` already enforces positive-integer keys via `assertPositiveIntegerKeys`. Adding `metabaseMappingsStrictSchema` here gives the same guarantee at the top-level config parse, so a malformed ktx.yaml fails fast at `parseKtxProjectConfig` time rather than at ingest time.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ktx/context exec vitest run src/project/driver-schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @ktx/context run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/project/driver-schemas.ts packages/context/src/project/driver-schemas.test.ts
git commit -m "feat(context): add metabase, looker, lookml driver schemas with mappings"
```

---

## Task 4: Add Notion, dbt, MetricFlow driver schemas

The remaining context-source drivers; no `mappings` for these, but plenty of driver-specific fields.

**Files:**
- Modify: `packages/context/src/project/driver-schemas.ts`
- Modify: `packages/context/src/project/driver-schemas.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/context/src/project/driver-schemas.test.ts`:

```typescript
describe('connectionConfigSchema — notion / dbt / metricflow', () => {
  it('parses a notion connection with selected_roots crawl', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'notion',
      auth_token_ref: 'env:NOTION_TOKEN',
      crawl_mode: 'selected_roots',
      root_page_ids: ['abc', 'def'],
      max_pages_per_run: 500,
    });
    expect(parsed).toMatchObject({
      driver: 'notion',
      crawl_mode: 'selected_roots',
      root_page_ids: ['abc', 'def'],
      max_pages_per_run: 500,
    });
  });

  it('rejects notion with unknown crawl_mode', () => {
    expect(() =>
      connectionConfigSchema.parse({
        driver: 'notion',
        auth_token_ref: 'env:NOTION_TOKEN',
        crawl_mode: 'everything',
      }),
    ).toThrow();
  });

  it('parses a dbt connection from a local source_dir', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'dbt',
      source_dir: '/tmp/dbt-project',
      target: 'dev',
    });
    expect(parsed).toMatchObject({ driver: 'dbt', source_dir: '/tmp/dbt-project', target: 'dev' });
  });

  it('parses a metricflow connection with nested config', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'metricflow',
      metricflow: {
        repoUrl: 'https://github.com/acme/sl.git',
        branch: 'main',
      },
    });
    expect(parsed).toMatchObject({
      driver: 'metricflow',
      metricflow: { repoUrl: 'https://github.com/acme/sl.git' },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ktx/context exec vitest run src/project/driver-schemas.test.ts`
Expected: FAIL — `driver: 'notion'` etc. not in union.

- [ ] **Step 3: Extend `driver-schemas.ts`**

Add to `packages/context/src/project/driver-schemas.ts` before the final `connectionConfigSchema` export:

```typescript
const notionConnectionSchema = z
  .looseObject({
    driver: z.literal('notion'),
    auth_token: z.string().min(1).optional().describe('Literal Notion integration token. Prefer auth_token_ref.'),
    auth_token_ref: z
      .string()
      .min(1)
      .optional()
      .describe('Reference to Notion integration token (e.g. env:NOTION_TOKEN).'),
    crawl_mode: z
      .enum(['selected_roots', 'all_accessible'])
      .optional()
      .describe('Crawl scope. "selected_roots" requires at least one of root_page_ids, root_database_ids, root_data_source_ids.'),
    root_page_ids: z.array(z.string().min(1)).optional().describe('Notion page IDs to crawl when crawl_mode is selected_roots.'),
    root_database_ids: z.array(z.string().min(1)).optional().describe('Notion database IDs to crawl when crawl_mode is selected_roots.'),
    root_data_source_ids: z
      .array(z.string().min(1))
      .optional()
      .describe('Notion data source IDs to crawl when crawl_mode is selected_roots.'),
    max_pages_per_run: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe('Maximum Notion pages fetched in a single ingest run.'),
    max_knowledge_creates_per_run: z
      .number()
      .int()
      .min(0)
      .max(25)
      .optional()
      .describe('Maximum new wiki pages created per run.'),
    max_knowledge_updates_per_run: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Maximum existing wiki pages updated per run.'),
  })
  .describe('Notion context-source connection.');

const dbtConnectionSchema = z
  .looseObject({
    driver: z.literal('dbt'),
    source_dir: z.string().min(1).optional().describe('Absolute or project-relative path to a local dbt project.'),
    repo_url: z.string().min(1).optional().describe('Git URL of the dbt project (https, ssh, or file:).'),
    branch: z.string().min(1).optional().describe('Git branch when using repo_url.'),
    path: z.string().optional().describe('Subdirectory within the repo when the dbt project lives in a monorepo.'),
    auth_token_ref: z.string().min(1).optional().describe('Reference to Git auth token for private repos.'),
    profiles_path: z.string().optional().describe('Override path to dbt profiles.yml.'),
    target: z.string().min(1).optional().describe('dbt target name (e.g. dev, prod).'),
    project_name: z.string().min(1).optional().describe('Override auto-detected dbt project name.'),
  })
  .describe('dbt context-source connection.');

const metricflowConnectionSchema = z
  .looseObject({
    driver: z.literal('metricflow'),
    metricflow: z
      .looseObject({
        repoUrl: z.string().min(1).describe('Git URL of the MetricFlow / SL project.'),
        branch: z.string().min(1).optional().describe('Git branch (default "main").'),
        path: z.string().optional().describe('Subdirectory within the repo when the SL config lives in a monorepo.'),
        auth_token_ref: z.string().min(1).optional().describe('Reference to Git auth token for private repos.'),
      })
      .describe('Nested MetricFlow configuration block.'),
  })
  .describe('MetricFlow / SL context-source connection.');
```

Then update the final union:

```typescript
export const connectionConfigSchema = z.discriminatedUnion(
  'driver',
  [
    ...warehouseDrivers.map(warehouseConnectionSchema),
    metabaseConnectionSchema,
    lookerConnectionSchema,
    lookmlConnectionSchema,
    notionConnectionSchema,
    dbtConnectionSchema,
    metricflowConnectionSchema,
  ],
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ktx/context exec vitest run src/project/driver-schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @ktx/context run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/project/driver-schemas.ts packages/context/src/project/driver-schemas.test.ts
git commit -m "feat(context): add notion, dbt, metricflow driver schemas"
```

---

## Task 5: Wire the discriminated union into `config.ts`

Now switch the top-level `connectionSchema` to the new union. This is the change that flips JSON-schema output.

**Files:**
- Modify: `packages/context/src/project/config.ts:209-214, 272`
- Test: `packages/context/src/project/config.test.ts` — add a JSON-schema assertion.

- [ ] **Step 1: Write a failing test for the JSON schema output**

Append to `packages/context/src/project/config.test.ts`:

```typescript
import { generateKtxProjectConfigJsonSchema } from './config.js';

describe('generateKtxProjectConfigJsonSchema', () => {
  it('emits the metabase mappings shape under connections', () => {
    const schema = generateKtxProjectConfigJsonSchema();
    const serialized = JSON.stringify(schema);
    expect(serialized).toContain('databaseMappings');
    expect(serialized).toContain('connectionMappings');
    expect(serialized).toContain('expectedLookerConnectionName');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ktx/context exec vitest run src/project/config.test.ts`
Expected: FAIL — the strings are not in the emitted schema yet because `connectionSchema` is still loose.

- [ ] **Step 3: Replace `connectionSchema` in `config.ts`**

In `packages/context/src/project/config.ts`, delete lines `209-214`:

```typescript
const connectionSchema = z
  .looseObject({
    driver: z.string().min(1).optional().describe('Connector driver identifier (e.g. "postgres", "bigquery", "snowflake").'),
    url: z.string().optional().describe('Connection URL or DSN. Format depends on the driver; may contain environment-variable references.'),
  })
  .describe('A single database/connector connection entry. Additional driver-specific fields are accepted and passed through.');
```

Replace with an import + re-bind at the top of the file (after the existing imports):

```typescript
import { connectionConfigSchema } from './driver-schemas.js';

const connectionSchema = connectionConfigSchema;
```

(Re-binding to the local name `connectionSchema` keeps the rest of the file unchanged, including the export of `KtxProjectConnectionConfig` at line `272`.)

- [ ] **Step 4: Run the new test plus existing config tests**

Run: `pnpm --filter @ktx/context exec vitest run src/project/`
Expected: PASS for all tests.

If any existing test fails (e.g. a fixture used an undocumented driver string), update the fixture or expand the union — do not loosen the union.

- [ ] **Step 5: Run the full context test suite to catch downstream regressions**

Run: `pnpm --filter @ktx/context run test`
Expected: PASS.

- [ ] **Step 6: Type-check the workspace**

Run: `pnpm run type-check`
Expected: PASS. `KtxProjectConnectionConfig` is now a union; any consumer that destructured fields not present on every driver branch will surface here.

If type-check fails in a consumer, the fix is usually `if (connection.driver === 'metabase')` style narrowing — or, for code that already does this dynamically (e.g. `String(connection.driver).toLowerCase() === 'metabase'`), an explicit cast at the call site is acceptable. Do not add `as any`; prefer narrowing.

- [ ] **Step 7: Commit**

```bash
git add packages/context/src/project/config.ts packages/context/src/project/config.test.ts
git commit -m "refactor(context): make connectionSchema a driver-discriminated union"
```

---

## Task 6: Verify the user-visible result and CLI smoke

Confirm the original bug is fixed and the CLI behavior is unchanged.

**Files:** none modified in this task.

- [ ] **Step 1: Build the CLI**

Run: `pnpm run build`
Expected: PASS.

- [ ] **Step 2: Confirm `ktx dev schema | rg -i mapping` now returns hits**

Run: `node scripts/run-ktx.mjs -- dev schema | rg -i mapping`
Expected: multiple lines, including the `databaseMappings`, `connectionMappings`, `expectedLookerConnectionName` keys and their descriptions.

- [ ] **Step 3: Run the CLI smoke**

Run: `pnpm --filter @ktx/cli run smoke`
Expected: PASS.

- [ ] **Step 4: Run the broader workspace test suite**

Run: `pnpm run test 2>&1 | tee /tmp/ktx-test-output.log`
Expected: PASS. Inspect `/tmp/ktx-test-output.log` if anything fails.

- [ ] **Step 5: Run pre-commit on changed files**

Run: `pnpm run check`
Expected: PASS.

- [ ] **Step 6: Knip dead-code sweep (in case we introduced unused exports)**

Run: `pnpm run dead-code`
Expected: PASS — or, if Knip flags `KtxConnectionConfig` as unused, decide whether to export it from `packages/context/src/project/index.ts` (preferred — it documents intent) or drop the export.

If exporting: add to `packages/context/src/project/index.ts`:

```typescript
export type { KtxConnectionConfig } from './driver-schemas.js';
```

- [ ] **Step 7: Final commit if any docs / index changes were made**

```bash
git status --short
# If only docs/index were touched in step 6:
git add packages/context/src/project/index.ts
git commit -m "chore(context): re-export KtxConnectionConfig from project package"
```

---

## Self-Review

**1. Spec coverage:** Original request was "I need to be able to see full schema" with chosen approach option 1 (discriminated union). Task 5 step 2 verifies that `ktx dev schema | rg -i mapping` now returns hits. Task 6 step 2 is the explicit end-to-end check. All catalogued drivers (warehouse + metabase + looker + lookml + notion + dbt + metricflow) have a schema and a test. ✅

**2. Placeholder scan:** No "TBD", "add validation", "similar to Task N", or skipped code. Every step has the actual code or command. ✅

**3. Type consistency:**
- `connectionConfigSchema` is defined in Task 2 and extended (not renamed) in Tasks 3–4. ✅
- `KtxConnectionConfig` (new type) appears only in `driver-schemas.ts` and the optional re-export in Task 6. `KtxProjectConnectionConfig` (existing type at `config.ts:272`) keeps its name. ✅
- `metabaseMappingsSchema`, `lookerMappingsSchema`, `lookmlMappingsSchema` — Task 1 exports them; Task 3 imports them by the same names. ✅
- `metabaseMappingsStrictSchema` is defined and used in Task 3 only. ✅
- The `warehouseDrivers` array and `warehouseConnectionSchema` helper are introduced in Task 2 and reused unchanged in Task 4's union extension. ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-connection-driver-discriminated-union.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
