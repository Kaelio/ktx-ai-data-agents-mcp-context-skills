# Historic SQL Pattern Shard Smoke Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the Postgres historic-SQL smoke and example docs with sharded pattern WorkUnits.

**Architecture:** The runtime already writes the full `patterns-input.json` audit file and bounded `patterns-input/part-0001.json` style shards. This plan updates the example acceptance assets so they verify the sharded contract instead of the pre-sharding root `historic-sql-patterns` WorkUnit.

**Tech Stack:** Bash, Node.js built-in test runner, pnpm workspace scripts, KTX local stage-only ingest.

---

## Spec And Existing Plan Status

Spec: `docs/superpowers/specs/2026-05-11-historic-sql-redesign-design.md`

Plans derived from this spec and implemented in this worktree:

- `docs/superpowers/plans/2026-05-11-historic-sql-foundations.md` - implemented. Evidence: `packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts`, `packages/context/src/sql-analysis/ports.ts`, daemon `/sql/analyze-batch`, `SemanticLayerSource.usage`, and `mergeUsagePreservingExternal()`.
- `docs/superpowers/plans/2026-05-11-historic-sql-search-enrichment.md` - implemented. Evidence: usage-aware SL search text, SQLite FTS snippets, and local/MCP result fields `frequencyTier` plus `snippet`.
- `docs/superpowers/plans/2026-05-11-historic-sql-unified-hot-path.md` - implemented. Evidence: `stageHistoricSqlAggregatedSnapshot()`, `chunkHistoricSqlUnifiedStagedDir()`, `PostgresPgssReader`, aggregate BigQuery/Snowflake readers, unified schemas, and package exports.
- `docs/superpowers/plans/2026-05-11-historic-sql-skills-projection-cutover.md` - implemented. Evidence: `HistoricSqlSourceAdapter`, `historic_sql_table_digest`, `historic_sql_patterns`, `emit_historic_sql_evidence`, `HistoricSqlProjectionPostProcessor`, and legacy skill removal from runtime code.
- `docs/superpowers/plans/2026-05-11-historic-sql-cross-dialect-readiness.md` - implemented. Evidence: local adapter registration tests for Postgres, BigQuery, and Snowflake plus PG doctor coverage for informational `pg_stat_statements.max`.
- `docs/superpowers/plans/2026-05-11-historic-sql-docs-smoke-and-config-cleanup.md` - implemented at the time it was written, but its smoke assertions predate pattern shard WorkUnits.
- `docs/superpowers/plans/2026-05-11-historic-sql-projection-archive-hardening.md` - implemented. Evidence: `isArchivedPatternPage()`, archive exclusion from slug matching, stale table tests, and legacy query-page cleanup coverage.
- `docs/superpowers/plans/2026-05-11-historic-sql-end-to-end-retrieval-acceptance.md` - implemented. Evidence: `local-ingest-acceptance.test.ts` proves production adapter output reaches SL search and wiki search.
- `docs/superpowers/plans/2026-05-11-historic-sql-redaction-hardening.md` - implemented. Evidence: `redaction.ts`, `redaction.test.ts`, and staged artifact redaction coverage in `stage-unified.test.ts`.
- `docs/superpowers/plans/2026-05-11-historic-sql-pattern-workunit-sharding.md` - implemented. Evidence: `pattern-inputs.ts`, `pattern-inputs.test.ts`, `stage-unified.ts` writes `patterns-input/part-*.json`, `chunk-unified.ts` emits `historic-sql-patterns-part-*`, `historic_sql_patterns` reads shards, and acceptance tests use `rawPath: 'patterns-input/part-0001.json'`.

No existing spec-derived implementation plan is currently unimplemented in this worktree.

Remaining gap this plan fixes:

- `examples/postgres-historic/scripts/smoke.sh` still asserts a WorkUnit with `unitKey === 'historic-sql-patterns'`.
- Current runtime emits pattern WorkUnits with keys like `historic-sql-patterns-part-0001` and raw files like `patterns-input/part-0001.json`.
- The same smoke only validates the audit file `patterns-input.json`; it does not assert that the bounded shard files exist or contain only cross-table candidates.
- `examples/postgres-historic/README.md` and `examples/README.md` describe unchanged "pattern inputs" but do not explain that `patterns-input.json` is now audit-only and `patterns-input/part-*.json` drives pattern WorkUnits.
- `scripts/examples-docs.test.mjs` does not pin the sharded smoke/doc contract, so the stale root WorkUnit assertion can regress silently.

## File Structure

- Modify `scripts/examples-docs.test.mjs`  
  Pins docs and smoke script to the sharded pattern WorkUnit contract.
- Modify `examples/postgres-historic/scripts/smoke.sh`  
  Validates `patterns-input/part-*.json` shard files and `historic-sql-patterns-part-*` stage-only WorkUnits.
- Modify `examples/postgres-historic/README.md`  
  Documents `patterns-input.json` as the full audit artifact and `patterns-input/part-*.json` as bounded pattern WorkUnit input.
- Modify `examples/README.md`  
  Updates the short example catalog entry with the same audit-vs-shard wording.

### Task 1: Pin Example Tests To Pattern Shards

**Files:**
- Modify: `scripts/examples-docs.test.mjs`

- [ ] **Step 1: Add failing assertions for sharded pattern smoke/docs**

In `scripts/examples-docs.test.mjs`, inside `it('documents the Postgres historic SQL smoke example', ...)`, add these assertions immediately after the existing `assert.match(readme, /patterns-input\.json/);` line:

```javascript
    assert.match(readme, /patterns-input\/part-\*\.json/);
    assert.match(readme, /full audit input/);
    assert.match(readme, /bounded pattern WorkUnit shards/);
```

In the same test, add these assertions immediately after the existing `assert.match(smoke, /assert_stage_record "\$UNCHANGED_RECORD" unchanged zero/);` line:

```javascript
    assert.match(smoke, /assertPatternShards/);
    assert.match(smoke, /historic-sql-patterns-part-/);
    assert.match(smoke, /patterns-input\/part-/);
    assert.doesNotMatch(smoke, /unitKey === 'historic-sql-patterns'/);
```

- [ ] **Step 2: Run the example docs test to verify it fails**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL. The test should report missing `patterns-input/part-*.json`, `full audit input`, `bounded pattern WorkUnit shards`, `assertPatternShards`, or it should fail because `smoke.sh` still contains `unitKey === 'historic-sql-patterns'`.

- [ ] **Step 3: Commit the failing test**

Run:

```bash
git add scripts/examples-docs.test.mjs
git commit -m "test: expect historic sql pattern shard smoke docs"
```

### Task 2: Update The Postgres Historic Smoke

**Files:**
- Modify: `examples/postgres-historic/scripts/smoke.sh`
- Test: `scripts/examples-docs.test.mjs`

- [ ] **Step 1: Import `existsSync` in the embedded snapshot assertion**

In `examples/postgres-historic/scripts/smoke.sh`, inside `assert_unified_snapshot()`, replace this line:

```javascript
const { readFileSync, readdirSync } = require('node:fs');
```

with:

```javascript
const { existsSync, readFileSync, readdirSync } = require('node:fs');
```

- [ ] **Step 2: Add shard validation to `assert_unified_snapshot()`**

In `examples/postgres-historic/scripts/smoke.sh`, inside the embedded Node script in `assert_unified_snapshot()`, add this function after the `legacyKeys` loop:

```javascript
function assertPatternShards(root) {
  const shardDir = join(root, 'patterns-input');
  assert(existsSync(shardDir), 'Expected patterns-input shard directory');
  const shardFiles = readdirSync(shardDir)
    .filter((file) => /^part-\d{4}\.json$/.test(file))
    .sort()
    .map((file) => `patterns-input/${file}`);
  assert(shardFiles.length > 0, 'Expected at least one pattern shard file');

  for (const shardFile of shardFiles) {
    const shard = JSON.parse(readFileSync(join(root, shardFile), 'utf8'));
    assert(Array.isArray(shard.templates), `${shardFile}: expected templates array`);
    assert(shard.templates.length > 0, `${shardFile}: expected at least one template`);
    assert(
      shard.templates.every((template) => Array.isArray(template.tablesTouched) && template.tablesTouched.length >= 2),
      `${shardFile}: expected only cross-table pattern candidates`,
    );
  }

  return shardFiles;
}
```

- [ ] **Step 3: Assert the full audit input and bounded shards**

In the same embedded Node script, replace the current `patterns` block:

```javascript
const patterns = JSON.parse(readFileSync(join(root, 'patterns-input.json'), 'utf8'));
assert(Array.isArray(patterns.templates) && patterns.templates.length > 0, 'Expected patterns-input templates');
assert(
  patterns.templates.every((template) => Array.isArray(template.tablesTouched) && template.tablesTouched.length > 0),
  'Expected every pattern template to have touched tables',
);
```

with:

```javascript
const patterns = JSON.parse(readFileSync(join(root, 'patterns-input.json'), 'utf8'));
assert(Array.isArray(patterns.templates) && patterns.templates.length > 0, 'Expected patterns-input audit templates');
assert(
  patterns.templates.every((template) => Array.isArray(template.tablesTouched) && template.tablesTouched.length > 0),
  'Expected every audit pattern template to have touched tables',
);
const shardFiles = assertPatternShards(root);
assert(
  shardFiles.length <= patterns.templates.length,
  `Expected shard count ${shardFiles.length} to be no greater than audit template count ${patterns.templates.length}`,
);
```

- [ ] **Step 4: Update the stage record WorkUnit assertions**

In `examples/postgres-historic/scripts/smoke.sh`, inside the embedded Node script in `assert_stage_record()`, replace:

```javascript
assert(record.rawFileCount >= 3, `${label}: expected manifest, patterns input, and at least one table file`);
```

with:

```javascript
assert(record.rawFileCount >= 4, `${label}: expected manifest, audit patterns input, pattern shard, and at least one table file`);
```

Then replace this nonzero WorkUnit block:

```javascript
} else if (expectedWorkUnits === 'nonzero') {
  assert(record.workUnitCount > 0, `${label}: expected nonzero WorkUnits`);
  assert(record.workUnits.some((unit) => unit.unitKey === 'historic-sql-patterns'), `${label}: expected patterns WorkUnit`);
  assert(record.workUnits.some((unit) => unit.unitKey.startsWith('historic-sql-table-')), `${label}: expected table WorkUnit`);
} else {
```

with:

```javascript
} else if (expectedWorkUnits === 'nonzero') {
  assert(record.workUnitCount > 0, `${label}: expected nonzero WorkUnits`);
  const patternUnits = record.workUnits.filter((unit) => /^historic-sql-patterns-part-\d{4}$/.test(unit.unitKey));
  assert(patternUnits.length > 0, `${label}: expected sharded patterns WorkUnit`);
  for (const unit of patternUnits) {
    assert(
      unit.rawFiles.some((rawFile) => /^patterns-input\/part-\d{4}\.json$/.test(rawFile)),
      `${label}: expected ${unit.unitKey} to read a pattern shard`,
    );
    assert(
      !unit.rawFiles.includes('patterns-input.json'),
      `${label}: expected ${unit.unitKey} not to schedule the full audit patterns input`,
    );
  }
  assert(record.workUnits.some((unit) => unit.unitKey.startsWith('historic-sql-table-')), `${label}: expected table WorkUnit`);
} else {
```

- [ ] **Step 5: Run shell syntax and the docs test**

Run:

```bash
bash -n examples/postgres-historic/scripts/smoke.sh
node --test scripts/examples-docs.test.mjs
```

Expected: `bash -n` exits 0. The docs test still fails until the README files are updated in Task 3.

- [ ] **Step 6: Commit the smoke update**

Run:

```bash
git add examples/postgres-historic/scripts/smoke.sh
git commit -m "test: assert historic sql pattern shard smoke"
```

### Task 3: Update Example Documentation

**Files:**
- Modify: `examples/postgres-historic/README.md`
- Modify: `examples/README.md`
- Test: `scripts/examples-docs.test.mjs`

- [ ] **Step 1: Update the artifact list in the Postgres historic README**

In `examples/postgres-historic/README.md`, replace this list:

```markdown
- `manifest.json`
- `tables/*.json`
- `patterns-input.json`
```

with:

```markdown
- `manifest.json`
- `tables/*.json`
- `patterns-input.json` as the full audit input
- `patterns-input/part-*.json` as bounded pattern WorkUnit shards
```

- [ ] **Step 2: Update the idempotency wording**

In `examples/postgres-historic/README.md`, replace this paragraph:

```markdown
The smoke also runs the same workload twice and verifies the second stage-only
run has `workUnitCount: 0`, which proves unchanged bucketed table and pattern
inputs do not schedule LLM work.
```

with:

```markdown
The smoke also runs the same workload twice and verifies the second stage-only
run has `workUnitCount: 0`, which proves unchanged bucketed table inputs and
unchanged bounded pattern shards do not schedule LLM work.
```

- [ ] **Step 3: Update the manifest inspection wording**

In `examples/postgres-historic/README.md`, replace this paragraph:

```markdown
The manifest should have `source: "historic-sql"`, `dialect: "postgres"`,
positive `snapshotRowCount`, positive `touchedTableCount`, numeric
`parseFailures`, `warnings`, and `probeWarnings`. The same directory should
contain `patterns-input.json` and one `tables/*.json` file per touched table.
```

with:

```markdown
The manifest should have `source: "historic-sql"`, `dialect: "postgres"`,
positive `snapshotRowCount`, positive `touchedTableCount`, numeric
`parseFailures`, `warnings`, and `probeWarnings`. The same directory should
contain `patterns-input.json`, at least one `patterns-input/part-*.json` pattern
shard for cross-table candidates, and one `tables/*.json` file per touched
table.
```

- [ ] **Step 4: Update the examples catalog entry**

In `examples/README.md`, replace this paragraph:

```markdown
`postgres-historic/` is a manual Docker-backed smoke for Postgres historic-SQL
ingest via `pg_stat_statements`. It verifies setup, unified Historic SQL artifacts,
managed daemon batch SQL analysis, and no-WorkUnit idempotency for unchanged
bucketed table and pattern inputs.
```

with:

```markdown
`postgres-historic/` is a manual Docker-backed smoke for Postgres historic-SQL
ingest via `pg_stat_statements`. It verifies setup, unified Historic SQL artifacts,
managed daemon batch SQL analysis, bounded pattern WorkUnit shards, and
no-WorkUnit idempotency for unchanged bucketed table inputs and pattern shards.
```

- [ ] **Step 5: Run the example docs test**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit the docs update**

Run:

```bash
git add examples/postgres-historic/README.md examples/README.md
git commit -m "docs: explain historic sql pattern shards"
```

### Task 4: Verify The Smoke Contract

**Files:**
- Verify: `scripts/examples-docs.test.mjs`
- Verify: `examples/postgres-historic/scripts/smoke.sh`
- Verify: `examples/postgres-historic/README.md`
- Verify: `examples/README.md`

- [ ] **Step 1: Run focused local checks**

Run:

```bash
bash -n examples/postgres-historic/scripts/smoke.sh
node --test scripts/examples-docs.test.mjs
```

Expected: both commands pass.

- [ ] **Step 2: Run the Docker-backed Postgres historic smoke**

Run:

```bash
examples/postgres-historic/scripts/smoke.sh
```

Expected: PASS with `Postgres historic SQL smoke passed`. The stage-only records should include pattern WorkUnits with keys like `historic-sql-patterns-part-0001`, each reading `patterns-input/part-0001.json`, and the unchanged run should report `workUnitCount: 0`.

- [ ] **Step 3: Run the drift grep**

Run:

```bash
rg -n "unitKey === 'historic-sql-patterns'|expected patterns WorkUnit|patterns-input\\.json\\` and one \\`tables|unchanged bucketed table and pattern inputs" examples scripts
```

Expected: no matches.

- [ ] **Step 4: Commit verification metadata if any test-only wording changed**

Run:

```bash
git status --short
```

Expected: no unstaged files. If a previous step required a wording fix, commit only the touched files:

```bash
git add scripts/examples-docs.test.mjs examples/postgres-historic/scripts/smoke.sh examples/postgres-historic/README.md examples/README.md
git commit -m "test: verify historic sql sharded smoke docs"
```

## Self-Review

**Spec coverage:** This plan follows spec section 5.2's deterministic pattern sharding and preserves section 4.6's full `patterns-input.json` audit artifact. It updates the smoke and docs around the already implemented sharded runtime contract.

**Placeholder scan:** The plan contains exact file paths, exact snippets, commands, expected outcomes, and commit commands.

**Type consistency:** The plan uses the implemented runtime names consistently: `patterns-input.json` for the audit file, `patterns-input/part-*.json` for bounded shards, and `historic-sql-patterns-part-0001` style WorkUnit keys for pattern curation.

Plan complete and saved to `docs/superpowers/plans/2026-05-11-historic-sql-pattern-shard-smoke-docs.md`. Two execution options:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints
