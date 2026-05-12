# CLI Output Harmonization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harmonize KTX CLI printing, logging, progress, and prompt behavior so command results are dev-friendly for humans while staying safe for JSON and scripted automation.

**Architecture:** Treat stdout as the result channel and stderr as the operational channel. Commander remains the command parser/output owner, Clack remains an interactive-only UI layer, and reusable `@ktx/context` code emits logs through explicit ports that default to noop. Dev-friendly result mode is a shared renderer policy: terminal users get compact pretty summaries, CI/non-TTY users get stable plain output, and `--json` gets exactly one parseable JSON payload on stdout.

**Tech Stack:** TypeScript, Commander 14, `@clack/prompts` 1.3, Vitest, pnpm workspace commands.

---

## File Structure

- Modify: `packages/context/src/ingest/adapters/metabase/fetch.ts`
  - Replace the module-level `console.*` logger with an explicit optional logger parameter that defaults to noop.
- Modify: `packages/context/src/ingest/adapters/metabase/client.ts`
  - Change `defaultLogger` from `console.*` to noop.
- Modify: `packages/context/src/ingest/adapters/looker/client.ts`
  - Change `defaultLogger` from `console.*` to noop.
- Modify: `packages/context/src/ingest/adapters/notion/fetch.ts`
  - Add an optional logger parameter and replace module-level `console.warn`.
- Modify: `packages/context/src/ingest/adapters/metabase/metabase.adapter.ts`
  - Accept and forward a logger to `fetchMetabaseBundle()`.
- Modify: `packages/context/src/ingest/adapters/notion/notion.adapter.ts`
  - Accept and forward a logger to `fetchNotionSnapshot()`.
- Modify: `packages/context/src/ingest/adapters/metabase/local-metabase.adapter.ts`
  - Accept a logger option and pass it to the Metabase client factory/adapter.
- Modify: `packages/context/src/ingest/adapters/looker/local-looker.adapter.ts`
  - Accept a logger option and pass it to `DefaultLookerConnectionClientFactory`.
- Modify: `packages/context/src/ingest/local-adapters.ts`
  - Accept a logger option and pass it to Metabase, Looker, and Notion local adapters.
- Modify: `packages/cli/src/io/mode.ts`
  - Make the result-mode policy explicit and reusable for commands that need `plain/json/pretty`.
- Create: `packages/cli/src/io/logger.ts`
  - Define `createCliOperationalLogger(io, mode)` and `createNoopOperationalLogger()`.
  - In JSON mode, default to noop unless a future `--debug` flag explicitly routes to stderr.
  - In plain/pretty/viz modes, route log/warn/error/debug through stderr.
- Modify: `packages/cli/src/ingest.ts`
  - Move fan-out progress and plain ingest progress from stdout to stderr.
  - Thread CLI operational logger into local ingest adapter creation/options.
  - Keep final result summaries on stdout.
- Modify: `packages/cli/src/local-adapters.ts`
  - Accept and thread logger options into Metabase/Looker/Notion local adapters.
- Modify: `packages/cli/src/clack.ts`
  - Expand the Clack adapter so prompts, logs, and spinners are only used through one injectable surface.
- Modify: `packages/cli/src/managed-python-command.ts`
  - Stop reading `process.stdin` / `process.stdout` directly in default prompt logic; use injected prompt deps or `KtxCliIo` capability.
- Test: `packages/context/src/ingest/adapters/metabase/fetch.test.ts`
- Test: `packages/context/src/ingest/adapters/metabase/client.test.ts`
- Test: `packages/context/src/ingest/adapters/looker/client.test.ts`
- Test: `packages/context/src/ingest/adapters/notion/fetch.test.ts`
- Test: `packages/cli/src/ingest.test.ts`
- Test: `packages/cli/src/managed-python-command.test.ts`
- Test: `packages/cli/src/io/mode.test.ts`
- Create: `packages/cli/src/io/logger.test.ts`

## Output Contract

Implement and preserve these invariants:

- `--json`: stdout contains exactly one JSON payload; stderr is empty unless the command fails before the payload or explicit debug is enabled.
- `plain`: stdout contains final command results in stable script-friendly text; progress goes to stderr.
- `pretty`: stdout contains a compact final summary optimized for terminal reading; progress, retries, warnings, and prompts go to stderr.
- `viz`: visual/TUI rendering is allowed only in an interactive terminal; unsupported terminals degrade once to plain final output and one stderr warning.
- Reusable `@ktx/context` code never calls `console.*` directly.

## Context7 Findings Applied

Current Context7 docs for Commander recommend `configureOutput()` for custom stdout/stderr routing, `exitOverride()` for programmatic handling, and Commander-native help/error controls. KTX already does this in `packages/cli/src/cli-program.ts`, so this plan keeps Commander as the parser/help/error owner.

Current Context7 docs for Clack recommend semantic `log.*`, `spinner`, and explicit `cancel`/`isCancel` handling. This plan keeps Clack as an interactive-only UI adapter and makes cancellation behavior explicit rather than allowing cancellation to degrade into missing-input paths.

---

### Task 1: Make Context Adapter Logging Explicit and Noop by Default

**Files:**
- Modify: `packages/context/src/ingest/adapters/metabase/fetch.ts`
- Modify: `packages/context/src/ingest/adapters/metabase/client.ts`
- Modify: `packages/context/src/ingest/adapters/looker/client.ts`
- Modify: `packages/context/src/ingest/adapters/notion/fetch.ts`
- Test: `packages/context/src/ingest/adapters/metabase/fetch.test.ts`
- Test: `packages/context/src/ingest/adapters/metabase/client.test.ts`
- Test: `packages/context/src/ingest/adapters/looker/client.test.ts`
- Test: `packages/context/src/ingest/adapters/notion/fetch.test.ts`

- [ ] **Step 1: Add a failing Metabase fetch test for no console output by default**

Add this test near the top of the `describe('fetchMetabaseBundle', ...)` block in `packages/context/src/ingest/adapters/metabase/fetch.test.ts`, after the existing happy-path test setup helpers:

```ts
  it('does not write Metabase fetch progress to console by default', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await fetchMetabaseBundle({
      pullConfig: { metabaseConnectionId, metabaseDatabaseId: 42 },
      stagedDir,
      ctx: makeFetchContext(),
      clientFactory,
      sourceStateReader,
    });

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Add a failing Metabase fetch test for injected warning capture**

Add this test to `packages/context/src/ingest/adapters/metabase/fetch.test.ts`:

```ts
  it('routes Metabase fetch warnings through the injected logger', async () => {
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    };
    clientFactory.__client.getCard.mockRejectedValueOnce(new Error('card read failed'));

    await fetchMetabaseBundle({
      pullConfig: { metabaseConnectionId, metabaseDatabaseId: 42 },
      stagedDir,
      ctx: makeFetchContext(),
      clientFactory,
      sourceStateReader,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith('failed to load card 1: card read failed');
  });
```

- [ ] **Step 3: Run Metabase fetch tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/metabase/fetch.test.ts
```

Expected: FAIL because `fetchMetabaseBundle()` does not accept `logger` and still uses module-level `console.*`.

- [ ] **Step 4: Implement explicit Metabase fetch logger**

In `packages/context/src/ingest/adapters/metabase/fetch.ts`, replace the module logger with this type and noop logger:

```ts
interface MetabaseFetchLogger {
  log(message: string): void;
  warn(message: string): void;
}

const noopMetabaseFetchLogger: MetabaseFetchLogger = {
  log: () => undefined,
  warn: () => undefined,
};
```

Update `FetchMetabaseBundleParams`:

```ts
export interface FetchMetabaseBundleParams {
  pullConfig: unknown;
  stagedDir: string;
  ctx: FetchContext;
  clientFactory: MetabaseClientFactory;
  sourceStateReader: MetabaseSourceStateReader;
  logger?: MetabaseFetchLogger;
}
```

At the start of `fetchMetabaseBundle()` after parsing `pullConfig`, add:

```ts
  const logger = params.logger ?? noopMetabaseFetchLogger;
```

Leave the existing `logger.warn(...)` and `logger.log(...)` call sites in place; they now refer to the local logger variable.

- [ ] **Step 5: Run Metabase fetch tests and verify they pass**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/metabase/fetch.test.ts
```

Expected: PASS.

- [ ] **Step 6: Add failing client default-logger tests**

In `packages/context/src/ingest/adapters/metabase/client.test.ts`, add this test inside `describe('MetabaseClient retry exhaustion', ...)` before retry behavior tests:

```ts
  it('does not warn to console when retrying by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const client = new MetabaseClient({ apiUrl: 'https://metabase.example.test', apiKey: 'key' }, {
      ...DEFAULT_METABASE_CLIENT_CONFIG,
      baseDelayMs: 0,
      maxRetries: 1,
    });

    await client.getDatabases();

    expect(warn).not.toHaveBeenCalled();
  });
```

In `packages/context/src/ingest/adapters/looker/client.test.ts`, add this test inside `describe('LookerClient', ...)`:

```ts
  it('does not warn to console when optional prioritization inputs fail by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fakeSdk = sdk({
      search_dashboards: vi.fn().mockRejectedValue(new Error('dashboards unavailable')),
      search_looks: vi.fn().mockRejectedValue(new Error('looks unavailable')),
    });
    const client = new LookerClient(params(), { sdkFactory: () => fakeSdk });

    await expect(client.listContentSignals()).resolves.toEqual([]);

    expect(warn).not.toHaveBeenCalled();
  });
```

- [ ] **Step 7: Run client tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/metabase/client.test.ts src/ingest/adapters/looker/client.test.ts
```

Expected: FAIL because the client default loggers still call `console.warn`.

- [ ] **Step 8: Make Metabase and Looker client defaults noop**

In `packages/context/src/ingest/adapters/metabase/client.ts`, replace `defaultLogger` with:

```ts
const defaultLogger: MetabaseClientLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
```

In `packages/context/src/ingest/adapters/looker/client.ts`, replace `defaultLogger` with:

```ts
const defaultLogger: LookerClientLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
```

- [ ] **Step 9: Add failing Notion fetch logger test**

Update `packages/context/src/ingest/adapters/notion/fetch.test.ts`. Replace the existing `console.warn` spy expectation in `it('logs skipped page materialization failures', ...)` with an injected logger:

```ts
    const logger = { warn: vi.fn() };
```

Update the `fetchNotionSnapshot()` call in that test to include:

```ts
      logger,
```

Update the final assertion to:

```ts
    expect(logger.warn).toHaveBeenCalledWith('Skipping Notion page page-1: Notion API failed');
```

- [ ] **Step 10: Implement explicit Notion fetch logger**

In `packages/context/src/ingest/adapters/notion/fetch.ts`, replace the module logger with:

```ts
interface NotionFetchLogger {
  warn(message: string): void;
}

const noopNotionFetchLogger: NotionFetchLogger = {
  warn: () => undefined,
};
```

Update `FetchNotionSnapshotParams`:

```ts
interface FetchNotionSnapshotParams {
  client: NotionApi;
  config: NotionPullConfig;
  stagedDir: string;
  logger?: NotionFetchLogger;
}
```

At the start of `fetchNotionSnapshot()`, add:

```ts
  const logger = params.logger ?? noopNotionFetchLogger;
```

Thread this logger into helpers that currently use the module-level logger. If a helper does not receive params today, add a `logger: NotionFetchLogger` field to its input object and pass the local logger through.

- [ ] **Step 11: Run context adapter tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/metabase/fetch.test.ts src/ingest/adapters/metabase/client.test.ts src/ingest/adapters/looker/client.test.ts src/ingest/adapters/notion/fetch.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit Task 1**

```bash
git add packages/context/src/ingest/adapters/metabase/fetch.ts \
  packages/context/src/ingest/adapters/metabase/fetch.test.ts \
  packages/context/src/ingest/adapters/metabase/client.ts \
  packages/context/src/ingest/adapters/metabase/client.test.ts \
  packages/context/src/ingest/adapters/looker/client.ts \
  packages/context/src/ingest/adapters/looker/client.test.ts \
  packages/context/src/ingest/adapters/notion/fetch.ts \
  packages/context/src/ingest/adapters/notion/fetch.test.ts
git commit -m "fix(context): make ingest adapter logging explicit"
```

### Task 2: Thread Operational Loggers from CLI to Local Adapters

**Files:**
- Create: `packages/cli/src/io/logger.ts`
- Create: `packages/cli/src/io/logger.test.ts`
- Modify: `packages/cli/src/local-adapters.ts`
- Modify: `packages/context/src/ingest/adapters/metabase/metabase.adapter.ts`
- Modify: `packages/context/src/ingest/adapters/metabase/local-metabase.adapter.ts`
- Modify: `packages/context/src/ingest/adapters/looker/local-looker.adapter.ts`
- Modify: `packages/context/src/ingest/local-adapters.ts`
- Modify: `packages/context/src/ingest/adapters/notion/notion.adapter.ts`
- Test: `packages/cli/src/ingest.test.ts`

- [ ] **Step 1: Write CLI logger tests**

Create `packages/cli/src/io/logger.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createCliOperationalLogger, createNoopOperationalLogger } from './logger.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('createCliOperationalLogger', () => {
  it('routes operational messages to stderr outside JSON mode', () => {
    const io = makeIo();
    const logger = createCliOperationalLogger(io.io, 'plain');

    logger.log('progress');
    logger.warn('warning');
    logger.error('failure');
    logger.debug?.('debug');

    expect(io.stdout()).toBe('');
    expect(io.stderr()).toBe('progress\nwarning\nfailure\ndebug\n');
  });

  it('suppresses operational messages in JSON mode by default', () => {
    const io = makeIo();
    const logger = createCliOperationalLogger(io.io, 'json');

    logger.log('progress');
    logger.warn('warning');
    logger.error('failure');
    logger.debug?.('debug');

    expect(io.stdout()).toBe('');
    expect(io.stderr()).toBe('');
  });
});

describe('createNoopOperationalLogger', () => {
  it('never writes', () => {
    const logger = createNoopOperationalLogger();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    logger.log('progress');
    logger.warn('warning');
    logger.error('failure');
    logger.debug?.('debug');

    expect(warn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the logger tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/io/logger.test.ts
```

Expected: FAIL because `packages/cli/src/io/logger.ts` does not exist.

- [ ] **Step 3: Implement `packages/cli/src/io/logger.ts`**

Create `packages/cli/src/io/logger.ts`:

```ts
import type { KtxCliIo } from '../cli-runtime.js';
import type { KtxOutputMode } from './mode.js';

export interface KtxOperationalLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export type KtxOperationalOutputMode = KtxOutputMode | 'viz';

function writeLine(io: KtxCliIo, message: string): void {
  io.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
}

export function createNoopOperationalLogger(): KtxOperationalLogger {
  return {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
}

export function createCliOperationalLogger(
  io: KtxCliIo,
  mode: KtxOperationalOutputMode,
): KtxOperationalLogger {
  if (mode === 'json') {
    return createNoopOperationalLogger();
  }

  return {
    log: (message) => writeLine(io, message),
    warn: (message) => writeLine(io, message),
    error: (message) => writeLine(io, message),
    debug: (message) => writeLine(io, message),
  };
}
```

- [ ] **Step 4: Run logger tests and verify they pass**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/io/logger.test.ts
```

Expected: PASS.

- [ ] **Step 5: Update adapter constructors to accept loggers**

In `packages/context/src/ingest/adapters/metabase/metabase.adapter.ts`, update the deps interface:

```ts
import type { MetabaseFetchLogger } from './fetch.js';

export interface MetabaseSourceAdapterDeps {
  clientFactory: MetabaseClientFactory;
  sourceStateReader: MetabaseSourceStateReader;
  logger?: MetabaseFetchLogger;
}
```

Forward the logger in `fetch()`:

```ts
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
```

In `packages/context/src/ingest/adapters/metabase/fetch.ts`, export the logger interface:

```ts
export interface MetabaseFetchLogger {
  log(message: string): void;
  warn(message: string): void;
}
```

In `packages/context/src/ingest/adapters/metabase/local-metabase.adapter.ts`, update options:

```ts
import type { MetabaseClientLogger } from './client.js';
import type { MetabaseFetchLogger } from './fetch.js';

interface CreateLocalMetabaseSourceAdapterOptions {
  env?: NodeJS.ProcessEnv;
  defaultClientConfig?: MetabaseClientConfig;
  logger?: MetabaseClientLogger & MetabaseFetchLogger;
}
```

Pass `options.logger` to `DefaultMetabaseConnectionClientFactory` and `MetabaseSourceAdapter`:

```ts
    options.defaultClientConfig ?? DEFAULT_METABASE_CLIENT_CONFIG,
    options.logger,
```

```ts
    ...(options.logger ? { logger: options.logger } : {}),
```

In `packages/context/src/ingest/adapters/looker/local-looker.adapter.ts`, update the factory call:

```ts
import type { LookerClientLogger } from './client.js';

export function createLocalLookerSourceAdapter(
  project: KtxLocalProject,
  env: NodeJS.ProcessEnv = process.env,
  logger?: LookerClientLogger,
): LookerSourceAdapter {
  const connectionFactory = new DefaultLookerConnectionClientFactory(createLocalLookerCredentialResolver(project, env), {
    ...(logger ? { logger } : {}),
  });
  return new LookerSourceAdapter({
    clientFactory: new DefaultLookerClientFactory(connectionFactory),
  });
}
```

In `packages/context/src/ingest/adapters/notion/notion.adapter.ts`, import `NotionFetchLogger`, add an optional logger dep, and pass it to `fetchNotionSnapshot()`:

```ts
import type { NotionFetchLogger } from './fetch.js';

export interface NotionSourceAdapterDeps {
  onPullSucceeded?: NotionPullSucceededHandler;
  logger?: NotionFetchLogger;
}
```

```ts
await fetchNotionSnapshot({
  client: new NotionClient(config.authToken),
  config,
  stagedDir,
  ...(this.deps.logger ? { logger: this.deps.logger } : {}),
});
```

- [ ] **Step 6: Update CLI local adapter factory**

In `packages/context/src/ingest/local-adapters.ts`, extend the shared local-adapter options with a logger. Import the narrow adapter logger types and use a structural intersection so one CLI operational logger can satisfy all adapters:

```ts
import type { LookerClientLogger } from './adapters/looker/client.js';
import type { MetabaseClientLogger } from './adapters/metabase/client.js';
import type { MetabaseFetchLogger } from './adapters/metabase/fetch.js';
import type { NotionFetchLogger } from './adapters/notion/fetch.js';

type LocalIngestOperationalLogger =
  & MetabaseClientLogger
  & MetabaseFetchLogger
  & LookerClientLogger
  & NotionFetchLogger;

export interface DefaultLocalIngestAdaptersOptions {
  // keep existing fields
  logger?: LocalIngestOperationalLogger;
}
```

Thread `options.logger` through the existing adapter construction points:

```ts
createLocalMetabaseSourceAdapter(project, {
  logger: options.logger,
});
```

```ts
const lookerConnectionFactory = new DefaultLookerConnectionClientFactory(
  createLocalLookerCredentialResolver(project, options.looker?.env),
  {
    ...(options.logger ? { logger: options.logger } : {}),
  },
);
```

```ts
new NotionSourceAdapter({
  ...(options.logger ? { logger: options.logger } : {}),
});
```

In `packages/cli/src/local-adapters.ts`, extend the existing CLI adapter options type with the CLI logger. Preserve the current `extends DefaultLocalIngestAdaptersOptions` shape:

```ts
import type { KtxOperationalLogger } from './io/logger.js';

export interface KtxCliLocalIngestAdaptersOptions extends DefaultLocalIngestAdaptersOptions {
  historicSqlConnectionId?: string;
  sqlAnalysis?: SqlAnalysisClient;
  logger?: KtxOperationalLogger;
}
```

Because `packages/cli/src/local-adapters.ts` already forwards `...options` into `createDefaultLocalIngestAdapters(project, { ...options, ... })`, do not add a parallel Notion local factory. The new `logger` field should flow through that existing options object.

- [ ] **Step 7: Add a failing CLI JSON-safety test for adapter logs**

In `packages/cli/src/ingest.test.ts`, add a test near `prints metabase fan-out JSON results`:

```ts
  it('keeps metabase JSON stdout free of operational adapter logs', async () => {
    const projectDir = join(tempDir, 'project');
    await writeMetabaseConfig(projectDir);
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'prod-metabase',
          adapter: 'metabase',
          outputMode: 'json',
        },
        io.io,
        {
          runLocalMetabaseIngest: async (input) => {
            input.adapters.find((adapter) => adapter.source === 'metabase');
            return {
              metabaseConnectionId: 'prod-metabase',
              status: 'all_succeeded',
              totals: { workUnits: 0, failedWorkUnits: 0 },
              children: [],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(() => JSON.parse(io.stdout())).not.toThrow();
    expect(io.stderr()).toBe('');
  });
```

- [ ] **Step 8: Thread the CLI operational logger through `runKtxIngest()`**

In `packages/cli/src/ingest.ts`, import:

```ts
import { createCliOperationalLogger } from './io/logger.js';
```

After resolving `env` and before `adapterOptions`, create:

```ts
      const operationalLogger = createCliOperationalLogger(io, args.outputMode);
```

Add the logger to `adapterOptions`:

```ts
        logger: operationalLogger,
```

Preserve existing `localIngestOptions.logger`; if both are present, `localIngestOptions.logger` should continue to flow into `runLocalIngest()` while `adapterOptions.logger` controls adapter/client operational output.

- [ ] **Step 9: Run CLI ingest tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest.test.ts src/io/logger.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 2**

```bash
git add packages/cli/src/io/logger.ts \
  packages/cli/src/io/logger.test.ts \
  packages/cli/src/local-adapters.ts \
  packages/cli/src/ingest.ts \
  packages/cli/src/ingest.test.ts \
  packages/context/src/ingest/local-adapters.ts \
  packages/context/src/ingest/adapters/metabase/metabase.adapter.ts \
  packages/context/src/ingest/adapters/metabase/local-metabase.adapter.ts \
  packages/context/src/ingest/adapters/looker/local-looker.adapter.ts \
  packages/context/src/ingest/adapters/notion/notion.adapter.ts
git commit -m "feat(cli): route ingest adapter logs through operational logger"
```

### Task 3: Move Progress to stderr and Keep stdout Result-Only

**Files:**
- Modify: `packages/cli/src/ingest.ts`
- Test: `packages/cli/src/ingest.test.ts`
- Test: `packages/cli/src/ingest-viz.test.ts`

- [ ] **Step 1: Add failing fan-out progress channel test**

In `packages/cli/src/ingest.test.ts`, update the existing fan-out progress test or add this new one near the Metabase fan-out tests:

```ts
  it('writes metabase fan-out progress to stderr and final result to stdout', async () => {
    const projectDir = join(tempDir, 'project');
    await writeMetabaseConfig(projectDir);
    const io = makeIo({ isTTY: true });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'prod-metabase',
          adapter: 'metabase',
          outputMode: 'plain',
        },
        io.io,
        {
          runLocalMetabaseIngest: async (input) => {
            input.progress?.onMetabaseFanoutPlanned({
              metabaseConnectionId: 'prod-metabase',
              children: [{ metabaseDatabaseId: 1, targetConnectionId: 'warehouse_a' }],
            });
            input.progress?.onMetabaseChildStarted({
              metabaseConnectionId: 'prod-metabase',
              metabaseDatabaseId: 1,
              targetConnectionId: 'warehouse_a',
              jobId: 'metabase-child-1',
            });
            return {
              metabaseConnectionId: 'prod-metabase',
              status: 'all_succeeded',
              totals: { workUnits: 0, failedWorkUnits: 0 },
              children: [],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toContain('Metabase ingest: prod-metabase');
    expect(io.stderr()).toContain('status=running job=metabase-child-1');
    expect(io.stdout()).toContain('Metabase fan-out: all_succeeded');
    expect(io.stdout()).not.toContain('status=running job=metabase-child-1');
  });
```

- [ ] **Step 2: Add failing plain progress channel test**

In `packages/cli/src/ingest.test.ts`, add this test near the local ingest progress tests:

```ts
  it('writes plain TTY ingest progress to stderr and final report to stdout', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => completedLocalBundleRun(input, 'local-job-1'));
    const io = makeIo({ isTTY: true });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'plain',
        },
        io.io,
        { runLocalIngest: runLocal },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toContain('[5%] Fetching source files for warehouse/fake');
    expect(io.stdout()).toContain('Report: report-live-1');
    expect(io.stdout()).not.toContain('[5%]');
  });
```

- [ ] **Step 3: Run ingest tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest.test.ts
```

Expected: FAIL because progress currently writes to stdout.

- [ ] **Step 4: Change Metabase fan-out progress to stderr**

In `packages/cli/src/ingest.ts`, update `createMetabaseFanoutProgress()`:

```ts
function createMetabaseFanoutProgress(
  connectionId: string,
  io: KtxIngestIo,
): LocalMetabaseFanoutProgress {
  io.stderr.write(`Metabase ingest: ${connectionId}\n`);
  io.stderr.write('Checking mappings and scheduled-pull targets...\n');
  return {
    onMetabaseFanoutPlanned(event) {
      io.stderr.write(`Targets: ${pluralize(event.children.length, 'mapped database')}\n`);
      for (const child of event.children) {
        io.stderr.write(`- database=${child.metabaseDatabaseId} target=${child.targetConnectionId} status=queued\n`);
      }
    },
    onMetabaseChildStarted(event) {
      io.stderr.write(
        `- database=${event.metabaseDatabaseId} target=${event.targetConnectionId} status=running job=${event.jobId}\n`,
      );
    },
    onMetabaseChildCompleted(event) {
      io.stderr.write(
        `- database=${event.metabaseDatabaseId} target=${event.targetConnectionId} status=${event.status} job=${event.jobId}\n`,
      );
    },
  };
}
```

- [ ] **Step 5: Change plain ingest progress renderer to stderr**

In `packages/cli/src/ingest.ts`, update only the `write()` helper inside `createPlainIngestProgressRenderer()`:

```ts
  const write = (percent: number, message: string) => {
    const nextPercent = Math.max(lastPercent, Math.max(0, Math.min(100, percent)));
    lastPercent = nextPercent;
    io.stderr.write(`[${nextPercent}%] ${message}\n`);
  };
```

- [ ] **Step 6: Update existing tests that intentionally asserted progress on stdout**

Search:

```bash
rg -n "\\[5%\\]|Metabase ingest:|status=running job|\\[15%\\]" packages/cli/src/ingest.test.ts packages/cli/src/ingest-viz.test.ts
```

For progress assertions, move expected text from `io.stdout()` to `io.stderr()`. Keep final result/report assertions on `io.stdout()`.

- [ ] **Step 7: Run ingest and viz tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest.test.ts src/ingest-viz.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add packages/cli/src/ingest.ts packages/cli/src/ingest.test.ts packages/cli/src/ingest-viz.test.ts
git commit -m "fix(cli): keep ingest progress off stdout"
```

### Task 4: Centralize Clack Prompt and Cancellation Behavior

**Files:**
- Modify: `packages/cli/src/clack.ts`
- Modify: `packages/cli/src/managed-python-command.ts`
- Test: `packages/cli/src/managed-python-command.test.ts`
- Test: setup prompt tests only if touched by implementation

- [ ] **Step 1: Add failing managed-runtime injected prompt test**

In `packages/cli/src/managed-python-command.test.ts`, add this test:

```ts
  it('uses injected runtime confirmation instead of reading process TTY directly', async () => {
    const io = makeIo();
    const installRuntime = vi.fn(async (): Promise<ManagedPythonRuntimeInstallResult> => ({
      layout: layout(),
      manifest: manifest(['core']),
    }));
    const confirmInstall = vi.fn(async () => true);

    await expect(
      createManagedPythonSemanticLayerComputePort({
        cliVersion: '0.2.0',
        installPolicy: 'prompt',
        io: io.io,
        readStatus: async () => missingStatus(),
        installRuntime,
        confirmInstall,
        createPythonCompute: () => ({ query: vi.fn(), validate: vi.fn(), close: vi.fn() }),
      }),
    ).resolves.toBeTruthy();

    expect(confirmInstall).toHaveBeenCalledWith(
      'KTX needs to install the core Python runtime. This downloads Python dependencies with uv. Continue?',
    );
    expect(io.stderr()).toContain('Installing KTX Python runtime (core) with uv...');
  });
```

This test should already pass for the injected case. It protects the desired seam before changing the default path.

- [ ] **Step 2: Add failing default prompt IO-capability test**

In `packages/cli/src/managed-python-command.test.ts`, add:

```ts
  it('can decide default runtime prompting from injected io capabilities', async () => {
    const io = makeIo();
    Object.assign(io.io.stdout, { isTTY: false });

    await expect(
      createManagedPythonSemanticLayerComputePort({
        cliVersion: '0.2.0',
        installPolicy: 'prompt',
        io: io.io,
        readStatus: async () => missingStatus(),
        installRuntime: vi.fn(),
        createPythonCompute: () => ({ query: vi.fn(), validate: vi.fn(), close: vi.fn() }),
      }),
    ).rejects.toThrow('KTX Python runtime installation was cancelled');
  });
```

If this passes without code changes, keep it as a regression test and continue. The implementation still removes direct process reads.

- [ ] **Step 3: Expand the Clack adapter**

In `packages/cli/src/clack.ts`, replace the file contents with:

```ts
import { cancel, confirm, isCancel, log, spinner } from '@clack/prompts';

export interface KtxCliSpinner {
  start(message: string): void;
  stop(message: string): void;
  error(message: string): void;
}

export interface KtxCliPromptAdapter {
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean>;
  cancel(message: string): void;
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    success(message: string): void;
    step(message: string): void;
  };
  spinner(): KtxCliSpinner;
}

export class KtxCliPromptCancelledError extends Error {
  constructor(message = 'Operation cancelled.') {
    super(message);
    this.name = 'KtxCliPromptCancelledError';
  }
}

export function createClackSpinner(): KtxCliSpinner {
  return spinner();
}

export function createClackPromptAdapter(): KtxCliPromptAdapter {
  return {
    async confirm(options) {
      const value = await confirm(options);
      if (isCancel(value)) {
        cancel('Operation cancelled.');
        throw new KtxCliPromptCancelledError();
      }
      return value;
    },
    cancel(message) {
      cancel(message);
    },
    log: {
      info(message) {
        log.info(message);
      },
      warn(message) {
        log.warn(message);
      },
      error(message) {
        log.error(message);
      },
      success(message) {
        log.success(message);
      },
      step(message) {
        log.step(message);
      },
    },
    spinner() {
      return createClackSpinner();
    },
  };
}
```

- [ ] **Step 4: Update managed runtime default confirm**

In `packages/cli/src/managed-python-command.ts`, change imports:

```ts
import { createClackPromptAdapter } from './clack.js';
```

Remove direct imports from `@clack/prompts`.

Update `ManagedPythonCommandDeps`:

```ts
  confirmInstall?: (message: string, io: KtxCliIo) => Promise<boolean>;
```

Replace `defaultConfirmInstall()` with:

```ts
async function defaultConfirmInstall(message: string, io: KtxCliIo): Promise<boolean> {
  if (io.stdout.isTTY !== true) {
    return false;
  }
  const prompts = createClackPromptAdapter();
  return await prompts.confirm({ message, initialValue: true });
}
```

Update the call site:

```ts
    const confirmInstall = options.confirmInstall ?? defaultConfirmInstall;
    const confirmed = await confirmInstall(installPrompt(feature), options.io);
```

- [ ] **Step 5: Update test types for `confirmInstall`**

In `packages/cli/src/managed-python-command.test.ts`, update any injected `confirmInstall` mocks to accept the second `io` argument if TypeScript requires it:

```ts
const confirmInstall = vi.fn(async (_message: string) => true);
```

No behavior change is required for tests that ignore the second argument.

- [ ] **Step 6: Run managed runtime tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/managed-python-command.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run setup prompt tests touched by shared Clack exports**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup.test.ts src/setup-databases.test.ts src/setup-models.test.ts src/setup-sources.test.ts src/setup-embeddings.test.ts
```

Expected: PASS. If this is slow locally, run it once and inspect the full output rather than repeatedly filtering.

- [ ] **Step 8: Commit Task 4**

```bash
git add packages/cli/src/clack.ts packages/cli/src/managed-python-command.ts packages/cli/src/managed-python-command.test.ts
git commit -m "refactor(cli): centralize Clack prompt handling"
```

### Task 5: Make Dev-Friendly Result Mode Reusable

**Files:**
- Modify: `packages/cli/src/io/mode.ts`
- Modify: `packages/cli/src/io/print-list.ts`
- Test: `packages/cli/src/io/mode.test.ts`
- Test: `packages/cli/src/sl.test.ts`
- Optional later consumers: `packages/cli/src/knowledge.ts`, `packages/cli/src/connection.ts`, `packages/cli/src/runtime.ts`

- [ ] **Step 1: Add output mode tests for the contract**

Create or update `packages/cli/src/io/mode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveOutputMode } from './mode.js';

function io(isTTY?: boolean) {
  return {
    stdout: {
      isTTY,
      write: () => undefined,
    },
    stderr: {
      write: () => undefined,
    },
  };
}

describe('resolveOutputMode', () => {
  it('prefers explicit JSON over every other output setting', () => {
    expect(resolveOutputMode({ json: true, explicit: 'pretty', io: io(true), env: { KTX_OUTPUT: 'plain' } })).toBe(
      'json',
    );
  });

  it('uses pretty for interactive terminals by default', () => {
    expect(resolveOutputMode({ io: io(true), env: {} })).toBe('pretty');
  });

  it('uses plain in CI even when stdout looks like a TTY', () => {
    expect(resolveOutputMode({ io: io(true), env: { CI: 'true' } })).toBe('plain');
  });

  it('uses plain when stdout is redirected', () => {
    expect(resolveOutputMode({ io: io(false), env: {} })).toBe('plain');
  });

  it('rejects invalid KTX_OUTPUT values', () => {
    expect(() => resolveOutputMode({ io: io(false), env: { KTX_OUTPUT: 'verbose' } })).toThrow(
      'Invalid KTX_OUTPUT value: verbose. Expected one of pretty, plain, json.',
    );
  });
});
```

- [ ] **Step 2: Run output mode tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/io/mode.test.ts
```

Expected: PASS or FAIL only if the file does not exist yet. Implement the test file if needed.

- [ ] **Step 3: Make `printList` output explicitly dev-friendly**

In `packages/cli/src/io/print-list.ts`, preserve the existing pretty renderer but add a small JSON helper for result envelopes:

```ts
export interface KtxJsonResultEnvelope<T> {
  kind: string;
  data: T;
  meta?: Record<string, unknown>;
}

export function writeJsonResult<T>(io: KtxCliIo, envelope: KtxJsonResultEnvelope<T>): void {
  io.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}
```

Update `printListJson()`:

```ts
function printListJson<Row extends object>(args: PrintListArgs<Row>): void {
  writeJsonResult(args.io, {
    kind: 'list',
    data: { items: args.rows },
    meta: { command: args.command },
  });
}
```

- [ ] **Step 4: Add JSON helper tests through `sl list`**

In `packages/cli/src/sl.test.ts`, ensure `sl list --json` parses as exactly one envelope. If no such test exists, add:

```ts
  it('prints sl list JSON as a single result envelope', async () => {
    const projectDir = await createProjectWithSlSource();
    const listIo = makeIo();

    await expect(
      runKtxSl({ command: 'list', projectDir, json: true }, listIo.io),
    ).resolves.toBe(0);

    expect(listIo.stderr()).toBe('');
    expect(JSON.parse(listIo.stdout())).toMatchObject({
      kind: 'list',
      data: {
        items: expect.any(Array),
      },
      meta: {
        command: 'sl list',
      },
    });
  });
```

Use the existing project/source helper names from `sl.test.ts`; do not invent new helpers if the file already has a fixture builder.

- [ ] **Step 5: Run `sl` and output tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/io/mode.test.ts src/sl.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add packages/cli/src/io/mode.ts packages/cli/src/io/mode.test.ts packages/cli/src/io/print-list.ts packages/cli/src/sl.test.ts
git commit -m "feat(cli): formalize dev-friendly result output"
```

### Task 6: Regression Sweep for stdout/JSON Safety

**Files:**
- Modify tests only if gaps are found:
  - `packages/cli/src/index.test.ts`
  - `packages/cli/src/ingest.test.ts`
  - `packages/cli/src/scan.test.ts`
  - `packages/cli/src/runtime.test.ts`
  - `packages/cli/src/setup.test.ts`
  - `packages/cli/src/connection.test.ts`

- [ ] **Step 1: Search remaining direct console calls in shipped packages**

Run:

```bash
rg -n "console\\.(log|warn|error|debug)" packages/cli/src packages/context/src -g '!*.test.ts'
```

Expected: no matches in shipped code. If matches remain in scripts or tests, leave them alone. If matches remain under `packages/context/src` or `packages/cli/src`, convert them to injected logger/io or justify them in the final handoff.

- [ ] **Step 2: Search direct process stdout/stderr reads in CLI code**

Run:

```bash
rg -n "process\\.(stdout|stderr|stdin)" packages/cli/src -g '!*.test.ts'
```

Expected allowed matches:

- terminal sizing fallbacks such as `process.stdout.columns`
- startup profiling to `process.stderr`
- `runKtxCli(..., io = process)` entry defaults

Any prompt behavior or command result printing found here should be converted to `KtxCliIo`.

- [ ] **Step 3: Add index-level JSON safety tests for representative commands**

In `packages/cli/src/index.test.ts`, add a table-driven test for commands that should produce parseable JSON without stderr:

```ts
  it('keeps representative JSON command stdout parseable', async () => {
    const commands = [
      {
        argv: ['--project-dir', tempDir, 'setup', 'status', '--json'],
        deps: {},
      },
      {
        argv: ['--project-dir', tempDir, 'sl', 'list', '--json'],
        deps: {},
      },
    ];

    for (const command of commands) {
      const testIo = makeIo();
      await runKtxCli(command.argv, testIo.io, command.deps);

      expect(() => JSON.parse(testIo.stdout())).not.toThrow();
      expect(testIo.stderr()).toBe('');
    }
  });
```

Use existing setup helpers in `index.test.ts` so `tempDir` contains a valid KTX project before the test runs.

- [ ] **Step 4: Run focused CLI regression tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/index.test.ts src/ingest.test.ts src/sl.test.ts src/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run package type checks**

Run:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 6: Run package tests**

Run:

```bash
pnpm --filter @ktx/context run test
pnpm --filter @ktx/cli run test
```

Expected: PASS. If slow tests are excluded by package scripts, also run affected slow CLI tests explicitly:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest.test.ts src/ingest-viz.test.ts src/setup.test.ts src/setup-databases.test.ts src/setup-models.test.ts src/setup-sources.test.ts src/setup-embeddings.test.ts --testTimeout 30000
```

- [ ] **Step 7: Run pre-commit on changed files**

Run:

```bash
uv run pre-commit run --files \
  packages/context/src/ingest/adapters/metabase/fetch.ts \
  packages/context/src/ingest/adapters/metabase/fetch.test.ts \
  packages/context/src/ingest/adapters/metabase/client.ts \
  packages/context/src/ingest/adapters/metabase/client.test.ts \
  packages/context/src/ingest/adapters/looker/client.ts \
  packages/context/src/ingest/adapters/looker/client.test.ts \
  packages/context/src/ingest/adapters/notion/fetch.ts \
  packages/context/src/ingest/adapters/notion/fetch.test.ts \
  packages/context/src/ingest/adapters/metabase/metabase.adapter.ts \
  packages/context/src/ingest/adapters/metabase/local-metabase.adapter.ts \
  packages/context/src/ingest/adapters/looker/local-looker.adapter.ts \
  packages/context/src/ingest/adapters/notion/notion.adapter.ts \
  packages/cli/src/io/logger.ts \
  packages/cli/src/io/logger.test.ts \
  packages/cli/src/io/mode.ts \
  packages/cli/src/io/mode.test.ts \
  packages/cli/src/io/print-list.ts \
  packages/cli/src/local-adapters.ts \
  packages/cli/src/ingest.ts \
  packages/cli/src/ingest.test.ts \
  packages/cli/src/ingest-viz.test.ts \
  packages/cli/src/clack.ts \
  packages/cli/src/managed-python-command.ts \
  packages/cli/src/managed-python-command.test.ts \
  packages/cli/src/sl.test.ts \
  packages/cli/src/index.test.ts
```

Expected: PASS. If pre-commit is unavailable or version-pinned beyond the local `uv`, state the blocker and run the closest package checks above.

- [ ] **Step 8: Commit regression sweep**

```bash
git add packages/cli/src packages/context/src
git commit -m "test(cli): cover output channel invariants"
```

## Self-Review

**Spec coverage:** This plan covers the requested harmonization across Commander, Clack, stdout/stderr, JSON safety, adapter logging, progress rendering, and dev-friendly result output. It explicitly targets implementation inconsistencies found in `packages/context` adapters, `packages/cli/src/ingest.ts`, `packages/cli/src/clack.ts`, `packages/cli/src/managed-python-command.ts`, and shared output helpers.

**Marker scan:** The plan avoids unfinished-marker text. The only conditional instruction is to use existing fixture helper names in `sl.test.ts` and `index.test.ts`, because those names must be confirmed in the file at execution time to avoid inventing duplicate helpers.

**Type consistency:** The plan uses `KtxCliIo`, `KtxOutputMode`, `KtxOperationalLogger`, `MetabaseFetchLogger`, `MetabaseClientLogger`, `LookerClientLogger`, and `NotionFetchLogger` consistently. The one cross-package rule is intentional: reusable context code owns noop defaults; CLI code owns stderr/noop operational routing.
