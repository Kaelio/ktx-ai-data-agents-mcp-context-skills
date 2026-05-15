# Claude Code Backend V1 Ingest Guidance Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `ktx ingest` missing-LLM guidance treat `claude-code` as a first-class setup path and restore the CLI ingest test suite.

**Architecture:** Keep the existing Claude Code runtime implementation unchanged. Update the single local-ingest guard message so users see both the local Claude Code setup path and the Anthropic API setup path, then align the context and CLI tests with that user-facing copy.

**Tech Stack:** TypeScript, pnpm, Vitest.

---

## Audit summary

The May 15 Claude Code backend runtime and isolation plans are implemented for
the core runtime path: config accepts `claude-code`, runtime calls use
`KtxLlmRuntimePort`, Claude SDK calls pass isolation options and scrubbed env,
setup/status/doctor validate Claude Code auth, and docs describe the backend.

One v1-blocking issue remains: `packages/context/src/ingest/local-bundle-runtime.ts`
lists `claude-code` in the missing-LLM guard line but still tells users only to
"Configure an Anthropic provider." The full CLI ingest test suite currently
fails because `packages/cli/src/ingest.test.ts` still expects the old provider
list without `claude-code`. This is v1-blocking because CI is red and the
fallback guidance is not first-class for the new backend.

Non-blocking gaps from the original spec remain unchanged:

- Same-step AI SDK tool-call repair parity is out of scope for the Claude Code
  runtime.
- OTEL telemetry parity is out of scope for the Claude Code runtime.
- Embedding parity is out of scope because embeddings stay independently
  configured.
- Full prompt-caching parity for tools, history, and per-section TTLs is out of
  scope; v1 only needs no AI SDK cache markers on `claude-code` and explicit
  warnings for ignored fields.

## File structure

Modify these files:

- `packages/context/src/ingest/local-bundle-runtime.ts` owns the missing-LLM
  guard message used by local ingest and MCP-triggered ingest.
- `packages/context/src/ingest/local-bundle-runtime.test.ts` verifies the guard
  message at the context boundary.
- `packages/cli/src/ingest.test.ts` verifies the user-facing CLI output.

No `docs-site/` update is required because the existing public docs already
document `claude-code` setup and ingest behavior; this plan only fixes an
inline runtime error message.

### Task 1: Update ingest LLM setup guidance

**Files:**

- Modify: `packages/context/src/ingest/local-bundle-runtime.test.ts`
- Modify: `packages/cli/src/ingest.test.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.ts`

- [ ] **Step 1: Update the context guard-message test**

In `packages/context/src/ingest/local-bundle-runtime.test.ts`, replace the
expected message in `requires an agent runner or configured local ingest LLM`
with this exact array:

```ts
[
  'ktx ingest requires llm.provider.backend: anthropic, vertex, gateway, or claude-code, or an injected agentRunner.',
  'Configure a local Claude Code session or API-backed LLM, then rerun ingest:',
  `  ktx setup --project-dir ${project.projectDir} --llm-backend claude-code --no-input`,
  `  ktx setup --project-dir ${project.projectDir} --llm-backend anthropic --anthropic-api-key-env ANTHROPIC_API_KEY --anthropic-model claude-sonnet-4-6 --no-input`,
].join('\n')
```

- [ ] **Step 2: Update the CLI ingest test**

In `packages/cli/src/ingest.test.ts`, replace the stale provider-list
assertion in `prints provider setup guidance when a skip-llm setup project runs
ingest` with:

```ts
expect(runIo.stderr()).toContain(
  'ktx ingest requires llm.provider.backend: anthropic, vertex, gateway, or claude-code, or an injected agentRunner.',
);
expect(runIo.stderr()).toContain('Configure a local Claude Code session or API-backed LLM, then rerun ingest:');
expect(runIo.stderr()).toContain(`ktx setup --project-dir ${projectDir} --llm-backend claude-code --no-input`);
expect(runIo.stderr()).toContain(
  `ktx setup --project-dir ${projectDir} --llm-backend anthropic --anthropic-api-key-env ANTHROPIC_API_KEY --anthropic-model claude-sonnet-4-6 --no-input`,
);
```

- [ ] **Step 3: Run tests to verify the new expectations fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-bundle-runtime.test.ts
pnpm --filter @ktx/cli exec vitest run src/ingest.test.ts
```

Expected: both suites fail because the source message still says
`Configure an Anthropic provider, then rerun ingest:` and does not include the
Claude Code setup command.

- [ ] **Step 4: Update the ingest guard message**

In `packages/context/src/ingest/local-bundle-runtime.ts`, replace
`localIngestLlmProviderGuardMessage` with:

```ts
function localIngestLlmProviderGuardMessage(projectDir: string): string {
  return [
    'ktx ingest requires llm.provider.backend: anthropic, vertex, gateway, or claude-code, or an injected agentRunner.',
    'Configure a local Claude Code session or API-backed LLM, then rerun ingest:',
    `  ktx setup --project-dir ${projectDir} --llm-backend claude-code --no-input`,
    `  ktx setup --project-dir ${projectDir} --llm-backend anthropic --anthropic-api-key-env ANTHROPIC_API_KEY --anthropic-model claude-sonnet-4-6 --no-input`,
  ].join('\n');
}
```

- [ ] **Step 5: Run the targeted tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-bundle-runtime.test.ts
pnpm --filter @ktx/cli exec vitest run src/ingest.test.ts
```

Expected: both suites pass.

- [ ] **Step 6: Run package type-checks**

Run:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/cli run type-check
```

Expected: both commands pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add packages/context/src/ingest/local-bundle-runtime.ts packages/context/src/ingest/local-bundle-runtime.test.ts packages/cli/src/ingest.test.ts
git commit -m "fix: update claude-code ingest setup guidance"
```

## Self-review

- Spec coverage: This plan closes the only remaining v1-blocking audit finding:
  ingest setup guidance and CLI test expectations now include `claude-code` as
  a first-class backend.
- Placeholder scan: No placeholders remain; every step includes exact paths,
  code, commands, and expected output.
- Type consistency: The exact guard string is identical across the source and
  both test updates.
