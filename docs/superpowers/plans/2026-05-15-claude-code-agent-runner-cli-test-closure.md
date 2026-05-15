# Claude Code Agent Runner CLI Test Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the CLI ingest verification suite after the Claude Code agent-runner backend changed the no-LLM guidance text.

**Architecture:** Keep the implemented runtime behavior unchanged. Update the stale CLI ingest test expectation so it matches the current context-runtime guard that accepts either a configured global LLM provider, `llm.agentRunner.backend: claude-code`, or an injected agent runner.

**Tech Stack:** TypeScript, Vitest, pnpm.

---

## Implemented spec coverage

The previous Claude Code backend plans are implemented in source: `llm.agentRunner.backend` exists, the final agent tool map uses `AgentToolSet`, the Claude Agent SDK runner disables built-in tools, filesystem settings, and SDK skills, ingest and memory DI choose the Claude runner, setup probes Claude Code auth with `accountInfo()`, and WorkUnit SDK tool failures enter the existing transcript-based failure counter.

The remaining v1 blocker is verification-only: `packages/cli/src/ingest.test.ts` still expects the pre-agent-runner error text, so `pnpm --filter @ktx/cli exec vitest run src/ingest.test.ts` fails even though runtime behavior is correct.

## File structure

- Modify `packages/cli/src/ingest.test.ts` to expect the Claude Code-aware setup guidance.

---

### Task 1: Update the stale CLI ingest assertion

**Files:**
- Modify: `packages/cli/src/ingest.test.ts`

- [ ] **Step 1: Confirm the existing failure**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest.test.ts
```

Expected: FAIL in `prints provider setup guidance when a skip-llm setup project runs ingest` because the test expects:

```text
ktx ingest requires llm.provider.backend: anthropic, vertex, or gateway, or an injected agentRunner.
```

but the runtime now emits:

```text
ktx ingest requires llm.provider.backend: anthropic, vertex, or gateway; llm.agentRunner.backend: claude-code; or an injected agentRunner.
```

- [ ] **Step 2: Update the expected guidance string**

In `packages/cli/src/ingest.test.ts`, replace the stale assertion:

```typescript
    expect(runIo.stderr()).toContain(
      'ktx ingest requires llm.provider.backend: anthropic, vertex, or gateway, or an injected agentRunner.',
    );
```

with:

```typescript
    expect(runIo.stderr()).toContain(
      'ktx ingest requires llm.provider.backend: anthropic, vertex, or gateway; llm.agentRunner.backend: claude-code; or an injected agentRunner.',
    );
```

Keep the following assertion that checks the Anthropic setup command:

```typescript
    expect(runIo.stderr()).toContain(
      `ktx setup --project-dir ${projectDir} --anthropic-api-key-env ANTHROPIC_API_KEY --anthropic-model claude-sonnet-4-6 --no-input`,
    );
```

- [ ] **Step 3: Run the focused CLI ingest test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest.test.ts
```

Expected: PASS with `Test Files 1 passed` and `Tests 30 passed`.

- [ ] **Step 4: Run the Claude Code setup regression tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-models.test.ts src/index.test.ts
```

Expected: PASS with `Test Files 2 passed` and all tests passing.

- [ ] **Step 5: Run CLI type-check**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/cli/src/ingest.test.ts
git commit -m "test: update claude-code ingest guidance expectation"
```

Expected: Commit succeeds with only `packages/cli/src/ingest.test.ts` staged.

---

## Self-review

- Spec coverage: This plan closes the only v1-blocking gap found in the audit, a failing CLI test caused by stale expected text after the implemented Claude Code agent-runner guard changed.
- Placeholder scan: The plan contains exact file paths, commands, expected outputs, and replacement code.
- Type consistency: The expected string matches the implemented guard in `packages/context/src/ingest/local-bundle-runtime.ts`.
