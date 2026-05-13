# Warehouse Verification SQL Example Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the last connectionless `sql_execution` prompt example so
warehouse-verification writer guidance always matches KTX's shipped tool
contract.

**Architecture:** Keep the warehouse verification tool code unchanged. Tighten
the prompt asset guard so multiline `sql_execution({ sql: ... })` examples
fail tests, then update the stale `sl_capture` worked example to pass
`connectionName` explicitly.

**Tech Stack:** Markdown skill prompts, TypeScript, Vitest, pnpm workspace
commands.

---

## Audit summary

The warehouse verification tools, runner wiring, source-adapter target fan-out,
CLI query executor, and focused tests are present. Focused verification passed:

```bash
pnpm --filter @ktx/context exec vitest run src/connections/dialects.test.ts src/connections/read-only-sql.test.ts src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts src/ingest/tools/warehouse-verification/entity-details.tool.test.ts src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts src/ingest/tools/warehouse-verification/discover-data.tool.test.ts src/ingest/ingest-prompts.test.ts src/ingest/ingest-runtime-assets.test.ts src/memory/memory-runtime-assets.test.ts src/ingest/local-adapters.test.ts src/ingest/adapters/notion/notion.adapter.test.ts src/ingest/adapters/lookml/lookml.adapter.test.ts src/ingest/adapters/metricflow/metricflow.adapter.test.ts
pnpm --filter @ktx/cli exec vitest run src/ingest-query-executor.test.ts src/ingest.test.ts -t "supplies a scan-connector query executor"
```

Remaining v1-blocking gap:

- `packages/context/skills/sl_capture/SKILL.md` still contains a worked example
  with a multiline `sql_execution({ sql: ... })` call. KTX's tool contract is
  `sql_execution({connectionName, sql, rowLimit?})`, so this example can teach
  agents to call the shipped tool with invalid input.

Non-blocking gaps remain out of scope for this v1 plan:

- Full DDL-style `entity_details` formatting with FK profile summaries.
- AST-backed SQL validation for data-modifying CTE bodies.
- Search over generated `enrichment/descriptions.json`.
- Per-WorkUnit reuse of a single `WarehouseCatalogService` instance for cache
  hits across separate tool calls.
- A deterministic fake-LLM end-to-end Notion hallucination regression.
- Tokenized or embedding-backed raw schema search ranking in `discover_data`.

## File structure

Modify these files:

- `packages/context/src/memory/memory-runtime-assets.test.ts`: add a prompt
  guard that catches multiline `sql_execution` calls without `connectionName`.
- `packages/context/skills/sl_capture/SKILL.md`: update the stale worked
  example to include the target warehouse `connectionName`.

### Task 1: Add a multiline SQL prompt guard

**Files:**
- Modify: `packages/context/src/memory/memory-runtime-assets.test.ts`

- [ ] **Step 1: Add a helper that extracts `sql_execution` call examples**

In `packages/context/src/memory/memory-runtime-assets.test.ts`, add this helper
after `forbiddenProductPattern()`:

```ts
function sqlExecutionCallBlocks(body: string): string[] {
  const blocks: string[] = [];
  const marker = 'sql_execution({';
  let offset = 0;

  while (offset < body.length) {
    const start = body.indexOf(marker, offset);
    if (start === -1) {
      break;
    }
    const end = body.indexOf('})', start + marker.length);
    blocks.push(body.slice(start, end === -1 ? start + marker.length : end + 2));
    offset = start + marker.length;
  }

  return blocks;
}
```

- [ ] **Step 2: Strengthen the existing SQL-shape test**

Replace the body of
`ships only the KTX connectionName sql_execution call shape in writer guidance`
with:

```ts
    const shared = await readFile(join(skillsDir, '_shared', 'identifier-verification.md'), 'utf-8');
    const bodies = [{ name: '_shared/identifier-verification.md', body: shared }];

    expect(shared).toContain('sql_execution({connectionName, sql: "SELECT DISTINCT');
    expect(shared).toContain('sql_execution({connectionName, sql: "SELECT 1 FROM');

    for (const skillName of verificationWriterSkills) {
      const body = await readFile(join(skillsDir, skillName, 'SKILL.md'), 'utf-8');
      bodies.push({ name: `${skillName}/SKILL.md`, body });
      expect(body).toContain('sql_execution({connectionName');
      expect(body).not.toContain('sql_execution({ sql');
      expect(body).not.toContain('session shape');
      expect(body).not.toContain('connection is already pinned by the ingest session');
    }

    for (const { name, body } of bodies) {
      const calls = sqlExecutionCallBlocks(body);
      expect(calls.length, `${name} should contain sql_execution guidance`).toBeGreaterThan(0);
      expect(
        calls.filter((call) => !call.includes('connectionName')),
        `${name} has sql_execution calls without connectionName`,
      ).toEqual([]);
      expect(body, `${name} has a connectionless multiline sql_execution call`).not.toMatch(
        /sql_execution\(\{\s*sql\s*:/,
      );
    }
```

- [ ] **Step 3: Run the failing prompt guard**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/memory/memory-runtime-assets.test.ts -t "connectionName sql_execution"
```

Expected: FAIL. The failure must identify
`sl_capture/SKILL.md` as having a `sql_execution` call without
`connectionName` or a connectionless multiline `sql_execution` call.

- [ ] **Step 4: Commit the failing guard**

Run:

```bash
git add packages/context/src/memory/memory-runtime-assets.test.ts
git commit -m "test(context): catch connectionless sql execution prompt examples"
```

### Task 2: Fix the stale `sl_capture` SQL example

**Files:**
- Modify: `packages/context/skills/sl_capture/SKILL.md`
- Test: `packages/context/src/memory/memory-runtime-assets.test.ts`
- Test: `packages/context/src/ingest/ingest-runtime-assets.test.ts`

- [ ] **Step 1: Update the worked example**

In `packages/context/skills/sl_capture/SKILL.md`, replace the `sql_execution`
block in "Worked example - new join" with:

```md
sql_execution({
  connectionName: "warehouse",
  sql: "SELECT COUNT(*), COUNT(DISTINCT a.admin_user_id) FROM public.fct_orders a JOIN public.fct_mau_multiprotocol b ON a.admin_user_id = b.admin_user_id LIMIT 1"
})
```

- [ ] **Step 2: Run the prompt guards**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/memory/memory-runtime-assets.test.ts src/ingest/ingest-runtime-assets.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run a direct stale-shape scan**

Run:

```bash
rg -n -U "sql_execution\\(\\{\\s*\\n\\s*sql:" packages/context/skills packages/context/prompts
```

Expected: no matches and exit code 1.

- [ ] **Step 4: Run the context type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 5: Commit the prompt fix**

Run:

```bash
git add packages/context/skills/sl_capture/SKILL.md
git commit -m "fix(context): include connection name in sl capture sql example"
```

## Self-review

Spec coverage:

- The only remaining v1-blocking prompt-shape gap has a failing test and a
  direct prompt edit.
- Tool implementation, runner wiring, adapter scoping, and CLI execution
  remain covered by the focused suites listed in the audit summary.

Placeholder scan:

- This plan contains no deferred implementation placeholders.

Type consistency:

- The plan uses the shipped KTX tool shape:
  `sql_execution({connectionName, sql, rowLimit?})`.
