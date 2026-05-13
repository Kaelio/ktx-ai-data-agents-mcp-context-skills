# Unified Ingest V1 Progress Copy Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the remaining v1-blocking scan wording from normal public
unified-ingest progress, failure, and setup scope-selection output.

**Architecture:** Keep the implemented connection-centric ingest planner,
hidden legacy commands, and foreground context-build view. Add a small shared
public-copy helper for lower-level database ingest and query-history messages,
then use it from foreground progress and direct public failure summarization.

**Tech Stack:** TypeScript ESM, Commander, Vitest, KTX CLI/context packages.

---

## Current audit

The implemented unified-ingest plan chain covers the original spec's main v1
behavior:

- `ktx ingest [connectionId]`, `ktx ingest --all`, `--fast`, `--deep`,
  `--query-history`, `--no-query-history`, and
  `--query-history-window-days` route through `public-ingest.ts`.
- Database targets run before source targets, inferred public adapters bypass
  `ingest.adapters`, and `fast` or `deep` maps to structural or enriched
  database ingest internals.
- Deep readiness is evaluated before target work starts, and `--all` isolates
  per-target deep-readiness failures.
- Setup stores `connections.<id>.context.depth` and
  `connections.<id>.context.queryHistory`, migrates legacy `historicSql`, and
  uses foreground-only setup context state.
- Normal help hides `ktx scan`, `ktx ingest run`, and `ktx ingest watch`; docs
  and command-tree output no longer present those as normal public workflows.

### V1-blocking gaps

- Foreground `ktx ingest` and setup context-build progress still pass database
  ingest progress messages through from scan internals. A normal user can see
  messages such as `Preparing scan`, even though the spec says the foreground
  view must use `reading schema` or `building schema context` and must not show
  `scan` in normal mode.
- Direct public database ingest failure summaries sanitize `live-database` and
  `historic-sql`, but not scan-specific failure lines such as
  `KTX scan enrichment failed after structural scan completed: ...`.
- Interactive database setup still asks for `PostgreSQL schemas to scan`, which
  keeps scan wording in normal setup output after the public model changed to
  database schema context.

### Non-blocking gaps

- Hidden debug commands can remain callable: `ktx scan`, `ktx ingest run`, and
  `ktx ingest watch`.
- Internal adapter keys, raw artifact paths, WorkUnit keys, package names,
  tests, and developer-only scripts can continue to use `scan`,
  `live-database`, and `historic-sql`.
- README package taxonomy such as `Postgres scan connector` can remain because
  it describes internal package ownership, not normal command usage.
- Internal readiness configuration names such as `scan.enrichment.mode` can
  remain because they refer to existing `ktx.yaml` configuration fields.

## File structure

- Create `packages/cli/src/public-ingest-copy.ts`: shared copy sanitizer for
  database ingest and query-history messages used by public output paths.
- Create `packages/cli/src/public-ingest-copy.test.ts`: unit coverage for the
  sanitizer.
- Modify `packages/cli/src/context-build-view.ts`: sanitize foreground
  database progress messages and reuse the shared query-history sanitizer.
- Modify `packages/cli/src/context-build-view.test.ts`: cover foreground
  progress output with lower-level scan messages.
- Modify `packages/cli/src/public-ingest.ts`: use the shared public output-line
  sanitizer for captured failure details.
- Modify `packages/cli/src/public-ingest.test.ts`: cover direct public failure
  output for scan-enrichment failures.
- Modify `packages/cli/src/setup-databases.ts`: change the schema scope prompt
  from `schemas to scan` to `schemas to include`.
- Modify `packages/cli/src/setup-databases.test.ts`: update the schema prompt
  expectation and assert scan wording is absent.

## Tasks

### Task 1: Add shared public ingest copy sanitizers

**Files:**
- Create: `packages/cli/src/public-ingest-copy.ts`
- Create: `packages/cli/src/public-ingest-copy.test.ts`

- [ ] **Step 1: Write the public-copy tests**

Create `packages/cli/src/public-ingest-copy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  publicDatabaseIngestMessage,
  publicIngestOutputLine,
  publicQueryHistoryMessage,
} from './public-ingest-copy.js';

describe('public ingest copy sanitizers', () => {
  it('maps database scan progress into schema-context wording', () => {
    expect(publicDatabaseIngestMessage('Preparing scan')).toBe('Preparing database ingest');
    expect(publicDatabaseIngestMessage('Inspecting database schema')).toBe('Reading database schema');
    expect(publicDatabaseIngestMessage('Writing schema artifacts')).toBe('Writing schema context');
    expect(publicDatabaseIngestMessage('Enriching schema metadata')).toBe('Building enriched schema context');
  });

  it('maps database scan failure text into public database ingest wording', () => {
    expect(
      publicDatabaseIngestMessage(
        'KTX scan enrichment failed after structural scan completed: embedding service timed out',
      ),
    ).toBe('Database enrichment failed after schema context completed: embedding service timed out');
    expect(publicDatabaseIngestMessage('structural scan wrote partial artifacts')).toBe(
      'schema context wrote partial artifacts',
    );
    expect(publicDatabaseIngestMessage('scan results may be less complete')).toBe(
      'database context may be less complete',
    );
  });

  it('maps query-history adapter progress into public wording', () => {
    expect(publicQueryHistoryMessage('Fetching source files for warehouse/historic-sql', 'warehouse')).toBe(
      'Fetching query history for warehouse',
    );
    expect(publicQueryHistoryMessage('Curating warehouse/historic-sql work units', 'warehouse')).toBe(
      'Curating warehouse query history work units',
    );
    expect(publicQueryHistoryMessage('historic SQL local ingest failed', 'warehouse')).toBe(
      'query history local ingest failed',
    );
  });

  it('sanitizes captured public output lines across database and query-history internals', () => {
    expect(
      publicIngestOutputLine(
        'KTX scan enrichment failed after structural scan completed in raw-sources/warehouse/live-database/sync-1',
      ),
    ).toBe('Database enrichment failed after schema context completed in raw-sources/warehouse/database schema/sync-1');
    expect(publicIngestOutputLine('Historic SQL local ingest requires a configured reader')).toBe(
      'query history local ingest requires a configured reader',
    );
  });
});
```

- [ ] **Step 2: Run the failing public-copy tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest-copy.test.ts
```

Expected: FAIL because `packages/cli/src/public-ingest-copy.ts` does not exist.

- [ ] **Step 3: Implement the shared sanitizers**

Create `packages/cli/src/public-ingest-copy.ts`:

```ts
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DATABASE_INGEST_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bPreparing scan\b/gi, 'Preparing database ingest'],
  [/\bInspecting database schema\b/gi, 'Reading database schema'],
  [/\bWriting schema artifacts\b/gi, 'Writing schema context'],
  [/\bEnriching schema metadata\b/gi, 'Building enriched schema context'],
  [
    /\bKTX scan enrichment failed after structural scan completed\b/gi,
    'Database enrichment failed after schema context completed',
  ],
  [/\bstructural scan\b/gi, 'schema context'],
  [/\benriched scan\b/gi, 'deep database ingest'],
  [/\bscan results\b/gi, 'database context'],
];

export function publicDatabaseIngestMessage(message: string): string {
  return DATABASE_INGEST_REPLACEMENTS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    message,
  );
}

export function publicQueryHistoryMessage(message: string, connectionId?: string): string {
  let current = message;
  if (connectionId && connectionId.length > 0) {
    const escapedConnectionId = escapeRegExp(connectionId);
    current = current
      .replace(
        new RegExp(`Fetching source files for ${escapedConnectionId}/historic-sql`, 'i'),
        `Fetching query history for ${connectionId}`,
      )
      .replace(`${connectionId}/historic-sql`, `${connectionId} query history`);
  }
  return current.replace(/\bhistoric-sql\b/g, 'query history').replace(/\bhistoric SQL\b/gi, 'query history');
}

export function publicIngestOutputLine(line: string): string {
  return publicQueryHistoryMessage(publicDatabaseIngestMessage(line)).replace(/\blive-database\b/g, 'database schema');
}
```

- [ ] **Step 4: Run the public-copy tests again**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest-copy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the shared sanitizer**

Run:

```bash
git add packages/cli/src/public-ingest-copy.ts packages/cli/src/public-ingest-copy.test.ts
git commit -m "fix(cli): add public ingest copy sanitizers"
```

### Task 2: Sanitize foreground progress and captured public failures

**Files:**
- Modify: `packages/cli/src/context-build-view.ts`
- Modify: `packages/cli/src/context-build-view.test.ts`
- Modify: `packages/cli/src/public-ingest.ts`
- Modify: `packages/cli/src/public-ingest.test.ts`
- Test: `packages/cli/src/public-ingest-copy.test.ts`

- [ ] **Step 1: Write the failing foreground progress test**

In `packages/cli/src/context-build-view.test.ts`, add this test inside the
`runContextBuild` describe block near the existing query-history progress test:

```ts
  it('renders database ingest progress without scan wording', async () => {
    const io = makeIo();
    const project = projectWithConnections({ warehouse: { driver: 'postgres' } });
    const executeTarget = vi.fn(async (target, _args, _targetIo, deps) => {
      await deps.scanProgress?.update(0.05, 'Preparing scan');
      await deps.scanProgress?.update(0.15, 'Inspecting database schema');
      await deps.scanProgress?.update(0.7, 'Writing schema artifacts');
      return successResult(target.connectionId, target.driver, target.operation);
    });

    await expect(
      runContextBuild(
        project,
        {
          projectDir: '/tmp/project',
          inputMode: 'disabled',
          targetConnectionId: 'warehouse',
          all: false,
        },
        io.io,
        { executeTarget, now: () => 1000, sourceProgressThrottleMs: 0 },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(io.stdout()).toContain('Preparing database ingest');
    expect(io.stdout()).toContain('Reading database schema');
    expect(io.stdout()).toContain('Writing schema context');
    expect(io.stdout()).not.toContain('Preparing scan');
    expect(io.stdout()).not.toMatch(/\bscan\b/i);
  });
```

- [ ] **Step 2: Write the failing direct public failure test**

In `packages/cli/src/public-ingest.test.ts`, add this test inside the
`runKtxPublicIngest` describe block near
`suppresses internal scan output for public database ingest summaries`:

```ts
  it('sanitizes captured database scan failure details in direct public output', async () => {
    const io = makeIo();
    const project = deepReadyProject({ warehouse: { driver: 'postgres', context: { depth: 'deep' } } });
    const runScan = vi.fn(async (_args, scanIo) => {
      scanIo.stdout.write('KTX scan enrichment failed after structural scan completed: embedding service timed out\n');
      return 1;
    });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'disabled',
          depth: 'deep',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan },
      ),
    ).resolves.toBe(1);

    expect(io.stdout()).toContain(
      'warehouse failed: Database enrichment failed after schema context completed: embedding service timed out.',
    );
    expect(io.stdout()).toContain('Retry: ktx ingest warehouse --project-dir /tmp/project --deep');
    expect(io.stdout()).not.toContain('KTX scan enrichment failed');
    expect(io.stdout()).not.toContain('structural scan');
  });
```

- [ ] **Step 3: Run the failing integration tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/context-build-view.test.ts src/public-ingest.test.ts -t "database ingest progress|captured database scan failure" --testTimeout 30000
```

Expected: FAIL because foreground progress still prints `Preparing scan`, and
captured direct failures still print the lower-level scan failure text.

- [ ] **Step 4: Use the shared sanitizer in foreground progress**

In `packages/cli/src/context-build-view.ts`, add this import:

```ts
import { publicDatabaseIngestMessage, publicQueryHistoryMessage } from './public-ingest-copy.js';
```

Replace the existing `publicProgressMessage()` implementation:

```ts
function publicProgressMessage(message: string, target: KtxPublicIngestPlanTarget): string {
  if (!target.steps.includes('query-history')) {
    return message;
  }
  return message
    .replace(
      new RegExp(`Fetching source files for ${target.connectionId}/historic-sql`, 'i'),
      `Fetching query history for ${target.connectionId}`,
    )
    .replace(`${target.connectionId}/historic-sql`, `${target.connectionId} query history`)
    .replace(/\bhistoric-sql\b/g, 'query history')
    .replace(/\bhistoric SQL\b/gi, 'query history');
}
```

with:

```ts
function publicProgressMessage(message: string, target: KtxPublicIngestPlanTarget): string {
  if (target.operation === 'database-ingest') {
    return publicDatabaseIngestMessage(message);
  }
  if (target.steps.includes('query-history')) {
    return publicQueryHistoryMessage(message, target.connectionId);
  }
  return message;
}
```

- [ ] **Step 5: Use the shared sanitizer in public ingest failure capture**

In `packages/cli/src/public-ingest.ts`, add this import:

```ts
import { publicIngestOutputLine } from './public-ingest-copy.js';
```

Delete the local `publicIngestOutputLine()` function:

```ts
function publicIngestOutputLine(line: string): string {
  return line
    .replace(/\blive-database\b/g, 'database schema')
    .replace(/\bhistoric-sql\b/g, 'query history')
    .replace(/\bhistoric SQL\b/gi, 'query history');
}
```

Leave `firstCapturedFailureLine()` calling `publicIngestOutputLine` unchanged;
the imported function now provides the broader public wording.

- [ ] **Step 6: Run the integration tests again**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest-copy.test.ts src/context-build-view.test.ts src/public-ingest.test.ts --testTimeout 30000
```

Expected: PASS.

- [ ] **Step 7: Commit foreground and failure sanitization**

Run:

```bash
git add packages/cli/src/context-build-view.ts packages/cli/src/context-build-view.test.ts packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts packages/cli/src/public-ingest-copy.ts packages/cli/src/public-ingest-copy.test.ts
git commit -m "fix(cli): sanitize public ingest progress copy"
```

### Task 3: Rename setup schema scope prompt

**Files:**
- Modify: `packages/cli/src/setup-databases.ts`
- Modify: `packages/cli/src/setup-databases.test.ts`

- [ ] **Step 1: Update the setup prompt expectation**

In `packages/cli/src/setup-databases.test.ts`, in the test named
`prompts for discovered Postgres schemas before the first scan`, replace:

```ts
      message: expect.stringContaining('PostgreSQL schemas to scan'),
```

with:

```ts
      message: expect.stringContaining('PostgreSQL schemas to include'),
```

Add this assertion after the `toHaveBeenCalledWith` block:

```ts
    expect(String(prompts.multiselect.mock.calls[0]?.[0].message)).not.toContain('to scan');
```

- [ ] **Step 2: Run the failing setup prompt test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-databases.test.ts -t "prompts for discovered Postgres schemas before the first scan" --testTimeout 30000
```

Expected: FAIL because the prompt still says `PostgreSQL schemas to scan`.

- [ ] **Step 3: Rename the setup scope prompt**

In `packages/cli/src/setup-databases.ts`, replace:

```ts
        `${spec.promptLabel} to scan\n` +
          `KTX found multiple ${spec.nounPlural}. Select every ${spec.noun} agents should use.`,
```

with:

```ts
        `${spec.promptLabel} to include\n` +
          `KTX found multiple ${spec.nounPlural}. Select every ${spec.noun} agents should use.`,
```

- [ ] **Step 4: Run the setup prompt test again**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-databases.test.ts -t "prompts for discovered Postgres schemas before the first scan" --testTimeout 30000
```

Expected: PASS.

- [ ] **Step 5: Commit setup prompt wording**

Run:

```bash
git add packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts
git commit -m "fix(cli): rename setup schema scope prompt"
```

### Task 4: Final verification

**Files:**
- Verify: `packages/cli/src/public-ingest-copy.ts`
- Verify: `packages/cli/src/context-build-view.ts`
- Verify: `packages/cli/src/public-ingest.ts`
- Verify: `packages/cli/src/setup-databases.ts`

- [ ] **Step 1: Run targeted unified-ingest tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest-copy.test.ts src/context-build-view.test.ts src/public-ingest.test.ts src/setup-databases.test.ts --testTimeout 30000
```

Expected: PASS.

- [ ] **Step 2: Run CLI type-check**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 3: Scan normal public files for the closed wording gaps**

Run:

```bash
rg -n "Preparing scan|KTX scan enrichment failed|structural scan completed|schemas to scan" packages/cli/src/context-build-view.ts packages/cli/src/public-ingest.ts packages/cli/src/setup-databases.ts packages/cli/src/*.test.ts
```

Expected: no matches except historical expectations in low-level `scan.test.ts`
or internal scan-specific tests that are not part of the command above.

- [ ] **Step 4: Run workspace dead-code check**

Run:

```bash
pnpm run dead-code
```

Expected: PASS.

- [ ] **Step 5: Commit final verification marker if needed**

If the verification steps required only the commits above, no additional
commit is needed. If a verification fix changed files, run:

```bash
git add packages/cli/src/public-ingest-copy.ts packages/cli/src/public-ingest-copy.test.ts packages/cli/src/context-build-view.ts packages/cli/src/context-build-view.test.ts packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts
git commit -m "test(cli): verify unified ingest public progress copy"
```

## Self-review

Spec coverage: this plan covers the remaining normal public output paths where
scan wording still leaks into unified ingest:

- Foreground progress now maps database scan progress into schema-context copy.
- Captured direct public failure summaries now map scan-enrichment failures into
  database ingest copy.
- Interactive setup schema scope selection now says `schemas to include`, not
  `schemas to scan`.

The plan intentionally leaves hidden debug commands, internal artifact paths,
developer scripts, low-level scan tests, and configuration field names alone.
Those are non-blocking under the original spec's implementation-detail
allowances.

Placeholder scan: no task uses deferred code markers, unnamed edge handling, or
undefined helper names. Every changed helper, test, and command is named with
the file that owns it.

Type consistency: the new helper exports
`publicDatabaseIngestMessage()`, `publicQueryHistoryMessage()`, and
`publicIngestOutputLine()`. Later tasks import those exact names from
`./public-ingest-copy.js`.
