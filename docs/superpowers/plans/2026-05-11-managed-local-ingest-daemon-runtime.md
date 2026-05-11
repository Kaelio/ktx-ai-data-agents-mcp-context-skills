# Managed Local Ingest Daemon Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local ingest, scan, and MCP daemon-backed helper paths use the
KTX-managed core Python daemon instead of requiring `KTX_DAEMON_URL` or a
manually started daemon on `127.0.0.1:8765`.

**Architecture:** Add lazy managed-daemon HTTP ports in the CLI package. Thread
those ports through CLI local ingest adapter creation and pull-config options so
Looker table identifier parsing, historic SQL analysis, and live-database daemon
fallbacks resolve the managed core daemon only when a request is made.

**Tech Stack:** TypeScript, Vitest, Commander, KTX CLI managed Python runtime,
KTX context local ingest adapters, MCP local project ports.

---

## Existing status

This plan is based on
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.

The following plans are based on that spec and are already implemented in this
worktree:

- `docs/superpowers/plans/2026-05-11-bundled-python-runtime-wheel.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-installer.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-command-integration.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-daemon-lifecycle.md`
- `docs/superpowers/plans/2026-05-11-managed-local-embeddings-runtime.md`
- `docs/superpowers/plans/2026-05-11-public-kaelio-ktx-npm-package.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-release-smoke.md`
- `docs/superpowers/plans/2026-05-11-managed-local-embeddings-release-smoke.md`
- `docs/superpowers/plans/2026-05-11-managed-agent-mcp-semantic-runtime.md`

Implementation evidence found before writing this plan includes:

- `scripts/build-python-runtime-wheel.mjs` and
  `packages/cli/assets/python/manifest.json`.
- `packages/cli/src/managed-python-runtime.ts`,
  `packages/cli/src/runtime.ts`, and
  `packages/cli/src/commands/runtime-commands.ts`.
- `packages/cli/src/managed-python-command.ts` and managed `ktx sl query`,
  hidden agent SL query, and MCP semantic compute paths.
- `packages/cli/src/managed-python-daemon.ts` and `ktx runtime start` /
  `ktx runtime stop`.
- `packages/cli/src/managed-local-embeddings.ts` and local embeddings setup
  wiring.
- `scripts/build-public-npm-package.mjs`, release policy updates, release
  smoke coverage, and opt-in local embeddings smoke coverage.
- `packages/cli/src/agent-runtime.ts` and `packages/cli/src/serve.ts` now
  create managed semantic-layer compute when no explicit semantic HTTP URL is
  provided.

The remaining spec gap is local ingest daemon-backed helper behavior:

- `packages/context/src/ingest/local-adapters.ts` still creates the Looker
  table identifier parser from `options.looker.daemonBaseUrl`,
  `KTX_DAEMON_URL`, or `http://127.0.0.1:8765`.
- `packages/cli/src/local-adapters.ts` still creates historic SQL analysis from
  `options.sqlAnalysisUrl`, `KTX_SQL_ANALYSIS_URL`, `KTX_DAEMON_URL`, or
  `http://127.0.0.1:8765`.
- `packages/cli/src/serve.ts` passes adapters to MCP local ingest, but
  `LocalIngestMcpOptions` has no `pullConfigOptions`, so Looker pull-config
  generation cannot receive CLI-managed daemon options.

This plan closes that gap without changing explicit daemon URL behavior.
Explicit `--database-introspection-url`, explicit test dependency injection,
`KTX_SQL_ANALYSIS_URL`, and `KTX_DAEMON_URL` continue to win over the managed
daemon.

## File structure

- Create `packages/cli/src/managed-python-http.ts`: lazy managed core daemon
  resolver, generic HTTP JSON runner, managed Looker table identifier parser,
  managed SQL analysis port, and managed live-database daemon request options.
- Create `packages/cli/src/managed-python-http.test.ts`: verifies lazy daemon
  resolution, install policy propagation, daemon reuse caching, and HTTP runner
  delegation.
- Modify `packages/cli/src/local-adapters.ts`: accepts managed daemon options
  and wires them into daemon-backed local ingest helpers only when no explicit
  daemon URL is configured.
- Modify `packages/cli/src/ingest.ts`: adds runtime install policy fields to
  run args and passes managed daemon options to both adapter creation and
  local pull-config resolution.
- Modify `packages/cli/src/ingest.test.ts`: covers managed daemon option
  threading and preserves explicit daemon URL behavior.
- Modify `packages/cli/src/commands/ingest-commands.ts`: adds `--yes` to
  `ktx ingest run` and uses existing `--no-input` as the runtime noninteractive
  mode.
- Modify `packages/cli/src/scan.ts`: adds runtime install policy fields and
  passes managed daemon options to local ingest adapters used during scan.
- Modify `packages/cli/src/scan.test.ts`: covers managed daemon option
  threading and explicit daemon URL behavior.
- Modify `packages/cli/src/commands/scan-commands.ts`: adds `--yes` and
  `--no-input` to `ktx scan`.
- Modify `packages/context/src/ingest/local-ingest.ts`: adds
  `pullConfigOptions` to `LocalIngestMcpOptions`.
- Modify `packages/context/src/mcp/local-project-ports.ts`: passes MCP local
  ingest pull-config options into `runLocalIngest()`.
- Modify `packages/context/src/mcp/local-project-ports.test.ts`: covers MCP
  pull-config option forwarding.
- Modify `packages/cli/src/serve.ts`: passes managed daemon options and
  pull-config options to MCP local ingest.
- Modify `packages/cli/src/serve.test.ts`: covers MCP local ingest managed
  daemon option wiring.
- Modify `packages/cli/src/index.test.ts`: updates Commander routing
  expectations for ingest and scan runtime install policy flags.

### Task 1: Add managed daemon HTTP helpers

**Files:**

- Create: `packages/cli/src/managed-python-http.test.ts`
- Create: `packages/cli/src/managed-python-http.ts`
- Test: `packages/cli/src/managed-python-http.test.ts`

- [ ] **Step 1: Write failing tests for lazy daemon HTTP helpers**

Create `packages/cli/src/managed-python-http.test.ts` with this content:

```typescript
import { describe, expect, it, vi } from 'vitest';
import {
  createManagedDaemonHttpJsonRunner,
  createManagedDaemonLookerTableIdentifierParser,
  createManagedDaemonSqlAnalysisPort,
  createManagedPythonDaemonBaseUrlResolver,
  managedDaemonDatabaseIntrospectionOptions,
} from './managed-python-http.js';

function io() {
  let stderr = '';
  return {
    io: {
      stdout: { write: vi.fn() },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    stderr: () => stderr,
  };
}

describe('createManagedPythonDaemonBaseUrlResolver', () => {
  it('ensures the core runtime, starts the daemon, reports the URL, and caches the result', async () => {
    const testIo = io();
    const ensureRuntime = vi.fn(async () => ({
      layout: {} as never,
      manifest: {} as never,
    }));
    const startDaemon = vi.fn(async () => ({
      status: 'started' as const,
      layout: {} as never,
      state: { pid: 1234 } as never,
      baseUrl: 'http://127.0.0.1:61234',
    }));
    const resolveBaseUrl = createManagedPythonDaemonBaseUrlResolver({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: testIo.io,
      ensureRuntime,
      startDaemon,
    });

    await expect(resolveBaseUrl()).resolves.toBe('http://127.0.0.1:61234');
    await expect(resolveBaseUrl()).resolves.toBe('http://127.0.0.1:61234');

    expect(ensureRuntime).toHaveBeenCalledTimes(1);
    expect(ensureRuntime).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: testIo.io,
      feature: 'core',
    });
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      features: ['core'],
      force: false,
    });
    expect(testIo.stderr()).toContain('Started KTX Python daemon: http://127.0.0.1:61234');
  });

  it('reports daemon reuse without reinstalling after the first resolved URL', async () => {
    const testIo = io();
    const ensureRuntime = vi.fn(async () => ({
      layout: {} as never,
      manifest: {} as never,
    }));
    const startDaemon = vi.fn(async () => ({
      status: 'reused' as const,
      layout: {} as never,
      state: { pid: 1234 } as never,
      baseUrl: 'http://127.0.0.1:61234',
    }));
    const resolveBaseUrl = createManagedPythonDaemonBaseUrlResolver({
      cliVersion: '0.2.0',
      installPolicy: 'never',
      io: testIo.io,
      ensureRuntime,
      startDaemon,
    });

    await expect(resolveBaseUrl()).resolves.toBe('http://127.0.0.1:61234');
    await expect(resolveBaseUrl()).resolves.toBe('http://127.0.0.1:61234');

    expect(ensureRuntime).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(testIo.stderr()).toContain('Using existing KTX Python daemon: http://127.0.0.1:61234');
  });
});

describe('createManagedDaemonHttpJsonRunner', () => {
  it('resolves the managed base URL lazily for each HTTP JSON request', async () => {
    const postJson = vi.fn(async () => ({ ok: true }));
    const runner = createManagedDaemonHttpJsonRunner({
      resolveBaseUrl: async () => 'http://127.0.0.1:61234',
      postJson,
    });

    await expect(runner('/sql/parse-table-identifier', { items: [] })).resolves.toEqual({ ok: true });

    expect(postJson).toHaveBeenCalledWith('http://127.0.0.1:61234', '/sql/parse-table-identifier', { items: [] });
  });
});

describe('managed daemon ingest ports', () => {
  it('creates a Looker table parser backed by the managed daemon runner', async () => {
    const requestJson = vi.fn(async () => ({
      results: {
        'model.explore': {
          ok: true,
          catalog: 'warehouse',
          schema: 'public',
          name: 'orders',
          canonical_table: 'public.orders',
        },
      },
    }));
    const parser = createManagedDaemonLookerTableIdentifierParser({ requestJson });

    await expect(
      parser.parse([{ key: 'model.explore', sql_table_name: 'public.orders', dialect: 'postgres' }]),
    ).resolves.toEqual({
      'model.explore': {
        ok: true,
        catalog: 'warehouse',
        schema: 'public',
        name: 'orders',
        canonical_table: 'public.orders',
      },
    });
    expect(requestJson).toHaveBeenCalledWith('/sql/parse-table-identifier', {
      items: [{ key: 'model.explore', sql_table_name: 'public.orders', dialect: 'postgres' }],
    });
  });

  it('creates a SQL analysis port backed by the managed daemon runner', async () => {
    const requestJson = vi.fn(async () => ({
      fingerprint: 'select-orders',
      normalized_sql: 'SELECT * FROM public.orders WHERE id = ?',
      tables_touched: ['public.orders'],
      literal_slots: [{ position: 1, type: 'number', example_value: '42' }],
    }));
    const sqlAnalysis = createManagedDaemonSqlAnalysisPort({ requestJson });

    await expect(sqlAnalysis.analyzeForFingerprint('SELECT * FROM public.orders WHERE id = 42', 'postgres')).resolves
      .toEqual({
        fingerprint: 'select-orders',
        normalizedSql: 'SELECT * FROM public.orders WHERE id = ?',
        tablesTouched: ['public.orders'],
        literalSlots: [{ position: 1, type: 'number', exampleValue: '42' }],
      });
    expect(requestJson).toHaveBeenCalledWith('/api/sql/analyze-for-fingerprint', {
      sql: 'SELECT * FROM public.orders WHERE id = 42',
      dialect: 'postgres',
    });
  });

  it('returns live-database daemon request options backed by the managed runner', async () => {
    const requestJson = vi.fn(async () => ({
      connection_id: 'warehouse',
      tables: [],
    }));
    const options = managedDaemonDatabaseIntrospectionOptions({ requestJson });

    await expect(options.requestJson('/database/introspect', { connection_id: 'warehouse' })).resolves.toEqual({
      connection_id: 'warehouse',
      tables: [],
    });
    expect(requestJson).toHaveBeenCalledWith('/database/introspect', { connection_id: 'warehouse' });
  });
});
```

- [ ] **Step 2: Run the failing helper tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-http.test.ts
```

Expected: FAIL with an import error for `./managed-python-http.js`.

- [ ] **Step 3: Implement managed daemon HTTP helpers**

Create `packages/cli/src/managed-python-http.ts` with this content:

```typescript
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import {
  createDaemonLookerTableIdentifierParser,
  type DaemonLiveDatabaseIntrospectionOptions,
  type KtxDaemonDatabaseHttpJsonRunner,
  type KtxDaemonTableIdentifierHttpJsonRunner,
  type LookerTableIdentifierParser,
} from '@ktx/context/ingest';
import {
  createHttpSqlAnalysisPort,
  type KtxSqlAnalysisHttpJsonRunner,
  type SqlAnalysisPort,
} from '@ktx/context/sql-analysis';
import type { KtxCliIo } from './cli-runtime.js';
import {
  ensureManagedPythonCommandRuntime,
  type KtxManagedPythonInstallPolicy,
  type ManagedPythonCommandRuntime,
} from './managed-python-command.js';
import { startManagedPythonDaemon, type ManagedPythonDaemonStartResult } from './managed-python-daemon.js';

export type ManagedPythonHttpJsonRunner = (
  path: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export type ManagedPythonHttpPostJson = (
  baseUrl: string,
  path: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface ManagedPythonCoreDaemonOptions {
  cliVersion: string;
  installPolicy: KtxManagedPythonInstallPolicy;
  io: KtxCliIo;
  ensureRuntime?: (options: {
    cliVersion: string;
    installPolicy: KtxManagedPythonInstallPolicy;
    io: KtxCliIo;
    feature: 'core';
  }) => Promise<ManagedPythonCommandRuntime>;
  startDaemon?: (options: {
    cliVersion: string;
    features: ['core'];
    force: false;
  }) => Promise<ManagedPythonDaemonStartResult>;
}

export type ManagedPythonDaemonHttpOptions =
  | {
      requestJson: ManagedPythonHttpJsonRunner;
    }
  | {
      resolveBaseUrl: () => Promise<string>;
      postJson?: ManagedPythonHttpPostJson;
    }
  | (ManagedPythonCoreDaemonOptions & {
      postJson?: ManagedPythonHttpPostJson;
    });

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function parseJsonObject(raw: string, path: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`KTX managed daemon HTTP ${path} returned non-object JSON`);
  }
  return parsed as Record<string, unknown>;
}

export async function postManagedDaemonJson(
  baseUrl: string,
  path: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const target = new URL(path.replace(/^\//, ''), normalizedBaseUrl(baseUrl));
    const body = JSON.stringify(payload);
    const client = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = client(
      target,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`KTX managed daemon HTTP ${path} failed with ${statusCode}: ${text}`));
            return;
          }
          try {
            resolve(parseJsonObject(text, path));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

export function createManagedPythonDaemonBaseUrlResolver(
  options: ManagedPythonCoreDaemonOptions,
): () => Promise<string> {
  let cachedBaseUrl: string | undefined;

  return async () => {
    if (cachedBaseUrl) {
      return cachedBaseUrl;
    }

    const ensureRuntime = options.ensureRuntime ?? ensureManagedPythonCommandRuntime;
    const startDaemon = options.startDaemon ?? startManagedPythonDaemon;
    await ensureRuntime({
      cliVersion: options.cliVersion,
      installPolicy: options.installPolicy,
      io: options.io,
      feature: 'core',
    });
    const daemon = await startDaemon({
      cliVersion: options.cliVersion,
      features: ['core'],
      force: false,
    });
    const verb = daemon.status === 'started' ? 'Started' : 'Using existing';
    options.io.stderr.write(`${verb} KTX Python daemon: ${daemon.baseUrl}\n`);
    cachedBaseUrl = daemon.baseUrl;
    return cachedBaseUrl;
  };
}

function isRequestJsonOnly(options: ManagedPythonDaemonHttpOptions): options is { requestJson: ManagedPythonHttpJsonRunner } {
  return 'requestJson' in options;
}

function isResolveBaseUrlOnly(
  options: ManagedPythonDaemonHttpOptions,
): options is { resolveBaseUrl: () => Promise<string>; postJson?: ManagedPythonHttpPostJson } {
  return 'resolveBaseUrl' in options;
}

export function createManagedDaemonHttpJsonRunner(
  options: ManagedPythonDaemonHttpOptions,
): ManagedPythonHttpJsonRunner {
  if (isRequestJsonOnly(options)) {
    return options.requestJson;
  }
  const resolveBaseUrl = isResolveBaseUrlOnly(options)
    ? options.resolveBaseUrl
    : createManagedPythonDaemonBaseUrlResolver(options);
  const postJson = options.postJson ?? postManagedDaemonJson;

  return async (path, payload) => postJson(await resolveBaseUrl(), path, payload);
}

export function createManagedDaemonLookerTableIdentifierParser(
  options: ManagedPythonDaemonHttpOptions,
): LookerTableIdentifierParser {
  return createDaemonLookerTableIdentifierParser({
    baseUrl: 'http://127.0.0.1:0',
    requestJson: createManagedDaemonHttpJsonRunner(options) as KtxDaemonTableIdentifierHttpJsonRunner,
  });
}

export function createManagedDaemonSqlAnalysisPort(options: ManagedPythonDaemonHttpOptions): SqlAnalysisPort {
  return createHttpSqlAnalysisPort({
    baseUrl: 'http://127.0.0.1:0',
    requestJson: createManagedDaemonHttpJsonRunner(options) as KtxSqlAnalysisHttpJsonRunner,
  });
}

export function managedDaemonDatabaseIntrospectionOptions(
  options: ManagedPythonDaemonHttpOptions,
): Pick<DaemonLiveDatabaseIntrospectionOptions, 'requestJson'> {
  return {
    requestJson: createManagedDaemonHttpJsonRunner(options) as KtxDaemonDatabaseHttpJsonRunner,
  };
}
```

- [ ] **Step 4: Verify the helper tests pass**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-http.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the helper**

Run:

```bash
git add packages/cli/src/managed-python-http.ts packages/cli/src/managed-python-http.test.ts
git commit -m "feat(cli): add managed daemon HTTP helpers"
```

Expected: commit succeeds.

### Task 2: Wire managed daemon options into CLI local adapters

**Files:**

- Modify: `packages/cli/src/local-adapters.ts`
- Test: `packages/cli/src/managed-python-http.test.ts`

- [ ] **Step 1: Update local adapter imports**

In `packages/cli/src/local-adapters.ts`, add this import after the
`createHttpSqlAnalysisPort` import:

```typescript
import {
  createManagedDaemonLookerTableIdentifierParser,
  createManagedDaemonSqlAnalysisPort,
  managedDaemonDatabaseIntrospectionOptions,
  type ManagedPythonCoreDaemonOptions,
} from './managed-python-http.js';
```

- [ ] **Step 2: Add managed daemon options to the local adapter option type**

Replace this interface:

```typescript
interface KtxCliLocalIngestAdaptersOptions extends DefaultLocalIngestAdaptersOptions {
  historicSqlConnectionId?: string;
  sqlAnalysisUrl?: string;
}
```

with this interface:

```typescript
export interface KtxCliLocalIngestAdaptersOptions extends DefaultLocalIngestAdaptersOptions {
  historicSqlConnectionId?: string;
  sqlAnalysisUrl?: string;
  managedDaemon?: ManagedPythonCoreDaemonOptions;
}
```

- [ ] **Step 3: Add helper functions for managed daemon adapter options**

Add these helpers immediately after `hasSnowflakeDriver()`:

```typescript
function ktxCliDaemonDatabaseIntrospectionOptions(
  options: KtxCliLocalIngestAdaptersOptions,
): DefaultLocalIngestAdaptersOptions['databaseIntrospection'] {
  if (options.databaseIntrospectionUrl || options.databaseIntrospection?.requestJson || !options.managedDaemon) {
    return options.databaseIntrospection;
  }
  return {
    ...(options.databaseIntrospection ?? {}),
    ...managedDaemonDatabaseIntrospectionOptions(options.managedDaemon),
  };
}

function ktxCliLookerOptions(
  options: KtxCliLocalIngestAdaptersOptions,
): DefaultLocalIngestAdaptersOptions['looker'] {
  const looker = options.looker;
  if (looker?.parser || looker?.daemonBaseUrl || process.env.KTX_DAEMON_URL || !options.managedDaemon) {
    return looker;
  }
  return {
    ...(looker ?? {}),
    parser: createManagedDaemonLookerTableIdentifierParser(options.managedDaemon),
  };
}

function ktxCliHistoricSqlAnalysis(options: KtxCliLocalIngestAdaptersOptions) {
  if (options.sqlAnalysisUrl) {
    return createHttpSqlAnalysisPort({ baseUrl: options.sqlAnalysisUrl });
  }
  if (process.env.KTX_SQL_ANALYSIS_URL) {
    return createHttpSqlAnalysisPort({ baseUrl: process.env.KTX_SQL_ANALYSIS_URL });
  }
  if (process.env.KTX_DAEMON_URL) {
    return createHttpSqlAnalysisPort({ baseUrl: process.env.KTX_DAEMON_URL });
  }
  if (options.managedDaemon) {
    return createManagedDaemonSqlAnalysisPort(options.managedDaemon);
  }
  return createHttpSqlAnalysisPort({ baseUrl: 'http://127.0.0.1:8765' });
}
```

- [ ] **Step 4: Use managed daemon request options for daemon live-database fallback**

In `createKtxCliLiveDatabaseIntrospection()`, insert this line before the
`const daemon = createDaemonLiveDatabaseIntrospection({` statement:

```typescript
  const databaseIntrospection = ktxCliDaemonDatabaseIntrospectionOptions(options);
```

Then replace the daemon creation block:

```typescript
  const daemon = createDaemonLiveDatabaseIntrospection({
    connections: project.config.connections,
    ...options.databaseIntrospection,
    ...(options.databaseIntrospectionUrl ? { baseUrl: options.databaseIntrospectionUrl } : {}),
  });
```

with this block:

```typescript
  const daemon = createDaemonLiveDatabaseIntrospection({
    connections: project.config.connections,
    ...databaseIntrospection,
    ...(options.databaseIntrospectionUrl ? { baseUrl: options.databaseIntrospectionUrl } : {}),
  });
```

- [ ] **Step 5: Use managed daemon SQL analysis for historic SQL**

In `historicSqlOptionsForLocalRun()`, replace this block:

```typescript
  return {
    sqlAnalysis: createHttpSqlAnalysisPort({
      baseUrl:
        options.sqlAnalysisUrl ??
        process.env.KTX_SQL_ANALYSIS_URL ??
        process.env.KTX_DAEMON_URL ??
        'http://127.0.0.1:8765',
    }),
    postgresQueryClient: createEphemeralPostgresHistoricSqlClient(project, connectionId),
    postgresBaselineRootDir: join(project.projectDir, '.ktx/cache/historic-sql'),
  };
```

with this block:

```typescript
  return {
    sqlAnalysis: ktxCliHistoricSqlAnalysis(options),
    postgresQueryClient: createEphemeralPostgresHistoricSqlClient(project, connectionId),
    postgresBaselineRootDir: join(project.projectDir, '.ktx/cache/historic-sql'),
  };
```

- [ ] **Step 6: Pass managed Looker options into default local adapters**

In `createKtxCliLocalIngestAdapters()`, replace:

```typescript
  const base = createDefaultLocalIngestAdapters(project, {
    ...options,
    ...(historicSql ? { historicSql } : {}),
  });
```

with:

```typescript
  const base = createDefaultLocalIngestAdapters(project, {
    ...options,
    databaseIntrospection: ktxCliDaemonDatabaseIntrospectionOptions(options),
    looker: ktxCliLookerOptions(options),
    ...(historicSql ? { historicSql } : {}),
  });
```

- [ ] **Step 7: Run the CLI type check for local adapter changes**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 8: Commit local adapter wiring**

Run:

```bash
git add packages/cli/src/local-adapters.ts
git commit -m "feat(cli): route local adapters through managed daemon"
```

Expected: commit succeeds.

### Task 3: Thread managed daemon options through ingest commands

**Files:**

- Modify: `packages/cli/src/ingest.ts`
- Modify: `packages/cli/src/ingest.test.ts`
- Modify: `packages/cli/src/commands/ingest-commands.ts`
- Test: `packages/cli/src/ingest.test.ts`
- Test: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Write failing ingest option-threading tests**

In `packages/cli/src/ingest.test.ts`, add this test after
`passes daemon database introspection URL to default local ingest adapters`:

```typescript
  it('passes managed daemon options to adapters and pull-config options when no explicit daemon URL is set', async () => {
    const projectDir = join(tempDir, 'managed-daemon-ingest-project');
    await initKtxProject({ projectDir, projectName: 'managed-daemon-ingest-project' });
    await writeWarehouseConfig(projectDir);
    const createdAdapters: SourceAdapter[] = [
      { source: 'fake', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
    ];
    const createAdapters = vi.fn(() => createdAdapters as never);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) =>
      completedLocalBundleRun(input, input.jobId ?? 'local-job-1'),
    );
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
          outputMode: 'plain',
        } satisfies KtxIngestArgs,
        io.io,
        {
          createAdapters,
          runLocalIngest: runLocal,
          jobIdFactory: () => 'local-job-1',
        },
      ),
    ).resolves.toBe(0);

    const expectedManagedDaemon = {
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: io.io,
    };
    expect(createAdapters).toHaveBeenCalledWith(expect.objectContaining({ projectDir }), {
      managedDaemon: expectedManagedDaemon,
    });
    expect(runLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        pullConfigOptions: {
          managedDaemon: expectedManagedDaemon,
        },
      }),
    );
  });
```

In the existing `passes daemon database introspection URL to default local ingest
adapters` test, add this assertion inside the existing `expect(runLocal)` block:

```typescript
        pullConfigOptions: {
          databaseIntrospectionUrl: 'http://127.0.0.1:8765',
        },
```

- [ ] **Step 2: Run the failing ingest tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/ingest.test.ts
```

Expected: FAIL because `KtxIngestArgs` has no `cliVersion` or
`runtimeInstallPolicy`, and `runKtxIngest()` does not pass managed daemon
options into `createAdapters()` or `pullConfigOptions`.

- [ ] **Step 3: Add runtime install policy fields to ingest args**

In `packages/cli/src/ingest.ts`, add this import after the local adapters
import:

```typescript
import type { KtxManagedPythonInstallPolicy } from './managed-python-command.js';
```

In the `KtxIngestArgs` `command: 'run'` branch, add these fields after
`databaseIntrospectionUrl?: string;`:

```typescript
      cliVersion?: string;
      runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
```

- [ ] **Step 4: Add a managed daemon option helper to ingest**

In `packages/cli/src/ingest.ts`, add this helper after
`initialRunMemoryFlowInput()`:

```typescript
function managedDaemonOptionsForIngestRun(
  args: Extract<KtxIngestArgs, { command: 'run' }>,
  io: KtxIngestIo,
) {
  if (args.databaseIntrospectionUrl || !args.cliVersion || !args.runtimeInstallPolicy) {
    return undefined;
  }
  return {
    cliVersion: args.cliVersion,
    installPolicy: args.runtimeInstallPolicy,
    io,
  };
}
```

- [ ] **Step 5: Pass managed daemon options to adapters and pull-config resolution**

In the `args.command === 'run'` branch of `runKtxIngest()`, replace the
`adapterOptions` block:

```typescript
      const adapterOptions = {
        ...(localIngestOptions.pullConfigOptions ?? {}),
        ...(args.databaseIntrospectionUrl ? { databaseIntrospectionUrl: args.databaseIntrospectionUrl } : {}),
        ...(args.adapter === 'historic-sql' ? { historicSqlConnectionId: args.connectionId } : {}),
      };
```

with:

```typescript
      const managedDaemon = managedDaemonOptionsForIngestRun(args, io);
      const adapterOptions = {
        ...(localIngestOptions.pullConfigOptions ?? {}),
        ...(args.databaseIntrospectionUrl ? { databaseIntrospectionUrl: args.databaseIntrospectionUrl } : {}),
        ...(managedDaemon ? { managedDaemon } : {}),
        ...(args.adapter === 'historic-sql' ? { historicSqlConnectionId: args.connectionId } : {}),
      };
```

In the non-Metabase `executeLocalIngest()` call, move `...localIngestOptions`
before `pullConfigOptions` and add `pullConfigOptions: adapterOptions`.
The call must contain this sequence after the edit:

```typescript
        const result = await executeLocalIngest({
          project,
          adapters: createAdapters(project, adapterOptions),
          adapter: args.adapter,
          connectionId: args.connectionId,
          sourceDir: args.sourceDir,
          trigger: 'manual_resync',
          jobId,
          ...localIngestOptions,
          pullConfigOptions: adapterOptions,
          ...(args.debugLlmRequestFile ? { llmDebugRequestFile: args.debugLlmRequestFile } : {}),
          ...(memoryFlow ? { memoryFlow } : {}),
        });
```

- [ ] **Step 6: Add runtime flags to `ktx ingest run` routing**

In `packages/cli/src/commands/ingest-commands.ts`, add this import after the
`KtxCliDeps` import:

```typescript
import { runtimeInstallPolicyFromFlags } from '../managed-python-command.js';
```

In the `ingest run` command options, add this option immediately before
`.option('--no-input', ...)`:

```typescript
    .option('--yes', 'Install the managed Python runtime without prompting when required', false)
```

In the `KtxIngestArgs` object built for `ingest run`, add these fields after
`databaseIntrospectionUrl: options.databaseIntrospectionUrl || undefined,`:

```typescript
          cliVersion: context.packageInfo.version,
          runtimeInstallPolicy: runtimeInstallPolicyFromFlags(options),
```

- [ ] **Step 7: Update Commander ingest routing expectations**

In `packages/cli/src/index.test.ts`, in the test that routes
`dev ingest run`, add these expected fields after
`databaseIntrospectionUrl: undefined,`:

```typescript
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'never',
```

Add this test after that existing routing test:

```typescript
  it('routes ingest managed runtime install policies', async () => {
    const autoIo = makeIo();
    const conflictIo = makeIo();
    const ingest = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          'dev',
          'ingest',
          'run',
          '--project-dir',
          tempDir,
          '--connection-id',
          'warehouse',
          '--adapter',
          'looker',
          '--yes',
        ],
        autoIo.io,
        { ingest },
      ),
    ).resolves.toBe(0);
    await expect(
      runKtxCli(
        [
          'dev',
          'ingest',
          'run',
          '--project-dir',
          tempDir,
          '--connection-id',
          'warehouse',
          '--adapter',
          'looker',
          '--yes',
          '--no-input',
        ],
        conflictIo.io,
        { ingest },
      ),
    ).resolves.toBe(1);

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'auto',
      }),
      autoIo.io,
    );
    expect(conflictIo.stderr()).toContain('Choose only one runtime install mode: --yes or --no-input');
  });
```

- [ ] **Step 8: Run focused ingest and routing tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/ingest.test.ts src/index.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit ingest runtime policy wiring**

Run:

```bash
git add packages/cli/src/ingest.ts packages/cli/src/ingest.test.ts packages/cli/src/commands/ingest-commands.ts packages/cli/src/index.test.ts
git commit -m "feat(cli): use managed daemon for ingest helpers"
```

Expected: commit succeeds.

### Task 4: Thread managed daemon options through scan commands

**Files:**

- Modify: `packages/cli/src/scan.ts`
- Modify: `packages/cli/src/scan.test.ts`
- Modify: `packages/cli/src/commands/scan-commands.ts`
- Modify: `packages/cli/src/index.test.ts`
- Test: `packages/cli/src/scan.test.ts`
- Test: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Write failing scan option-threading test**

In `packages/cli/src/scan.test.ts`, add this test after the test that passes
`databaseIntrospectionUrl`:

```typescript
  it('passes managed daemon options to local ingest adapters when no explicit daemon URL is set', async () => {
    const report = minimalScanReport();
    const createLocalIngestAdapters = vi.fn(() => []);
    const runLocalScan = vi.fn(
      async (_input: RunLocalScanOptions): Promise<LocalScanRunResult> => ({
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'structural',
        dryRun: false,
        syncId: 'sync-1',
        report,
      }),
    );
    const io = makeIo();

    await expect(
      runKtxScan(
        {
          command: 'run',
          projectDir: tempDir,
          connectionId: 'warehouse',
          mode: 'structural',
          detectRelationships: false,
          dryRun: false,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        io.io,
        { runLocalScan, createLocalIngestAdapters },
      ),
    ).resolves.toBe(0);

    expect(createLocalIngestAdapters).toHaveBeenCalledWith(expect.objectContaining({ projectDir: tempDir }), {
      managedDaemon: {
        cliVersion: '0.2.0',
        installPolicy: 'auto',
        io: io.io,
      },
    });
  });
```

- [ ] **Step 2: Run the failing scan tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/scan.test.ts
```

Expected: FAIL because `KtxScanArgs` has no `cliVersion` or
`runtimeInstallPolicy`, and `runKtxScan()` does not pass managed daemon options
to adapter creation.

- [ ] **Step 3: Add runtime install policy fields to scan args**

In `packages/cli/src/scan.ts`, add this import after the local adapter import:

```typescript
import type { KtxManagedPythonInstallPolicy } from './managed-python-command.js';
```

In the `KtxScanArgs` `command: 'run'` branch, add these fields after
`databaseIntrospectionUrl?: string;`:

```typescript
      cliVersion?: string;
      runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
```

- [ ] **Step 4: Add managed daemon option construction to scan**

In `packages/cli/src/scan.ts`, add this helper after `warningLine()`:

```typescript
function managedDaemonOptionsForScanRun(args: Extract<KtxScanArgs, { command: 'run' }>, io: KtxCliIo) {
  if (args.databaseIntrospectionUrl || !args.cliVersion || !args.runtimeInstallPolicy) {
    return undefined;
  }
  return {
    cliVersion: args.cliVersion,
    installPolicy: args.runtimeInstallPolicy,
    io,
  };
}
```

In the `runLocalScan()` call, replace this adapter creation block:

```typescript
        adapters: (deps.createLocalIngestAdapters ?? createKtxCliLocalIngestAdapters)(project, {
          databaseIntrospectionUrl: args.databaseIntrospectionUrl,
        }),
```

with:

```typescript
        adapters: (deps.createLocalIngestAdapters ?? createKtxCliLocalIngestAdapters)(project, {
          ...(args.databaseIntrospectionUrl ? { databaseIntrospectionUrl: args.databaseIntrospectionUrl } : {}),
          ...(managedDaemonOptionsForScanRun(args, io)
            ? { managedDaemon: managedDaemonOptionsForScanRun(args, io) }
            : {}),
        }),
```

Then replace the repeated helper call with a local constant to keep the code
single-pass. The final block must be:

```typescript
    const managedDaemon = managedDaemonOptionsForScanRun(args, io);
    const connector =
      args.mode !== 'structural' || args.detectRelationships
        ? await createKtxCliScanConnector(project, args.connectionId)
        : undefined;
    const progress = createCliScanProgress(io);
    try {
      const result = await (deps.runLocalScan ?? runLocalScan)({
        project,
        connectionId: args.connectionId,
        mode: args.mode,
        detectRelationships: args.detectRelationships,
        dryRun: args.dryRun,
        trigger: 'cli',
        databaseIntrospectionUrl: args.databaseIntrospectionUrl,
        connector,
        adapters: (deps.createLocalIngestAdapters ?? createKtxCliLocalIngestAdapters)(project, {
          ...(args.databaseIntrospectionUrl ? { databaseIntrospectionUrl: args.databaseIntrospectionUrl } : {}),
          ...(managedDaemon ? { managedDaemon } : {}),
        }),
        progress,
      });
```

- [ ] **Step 5: Add runtime flags to scan routing**

In `packages/cli/src/commands/scan-commands.ts`, add this import after the
`cli-program.js` import:

```typescript
import { runtimeInstallPolicyFromFlags } from '../managed-python-command.js';
```

In the top-level `scan` command options, add these options after
`--database-introspection-url`:

```typescript
    .option('--yes', 'Install the managed Python runtime without prompting when required', false)
    .option('--no-input', 'Disable interactive managed runtime installation')
```

In the scan run action, add these fields after
`databaseIntrospectionUrl: options.databaseIntrospectionUrl,`:

```typescript
        cliVersion: context.packageInfo.version,
        runtimeInstallPolicy: runtimeInstallPolicyFromFlags(options),
```

- [ ] **Step 6: Update Commander scan routing expectations**

In `packages/cli/src/index.test.ts`, update the `routes low-level scan through
ktx dev with top-level project-dir` expected args by adding:

```typescript
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'prompt',
```

Add this test after that routing test:

```typescript
  it('routes scan managed runtime install policies', async () => {
    const autoIo = makeIo();
    const neverIo = makeIo();
    const conflictIo = makeIo();
    const scan = vi.fn().mockResolvedValue(0);

    await expect(runKtxCli(['--project-dir', tempDir, 'dev', 'scan', 'warehouse', '--yes'], autoIo.io, { scan }))
      .resolves.toBe(0);
    await expect(runKtxCli(['--project-dir', tempDir, 'dev', 'scan', 'warehouse', '--no-input'], neverIo.io, { scan }))
      .resolves.toBe(0);
    await expect(
      runKtxCli(['--project-dir', tempDir, 'dev', 'scan', 'warehouse', '--yes', '--no-input'], conflictIo.io, {
        scan,
      }),
    ).resolves.toBe(1);

    expect(scan).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: 'run',
        runtimeInstallPolicy: 'auto',
      }),
      autoIo.io,
    );
    expect(scan).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'run',
        runtimeInstallPolicy: 'never',
      }),
      neverIo.io,
    );
    expect(conflictIo.stderr()).toContain('Choose only one runtime install mode: --yes or --no-input');
  });
```

- [ ] **Step 7: Run focused scan and routing tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/scan.test.ts src/index.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit scan runtime policy wiring**

Run:

```bash
git add packages/cli/src/scan.ts packages/cli/src/scan.test.ts packages/cli/src/commands/scan-commands.ts packages/cli/src/index.test.ts
git commit -m "feat(cli): pass managed daemon options to scan"
```

Expected: commit succeeds.

### Task 5: Pass pull-config options through MCP local ingest

**Files:**

- Modify: `packages/context/src/ingest/local-ingest.ts`
- Modify: `packages/context/src/mcp/local-project-ports.ts`
- Modify: `packages/context/src/mcp/local-project-ports.test.ts`
- Test: `packages/context/src/mcp/local-project-ports.test.ts`

- [ ] **Step 1: Write failing MCP pull-config forwarding test**

In `packages/context/src/mcp/local-project-ports.test.ts`, add this test in
the local ingest tool describe block, next to the existing local ingest tests:

```typescript
  it('passes local ingest pull-config options into runLocalIngest', async () => {
    const runLocalIngest = vi.fn(async () => ({
      result: { ok: true },
      report: {
        id: 'report-1',
        runId: 'run-1',
        jobId: 'job-1',
        sourceKey: 'looker',
        connectionId: 'warehouse',
        body: {
          syncId: 'sync-1',
          workUnits: [],
          failedWorkUnits: [],
          diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
          provenanceRows: [],
        },
      },
    } as never));
    const ports = createLocalProjectMcpContextPorts(project, {
      localIngest: {
        adapters: [{ source: 'looker', skillNames: [] }],
        pullConfigOptions: {
          looker: {
            daemonBaseUrl: 'http://127.0.0.1:61234',
          },
        },
        runLocalIngest,
      },
    });

    await expect(
      ports.ingest.run({
        adapter: 'looker',
        connectionId: 'warehouse',
        trigger: 'manual_resync',
        config: {},
      }),
    ).resolves.toMatchObject({
      runId: 'run-1',
      jobId: 'job-1',
      reportId: 'report-1',
    });

    expect(runLocalIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        pullConfigOptions: {
          looker: {
            daemonBaseUrl: 'http://127.0.0.1:61234',
          },
        },
      }),
    );
  });
```

- [ ] **Step 2: Run the failing MCP test**

Run:

```bash
pnpm --filter @ktx/context run test -- src/mcp/local-project-ports.test.ts
```

Expected: FAIL because `LocalIngestMcpOptions` does not accept
`pullConfigOptions`, and MCP local ingest does not pass it to
`runLocalIngest()`.

- [ ] **Step 3: Add pull-config options to MCP local ingest options**

In `packages/context/src/ingest/local-ingest.ts`, update
`LocalIngestMcpOptions` so the `Pick<RunLocalIngestOptions, ...>` includes
`'pullConfigOptions'`. The interface must contain this sequence after the edit:

```typescript
export interface LocalIngestMcpOptions
  extends Pick<
    RunLocalIngestOptions,
    | 'agentRunner'
    | 'llmProvider'
    | 'memoryModel'
    | 'semanticLayerCompute'
    | 'queryExecutor'
    | 'logger'
    | 'pullConfigOptions'
  > {
  adapters?: SourceAdapter[];
  jobIdFactory?: () => string;
  runLocalMetabaseIngest?: (options: RunLocalMetabaseIngestOptions) => Promise<LocalMetabaseFanoutResult>;
}
```

- [ ] **Step 4: Pass pull-config options in MCP local ingest execution**

In `packages/context/src/mcp/local-project-ports.ts`, in the
`runLocalIngest({ ... })` call, add this field after `sourceDir,`:

```typescript
          pullConfigOptions: options.localIngest?.pullConfigOptions,
```

- [ ] **Step 5: Run MCP tests**

Run:

```bash
pnpm --filter @ktx/context run test -- src/mcp/local-project-ports.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit MCP pull-config forwarding**

Run:

```bash
git add packages/context/src/ingest/local-ingest.ts packages/context/src/mcp/local-project-ports.ts packages/context/src/mcp/local-project-ports.test.ts
git commit -m "feat(context): pass MCP ingest pull config options"
```

Expected: commit succeeds.

### Task 6: Wire managed daemon options through MCP serve

**Files:**

- Modify: `packages/cli/src/serve.ts`
- Modify: `packages/cli/src/serve.test.ts`
- Test: `packages/cli/src/serve.test.ts`
- Test: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Write failing serve managed daemon wiring test**

In `packages/cli/src/serve.test.ts`, add this test after
`uses managed semantic compute when MCP semantic compute has no explicit HTTP
URL`:

```typescript
  it('passes managed daemon options to MCP local ingest adapters and pull-config options', async () => {
    const project = { projectDir: '/tmp/ktx-project', config: { connections: {} } } as never;
    const adapters = [{ source: 'looker', skillNames: [] }];
    const createIngestAdapters = vi.fn(() => adapters);
    const createContextTools = vi.fn(() => ({ connections: { list: async () => [] } }));
    const managedRuntimeIo = makeManagedRuntimeIo();

    await expect(
      runKtxServeStdio(
        {
          mcp: 'stdio',
          projectDir: '/tmp/ktx-project',
          userId: 'agent',
          semanticCompute: false,
          semanticComputeUrl: undefined,
          databaseIntrospectionUrl: undefined,
          executeQueries: false,
          memoryCapture: false,
          memoryModel: undefined,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        {
          loadProject: async () => project,
          createContextTools,
          createIngestAdapters,
          managedRuntimeIo: managedRuntimeIo.io,
          createServer: vi.fn(() => ({ connect: vi.fn(async () => undefined) }) as never),
          createTransport: vi.fn(() => ({}) as never),
          stderr: { write: vi.fn() },
        },
      ),
    ).resolves.toBe(0);

    const expectedManagedDaemon = {
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: managedRuntimeIo.io,
    };
    expect(createIngestAdapters).toHaveBeenCalledWith(project, {
      managedDaemon: expectedManagedDaemon,
    });
    expect(createContextTools).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        localIngest: expect.objectContaining({
          adapters,
          pullConfigOptions: {
            managedDaemon: expectedManagedDaemon,
          },
        }),
      }),
    );
  });
```

Add this assertion to the existing test that passes
`databaseIntrospectionUrl: 'http://127.0.0.1:8765'`:

```typescript
          localIngest: expect.objectContaining({
            pullConfigOptions: {
              databaseIntrospectionUrl: 'http://127.0.0.1:8765',
            },
          }),
```

- [ ] **Step 2: Run the failing serve tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/serve.test.ts
```

Expected: FAIL because `runKtxServeStdio()` does not pass managed daemon
options or pull-config options into local ingest.

- [ ] **Step 3: Add serve managed daemon option helper**

In `packages/cli/src/serve.ts`, add this import after the managed command
import:

```typescript
import type { ManagedPythonCoreDaemonOptions } from './managed-python-http.js';
```

Add this helper after `requiredManagedRuntimeCliVersion()`:

```typescript
function managedDaemonOptionsForServe(
  args: KtxServeArgs,
  deps: KtxServeDeps,
): ManagedPythonCoreDaemonOptions | undefined {
  if (args.databaseIntrospectionUrl || !args.cliVersion) {
    return undefined;
  }
  return {
    cliVersion: args.cliVersion,
    installPolicy: args.runtimeInstallPolicy ?? 'prompt',
    io: deps.managedRuntimeIo ?? process,
  };
}
```

- [ ] **Step 4: Pass managed daemon options to serve local ingest**

In `runKtxServeStdio()`, replace this block:

```typescript
  const createIngestAdapters = deps.createIngestAdapters ?? createKtxCliLocalIngestAdapters;
  const localAdapters = createIngestAdapters(project, {
    databaseIntrospectionUrl: args.databaseIntrospectionUrl,
  });
```

with:

```typescript
  const createIngestAdapters = deps.createIngestAdapters ?? createKtxCliLocalIngestAdapters;
  const managedDaemon = managedDaemonOptionsForServe(args, deps);
  const localAdapterOptions = {
    ...(args.databaseIntrospectionUrl ? { databaseIntrospectionUrl: args.databaseIntrospectionUrl } : {}),
    ...(managedDaemon ? { managedDaemon } : {}),
  };
  const localAdapters = createIngestAdapters(project, localAdapterOptions);
```

In the `localIngest` object, add this field after `adapters: localAdapters,`:

```typescript
    pullConfigOptions: localAdapterOptions,
```

- [ ] **Step 5: Run serve and routing tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/serve.test.ts src/index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit serve managed daemon wiring**

Run:

```bash
git add packages/cli/src/serve.ts packages/cli/src/serve.test.ts
git commit -m "feat(cli): pass managed daemon options to serve ingest"
```

Expected: commit succeeds.

### Task 7: Verify managed local ingest daemon integration

**Files:**

- Verify: `packages/cli/src/managed-python-http.ts`
- Verify: `packages/cli/src/local-adapters.ts`
- Verify: `packages/cli/src/ingest.ts`
- Verify: `packages/cli/src/scan.ts`
- Verify: `packages/cli/src/serve.ts`
- Verify: `packages/context/src/ingest/local-ingest.ts`
- Verify: `packages/context/src/mcp/local-project-ports.ts`

- [ ] **Step 1: Run focused CLI tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-http.test.ts src/ingest.test.ts src/scan.test.ts src/serve.test.ts src/index.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused context tests**

Run:

```bash
pnpm --filter @ktx/context run test -- src/mcp/local-project-ports.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run affected package type checks**

Run:

```bash
pnpm --filter @ktx/cli run type-check
pnpm --filter @ktx/context run type-check
```

Expected: both commands PASS.

- [ ] **Step 4: Run the broader TypeScript test surface**

Run:

```bash
pnpm --filter @ktx/cli run test
pnpm --filter @ktx/context run test
```

Expected: both commands PASS.

- [ ] **Step 5: Commit verification-only fixes if needed**

If Step 1 through Step 4 require mechanical test expectation or type fixes, run:

```bash
git add packages/cli/src packages/context/src
git commit -m "test: verify managed local ingest daemon runtime"
```

Expected: commit succeeds only when files changed during verification. If no
files changed, skip this commit.

## Self-review

Spec coverage:

- The plan uses the managed core runtime and daemon for Python-backed local
  ingest helper behavior.
- The plan preserves explicit daemon URLs and environment-variable override
  behavior.
- The plan keeps the first-use installation policy aligned with existing
  `--yes`, `--no-input`, and prompt semantics.
- The plan avoids local embedding dependency installation by requesting only
  the `core` runtime feature.

Placeholder scan:

- No placeholder markers remain in the task steps.
- Every code-changing step includes the exact code block or replacement to use.

Type consistency:

- The new managed daemon option type is named `ManagedPythonCoreDaemonOptions`.
- CLI runtime policy fields use the existing
  `KtxManagedPythonInstallPolicy` type.
- MCP local ingest reuses the existing `DefaultLocalIngestAdaptersOptions`
  through `RunLocalIngestOptions['pullConfigOptions']`.
