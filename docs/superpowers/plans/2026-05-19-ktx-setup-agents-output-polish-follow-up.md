# KTX Setup Agents Output Polish Follow-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the remaining v1-blocking verification gap by updating the parent
setup integration test to expect the new inline agent install summary.

**Architecture:** No production code changes are needed. The already-implemented
`runKtxSetupAgentsStep` output now prints a `Claude Code · Project scope`
inline summary before the parent `Finish KTX agent setup` note, so the excluded
`setup.test.ts` assertion must stop expecting the removed
`Agent integration complete` note title.

**Tech Stack:** TypeScript, Vitest, pnpm workspace commands, `uv` pre-commit.

---

## Current audit

Original spec:
`docs/superpowers/specs/2026-05-19-ktx-setup-agents-output-polish-design.md`

Executed plan:
`docs/superpowers/plans/2026-05-19-ktx-setup-agents-output-polish.md`

Committed implementation:
`0cbf8121d9f373e047c43883e8f7623f22cddef7`

Verification already run:

- `pnpm --filter @ktx/cli run type-check` passed.
- `pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts` passed.
- `pnpm --filter @ktx/cli run test` passed, but this script excludes
  `src/setup.test.ts`.
- `pnpm run dead-code` passed.
- `source .venv/bin/activate && uv run pre-commit run --files packages/cli/src/setup-agents.ts packages/cli/src/setup-agents.test.ts`
  passed.

V1-blocking gap:

- `pnpm --filter @ktx/cli exec vitest run src/setup.test.ts` fails one test:
  `prints agent next actions inside the final ready summary during full setup`.
  The test still expects `Agent integration complete`, which the spec required
  removing from setup-agents install-summary output.

Non-blocking gaps:

- The commit also carries Claude Desktop split-ZIP behavior in
  `packages/cli/src/setup-agents.ts`. That is outside the output-polish spec,
  but the executed plan treated it as the baseline and the user identified the
  remaining README/docs-site split-ZIP edits as unrelated.
- Tests do not directly assert that the short multiselect hint is skipped when
  `--target` is supplied. The current implementation does skip it through the
  `args.inputMode === 'auto' && args.target === undefined` guard, so this is a
  coverage improvement, not a v1 blocker.

## File structure

Modify:

- `packages/cli/src/setup.test.ts`
  - Update the stale full-setup assertion to expect the new inline summary and
    reject the removed note title.

Do not modify:

- `packages/cli/src/setup-agents.ts`
- `packages/cli/src/setup-agents.test.ts`
- `README.md`
- `docs-site/content/docs/integrations/agent-clients.mdx`

## Task 1: Update the parent setup integration test

**Files:**

- Modify: `packages/cli/src/setup.test.ts`

- [ ] **Step 1: Reproduce the failing direct setup test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup.test.ts
```

Expected: FAIL with this assertion:

```text
expected ... to contain 'Agent integration complete'
```

- [ ] **Step 2: Replace the stale output assertion**

In `packages/cli/src/setup.test.ts`, inside the test named
`prints agent next actions inside the final ready summary during full setup`,
replace:

```typescript
    expect(output).toContain('Agent integration complete');
    expect(output).toContain('Finish KTX agent setup');
    expect(output).not.toContain('KTX project ready');
    expect(output).toContain('REQUIRED BEFORE USING AGENTS');
```

with:

```typescript
    expect(output).toContain('Claude Code · Project scope');
    expect(output).toContain(join(tempDir, '.mcp.json'));
    expect(output).toContain('Requires MCP to be started.');
    expect(output).toContain('Analytics skill installed.');
    expect(output).not.toContain('Agent integration complete');
    expect(output).toContain('Finish KTX agent setup');
    expect(output).not.toContain('KTX project ready');
    expect(output).toContain('REQUIRED BEFORE USING AGENTS');
```

- [ ] **Step 3: Run the direct setup test and verify it passes**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup.test.ts
```

Expected: PASS with `46 passed`.

- [ ] **Step 4: Re-run setup-agents tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts
```

Expected: PASS with `28 passed`.

- [ ] **Step 5: Run package verification**

Run:

```bash
pnpm --filter @ktx/cli run type-check
pnpm --filter @ktx/cli run test
pnpm run dead-code
source .venv/bin/activate && uv run pre-commit run --files packages/cli/src/setup.test.ts
```

Expected: all commands PASS. The `pnpm --filter @ktx/cli run test` command
still excludes `src/setup.test.ts`, so Step 3 remains the required direct
coverage for this gap.

- [ ] **Step 6: Commit the follow-up test fix**

Run:

```bash
git status --short
git add packages/cli/src/setup.test.ts
git commit -m "test: update setup agents output polish assertion"
```

Expected: the commit includes only `packages/cli/src/setup.test.ts`. Leave the
unrelated dirty `README.md` and
`docs-site/content/docs/integrations/agent-clients.mdx` files uncommitted.

## Self-review checklist

- `packages/cli/src/setup.test.ts` no longer expects
  `Agent integration complete`.
- The test asserts the new inline summary heading and key body lines.
- The test still verifies the parent `Finish KTX agent setup` ready summary and
  required next-actions content.
- No production code changed.
- Unrelated README and docs-site split-ZIP edits remain untouched.
