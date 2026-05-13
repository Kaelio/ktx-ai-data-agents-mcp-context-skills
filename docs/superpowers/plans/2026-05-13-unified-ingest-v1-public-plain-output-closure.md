# Unified Ingest V1 Public Plain Output Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the last v1-blocking adapter-centric and internal source-key leaks from normal public `ktx ingest` plain output.

**Architecture:** Keep the current connection-centric public ingest planner and hidden debug commands. Sanitize low-level ingest report labels in `ingest.ts`, and capture low-level source/query-history output in `public-ingest.ts` so public plain `ktx ingest <connectionId>` renders only the unified result table, warnings, notices, and retry guidance. JSON output and hidden debug commands may continue to expose raw `sourceKey` values for troubleshooting.

**Tech Stack:** TypeScript, Commander, Vitest, pnpm workspace scripts.

---

## Current audit

The unified ingest plan chain has implemented the main v1 behavior:

- `ktx ingest [connectionId]`, `ktx ingest --all`, `--fast`, `--deep`,
  `--query-history`, `--no-query-history`, and
  `--query-history-window-days` route through `public-ingest.ts`.
- Database targets run before source targets, deep readiness is target-local
  for `--all`, and inferred public adapters bypass `ingest.adapters`.
- Normal command help hides `ktx scan`, `ktx ingest run`, and
  `ktx ingest watch`; docs-site command references no longer publish those
  as normal workflows.
- Setup stores `connections.<id>.context.depth` and
  `connections.<id>.context.queryHistory`, migrates legacy `historicSql`, and
  uses foreground-only context-build state.

### V1-blocking gaps

- Direct public non-TTY or `--no-input` source ingest still delegates to
  `runKtxIngest()` with the real CLI IO. The lower-level reporter prints
  `Adapter: <sourceKey>` and routine report details before the public result
  table. For query history this can print `Adapter: historic-sql`, violating
  the spec requirement that normal output use query-history wording and keep
  internal adapter names out of routine output.
- `ktx ingest status` and `ktx ingest replay` plain output call the same
  lower-level report formatter. Stored database reports can therefore print
  `Adapter: live-database`, and stored query-history reports can print
  `Adapter: historic-sql`, even though `status` and `replay` are public
  report-viewing surfaces.

### Non-blocking gaps

- Hidden debug commands remain callable: `ktx scan`, `ktx ingest run`, and
  `ktx ingest watch`.
- JSON output, debug output, tests, internal artifact paths, WorkUnit keys,
  adapter package names, and developer scripts can continue to use
  `scan`, `live-database`, and `historic-sql`.
- Public docs still use "scan" as a generic implementation noun in a few
  contributor or concept pages. They do not present `ktx scan` as the normal
  public command, so that is later wording cleanup.

## File structure

- Modify `packages/cli/src/ingest.ts`: replace the plain report `Adapter:`
  label with public source labels, while leaving JSON report payloads intact.
- Modify `packages/cli/src/public-ingest.ts`: capture lower-level source and
  query-history plain output for direct public ingest, sanitize failure detail
  lines, and render only the public summary table.
- Modify `packages/cli/src/ingest.test.ts`: update existing report label
  expectations and add regressions for `live-database` and `historic-sql`
  stored-report labels.
- Modify `packages/cli/src/public-ingest.test.ts`: add regressions proving
  direct public source and query-history runs do not leak lower-level adapter
  report output.

## Tasks

### Task 1: Use public source labels in stored report output

**Files:**
- Modify: `packages/cli/src/ingest.ts`
- Modify: `packages/cli/src/ingest.test.ts`

- [ ] **Step 1: Add failing stored-report label tests**

Add these tests inside the existing `describe('runKtxIngest', () => { ... })`
block in `packages/cli/src/ingest.test.ts`, near the existing
`runs local ingest and reads status` test:

```typescript
  it('labels internal database reports without adapter names in plain status output', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const report = localFakeBundleReport('scan-job-1', {
      id: 'report-scan-1',
      runId: 'run-scan-1',
      connectionId: 'warehouse',
      sourceKey: 'live-database',
    });
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'status',
          projectDir,
          reportFile: '/tmp/scan-report.json',
          outputMode: 'plain',
        },
        io.io,
        {
          readReportFile: vi.fn(async () => report),
        },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Source: Database schema\n');
    expect(io.stdout()).not.toContain('Adapter:');
    expect(io.stdout()).not.toContain('live-database');
    expect(io.stderr()).toBe('');
  });

  it('labels internal query-history reports without adapter names in plain status output', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const report = localFakeBundleReport('query-history-job-1', {
      id: 'report-query-history-1',
      runId: 'run-query-history-1',
      connectionId: 'warehouse',
      sourceKey: 'historic-sql',
    });
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'status',
          projectDir,
          reportFile: '/tmp/query-history-report.json',
          outputMode: 'plain',
        },
        io.io,
        {
          readReportFile: vi.fn(async () => report),
        },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Source: Query history\n');
    expect(io.stdout()).not.toContain('Adapter:');
    expect(io.stdout()).not.toContain('historic-sql');
    expect(io.stderr()).toBe('');
  });
```

- [ ] **Step 2: Run the failing stored-report tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest.test.ts --testNamePattern "labels internal"
```

Expected: FAIL. The output still contains `Adapter: live-database` or
`Adapter: historic-sql`, and it does not contain the new public `Source:`
labels.

- [ ] **Step 3: Add public report source labels**

In `packages/cli/src/ingest.ts`, add these helpers above
`function writeReportStatus(...)`:

```typescript
const REPORT_SOURCE_LABELS = new Map<string, string>([
  ['live-database', 'Database schema'],
  ['historic-sql', 'Query history'],
  ['dbt', 'dbt'],
  ['metricflow', 'MetricFlow'],
  ['lookml', 'LookML'],
  ['looker', 'Looker'],
  ['metabase', 'Metabase'],
  ['notion', 'Notion'],
]);

function reportSourceLabel(sourceKey: string): string {
  const label = REPORT_SOURCE_LABELS.get(sourceKey);
  if (label) {
    return label;
  }
  return sourceKey
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
```

Then replace the `Adapter:` line in `writeReportStatus()`:

```typescript
  io.stdout.write(`Source: ${reportSourceLabel(report.sourceKey)}\n`);
```

The full function should keep the remaining fields unchanged:

```typescript
function writeReportStatus(report: IngestReportSnapshot, io: KtxIngestIo): void {
  const counts = savedMemoryCountsForReport(report);
  io.stdout.write(`Report: ${report.id}\n`);
  io.stdout.write(`Run: ${report.runId}\n`);
  io.stdout.write(`Job: ${report.jobId}\n`);
  io.stdout.write(`Status: ${reportStatus(report)}\n`);
  io.stdout.write(`Source: ${reportSourceLabel(report.sourceKey)}\n`);
  io.stdout.write(`Connection: ${report.connectionId}\n`);
  io.stdout.write(`Sync: ${report.body.syncId}\n`);
  io.stdout.write(
    `Diff: +${report.body.diffSummary.added}/~${report.body.diffSummary.modified}/-${report.body.diffSummary.deleted}/=${report.body.diffSummary.unchanged}\n`,
  );
  io.stdout.write(`Work units: ${report.body.workUnits.length}\n`);
  io.stdout.write(`Saved memory: ${counts.wikiCount} wiki, ${counts.slCount} SL\n`);
  io.stdout.write(`Provenance rows: ${report.body.provenanceRows.length}\n`);
}
```

- [ ] **Step 4: Update existing report label expectations**

In `packages/cli/src/ingest.test.ts`, update the existing assertions that
still expect the old `Adapter:` label:

```typescript
expect(statusIo.stdout()).toContain('Source: Metabase');
```

```typescript
expect(io.stdout()).toContain('Source: Query history\n');
```

```typescript
expect(io.stdout()).toContain('Source: Looker');
```

```typescript
expect(statusIo.stdout()).toContain('Source: Looker');
```

Remove the corresponding `Adapter: metabase`, `Adapter: historic-sql`, and
`Adapter: looker` expectations.

- [ ] **Step 5: Run the stored-report tests again**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest.test.ts --testNamePattern "labels internal|runs public Metabase|historic-sql projection|Looker"
```

Expected: PASS. Plain report output uses `Source:` labels and does not print
`Adapter:` for the covered status and run summaries.

- [ ] **Step 6: Commit stored-report label cleanup**

Run:

```bash
git add packages/cli/src/ingest.ts packages/cli/src/ingest.test.ts
git commit -m "fix(cli): use public source labels in ingest reports"
```

### Task 2: Capture low-level output during public source ingest

**Files:**
- Modify: `packages/cli/src/public-ingest.ts`
- Modify: `packages/cli/src/public-ingest.test.ts`

- [ ] **Step 1: Add failing public source-output tests**

Add these tests to `packages/cli/src/public-ingest.test.ts` near the existing
public output tests for captured scan output and query-history retry guidance:

```typescript
  it('suppresses lower-level source report output during direct public source ingest', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      docs: { driver: 'notion' },
    });
    const runIngest = vi.fn(async (_args, ingestIo) => {
      ingestIo.stdout.write('Report: report-docs-1\n');
      ingestIo.stdout.write('Adapter: notion\n');
      ingestIo.stdout.write('Saved memory: 2 wiki, 0 SL\n');
      return 0;
    });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'docs',
          all: false,
          json: false,
          inputMode: 'disabled',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runIngest },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Ingest finished');
    expect(io.stdout()).toContain('docs');
    expect(io.stdout()).toContain('source-ingest');
    expect(io.stdout()).not.toContain('Report: report-docs-1');
    expect(io.stdout()).not.toContain('Adapter:');
    expect(io.stdout()).not.toContain('notion\n');
    expect(io.stderr()).toBe('');
  });

  it('suppresses historic-sql report output during direct public query-history ingest', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: { driver: 'postgres', context: { depth: 'deep' } },
    });
    const runScan = vi.fn(async () => 0);
    const runIngest = vi.fn(async (_args, ingestIo) => {
      ingestIo.stdout.write('Report: report-query-history-1\n');
      ingestIo.stdout.write('Adapter: historic-sql\n');
      ingestIo.stdout.write('Saved memory: 1 wiki, 1 SL\n');
      return 0;
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
          queryHistory: 'enabled',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan, runIngest },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Schema ingest runs before query history for warehouse.');
    expect(io.stdout()).toContain('Ingest finished');
    expect(io.stdout()).toContain('warehouse');
    expect(io.stdout()).toContain('done');
    expect(io.stdout()).not.toContain('Report: report-query-history-1');
    expect(io.stdout()).not.toContain('Adapter:');
    expect(io.stdout()).not.toContain('historic-sql');
    expect(io.stderr()).toBe('');
  });
```

- [ ] **Step 2: Run the failing public source-output tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts --testNamePattern "suppresses"
```

Expected: FAIL. The direct public run writes lower-level `Report:` and
`Adapter:` lines into normal public stdout.

- [ ] **Step 3: Add captured ingest output helpers**

In `packages/cli/src/public-ingest.ts`, keep the existing
`createCapturedPublicIngestIo()` helper and replace
`firstCapturedFailureLine()` with these helpers:

```typescript
const INTERNAL_STATUS_LINE_RE =
  /^(Report|Run|Job|Status|Adapter|Connection|Sync|Diff|Work units|Saved memory|Provenance rows):\s*/;

function publicIngestOutputLine(line: string): string {
  return line
    .replace(/\blive-database\b/g, 'database schema')
    .replace(/\bhistoric-sql\b/g, 'query history')
    .replace(/\bhistoric SQL\b/gi, 'query history');
}

function firstCapturedFailureLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('KTX scan completed'))
    .filter((line) => !INTERNAL_STATUS_LINE_RE.test(line))
    .map(publicIngestOutputLine)
    .find((line) => line.length > 0);
}
```

- [ ] **Step 4: Capture query-history ingest output**

In `executePublicIngestTarget()`, replace the query-history branch with this
captured-output flow:

```typescript
    if (target.queryHistory?.enabled === true) {
      const { runKtxIngest } = await import('./ingest.js');
      const runIngest = deps.runIngest ?? runKtxIngest;
      const ingestArgs: KtxIngestArgs = {
        command: 'run',
        projectDir: args.projectDir,
        connectionId: target.connectionId,
        adapter: 'historic-sql',
        outputMode: sourceIngestOutputMode(args, io),
        inputMode: args.inputMode,
        allowImplicitAdapter: true,
        historicSqlPullConfigOverride:
          target.queryHistory.pullConfig ?? {
            dialect: target.queryHistory.dialect,
            ...(target.queryHistory.windowDays !== undefined ? { windowDays: target.queryHistory.windowDays } : {}),
          },
      };
      const capturedIngestIo = deps.ingestProgress ? null : createCapturedPublicIngestIo();
      const ingestIo = capturedIngestIo ?? io;
      const qhExitCode = deps.ingestProgress
        ? await runIngest(ingestArgs, ingestIo, { progress: deps.ingestProgress })
        : await runIngest(ingestArgs, ingestIo);
      if (qhExitCode !== 0) {
        return markTargetResult(
          target,
          args,
          'failed',
          'query-history',
          capturedIngestIo ? firstCapturedFailureLine(capturedIngestIo.capturedOutput()) : undefined,
        );
      }
    }
```

This keeps foreground progress working because `runContextBuild()` supplies
`deps.ingestProgress` and already passes a captured IO object into
`executePublicIngestTarget()`.

- [ ] **Step 5: Capture source ingest output**

In the source-ingest branch of `executePublicIngestTarget()`, replace the
direct `runIngest(..., io, ...)` call with this captured-output flow:

```typescript
  const runIngest = deps.runIngest ?? runKtxIngest;
  const capturedIngestIo = deps.ingestProgress ? null : createCapturedPublicIngestIo();
  const ingestIo = capturedIngestIo ?? io;
  const exitCode = deps.ingestProgress
    ? await runIngest(ingestArgs, ingestIo, { progress: deps.ingestProgress })
    : await runIngest(ingestArgs, ingestIo);
  return markTargetResult(
    target,
    args,
    exitCode === 0 ? 'done' : 'failed',
    'source-ingest',
    capturedIngestIo ? firstCapturedFailureLine(capturedIngestIo.capturedOutput()) : undefined,
  );
```

Keep the existing `ingestArgs` object unchanged:

```typescript
  const ingestArgs: KtxIngestArgs = {
    command: 'run',
    projectDir: args.projectDir,
    connectionId: target.connectionId,
    adapter: target.adapter ?? target.driver,
    ...(target.sourceDir ? { sourceDir: target.sourceDir } : {}),
    outputMode: sourceIngestOutputMode(args, io),
    inputMode: args.inputMode,
    allowImplicitAdapter: true,
  };
```

- [ ] **Step 6: Run the public source-output tests again**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts --testNamePattern "suppresses|retry guidance|foreground"
```

Expected: PASS. Direct public source and query-history runs no longer print
low-level `Report:`, `Adapter:`, `live-database`, or `historic-sql` lines in
plain stdout, while existing foreground and retry guidance tests still pass.

- [ ] **Step 7: Commit public source-output capture**

Run:

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts
git commit -m "fix(cli): suppress low-level public ingest output"
```

### Task 3: Final verification

**Files:**
- Verify: `packages/cli/src/ingest.ts`
- Verify: `packages/cli/src/public-ingest.ts`
- Verify: `packages/cli/src/ingest.test.ts`
- Verify: `packages/cli/src/public-ingest.test.ts`

- [ ] **Step 1: Run focused CLI tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run \
  src/public-ingest.test.ts \
  src/context-build-view.test.ts \
  src/ingest.test.ts \
  src/ingest-viz.test.ts \
  src/command-tree.test.ts \
  src/print-command-tree.test.ts
```

Expected: PASS. These tests cover direct public ingest, foreground context
builds, stored report rendering, visual report rendering, and hidden command
tree filtering.

- [ ] **Step 2: Run CLI type-check**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Verify generated command tree still hides debug commands**

Run:

```bash
pnpm --filter @ktx/cli run docs:commands >/tmp/ktx-command-tree.txt
rg "scan <connectionId>|ingest run|ingest watch" /tmp/ktx-command-tree.txt
```

Expected: the `docs:commands` command succeeds. The `rg` command exits `1`
with no matches.

- [ ] **Step 4: Search public docs and normal CLI surfaces for old public command guidance**

Run:

```bash
rg -n "ktx scan|ktx ingest run|ktx ingest watch|--enable-historic-sql|--historic-sql|historicSql|Historic SQL|live-database" \
  README.md docs-site/content examples/README.md examples/local-warehouse/README.md examples/postgres-historic/README.md
```

Expected: no v1-blocking matches. Matches that refer only to internal raw
artifact paths such as `raw-sources/warehouse/historic-sql` are allowed only in
the Postgres query-history smoke README.

- [ ] **Step 5: Run dead-code checks after TypeScript changes**

Run:

```bash
pnpm run dead-code
```

Expected: PASS. If Knip reports unrelated existing findings, inspect them and
record the unrelated findings before finishing.

- [ ] **Step 6: Inspect final diff**

Run:

```bash
git status --short
git diff -- packages/cli/src/ingest.ts packages/cli/src/public-ingest.ts packages/cli/src/ingest.test.ts packages/cli/src/public-ingest.test.ts
```

Expected: only the intended TypeScript source and test files are modified.
The diff contains no generated `dist/` files and no docs changes beyond this
plan.

- [ ] **Step 7: Commit verification-only fixes if needed**

Run only if verification required small expectation or formatting fixes:

```bash
git add packages/cli/src/ingest.ts packages/cli/src/public-ingest.ts packages/cli/src/ingest.test.ts packages/cli/src/public-ingest.test.ts
git commit -m "test(cli): verify unified ingest public plain output"
```

Expected: no commit is needed when all checks pass after Tasks 1 and 2.

## Self-review

- Spec coverage: This plan closes the remaining v1-blocking normal-output
  leaks for direct public source ingest, public query-history ingest, and
  public stored-report status/replay output. It intentionally leaves hidden
  debug commands, JSON payloads, internal artifact paths, and developer tests
  untouched.
- Placeholder scan: The plan contains concrete file paths, exact test code,
  exact implementation snippets, commands, and expected results.
- Type consistency: The snippets use existing local types and helpers:
  `KtxIngestArgs`, `createCapturedPublicIngestIo()`,
  `firstCapturedFailureLine()`, `sourceIngestOutputMode()`,
  `markTargetResult()`, `localFakeBundleReport()`, and `makeIo()`.
