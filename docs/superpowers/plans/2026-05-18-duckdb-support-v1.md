# DuckDB Support V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class local DuckDB file support for config loading, connection tests, scan/ingest, `ktx sql`, MCP SQL execution, and `ktx sl query --execute`.

**Architecture:** Keep native DuckDB ownership inside a new `@ktx/connector-duckdb` package. `@ktx/context` recognizes `duckdb` and exposes a DuckDB query-executor slot, while `@ktx/cli` dynamically wires the connector into setup, scan, ingest, SQL, MCP, and semantic-layer execution.

**Tech Stack:** TypeScript ESM, Vitest, `@duckdb/node-api`, KTX connector interfaces, sqlglot-backed Python semantic layer and SQL analysis tests, Fumadocs MDX.

---

## Audit Snapshot

No DuckDB-specific implementation plan exists under `docs/superpowers/plans/` as of this audit. The checked-in spec exists at `docs/superpowers/specs/2026-05-18-duckdb-support-design.md`.

Implemented pieces found in the live tree:

- `packages/context/src/mcp/local-project-ports.ts`, `packages/context/src/sl/local-query.ts`, and `packages/context/src/sl/semantic-layer.service.ts` already map `DUCKDB` connection types to sqlglot dialect `duckdb`.
- `python/ktx-sl/tests/test_generator.py` has a basic `test_dialect_duckdb`, but it only asserts that SQL was produced.
- `docs/spider2-dbt-benchmark.md` documents that DuckDB support is currently a connector gap.

V1-blocking gaps this plan closes:

- `driver: duckdb` is still rejected by config parsing.
- There is no `packages/connector-duckdb` package and no native DuckDB file opener.
- CLI scan connector creation, live database ingest, connection tests, setup, status, `ktx sql`, MCP SQL execution, and `ktx sl query --execute` do not have a working DuckDB runtime path.
- Context driver sets, dialect sets, local warehouse descriptors, connection types, and local query execution dispatch do not recognize DuckDB end-to-end.
- Public package/artifact scripts and docs do not ship or document DuckDB.
- Native binary/platform guidance for `@duckdb/node-api` is absent.
- Python SQL-analysis and semantic-layer tests do not prove DuckDB parse/read-only behavior.

Non-blocking gaps left out of this v1 plan:

- DuckDB query-history ingestion.
- In-memory DuckDB connections.
- DuckDB table functions such as `read_parquet()` and `read_csv()` as primary KTX warehouse tables.
- Looker warehouse mapping changes for DuckDB.
- Broadening table-identifier parsing for DuckDB external-tool SQL.

## File Structure

Create:

- `packages/connector-duckdb/package.json` - workspace package metadata and native dependency.
- `packages/connector-duckdb/tsconfig.json` - TypeScript build config.
- `packages/connector-duckdb/src/index.ts` - public exports.
- `packages/connector-duckdb/src/platform.ts` - supported platform/libc detection and user-facing messages.
- `packages/connector-duckdb/src/native.ts` - lazy `@duckdb/node-api` loader.
- `packages/connector-duckdb/src/dialect.ts` - identifier quoting and DuckDB SQL snippets.
- `packages/connector-duckdb/src/connector.ts` - config/path resolution, pre-open file safety checks, schema introspection, sampling, and read-only SQL execution.
- `packages/connector-duckdb/src/live-database-introspection.ts` - KTX live database adapter bridge.
- `packages/connector-duckdb/src/connector.test.ts` - generated DuckDB fixture tests.
- `packages/connector-duckdb/src/platform.test.ts` - unsupported-platform and missing-binary tests.

Modify:

- `packages/context/src/project/driver-schemas.ts` and tests - accept `driver: duckdb`.
- `packages/context/src/scan/types.ts`, `packages/context/src/scan/local-scan.ts`, and tests - include DuckDB in scan drivers.
- `packages/context/src/connections/connection-type.ts`, `dialects.ts`, `local-warehouse-descriptor.ts`, `local-query-executor.ts`, and tests - add `DUCKDB`, dialect mapping, and executor dispatch.
- `packages/context/src/mcp/local-project-ports.test.ts` and `packages/context/src/sl/local-query.test.ts` if present - assert DuckDB dialect and connection-list behavior.
- `packages/cli/package.json`, `packages/cli/src/local-scan-connectors.ts`, `local-adapters.ts`, `connection.ts`, `sql.ts`, `ingest-query-executor.ts`, `sl.ts`, `setup-databases.ts`, `commands/setup-commands.ts`, `ingest-depth.ts`, `status-project.ts`, and focused tests - wire CLI behavior.
- `scripts/build-public-npm-package.mjs`, `scripts/package-artifacts.mjs`, and script tests - bundle the new connector.
- `README.md`, `docs-site/content/docs/integrations/primary-sources.mdx`, `docs-site/content/docs/cli-reference/ktx-setup.mdx`, `docs-site/content/docs/cli-reference/ktx-connection.mdx`, `docs-site/content/docs/cli-reference/ktx-sql.mdx`, and `docs-site/content/docs/community/contributing.mdx` - document DuckDB.
- `python/ktx-sl/tests/test_generator.py` and `python/ktx-daemon/tests/test_sql_analysis.py` - prove DuckDB sqlglot parse/read-only coverage.
- `pnpm-lock.yaml` - update via `pnpm install` after adding `@duckdb/node-api`.

### Task 1: DuckDB Connector Package Skeleton, Path Safety, And Native Loader

**Files:**
- Create: `packages/connector-duckdb/package.json`
- Create: `packages/connector-duckdb/tsconfig.json`
- Create: `packages/connector-duckdb/src/index.ts`
- Create: `packages/connector-duckdb/src/platform.ts`
- Create: `packages/connector-duckdb/src/native.ts`
- Create: `packages/connector-duckdb/src/connector.ts`
- Create: `packages/connector-duckdb/src/platform.test.ts`
- Create: `packages/connector-duckdb/src/connector.test.ts`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add failing package and path/native tests**

Create `packages/connector-duckdb/src/platform.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertSupportedDuckDbPlatform, formatDuckDbNativeLoadError } from './platform.js';

describe('DuckDB native platform guard', () => {
  it('rejects Linux musl before native loading', () => {
    expect(() =>
      assertSupportedDuckDbPlatform({ platform: 'linux', arch: 'x64', libc: 'musl' }),
    ).toThrow('DuckDB native bindings are not supported on linux x64 musl');
  });

  it('accepts macOS arm64', () => {
    expect(() =>
      assertSupportedDuckDbPlatform({ platform: 'darwin', arch: 'arm64', libc: 'unknown' }),
    ).not.toThrow();
  });

  it('formats missing optional binary errors with platform details', () => {
    const error = formatDuckDbNativeLoadError(
      new Error("Cannot find module '@duckdb/node-bindings-darwin-arm64'"),
      { platform: 'darwin', arch: 'arm64', libc: 'unknown' },
    );
    expect(error.message).toContain('@duckdb/node-api native bindings could not be loaded');
    expect(error.message).toContain('darwin arm64');
  });
});
```

Create the first tests in `packages/connector-duckdb/src/connector.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  duckDbDatabasePathFromConfig,
  isKtxDuckDbConnectionConfig,
  KtxDuckDbScanConnector,
} from './connector.js';

describe('DuckDB connection config and path resolution', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-duckdb-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.KTX_DUCKDB_FIXTURE;
  });

  it('recognizes duckdb configs', () => {
    expect(isKtxDuckDbConnectionConfig({ driver: 'duckdb', path: 'warehouse.duckdb' })).toBe(true);
    expect(isKtxDuckDbConnectionConfig({ driver: 'sqlite', path: 'warehouse.duckdb' })).toBe(false);
  });

  it('resolves project-relative path, env refs, file refs, and file URLs', async () => {
    const dbPath = join(tempDir, 'warehouse.duckdb');
    const pathRefFile = join(tempDir, 'warehouse-path.txt');
    await writeFile(dbPath, '', 'utf-8');
    await writeFile(pathRefFile, dbPath, 'utf-8');
    process.env.KTX_DUCKDB_FIXTURE = dbPath;

    expect(
      duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', path: 'warehouse.duckdb' },
      }),
    ).toBe(resolve(tempDir, 'warehouse.duckdb'));
    expect(
      duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', path: 'env:KTX_DUCKDB_FIXTURE' },
      }),
    ).toBe(dbPath);
    expect(
      duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', path: `file:${pathRefFile}` },
      }),
    ).toBe(dbPath);
    expect(
      duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', url: pathToFileURL(dbPath).href },
      }),
    ).toBe(dbPath);
  });

  it('rejects in-memory, missing, and directory targets before opening DuckDB', async () => {
    await mkdir(join(tempDir, 'directory.duckdb'));
    expect(() =>
      new KtxDuckDbScanConnector({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', path: ':memory:' },
      }),
    ).toThrow('DuckDB in-memory connections are not supported');

    const missing = join(tempDir, 'missing.duckdb');
    const missingConnector = new KtxDuckDbScanConnector({
      connectionId: 'warehouse',
      projectDir: tempDir,
      connection: { driver: 'duckdb', path: missing },
    });
    await expect(missingConnector.testConnection()).resolves.toEqual({
      success: false,
      error: `File not found: ${missing}`,
    });
    await expect(stat(missing)).rejects.toThrow();

    const directory = join(tempDir, 'directory.duckdb');
    const directoryConnector = new KtxDuckDbScanConnector({
      connectionId: 'warehouse',
      projectDir: tempDir,
      connection: { driver: 'duckdb', path: directory },
    });
    await expect(directoryConnector.testConnection()).resolves.toEqual({
      success: false,
      error: `Expected a DuckDB database file, got directory: ${directory}`,
    });

    await expect(readFile(directory)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify the package does not exist yet**

Run:

```bash
pnpm --filter @ktx/connector-duckdb run test
```

Expected: FAIL with a pnpm filter/package-not-found error or TypeScript import errors for the new files.

- [ ] **Step 3: Create package metadata and install dependency**

Create `packages/connector-duckdb/package.json`:

```json
{
  "name": "@ktx/connector-duckdb",
  "version": "0.0.0-private",
  "description": "DuckDB connector package for KTX scan interfaces",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.0.0"
  },
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "type-check": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@duckdb/node-api": "^1.4.2",
    "@ktx/context": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^25.7.0",
    "@vitest/coverage-v8": "^4.1.6",
    "typescript": "^6.0.3",
    "vitest": "^4.1.6"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/kaelio/ktx.git",
    "directory": "packages/connector-duckdb"
  },
  "bugs": {
    "url": "https://github.com/kaelio/ktx/issues"
  },
  "homepage": "https://github.com/kaelio/ktx#readme"
}
```

Create `packages/connector-duckdb/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

Run:

```bash
pnpm install
```

Expected: `pnpm-lock.yaml` changes and `@duckdb/node-api` resolves.

- [ ] **Step 4: Implement platform and native loading helpers**

Create `packages/connector-duckdb/src/platform.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type DuckDbLibc = 'glibc' | 'musl' | 'unknown';

export interface DuckDbPlatformInfo {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  libc: DuckDbLibc;
}

export function detectDuckDbLibc(): DuckDbLibc {
  const report = process.report?.getReport?.();
  const header = report?.header as { glibcVersionRuntime?: string } | undefined;
  if (header?.glibcVersionRuntime) return 'glibc';
  if (process.platform === 'linux') {
    const muslLoaderHints = [
      '/lib/ld-musl-x86_64.so.1',
      '/lib/ld-musl-aarch64.so.1',
      join('/usr', 'bin', 'ldd'),
    ];
    if (muslLoaderHints.some((path) => existsSync(path) && path.includes('musl'))) return 'musl';
  }
  return 'unknown';
}

export function currentDuckDbPlatform(): DuckDbPlatformInfo {
  return { platform: process.platform, arch: process.arch, libc: detectDuckDbLibc() };
}

export function assertSupportedDuckDbPlatform(info: DuckDbPlatformInfo = currentDuckDbPlatform()): void {
  const supported =
    (info.platform === 'darwin' && (info.arch === 'arm64' || info.arch === 'x64')) ||
    (info.platform === 'win32' && (info.arch === 'arm64' || info.arch === 'x64')) ||
    (info.platform === 'linux' && (info.arch === 'arm64' || info.arch === 'x64') && info.libc !== 'musl');
  if (!supported) {
    throw new Error(
      `DuckDB native bindings are not supported on ${info.platform} ${info.arch} ${info.libc}. ` +
        'KTX DuckDB v1 supports macOS arm64/x64, Windows arm64/x64, and Linux glibc arm64/x64.',
    );
  }
}

export function formatDuckDbNativeLoadError(error: unknown, info = currentDuckDbPlatform()): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `@duckdb/node-api native bindings could not be loaded for ${info.platform} ${info.arch} ${info.libc}. ` +
      `Install optional dependencies for @duckdb/node-api or use a supported platform. ${detail}`,
  );
}
```

Create `packages/connector-duckdb/src/native.ts`:

```ts
import { assertSupportedDuckDbPlatform, formatDuckDbNativeLoadError } from './platform.js';

export type DuckDbNodeApi = typeof import('@duckdb/node-api');

export interface DuckDbNativeLoader {
  load(): Promise<DuckDbNodeApi>;
}

export async function loadDuckDbNodeApi(): Promise<DuckDbNodeApi> {
  assertSupportedDuckDbPlatform();
  try {
    return await import('@duckdb/node-api');
  } catch (error) {
    throw formatDuckDbNativeLoadError(error);
  }
}
```

- [ ] **Step 5: Implement config recognition, path resolution, pre-open checks, and minimal connection test**

Create `packages/connector-duckdb/src/connector.ts` with these initial exports:

```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKtxConnectorCapabilities, type KtxScanConnector } from '@ktx/context/scan';
import { loadDuckDbNodeApi, type DuckDbNativeLoader } from './native.js';

export interface KtxDuckDbConnectionConfig {
  driver?: string;
  path?: string;
  url?: string;
  [key: string]: unknown;
}

export interface DuckDbDatabasePathInput {
  connectionId: string;
  projectDir?: string;
  connection: KtxDuckDbConnectionConfig | undefined;
}

export interface KtxDuckDbScanConnectorOptions extends DuckDbDatabasePathInput {
  now?: () => Date;
  nativeLoader?: DuckDbNativeLoader;
}

function resolveTilde(path: string): string {
  return path.startsWith('~') ? resolve(homedir(), path.slice(1)) : path;
}

function resolveStringReference(key: 'path' | 'url', value: string): string {
  if (value === ':memory:') {
    throw new Error('DuckDB in-memory connections are not supported');
  }
  if (value.startsWith('env:')) {
    return process.env[value.slice('env:'.length)] ?? '';
  }
  if (key === 'path' && value.startsWith('file:')) {
    return readFileSync(resolveTilde(value.slice('file:'.length)), 'utf-8').trim();
  }
  return value;
}

function duckDbPathFromUrl(url: string): string {
  if (url === ':memory:') {
    throw new Error('DuckDB in-memory connections are not supported');
  }
  if (url.startsWith('file:')) {
    return fileURLToPath(url);
  }
  return url;
}

function stringConfigValue(
  connection: KtxDuckDbConnectionConfig | undefined,
  key: 'path' | 'url',
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(key, value.trim()) : undefined;
}

export function isKtxDuckDbConnectionConfig(
  connection: KtxDuckDbConnectionConfig | undefined,
): connection is KtxDuckDbConnectionConfig {
  return String(connection?.driver ?? '').toLowerCase() === 'duckdb';
}

export function duckDbDatabasePathFromConfig(input: DuckDbDatabasePathInput): string {
  if (!isKtxDuckDbConnectionConfig(input.connection)) {
    throw new Error(`Native DuckDB connector cannot run driver "${input.connection?.driver ?? 'unknown'}"`);
  }
  const configuredPath =
    stringConfigValue(input.connection, 'path') ?? duckDbPathFromUrl(stringConfigValue(input.connection, 'url') ?? '');
  if (!configuredPath) {
    throw new Error(`connections.${input.connectionId}.path or url is required`);
  }
  if (configuredPath === ':memory:') {
    throw new Error('DuckDB in-memory connections are not supported');
  }
  return isAbsolute(configuredPath) ? configuredPath : resolve(input.projectDir ?? process.cwd(), configuredPath);
}

export function assertDuckDbDatabaseFile(dbPath: string): void {
  if (!existsSync(dbPath)) {
    throw new Error(`File not found: ${dbPath}`);
  }
  const stats = statSync(dbPath);
  if (stats.isDirectory()) {
    throw new Error(`Expected a DuckDB database file, got directory: ${dbPath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Expected a DuckDB database file, got non-file path: ${dbPath}`);
  }
}

export class KtxDuckDbScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'duckdb' as const;
  readonly capabilities = createKtxConnectorCapabilities({
    tableSampling: true,
    columnSampling: true,
    columnStats: false,
    readOnlySql: true,
    nestedAnalysis: false,
    formalForeignKeys: true,
    estimatedRowCounts: true,
  });

  private readonly connectionId: string;
  private readonly dbPath: string;
  private readonly nativeLoader: DuckDbNativeLoader;

  constructor(options: KtxDuckDbScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.dbPath = duckDbDatabasePathFromConfig(options);
    this.nativeLoader = options.nativeLoader ?? { load: loadDuckDbNodeApi };
    this.id = `duckdb:${options.connectionId}`;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      assertDuckDbDatabaseFile(this.dbPath);
      const { DuckDBInstance } = await this.nativeLoader.load();
      const instance = await DuckDBInstance.create(this.dbPath, { access_mode: 'READ_ONLY' });
      const connection = await instance.connect();
      try {
        await connection.runAndReadAll('SELECT 1');
        return { success: true };
      } finally {
        connection.disconnectSync();
        instance.closeSync();
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async introspect(): Promise<never> {
    throw new Error('DuckDB schema introspection is implemented in Task 2.');
  }

  async cleanup(): Promise<void> {}
}
```

Create `packages/connector-duckdb/src/index.ts`:

```ts
export {
  assertDuckDbDatabaseFile,
  duckDbDatabasePathFromConfig,
  isKtxDuckDbConnectionConfig,
  KtxDuckDbScanConnector,
  type DuckDbDatabasePathInput,
  type KtxDuckDbConnectionConfig,
  type KtxDuckDbScanConnectorOptions,
} from './connector.js';
export {
  assertSupportedDuckDbPlatform,
  currentDuckDbPlatform,
  detectDuckDbLibc,
  formatDuckDbNativeLoadError,
  type DuckDbPlatformInfo,
} from './platform.js';
```

- [ ] **Step 6: Run focused connector tests**

Run:

```bash
pnpm --filter @ktx/connector-duckdb run test
pnpm --filter @ktx/connector-duckdb run type-check
```

Expected: tests that do not require a real DuckDB file pass; type-check passes.

- [ ] **Step 7: Commit**

```bash
git add packages/connector-duckdb package.json pnpm-lock.yaml
git commit -m "feat: add duckdb connector package foundation"
```

### Task 2: DuckDB Introspection, Sampling, And Read-Only SQL

**Files:**
- Modify: `packages/connector-duckdb/src/dialect.ts`
- Modify: `packages/connector-duckdb/src/connector.ts`
- Modify: `packages/connector-duckdb/src/live-database-introspection.ts`
- Modify: `packages/connector-duckdb/src/index.ts`
- Modify: `packages/connector-duckdb/src/connector.test.ts`

- [ ] **Step 1: Extend connector tests with a generated DuckDB fixture**

Append to `packages/connector-duckdb/src/connector.test.ts`:

```ts
async function createDuckDbFixture(dbPath: string): Promise<void> {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  try {
    await connection.run(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY,
        segment VARCHAR NOT NULL
      )
    `);
    await connection.run(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id),
        amount DOUBLE,
        status VARCHAR
      )
    `);
    await connection.run(`CREATE VIEW paid_orders AS SELECT id, customer_id, amount FROM orders WHERE status = 'paid'`);
    await connection.run(`INSERT INTO customers VALUES (1, 'enterprise'), (2, 'self-serve')`);
    await connection.run(`INSERT INTO orders VALUES (10, 1, 25.5, 'paid'), (11, 1, 5.0, 'open'), (12, 2, NULL, 'paid')`);
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

describe('KtxDuckDbScanConnector runtime behavior', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-duckdb-runtime-'));
    dbPath = join(tempDir, 'warehouse.duckdb');
    await createDuckDbFixture(dbPath);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function connector() {
    return new KtxDuckDbScanConnector({
      connectionId: 'warehouse',
      projectDir: tempDir,
      connection: { driver: 'duckdb', path: 'warehouse.duckdb' },
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    });
  }

  it('tests the connection without mutating the database', async () => {
    const c = connector();
    await expect(c.testConnection()).resolves.toEqual({ success: true });
    await c.cleanup();
  });

  it('introspects tables, views, primary keys, foreign keys, and row counts', async () => {
    const c = connector();
    const snapshot = await c.introspect({ connectionId: 'warehouse', driver: 'duckdb' }, { runId: 'test' });
    await c.cleanup();

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'duckdb',
      extractedAt: '2026-05-18T12:00:00.000Z',
      metadata: { table_count: 3 },
    });
    const orders = snapshot.tables.find((table) => table.name === 'orders');
    expect(orders?.kind).toBe('table');
    expect(orders?.estimatedRows).toBe(3);
    expect(orders?.columns.find((column) => column.name === 'id')?.primaryKey).toBe(true);
    expect(orders?.foreignKeys).toContainEqual(
      expect.objectContaining({
        fromColumn: 'customer_id',
        toTable: 'customers',
        toColumn: 'id',
      }),
    );
    expect(snapshot.tables.find((table) => table.name === 'paid_orders')?.kind).toBe('view');
  });

  it('samples tables, samples columns, returns distinct values, and counts rows', async () => {
    const c = connector();
    await expect(
      c.sampleTable?.(
        { connectionId: 'warehouse', table: { catalog: null, db: 'main', name: 'orders' }, columns: ['id', 'status'], limit: 2 },
        { runId: 'test' },
      ),
    ).resolves.toMatchObject({ headers: ['id', 'status'], totalRows: 2 });
    await expect(
      c.sampleColumn?.(
        { connectionId: 'warehouse', table: { catalog: null, db: 'main', name: 'orders' }, column: 'status', limit: 2 },
        { runId: 'test' },
      ),
    ).resolves.toMatchObject({ values: ['paid', 'open'] });
    await expect(c.getColumnDistinctValues({ catalog: null, db: 'main', name: 'orders' }, 'status', {
      maxCardinality: 10,
      limit: 10,
    })).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });
    await expect(c.getTableRowCount('orders')).resolves.toBe(3);
    await c.cleanup();
  });

  it('executes read-only SQL and rejects mutating SQL before execution', async () => {
    const c = connector();
    await expect(
      c.executeReadOnly?.({ connectionId: 'warehouse', sql: 'select id from orders order by id', maxRows: 2 }, { runId: 'test' }),
    ).resolves.toMatchObject({ headers: ['id'], rows: [[10], [11]], rowCount: 2 });
    await expect(
      c.executeReadOnly?.({ connectionId: 'warehouse', sql: 'create table created_by_test(id int)' }, { runId: 'test' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally.');
    await c.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify runtime methods are missing**

Run:

```bash
pnpm --filter @ktx/connector-duckdb run test
```

Expected: FAIL for `introspect`, `sampleTable`, `sampleColumn`, `getColumnDistinctValues`, `getTableRowCount`, or `executeReadOnly`.

- [ ] **Step 3: Add DuckDB dialect helper**

Create `packages/connector-duckdb/src/dialect.ts`:

```ts
import type { KtxSchemaDimensionType, KtxTableRef } from '@ktx/context/scan';

export class KtxDuckDbDialect {
  readonly type = 'duckdb';

  quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  formatTableName(table: Pick<KtxTableRef, 'catalog' | 'db' | 'name'>): string {
    return [table.catalog, table.db, table.name].filter((part): part is string => !!part).map((part) => this.quoteIdentifier(part)).join('.');
  }

  mapDataType(nativeType: string): string {
    return nativeType;
  }

  mapToDimensionType(nativeType: string): KtxSchemaDimensionType {
    const normalized = nativeType.toUpperCase().trim();
    if (normalized.includes('DATE') || normalized.includes('TIME')) return 'time';
    if (
      normalized.includes('INT') ||
      normalized.includes('DECIMAL') ||
      normalized.includes('DOUBLE') ||
      normalized.includes('FLOAT') ||
      normalized.includes('NUMERIC') ||
      normalized.includes('REAL')
    ) {
      return 'number';
    }
    if (normalized.includes('BOOL')) return 'boolean';
    return 'string';
  }

  generateSampleQuery(tableName: string, limit: number, columns?: string[]): string {
    const columnList =
      columns && columns.length > 0 ? columns.map((column) => this.quoteIdentifier(column)).join(', ') : '*';
    return `SELECT ${columnList} FROM ${tableName} LIMIT ${limit}`;
  }

  generateColumnSampleQuery(tableName: string, columnName: string, limit: number): string {
    const quoted = this.quoteIdentifier(columnName);
    return `SELECT ${quoted} FROM ${tableName} WHERE ${quoted} IS NOT NULL AND TRIM(CAST(${quoted} AS VARCHAR)) != '' LIMIT ${limit}`;
  }

  generateCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    return `
      WITH sampled AS (
        SELECT ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        LIMIT ${sampleSize}
      )
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM sampled
    `;
  }

  generateDistinctValuesQuery(tableName: string, columnName: string, limit: number): string {
    return `
      SELECT DISTINCT CAST(${columnName} AS VARCHAR) AS val
      FROM ${tableName}
      WHERE ${columnName} IS NOT NULL
      ORDER BY val
      LIMIT ${limit}
    `;
  }
}
```

- [ ] **Step 4: Implement runtime connector methods**

In `packages/connector-duckdb/src/connector.ts`, replace the initial throwing `introspect()` and no-op `cleanup()` with methods that use one cached read-only connection. The query SQL must use these exact metadata sources:

```ts
const TABLES_SQL = `
  SELECT table_catalog AS catalog, table_schema AS db, table_name AS name, table_type AS type
  FROM information_schema.tables
  WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
  ORDER BY table_schema, table_name
`;

const COLUMNS_SQL = `
  SELECT table_catalog AS catalog, table_schema AS db, table_name, column_name, data_type, is_nullable, ordinal_position
  FROM information_schema.columns
  WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
  ORDER BY table_schema, table_name, ordinal_position
`;

const CONSTRAINTS_SQL = `
  SELECT database_name, schema_name, table_name, constraint_type, constraint_name,
         constraint_column_names, referenced_table, referenced_column_names
  FROM duckdb_constraints()
  WHERE constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
`;
```

Use `assertDuckDbDatabaseFile(this.dbPath)` immediately before `DuckDBInstance.create(this.dbPath, { access_mode: 'READ_ONLY' })`. Use `assertReadOnlySql()` and `limitSqlForExecution()` before every user SQL execution:

```ts
async executeReadOnly(input: KtxDuckDbReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
  this.assertConnection(input.connectionId);
  const result = await this.query(limitSqlForExecution(input.sql, input.maxRows));
  return { ...result, rowCount: result.rows.length };
}
```

Map foreign keys by pairing `constraint_column_names[index]` with `referenced_column_names[index]`. Only keep a DuckDB foreign key row when both source and referenced column names are present.

- [ ] **Step 5: Add live database introspection bridge and query executor export**

Create `packages/connector-duckdb/src/live-database-introspection.ts`:

```ts
import type { LiveDatabaseIntrospectionPort } from '@ktx/context/ingest';
import type { KtxProjectConnectionConfig } from '@ktx/context/project';
import { KtxDuckDbScanConnector, type KtxDuckDbConnectionConfig } from './connector.js';

export interface CreateDuckDbLiveDatabaseIntrospectionOptions {
  projectDir?: string;
  connections: Record<string, KtxProjectConnectionConfig>;
  now?: () => Date;
}

export function createDuckDbLiveDatabaseIntrospection(
  options: CreateDuckDbLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string) {
      const connection = options.connections[connectionId] as KtxDuckDbConnectionConfig | undefined;
      const connector = new KtxDuckDbScanConnector({
        connectionId,
        connection,
        projectDir: options.projectDir,
        now: options.now,
      });
      try {
        return await connector.introspect({ connectionId, driver: 'duckdb' }, { runId: `duckdb-${connectionId}` });
      } finally {
        await connector.cleanup();
      }
    },
  };
}
```

Add `createDuckDbQueryExecutor()` to `connector.ts`:

```ts
export function createDuckDbQueryExecutor(): KtxSqlQueryExecutorPort {
  return {
    async execute(input: KtxSqlQueryExecutionInput): Promise<KtxSqlQueryExecutionResult> {
      const connector = new KtxDuckDbScanConnector({
        connectionId: input.connectionId,
        projectDir: input.projectDir,
        connection: input.connection as KtxDuckDbConnectionConfig | undefined,
      });
      try {
        const result = await connector.executeReadOnly(
          { connectionId: input.connectionId, sql: input.sql, maxRows: input.maxRows },
          { runId: 'duckdb-query-executor' },
        );
        return {
          headers: result.headers,
          rows: result.rows,
          totalRows: result.totalRows,
          command: 'SELECT',
          rowCount: result.rowCount,
        };
      } finally {
        await connector.cleanup();
      }
    },
  };
}
```

Update `packages/connector-duckdb/src/index.ts` to export `KtxDuckDbDialect`, `createDuckDbQueryExecutor`, and `createDuckDbLiveDatabaseIntrospection`.

- [ ] **Step 6: Run focused connector verification**

Run:

```bash
pnpm --filter @ktx/connector-duckdb run test
pnpm --filter @ktx/connector-duckdb run type-check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/connector-duckdb pnpm-lock.yaml
git commit -m "feat: implement duckdb connector runtime"
```

### Task 3: Context Driver, Dialect, Descriptor, And Executor Wiring

**Files:**
- Modify: `packages/context/src/project/driver-schemas.ts`
- Modify: `packages/context/src/project/driver-schemas.test.ts`
- Modify: `packages/context/src/scan/types.ts`
- Modify: `packages/context/src/scan/local-scan.ts`
- Modify: `packages/context/src/scan/local-scan.test.ts`
- Modify: `packages/context/src/connections/connection-type.ts`
- Modify: `packages/context/src/connections/dialects.ts`
- Modify: `packages/context/src/connections/dialects.test.ts`
- Modify: `packages/context/src/connections/local-warehouse-descriptor.ts`
- Modify: `packages/context/src/connections/local-warehouse-descriptor.test.ts`
- Modify: `packages/context/src/connections/local-query-executor.ts`
- Modify: `packages/context/src/connections/local-query-executor.test.ts`
- Modify: `packages/context/src/mcp/local-project-ports.test.ts`
- Modify: `packages/context/src/sl/local-query.test.ts` if present

- [ ] **Step 1: Add failing context tests for DuckDB**

Add to `packages/context/src/project/driver-schemas.test.ts`:

```ts
it('accepts duckdb local file config', () => {
  expect(connectionConfigSchema.parse({ driver: 'duckdb', path: 'data/warehouse.duckdb' })).toMatchObject({
    driver: 'duckdb',
    path: 'data/warehouse.duckdb',
  });
});
```

Add `duckdb` to the table in `packages/context/src/connections/dialects.test.ts`:

```ts
['duckdb', '"analytics"."main"."orders"'],
```

Add to `packages/context/src/connections/local-warehouse-descriptor.test.ts`:

```ts
it('maps DuckDB configs to DUCKDB warehouse descriptors', () => {
  expect(localConnectionToWarehouseDescriptor('warehouse', { driver: 'duckdb', path: 'data/warehouse.duckdb' })).toMatchObject({
    id: 'warehouse',
    connection_type: 'DUCKDB',
    connection_params: { driver: 'duckdb', path: 'data/warehouse.duckdb' },
  });
  expect(localConnectionTypeForConfig('warehouse', { driver: 'duckdb', path: 'data/warehouse.duckdb' })).toBe('DUCKDB');
});
```

Add to `packages/context/src/connections/local-query-executor.test.ts`:

```ts
it('dispatches duckdb only when a duckdb executor slot is supplied', async () => {
  const duckdb = {
    execute: vi.fn(async () => ({
      headers: ['duckdb'],
      rows: [[3]],
      totalRows: 1,
      command: 'SELECT',
      rowCount: 1,
    })),
  };
  const executor = createDefaultLocalQueryExecutor({
    postgres: { execute: vi.fn() },
    sqlite: { execute: vi.fn() },
    duckdb,
  });

  await expect(
    executor.execute({
      connectionId: 'warehouse',
      connection: { driver: 'duckdb' },
      sql: 'select 1',
    }),
  ).resolves.toMatchObject({ headers: ['duckdb'] });
  expect(duckdb.execute).toHaveBeenCalledTimes(1);

  const missingSlot = createDefaultLocalQueryExecutor({
    postgres: { execute: vi.fn() },
    sqlite: { execute: vi.fn() },
  });
  await expect(
    missingSlot.execute({
      connectionId: 'warehouse',
      connection: { driver: 'duckdb' },
      sql: 'select 1',
    }),
  ).rejects.toThrow('No local query executor is configured for driver "duckdb".');
});
```

- [ ] **Step 2: Run tests to verify failures**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/project/driver-schemas.test.ts src/connections/dialects.test.ts src/connections/local-warehouse-descriptor.test.ts src/connections/local-query-executor.test.ts
```

Expected: FAIL for DuckDB not being recognized.

- [ ] **Step 3: Implement context wiring**

Apply these exact code changes:

- In `packages/context/src/project/driver-schemas.ts`, add `'duckdb'` to `warehouseDrivers` and `warehouseConnectionSchemas`.
- In `warehouseConnectionSchema()`, include:

```ts
path: z
  .string()
  .min(1)
  .optional()
  .describe('Local database file path for file-backed warehouse drivers such as SQLite and DuckDB.'),
```

- In `packages/context/src/scan/types.ts`, add `'duckdb'` to `KtxConnectionDriver`.
- In `packages/context/src/scan/local-scan.ts`, add `normalized === 'duckdb'` to `normalizeDriver()` and update the supported-driver error string to include `duckdb`.
- In `packages/context/src/connections/connection-type.ts`, add `'DUCKDB'` to `connectionTypeSchema`.
- In `packages/context/src/connections/local-warehouse-descriptor.ts`, add:

```ts
duckdb: 'DUCKDB',
```

to `DRIVER_TO_CONNECTION_TYPE`.

- In `packages/context/src/connections/dialects.ts`, add `'duckdb'` to `SupportedDriver`, `supportedDrivers`, and `dialects`:

```ts
duckdb: createDialect('duckdb', doubleQuoted),
```

- In `packages/context/src/connections/local-query-executor.ts`, add the optional slot and dispatch:

```ts
export interface DefaultLocalQueryExecutorOptions {
  postgres?: KtxSqlQueryExecutorPort;
  sqlite?: KtxSqlQueryExecutorPort;
  duckdb?: KtxSqlQueryExecutorPort;
}
```

```ts
if (driver === 'duckdb') {
  if (!options.duckdb) {
    throw new Error(`No local query executor is configured for driver "${input.connection?.driver ?? 'unknown'}".`);
  }
  return options.duckdb.execute(input);
}
```

- [ ] **Step 4: Run context tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/project/driver-schemas.test.ts src/connections/dialects.test.ts src/connections/local-warehouse-descriptor.test.ts src/connections/local-query-executor.test.ts src/mcp/local-project-ports.test.ts
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/context
git commit -m "feat: recognize duckdb in context drivers"
```

### Task 4: CLI Setup, Scan, Ingest, SQL, MCP, And Semantic Layer Wiring

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/src/local-scan-connectors.ts`
- Modify: `packages/cli/src/local-scan-connectors.test.ts`
- Modify: `packages/cli/src/local-adapters.ts`
- Modify: `packages/cli/src/local-adapters.test.ts`
- Modify: `packages/cli/src/connection.ts`
- Modify: `packages/cli/src/connection.test.ts`
- Modify: `packages/cli/src/sql.ts`
- Modify: `packages/cli/src/sql.test.ts`
- Modify: `packages/cli/src/sl.ts`
- Modify: `packages/cli/src/sl.test.ts`
- Modify: `packages/cli/src/setup-databases.ts`
- Modify: `packages/cli/src/setup-databases.test.ts`
- Modify: `packages/cli/src/commands/setup-commands.ts`
- Modify: `packages/cli/src/ingest-depth.ts`
- Modify: `packages/cli/src/status-project.ts`

- [ ] **Step 1: Add failing CLI tests**

Update `packages/cli/src/local-scan-connectors.test.ts` by replacing the current DuckDB rejection test with:

```ts
it('creates a native duckdb connector from standalone config', async () => {
  await initKtxProject({ projectDir: tempDir });
  await writeFile(
    join(tempDir, 'ktx.yaml'),
    [
      'connections:',
      '  warehouse:',
      '    driver: duckdb',
      '    path: warehouse.duckdb',
      '',
    ].join('\n'),
    'utf-8',
  );
  const project = await loadKtxProject({ projectDir: tempDir });

  const connector = await createKtxCliScanConnector(project, 'warehouse');

  expect(connector.id).toBe('duckdb:warehouse');
  expect(connector.driver).toBe('duckdb');
});
```

Add to `packages/cli/src/sql.test.ts`:

```ts
it('validates duckdb SQL with the duckdb analysis dialect', async () => {
  const sqlAnalysis = makeSqlAnalysis({ ok: true, error: null });
  const connector = makeConnector({
    headers: ['id'],
    rows: [[1]],
    totalRows: 1,
    rowCount: 1,
  });
  const io = makeIo();

  await expect(
    runKtxSql(
      {
        command: 'execute',
        projectDir: tempDir,
        connectionId: 'warehouse',
        sql: 'select id from orders',
        maxRows: 1000,
        cliVersion: '0.0.0-test',
      },
      io.io,
      {
        loadProject: async () => project({ warehouse: { driver: 'duckdb', path: 'warehouse.duckdb' } }),
        createSqlAnalysis: () => sqlAnalysis,
        createScanConnector: async () => connector,
      },
    ),
  ).resolves.toBe(0);
  expect(sqlAnalysis.validateReadOnly).toHaveBeenCalledWith('select id from orders', 'duckdb');
});
```

Add to `packages/cli/src/sl.test.ts`:

```ts
it('injects a duckdb-capable executor for sl query --execute', async () => {
  const queryExecutor = {
    execute: vi.fn(async () => ({
      headers: ['total'],
      rows: [[42]],
      totalRows: 1,
      command: 'SELECT',
      rowCount: 1,
    })),
  };
  const compute = {
    query: vi.fn(async () => ({
      dialect: 'duckdb',
      sql: 'select 42 as total',
      columns: [{ name: 'total' }],
      rows: [],
      totalRows: 0,
      plan: {},
    })),
  };

  await expect(
    runKtxSl(
      {
        command: 'query',
        projectDir: tempDir,
        connectionId: 'warehouse',
        query: { measures: ['sum(orders.amount)'] },
        format: 'json',
        execute: true,
        cliVersion: '0.0.0-test',
        runtimeInstallPolicy: 'never',
      },
      makeIo().io,
      {
        loadProject: async () => project({ warehouse: { driver: 'duckdb', path: 'warehouse.duckdb' } }),
        createSemanticLayerCompute: () => compute,
        createQueryExecutor: () => queryExecutor,
      },
    ),
  ).resolves.toBe(0);
  expect(queryExecutor.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: 'warehouse',
      connection: expect.objectContaining({ driver: 'duckdb' }),
      sql: 'select 42 as total',
    }),
  );
});
```

- [ ] **Step 2: Run tests to verify failures**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/local-scan-connectors.test.ts src/sql.test.ts src/sl.test.ts
```

Expected: FAIL because CLI does not import or wire `@ktx/connector-duckdb`.

- [ ] **Step 3: Add CLI connector dependency and scan factory**

In `packages/cli/package.json`, add:

```json
"@ktx/connector-duckdb": "workspace:*"
```

In `packages/cli/src/local-scan-connectors.ts`, update `SUPPORTED_DRIVERS` to include `duckdb` and add this branch before the final error:

```ts
if (driver === 'duckdb') {
  const { KtxDuckDbScanConnector, isKtxDuckDbConnectionConfig } = await import('@ktx/connector-duckdb');
  if (isKtxDuckDbConnectionConfig(connection)) {
    return new KtxDuckDbScanConnector({ connectionId, connection, projectDir: project.projectDir });
  }
}
```

- [ ] **Step 4: Add native DuckDB live database introspection before daemon fallback**

In `packages/cli/src/local-adapters.ts`, import:

```ts
import { createDuckDbLiveDatabaseIntrospection, isKtxDuckDbConnectionConfig } from '@ktx/connector-duckdb';
```

Create the adapter next to SQLite:

```ts
const duckdb = createDuckDbLiveDatabaseIntrospection({
  projectDir: project.projectDir,
  connections: project.config.connections,
});
```

Add the dispatch before Snowflake and before `return daemon.extractSchema(connectionId)`:

```ts
if (isKtxDuckDbConnectionConfig(connection)) {
  return duckdb.extractSchema(connectionId);
}
```

Add a `local-adapters.test.ts` assertion that a DuckDB connection calls the DuckDB introspection port and does not call `createDaemonLiveDatabaseIntrospection().extractSchema`.

- [ ] **Step 5: Add CLI command surface recognition**

Apply these changes:

- In `packages/cli/src/connection.ts`, add `'duckdb'` to `SUPPORTED_TEST_DRIVERS` and to the native driver branch inside `testConnectionByDriver()`.
- In `packages/cli/src/sql.ts`, add `duckdb: 'duckdb'` to `sqlAnalysisDialectForDriver()`.
- In `packages/cli/src/ingest-depth.ts`, add `'duckdb'` to `KTX_DATABASE_DRIVER_IDS`.
- In `packages/cli/src/status-project.ts`, add a `case 'duckdb'` branch:

```ts
case 'duckdb': {
  const path = (conn as Record<string, unknown>).path ?? (conn as Record<string, unknown>).url;
  if (typeof path === 'string' && path.length > 0) return ok(`path: ${path}`);
  return warn('path not set', 'Rerun `ktx setup`');
}
```

- In `packages/cli/src/sl.ts`, import the DuckDB query executor:

```ts
import { createDuckDbQueryExecutor } from '@ktx/connector-duckdb';
```

Add:

```ts
function createKtxCliSlQueryExecutor(): KtxSqlQueryExecutorPort {
  return createDefaultLocalQueryExecutor({ duckdb: createDuckDbQueryExecutor() });
}
```

Then replace:

```ts
const queryExecutor = args.execute ? (deps.createQueryExecutor ?? createDefaultLocalQueryExecutor)() : undefined;
```

with:

```ts
const queryExecutor = args.execute ? (deps.createQueryExecutor ?? createKtxCliSlQueryExecutor)() : undefined;
```

- [ ] **Step 6: Add setup support for `--database duckdb` and interactive DuckDB path prompts**

In `packages/cli/src/setup-databases.ts`:

- Add `'duckdb'` to `KtxSetupDatabaseDriver`.
- Add `{ value: 'duckdb', label: 'DuckDB' }` to `DRIVER_OPTIONS`.
- Add `duckdb: 'duckdb-local'` to `DEFAULT_CONNECTION_IDS`.
- Add this branch to `buildConnectionConfig()` directly after the SQLite branch:

```ts
if (driver === 'duckdb') {
  if (args.inputMode === 'disabled' && !args.databaseUrl) return null;
  const path =
    args.databaseUrl ??
    (await promptText(
      prompts,
      'DuckDB database file\nEnter a relative or absolute path, for example ./warehouse.duckdb.',
      stringConfigField(input.existingConnection, 'path'),
    ));
  if (path === undefined) return 'back';
  return path ? { driver: 'duckdb', path } : null;
}
```

In `packages/cli/src/commands/setup-commands.ts`, add `value === 'duckdb'` to `databaseDriver()`.

Add setup tests proving:

- `--database duckdb --database-url ./warehouse.duckdb` writes `{ driver: 'duckdb', path: './warehouse.duckdb' }`.
- Interactive DuckDB setup asks for a file path.
- `--enable-query-history --database duckdb` fails with query-history unsupported text.

- [ ] **Step 7: Run focused CLI verification**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/local-scan-connectors.test.ts src/local-adapters.test.ts src/connection.test.ts src/sql.test.ts src/sl.test.ts src/setup-databases.test.ts
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/cli packages/connector-duckdb pnpm-lock.yaml
git commit -m "feat: wire duckdb through cli runtime"
```

### Task 5: Packaging, Docs, And Python SQL Coverage

**Files:**
- Modify: `scripts/build-public-npm-package.mjs`
- Modify: `scripts/package-artifacts.mjs`
- Modify: `scripts/examples-docs.test.mjs`
- Modify: `README.md`
- Modify: `docs-site/content/docs/integrations/primary-sources.mdx`
- Modify: `docs-site/content/docs/cli-reference/ktx-setup.mdx`
- Modify: `docs-site/content/docs/cli-reference/ktx-connection.mdx`
- Modify: `docs-site/content/docs/cli-reference/ktx-sql.mdx`
- Modify: `docs-site/content/docs/community/contributing.mdx`
- Modify: `python/ktx-sl/tests/test_generator.py`
- Modify: `python/ktx-daemon/tests/test_sql_analysis.py`

- [ ] **Step 1: Add failing script/docs tests**

In `scripts/examples-docs.test.mjs`, extend the workspace package assertions:

```js
assert.match(contributing, /connector-duckdb\/\s+# DuckDB connector/);
```

Add this assertion to a new `it('lists the DuckDB connector in the root package table', ...)` test in `scripts/examples-docs.test.mjs`:

```js
assert.match(readme, /\| `packages\/connector-duckdb` \| DuckDB scan connector \|/);
```

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL because docs do not mention `connector-duckdb`.

- [ ] **Step 2: Bundle the connector in public package artifacts**

In `scripts/build-public-npm-package.mjs`, add `@ktx/connector-duckdb` to both `PUBLIC_BUNDLED_WORKSPACE_PACKAGES` and `PUBLIC_BUNDLED_WORKSPACE_PACKAGE_ROOTS`:

```js
'@ktx/connector-duckdb',
```

```js
'@ktx/connector-duckdb': 'packages/connector-duckdb',
```

In `scripts/package-artifacts.mjs`, add:

```js
{ name: '@ktx/connector-duckdb', packageRoot: 'packages/connector-duckdb' },
```

- [ ] **Step 3: Update docs with copy-pasteable DuckDB examples**

Add this table row to root `README.md` package layout:

```md
| `packages/connector-duckdb` | DuckDB scan connector |
```

Add this example to `docs-site/content/docs/integrations/primary-sources.mdx`:

````mdx
### DuckDB

```yaml
connections:
  warehouse:
    driver: duckdb
    path: data/warehouse.duckdb
```

DuckDB support is local-file only. KTX opens the configured file read-only and fails if the file is missing, points to a directory, or uses `:memory:`.
````

Add `duckdb` to `docs-site/content/docs/cli-reference/ktx-setup.mdx` where supported `--database` values are listed, and include:

```bash
ktx setup --new --database duckdb --new-database-connection-id warehouse --database-url ./data/warehouse.duckdb
```

Add this example to `docs-site/content/docs/cli-reference/ktx-sql.mdx`:

```bash
ktx sql --connection warehouse "select count(*) as rows from orders"
```

Add this note to `docs-site/content/docs/cli-reference/ktx-connection.mdx`:

```mdx
DuckDB connection tests open the configured file read-only. Missing files are reported as `File not found: <path>` and are not created.
```

Add `connector-duckdb/   # DuckDB connector` to the package tree in `docs-site/content/docs/community/contributing.mdx`.

- [ ] **Step 4: Strengthen Python DuckDB SQL tests**

In `python/ktx-sl/tests/test_generator.py`, update `test_dialect_duckdb`:

```py
def test_dialect_duckdb(self):
    import sqlglot

    engine = SemanticEngine(SOURCES_DIR, dialect="duckdb")
    result = engine.query(
        {
            "measures": ["sum(orders.amount)"],
            "dimensions": ["orders.status"],
        }
    )
    assert result.dialect == "duckdb"
    assert result.sql
    sqlglot.parse_one(result.sql, read="duckdb")
```

In `python/ktx-daemon/tests/test_sql_analysis.py`, add:

```py
def test_validate_read_only_sql_accepts_duckdb_select() -> None:
    response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(
            dialect="duckdb",
            sql="select * from read_csv_auto('orders.csv') limit 10",
        )
    )

    assert response.ok is True
    assert response.error is None


def test_validate_read_only_sql_rejects_duckdb_mutation() -> None:
    response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(
            dialect="duckdb",
            sql="create table copied as select 1",
        )
    )

    assert response.ok is False
    assert response.error
```

- [ ] **Step 5: Run docs/script/Python verification**

Run:

```bash
node --test scripts/build-public-npm-package.test.mjs scripts/package-artifacts.test.mjs scripts/examples-docs.test.mjs
```

Expected: PASS.

If `.venv` exists, run:

```bash
source .venv/bin/activate
uv run pytest python/ktx-sl/tests/test_generator.py python/ktx-daemon/tests/test_sql_analysis.py -q
uv run pre-commit run --files python/ktx-sl/tests/test_generator.py python/ktx-daemon/tests/test_sql_analysis.py
```

Expected: PASS. If `uv run` reports `Required uv version ... does not match the running version ...`, do not edit `pyproject.toml`; record the version mismatch and run the TypeScript verification plus any Python tests available through the activated `.venv`.

- [ ] **Step 6: Commit**

```bash
git add scripts README.md docs-site/content/docs python/ktx-sl/tests/test_generator.py python/ktx-daemon/tests/test_sql_analysis.py
git commit -m "docs: document duckdb support"
```

### Task 6: End-To-End Verification And Cleanup

**Files:**
- Modify only files needed to fix failures found by verification.

- [ ] **Step 1: Run full DuckDB v1 verification**

Run:

```bash
pnpm --filter @ktx/connector-duckdb run test
pnpm --filter @ktx/context run test
pnpm --filter @ktx/cli run test
pnpm --filter @ktx/cli run test:slow
pnpm --filter './packages/*' run type-check
pnpm run dead-code
node --test scripts/build-public-npm-package.test.mjs scripts/package-artifacts.test.mjs scripts/examples-docs.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run Python checks when the local uv version is compatible**

Run:

```bash
source .venv/bin/activate
uv run pytest python/ktx-sl/tests python/ktx-daemon/tests/test_sql_analysis.py -q
uv run pre-commit run --files python/ktx-sl/tests/test_generator.py python/ktx-daemon/tests/test_sql_analysis.py
```

Expected: PASS, or a reported `uv` version mismatch without project-file changes.

- [ ] **Step 3: Run a local smoke with a generated DuckDB file**

Run:

```bash
TMP_PROJECT="$(mktemp -d)"
node -e "import('@duckdb/node-api').then(async ({ DuckDBInstance }) => { const db = process.argv[1]; const i = await DuckDBInstance.create(db); const c = await i.connect(); await c.run('create table orders(id integer, amount double)'); await c.run('insert into orders values (1, 10.5), (2, 20.5)'); c.disconnectSync(); i.closeSync(); })" "$TMP_PROJECT/warehouse.duckdb"
pnpm run ktx -- --project-dir "$TMP_PROJECT" setup --new --no-input --skip-agents --skip-llm --skip-embeddings --database duckdb --new-database-connection-id warehouse --database-url "$TMP_PROJECT/warehouse.duckdb" --skip-sources
pnpm run ktx -- --project-dir "$TMP_PROJECT" connection test warehouse
pnpm run ktx -- --project-dir "$TMP_PROJECT" ingest warehouse --fast
pnpm run ktx -- --project-dir "$TMP_PROJECT" sql --connection warehouse "select count(*) as rows from orders" --plain
```

Expected:

- Connection test prints `Connection test passed: warehouse`.
- Ingest completes without daemon database-introspection fallback errors.
- SQL output contains a `rows` header and value `2`.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status --short
git diff --check
```

Expected: no whitespace errors; only DuckDB support files are modified.

- [ ] **Step 5: Commit final fixes**

```bash
git add packages/connector-duckdb packages/context packages/cli scripts README.md docs-site/content/docs python/ktx-sl/tests/test_generator.py python/ktx-daemon/tests/test_sql_analysis.py pnpm-lock.yaml
git commit -m "test: verify duckdb v1 support"
```
