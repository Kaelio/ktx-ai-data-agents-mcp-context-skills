# Unified Ingest V1 Verification Copy Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining v1-blocking verification and setup-copy gaps in the unified `ktx ingest` UX.

**Architecture:** Keep the implemented connection-centric ingest planner unchanged. Fix the test-only TypeScript error that currently blocks `@ktx/cli` type-check, then replace the remaining normal setup help/output references to old "primary source" terminology with database-oriented copy.

**Tech Stack:** TypeScript ESM, Commander, Vitest, pnpm workspace scripts, uv pre-commit.

---

## Current Audit

Implemented unified-ingest plans already cover the original spec's main v1 behavior:

- `ktx ingest [connectionId]`, `ktx ingest --all`, `--fast`, `--deep`, `--query-history`, `--no-query-history`, and `--query-history-window-days` route through `packages/cli/src/public-ingest.ts`.
- Database targets are ordered before source targets, public source ingest bypasses `ingest.adapters`, and database depth maps to structural/enriched scan internals.
- Deep readiness is evaluated per target before target work starts, and `--all` isolates eligible targets from independent failures.
- Setup stores `connections.<id>.context.depth` and `connections.<id>.context.queryHistory`, migrates legacy `historicSql`, and uses foreground-only context-build state.
- Normal `ktx` and `ktx ingest` help hide `ktx scan`, `ktx ingest run`, and live `ktx ingest watch`.
- Foreground progress and normal public output sanitize scan/live-database/historic-sql internals.

### V1-Blocking Gaps

- `pnpm --filter @ktx/cli run type-check` fails:

```text
src/setup-databases.test.ts(1078,39): error TS2339: Property 'mock' does not exist on type '(options: { message: string; options: KtxSetupPromptOption<string>[]; required?: boolean | undefined; initialValues?: string[] | undefined; }) => Promise<string[]>'.
```

- Normal setup help/output still exposes the old database category as "primary source":
  - `packages/cli/src/commands/setup-commands.ts` documents `--skip-databases` as `KTX cannot work until a primary source is added`.
  - `packages/cli/src/setup-sources.ts` prints `Connect a primary source before adding context sources.`
  - `packages/cli/src/setup-context.ts` prints `No primary or context sources are configured for a KTX context build.`

### Non-Blocking Gaps

- Hidden debug commands remain callable: `ktx scan`, `ktx ingest run`, and `ktx ingest watch`.
- Internal adapter keys, artifact paths, WorkUnit keys, package names, tests, and developer-only scripts can continue to use `scan`, `live-database`, `historic-sql`, and internal `primarySource*` identifiers.
- Public docs still have a `Primary Sources` integration page and a quickstart sentence about BI metadata mapping to primary source connections. That is broader documentation information architecture cleanup, not a v1 blocker for the normal command/help/output behavior in this spec.

## File Structure

- Modify `packages/cli/src/setup-databases.test.ts`: use Vitest's typed mock helper for the existing `prompts.multiselect` assertion.
- Modify `packages/cli/src/setup-sources.ts`: change the normal missing-database message before context source setup.
- Modify `packages/cli/src/setup-sources.test.ts`: update the missing-database regression.
- Modify `packages/cli/src/setup-context.ts`: change the normal no-target context-build error.
- Modify `packages/cli/src/setup-context.test.ts`: update the no-target context-build regression.
- Modify `packages/cli/src/commands/setup-commands.ts`: change the public `--skip-databases` help copy.
- Modify `packages/cli/src/index.test.ts`: assert setup help no longer contains public "primary source" wording.

## Tasks

### Task 1: Repair Setup Database Test Type-Check

**Files:**
- Modify: `packages/cli/src/setup-databases.test.ts`

- [ ] **Step 1: Replace the untyped mock access**

In `packages/cli/src/setup-databases.test.ts`, in the test named `prompts for discovered Postgres schemas before the first scan`, replace:

```ts
    expect(String(prompts.multiselect.mock.calls[0]?.[0].message)).not.toContain('to scan');
```

with:

```ts
    expect(String(vi.mocked(prompts.multiselect).mock.calls[0]?.[0].message)).not.toContain('to scan');
```

- [ ] **Step 2: Run the setup database type-check regression**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected before the fix: FAIL with `TS2339: Property 'mock' does not exist`.

Expected after the fix: PASS.

- [ ] **Step 3: Commit the type-check repair**

Run:

```bash
git add packages/cli/src/setup-databases.test.ts
git commit -m "test(cli): fix setup database test type-check"
```

### Task 2: Replace Remaining Normal Setup Primary-Source Copy

**Files:**
- Modify: `packages/cli/src/setup-sources.ts`
- Modify: `packages/cli/src/setup-sources.test.ts`
- Modify: `packages/cli/src/setup-context.ts`
- Modify: `packages/cli/src/setup-context.test.ts`
- Modify: `packages/cli/src/commands/setup-commands.ts`
- Modify: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Update setup source missing-database expectations**

In `packages/cli/src/setup-sources.test.ts`, replace the test name and output expectation:

```ts
  it('does not offer context sources until a primary source exists', async () => {
```

with:

```ts
  it('does not offer context sources until a database exists', async () => {
```

and replace:

```ts
    expect(io.stdout()).toContain('Connect a primary source before adding context sources.');
```

with:

```ts
    expect(io.stdout()).toContain('Connect a database before adding context sources.');
```

- [ ] **Step 2: Update setup context no-target expectations**

In `packages/cli/src/setup-context.test.ts`, replace:

```ts
    expect(io.stderr()).toContain('No primary or context sources are configured for a KTX context build.');
```

with:

```ts
    expect(io.stderr()).toContain('No databases or context sources are configured for a KTX context build.');
```

- [ ] **Step 3: Add setup help regression coverage**

In `packages/cli/src/index.test.ts`, in the test named `documents setup as a bare command without subcommands`, add these assertions after the existing query-history flag assertions and before the historic-SQL assertions:

```ts
    expect(testIo.stdout()).toContain('KTX cannot work until a database is added');
    expect(testIo.stdout()).not.toContain('primary source');
    expect(testIo.stdout()).not.toContain('primary sources');
```

- [ ] **Step 4: Run the failing setup-copy tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-sources.test.ts src/setup-context.test.ts src/index.test.ts -t "context sources until a database exists|No databases or context sources|documents setup as a bare command"
```

Expected: FAIL because implementation still prints `primary source` in setup source/context output and setup help.

- [ ] **Step 5: Update setup source output**

In `packages/cli/src/setup-sources.ts`, replace:

```ts
      const message = 'Connect a primary source before adding context sources.';
```

with:

```ts
      const message = 'Connect a database before adding context sources.';
```

- [ ] **Step 6: Update setup context output**

In `packages/cli/src/setup-context.ts`, replace:

```ts
      io.stderr.write('No primary or context sources are configured for a KTX context build.\n');
```

with:

```ts
      io.stderr.write('No databases or context sources are configured for a KTX context build.\n');
```

- [ ] **Step 7: Update public setup help output**

In `packages/cli/src/commands/setup-commands.ts`, replace:

```ts
    .option('--skip-databases', 'Leave database setup incomplete; KTX cannot work until a primary source is added', false)
```

with:

```ts
    .option('--skip-databases', 'Leave database setup incomplete; KTX cannot work until a database is added', false)
```

- [ ] **Step 8: Run the setup-copy tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-sources.test.ts src/setup-context.test.ts src/index.test.ts -t "context sources until a database exists|No databases or context sources|documents setup as a bare command"
```

Expected: PASS.

- [ ] **Step 9: Commit the setup-copy repair**

Run:

```bash
git add packages/cli/src/setup-sources.ts packages/cli/src/setup-sources.test.ts packages/cli/src/setup-context.ts packages/cli/src/setup-context.test.ts packages/cli/src/commands/setup-commands.ts packages/cli/src/index.test.ts
git commit -m "fix(cli): remove primary-source wording from setup output"
```

### Task 3: Final V1 Verification

**Files:**
- Verify: `packages/cli/src/setup-databases.test.ts`
- Verify: `packages/cli/src/setup-sources.ts`
- Verify: `packages/cli/src/setup-sources.test.ts`
- Verify: `packages/cli/src/setup-context.ts`
- Verify: `packages/cli/src/setup-context.test.ts`
- Verify: `packages/cli/src/commands/setup-commands.ts`
- Verify: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Run focused unified ingest tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts src/context-build-view.test.ts src/setup-ready-menu.test.ts src/setup.test.ts src/setup-context.test.ts src/setup-databases.test.ts src/setup-sources.test.ts src/index.test.ts src/command-tree.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run docs regression tests**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run CLI type-check**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 4: Check the normal setup public-copy surface**

Run:

```bash
rg -n "primary source|primary sources|Primary Sources|primary-source" \
  packages/cli/src/commands/setup-commands.ts \
  packages/cli/src/setup-sources.ts \
  packages/cli/src/setup-context.ts \
  packages/cli/src/index.test.ts \
  packages/cli/src/setup-sources.test.ts \
  packages/cli/src/setup-context.test.ts
```

Expected: no matches.

- [ ] **Step 5: Check the unified ingest public command surface**

Run:

```bash
node packages/cli/dist/bin.js ingest --help
node packages/cli/dist/bin.js --help
```

Expected: normal help lists `ktx ingest [connectionId]`, `--all`, `--fast`, `--deep`, `--query-history`, `status`, and `replay`; it does not list `ktx scan`, `ktx ingest run`, or `ktx ingest watch`.

- [ ] **Step 6: Run pre-commit on changed files**

Run:

```bash
uv run pre-commit run --files \
  packages/cli/src/setup-databases.test.ts \
  packages/cli/src/setup-sources.ts \
  packages/cli/src/setup-sources.test.ts \
  packages/cli/src/setup-context.ts \
  packages/cli/src/setup-context.test.ts \
  packages/cli/src/commands/setup-commands.ts \
  packages/cli/src/index.test.ts
```

Expected: PASS. If pre-commit cannot run because the local hook environment or pinned tool version is unavailable, record the exact failure and keep the focused Vitest, docs, and type-check results from Steps 1-3.

- [ ] **Step 7: Commit verification formatting if needed**

If Step 6 changes files, run:

```bash
git add packages/cli/src/setup-databases.test.ts packages/cli/src/setup-sources.ts packages/cli/src/setup-sources.test.ts packages/cli/src/setup-context.ts packages/cli/src/setup-context.test.ts packages/cli/src/commands/setup-commands.ts packages/cli/src/index.test.ts
git commit -m "test(cli): verify unified ingest setup closure"
```

If Step 6 makes no changes, do not create an empty commit.

## Self-Review

- Spec coverage: This plan covers the remaining v1-blocking issues found in the audit: package type-check is currently red, and normal setup help/output still exposes the old public database category as `primary source` instead of database-oriented copy. Core ingest routing, depth behavior, query-history behavior, foreground-only state, warning aggregation, public command help, and scan/live-database/historic-sql output sanitization are already implemented by prior plans.
- Placeholder scan: The plan contains concrete file paths, exact replacement snippets, exact commands, and expected outcomes.
- Type consistency: The only test typing change uses the existing Vitest pattern already used elsewhere in `packages/cli/src/setup-databases.test.ts`: `vi.mocked(prompts.multiselect).mock.calls`.
