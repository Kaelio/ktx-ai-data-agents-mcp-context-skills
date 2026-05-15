# Claude Code Agent Runner V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `claude-code` agent-runner backend that runs KTX ingest and memory-agent loops through `@anthropic-ai/claude-agent-sdk` while preserving KTX's curated tool boundary.

**Architecture:** Keep the existing global `llm.provider.backend` values unchanged and add `llm.agentRunner.backend` for agent-loop selection. Convert final agent tool maps to a backend-neutral `AgentToolSet`; the existing AI SDK runner converts that set back to AI SDK tools, while the new Claude Agent SDK runner exposes the same set as an in-process KTX MCP server with Claude Code built-ins, filesystem settings, and SDK skills disabled.

**Tech Stack:** TypeScript, Zod 4, AI SDK v6, `@anthropic-ai/claude-agent-sdk` 0.3.142, Vitest, pnpm.

---

## Decisions Locked By This Plan

- Use `llm.agentRunner.backend: ai-sdk | claude-code`; default is `ai-sdk`.
- Leave `llm.provider.backend` unchanged: `none | anthropic | vertex | gateway`.
- For `claude-code`, use `llm.models[modelRole] ?? llm.models.default`; if neither exists, omit `model` and let the SDK use the authenticated Claude Code default.
- Pin `@anthropic-ai/claude-agent-sdk` to `0.3.142` in `packages/context`.
- In the Claude runner, pass `tools: []`, `settingSources: []`, `skills: []`, `allowedTools: ['mcp__ktx__*']`, `permissionMode: 'dontAsk'`, and a `canUseTool` guard that allows only `mcp__ktx__` names.
- Preserve the AI SDK runner's current repair and telemetry behavior; the Claude runner ships without same-step repair and without OTEL telemetry.

## File Structure

- Modify `packages/context/package.json` and `pnpm-lock.yaml` to add the Agent SDK dependency.
- Modify `packages/context/src/project/config.ts` and `packages/context/src/project/config.test.ts` for `llm.agentRunner`.
- Create `packages/context/src/agent/agent-tool.ts` for backend-neutral tool descriptors and AI SDK conversion.
- Modify `packages/context/src/tools/base-tool.ts` so every `BaseTool` can emit an `AgentToolDefinition`.
- Modify ingest and memory toolset ports in `packages/context/src/ingest/ports.ts` and `packages/context/src/memory/types.ts` to return `AgentToolSet`.
- Modify raw stage-local tool files under `packages/context/src/ingest/tools/` and inline `load_skill` tools so the final map handed to `runLoop` is `AgentToolSet`.
- Modify `packages/context/src/agent/agent-runner.service.ts` to implement `AgentRunnerPort` and convert `AgentToolSet` to AI SDK tools internally.
- Create `packages/context/src/agent/claude-agent-sdk-runner.service.ts` and `packages/context/src/agent/claude-agent-sdk-runner.service.test.ts`.
- Modify DI wiring in `packages/context/src/ingest/local-bundle-runtime.ts`, `packages/context/src/ingest/local-ingest.ts`, and `packages/context/src/memory/local-memory.ts`.
- Modify setup files `packages/cli/src/commands/setup-commands.ts`, `packages/cli/src/setup-models.ts`, and related tests to support `--llm-backend claude-code`.
- Modify docs-site pages under `docs-site/content/docs/getting-started/` and `docs-site/content/docs/concepts/`.

---

### Task 1: Add Agent Runner Config And SDK Dependency

**Files:**
- Modify: `packages/context/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/context/src/project/config.ts`
- Modify: `packages/context/src/project/config.test.ts`
- Modify: `packages/context/src/project/index.ts`

- [ ] **Step 1: Add failing config tests**

Append these tests to `packages/context/src/project/config.test.ts` inside the existing `describe('KTX project config', () => { ... })` block:

```typescript
  it('defaults the agent runner backend to ai-sdk', () => {
    expect(buildDefaultKtxProjectConfig().llm.agentRunner).toEqual({
      backend: 'ai-sdk',
    });
  });

  it('accepts claude-code as an agent runner backend without enabling the global LLM provider', () => {
    const config = parseKtxProjectConfig(`
llm:
  agentRunner:
    backend: claude-code
  models:
    default: claude-sonnet-4-6
`);

    expect(config.llm.provider.backend).toBe('none');
    expect(config.llm.agentRunner.backend).toBe('claude-code');
    expect(config.llm.models.default).toBe('claude-sonnet-4-6');
  });

  it('rejects unknown agent runner backends with a scoped config issue', () => {
    const result = validateKtxProjectConfig(`
llm:
  agentRunner:
    backend: subprocess
`);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues).toContainEqual({
      path: 'llm.agentRunner',
      message: 'Unsupported llm.agentRunner: subprocess',
    });
  });

  it('includes agent runner backend values in the generated JSON schema', () => {
    const schema = generateKtxProjectConfigJsonSchema();
    const properties = schema.properties as Record<string, { properties?: Record<string, unknown> }>;
    const llm = properties.llm as { properties?: Record<string, { properties?: Record<string, unknown> }> };
    const agentRunner = llm.properties?.agentRunner as { properties?: Record<string, unknown> };
    const backend = agentRunner.properties?.backend as { enum?: readonly string[] };

    expect(backend.enum).toEqual(['ai-sdk', 'claude-code']);
  });
```

- [ ] **Step 2: Run config tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/project/config.test.ts
```

Expected: FAIL because `llm.agentRunner` is not in the schema.

- [ ] **Step 3: Add the config schema**

In `packages/context/src/project/config.ts`, add the backend enum near the existing backend constants:

```typescript
const KTX_AGENT_RUNNER_BACKENDS = ['ai-sdk', 'claude-code'] as const;
```

Add this schema between `promptCachingSchema` and `llmSchema`:

```typescript
const agentRunnerSchema = z
  .strictObject({
    backend: z
      .enum(KTX_AGENT_RUNNER_BACKENDS)
      .default('ai-sdk')
      .describe('Agent-loop backend. "ai-sdk" uses the configured LLM provider; "claude-code" uses the local Claude Agent SDK session for agentic loops only.'),
  })
  .describe('Agent runner backend selection for ingest and memory-agent loops.');
```

Modify `llmSchema` so it includes `agentRunner`:

```typescript
const llmSchema = z
  .strictObject({
    provider: llmProviderSchema.prefault({}).describe('LLM provider backend and credentials.'),
    models: z
      .partialRecord(z.enum(KTX_MODEL_ROLES), z.string().min(1))
      .default({})
      .describe('Per-role model overrides keyed by KTX model role (e.g. "default", "triage"). Values are provider-specific model identifiers.'),
    promptCaching: promptCachingSchema.optional().describe('Optional prompt-caching tunables.'),
    agentRunner: agentRunnerSchema.prefault({}).describe('Agent runner backend selection for ingest and memory-agent loops.'),
  })
  .describe('LLM provider, per-role model overrides, prompt-caching tunables, and agent-runner backend.');
```

Add this exported type near the existing config types:

```typescript
export type KtxProjectAgentRunnerConfig = z.infer<typeof agentRunnerSchema>;
```

In `packages/context/src/project/index.ts`, export the new type with the other config types:

```typescript
  KtxProjectAgentRunnerConfig,
```

- [ ] **Step 4: Update default-config test expectation**

In the `builds the default standalone project config` test, replace the `llm` block with:

```typescript
      llm: {
        provider: {
          backend: 'none',
        },
        models: {},
        agentRunner: {
          backend: 'ai-sdk',
        },
      },
```

- [ ] **Step 5: Add SDK dependency**

Modify `packages/context/package.json` dependencies:

```json
    "@anthropic-ai/claude-agent-sdk": "0.3.142",
    "@ktx/llm": "workspace:*",
```

Run:

```bash
pnpm install --lockfile-only
```

Expected: `pnpm-lock.yaml` records `@anthropic-ai/claude-agent-sdk@0.3.142` and its optional platform packages.

- [ ] **Step 6: Run config tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/project/config.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/context/package.json pnpm-lock.yaml packages/context/src/project/config.ts packages/context/src/project/config.test.ts packages/context/src/project/index.ts
git commit -m "feat: add claude-code agent runner config"
```

---

### Task 2: Add Backend-Neutral Agent Tools

**Files:**
- Create: `packages/context/src/agent/agent-tool.ts`
- Modify: `packages/context/src/agent/index.ts`
- Modify: `packages/context/src/tools/base-tool.ts`
- Modify: `packages/context/src/ingest/ports.ts`
- Modify: `packages/context/src/memory/types.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Modify: `packages/context/src/memory/local-memory.ts`
- Test: `packages/context/src/agent/agent-tool.test.ts`

- [ ] **Step 1: Add failing agent-tool tests**

Create `packages/context/src/agent/agent-tool.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgentTool, toAiSdkTool, toAiSdkToolSet } from './agent-tool.js';

describe('agent tools', () => {
  it('converts an agent tool to an AI SDK tool and preserves markdown output', async () => {
    const execute = vi.fn(async (input: { name: string }) => ({
      markdown: `hello ${input.name}`,
      structured: { ok: true },
    }));
    const agentTool = createAgentTool({
      name: 'greet',
      description: 'Greet someone',
      inputSchema: z.object({ name: z.string() }),
      execute,
    });

    const aiTool = toAiSdkTool(agentTool);
    const output = await aiTool.execute?.({ name: 'Ada' }, { toolCallId: 'call-1', messages: [] } as never);
    const modelOutput = aiTool.toModelOutput?.({ output } as never);

    expect(execute).toHaveBeenCalledWith({ name: 'Ada' }, { toolCallId: 'call-1' });
    expect(modelOutput).toEqual({ type: 'content', value: [{ type: 'text', text: 'hello Ada' }] });
  });

  it('converts a named map of agent tools to an AI SDK tool set', () => {
    const toolSet = toAiSdkToolSet({
      ping: createAgentTool({
        name: 'ping',
        description: 'Ping',
        inputSchema: z.object({}),
        execute: async () => 'pong',
      }),
    });

    expect(Object.keys(toolSet)).toEqual(['ping']);
    expect(toolSet.ping?.description).toBe('Ping');
  });
});
```

- [ ] **Step 2: Run agent-tool tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/agent/agent-tool.test.ts
```

Expected: FAIL because `agent-tool.ts` does not exist.

- [ ] **Step 3: Create agent-tool helpers**

Create `packages/context/src/agent/agent-tool.ts`:

```typescript
import { tool as aiTool, type Tool, type ToolSet } from 'ai';
import { z, type ZodObject, type ZodRawShape } from 'zod';

export interface AgentToolCallOptions {
  toolCallId?: string;
}

export type AgentToolOutput = string | { markdown: string; structured?: unknown };

export interface AgentToolDefinition<TInputSchema extends ZodObject<ZodRawShape> = ZodObject<ZodRawShape>> {
  name: string;
  description: string;
  inputSchema: TInputSchema;
  execute(input: z.infer<TInputSchema>, options: AgentToolCallOptions): Promise<AgentToolOutput>;
}

export type AgentToolSet = Record<string, AgentToolDefinition>;

export function createAgentTool<TInputSchema extends ZodObject<ZodRawShape>>(
  definition: AgentToolDefinition<TInputSchema>,
): AgentToolDefinition<TInputSchema> {
  return definition;
}

export function assertAgentToolSet(toolSet: AgentToolSet): void {
  for (const [name, definition] of Object.entries(toolSet)) {
    if (definition.name !== name) {
      throw new Error(`Agent tool map key "${name}" does not match definition name "${definition.name}"`);
    }
    if (!(definition.inputSchema instanceof z.ZodObject)) {
      throw new Error(`Agent tool "${name}" must use a Zod object input schema`);
    }
  }
}

export function agentToolOutputToText(output: AgentToolOutput): string {
  if (output && typeof output === 'object' && 'markdown' in output) {
    return output.markdown;
  }
  return String(output);
}

export function toAiSdkTool(definition: AgentToolDefinition): Tool {
  return aiTool({
    description: definition.description,
    inputSchema: definition.inputSchema,
    execute: async (params, options) =>
      definition.execute(definition.inputSchema.parse(params), {
        ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
      }),
    toModelOutput: ({ output }) => ({
      type: 'content',
      value: [{ type: 'text', text: agentToolOutputToText(output as AgentToolOutput) }],
    }),
  });
}

export function toAiSdkToolSet(toolSet: AgentToolSet): ToolSet {
  assertAgentToolSet(toolSet);
  return Object.fromEntries(Object.entries(toolSet).map(([name, definition]) => [name, toAiSdkTool(definition)]));
}
```

- [ ] **Step 4: Export agent-tool helpers**

In `packages/context/src/agent/index.ts`, add:

```typescript
export type { AgentToolCallOptions, AgentToolDefinition, AgentToolOutput, AgentToolSet } from './agent-tool.js';
export { agentToolOutputToText, assertAgentToolSet, createAgentTool, toAiSdkTool, toAiSdkToolSet } from './agent-tool.js';
```

- [ ] **Step 5: Modify BaseTool**

In `packages/context/src/tools/base-tool.ts`, add this import:

```typescript
import { createAgentTool, toAiSdkTool, type AgentToolDefinition } from '../agent/agent-tool.js';
```

Replace the existing `toAiSdkTool(context: ToolContext): any { ... }` method with these two methods:

```typescript
  toAgentTool(context: ToolContext): AgentToolDefinition<any> {
    const toolName = this.name;

    return createAgentTool({
      name: toolName,
      description: this.description,
      inputSchema: this.inputSchema as any,
      execute: async (params, { toolCallId }) => {
        const callContext = { ...context, ...(toolCallId ? { toolCallId } : {}) };

        if (callContext.timingTracker && toolCallId) {
          callContext.timingTracker.recordToolExecutionStart(callContext.messageId, toolName, toolCallId);
        }

        let state = 'completed';
        try {
          if (!callContext.userId) {
            throw new Error('Authentication required: userId must be provided in ToolContext');
          }
          const parsedInput = this.parseInput(params as Record<string, any>);
          return await this.call(parsedInput, callContext);
        } catch (error) {
          state = 'error';
          this.logger.error(
            `Tool ${this.name} execution failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        } finally {
          if (callContext.timingTracker && toolCallId) {
            callContext.timingTracker.recordToolExecutionEnd(callContext.messageId, toolName, toolCallId, state);
          }
        }
      },
    });
  }

  toAiSdkTool(context: ToolContext): any {
    return toAiSdkTool(this.toAgentTool(context));
  }
```

- [ ] **Step 6: Retype toolset ports**

In `packages/context/src/ingest/ports.ts`, add:

```typescript
import type { AgentToolSet } from '../agent/index.js';
```

Change `IngestToolsetLike` to:

```typescript
export interface IngestToolsetLike {
  toAgentTools(context: ToolContext): AgentToolSet;
}
```

In `packages/context/src/memory/types.ts`, add:

```typescript
import type { AgentToolSet } from '../agent/index.js';
```

Change `MemoryToolSetLike` to:

```typescript
export interface MemoryToolSetLike {
  toAgentTools(context: ToolContext): AgentToolSet;
}
```

- [ ] **Step 7: Update local toolset factories**

In `packages/context/src/ingest/local-bundle-runtime.ts`, change `LocalIngestToolset.toAiSdkTools` to:

```typescript
  toAgentTools(context: ToolContext) {
    return {
      ...Object.fromEntries(this.tools.map((tool) => [tool.name, tool.toAgentTool(context)])),
      ...this.extraTools,
    };
  }
```

Change the `extraTools` constructor type from `Record<string, Tool>` to `AgentToolSet`. The `emit_historic_sql_evidence` conversion is completed in Task 3.

In `packages/context/src/memory/local-memory.ts`, change `LocalMemoryToolset.toAiSdkTools` to:

```typescript
  toAgentTools(context: ToolContext) {
    return Object.fromEntries(this.tools.map((tool) => [tool.name, tool.toAgentTool(context)]));
  }
```

- [ ] **Step 8: Run agent-tool tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/agent/agent-tool.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/context/src/agent/agent-tool.ts packages/context/src/agent/agent-tool.test.ts packages/context/src/agent/index.ts packages/context/src/tools/base-tool.ts packages/context/src/ingest/ports.ts packages/context/src/memory/types.ts packages/context/src/ingest/local-bundle-runtime.ts packages/context/src/memory/local-memory.ts
git commit -m "feat: add backend-neutral agent tools"
```

---

### Task 3: Convert Final RunLoop Tool Maps To AgentToolSet

**Files:**
- Modify: `packages/context/src/ingest/tools/read-raw-file.tool.ts`
- Modify: `packages/context/src/ingest/tools/read-raw-span.tool.ts`
- Modify: `packages/context/src/ingest/tools/stage-list.tool.ts`
- Modify: `packages/context/src/ingest/tools/stage-diff.tool.ts`
- Modify: `packages/context/src/ingest/tools/eviction-list.tool.ts`
- Modify: `packages/context/src/ingest/tools/emit-unmapped-fallback.tool.ts`
- Modify: `packages/context/src/ingest/tools/verification-ledger.tool.ts`
- Modify: `packages/context/src/ingest/stages/build-wu-context.ts`
- Modify: `packages/context/src/ingest/stages/build-reconcile-context.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Modify: `packages/context/src/memory/memory-agent.service.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/evidence-tool.ts`
- Modify tests that construct expected tool maps under `packages/context/src/ingest/**` and `packages/context/src/memory/**`

- [ ] **Step 1: Add failing final-map assertions**

In `packages/context/src/ingest/stages/build-wu-context.test.ts`, update the first `buildWuToolSet` test so the provided tool maps use `createAgentTool`:

```typescript
import { createAgentTool } from '../../agent/index.js';
import { z } from 'zod';

const fakeTool = (name: string) =>
  createAgentTool({
    name,
    description: name,
    inputSchema: z.object({}),
    execute: async () => `${name} output`,
  });
```

Replace the test input maps in that file with:

```typescript
      loadSkillTool: { load_skill: fakeTool('load_skill') },
      emitUnmappedFallbackTool: { emit_unmapped_fallback: fakeTool('emit_unmapped_fallback') },
      toolsetTools: { wiki_write: fakeTool('wiki_write') },
```

Add this assertion to the same test:

```typescript
    expect(toolSet.record_verification_ledger.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(toolSet.wiki_write.name).toBe('wiki_write');
```

In `packages/context/src/ingest/stages/build-reconcile-context.test.ts`, apply the same `fakeTool` helper and assert:

```typescript
    expect(toolSet.record_verification_ledger.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(toolSet.emit_conflict_resolution.name).toBe('emit_conflict_resolution');
```

- [ ] **Step 2: Run stage toolset tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/stages/build-wu-context.test.ts src/ingest/stages/build-reconcile-context.test.ts
```

Expected: FAIL because the stage builders still use AI SDK `ToolSet`.

- [ ] **Step 3: Update stage builder types**

In `packages/context/src/ingest/stages/build-wu-context.ts`, replace the AI SDK import:

```typescript
import type { AgentToolSet } from '../../agent/index.js';
```

Change `BuildWuToolSetInput` to:

```typescript
export interface BuildWuToolSetInput {
  sourceKey?: string;
  stagedDir: string;
  wu: WorkUnit;
  loadSkillTool: AgentToolSet;
  emitUnmappedFallbackTool: AgentToolSet;
  toolsetTools: AgentToolSet;
}
```

Change `withoutWriteSlTools` and `buildWuToolSet` signatures to return `AgentToolSet`.

In `packages/context/src/ingest/stages/build-reconcile-context.ts`, replace the AI SDK import with:

```typescript
import type { AgentToolSet } from '../../agent/index.js';
```

Change every tool-map field in `ReconcileToolSetInput` plus `toolsetTools` to `AgentToolSet`, and change `buildReconcileToolSet` to return `AgentToolSet`.

- [ ] **Step 4: Convert read raw tools**

In `packages/context/src/ingest/tools/read-raw-file.tool.ts`, replace `import { tool } from 'ai';` with:

```typescript
import { createAgentTool } from '../../agent/index.js';
```

Change the returned tool to:

```typescript
  return createAgentTool({
    name: 'read_raw_file',
    description:
      "Read the full text content of a raw source file inside this WorkUnit. `path` must be relative to the staged bundle root (no leading slash, no `..`) and must appear in the WorkUnit's rawFiles or dependencyPaths list.",
    inputSchema: z.object({
      path: z.string().describe('Path relative to the staged bundle root. Example: "views/customers/customer.lkml".'),
    }),
    execute: async ({ path }) => {
      const normalized = normalize(path).replace(/^[/\\]+/, '');
      if (normalized.startsWith('..') || !deps.allowedPaths.has(normalized)) {
        return `Error: path "${path}" is not accessible from this WorkUnit. Allowed paths: ${[...deps.allowedPaths].sort().join(', ')}`;
      }
      const absolute = resolve(join(stagedRoot, normalized));
      if (!absolute.startsWith(`${stagedRoot}/`) && absolute !== stagedRoot) {
        return `Error: path "${path}" is not accessible from this WorkUnit.`;
      }
      try {
        const fileStat = await stat(absolute);
        if (fileStat.size > MAX_READ_RAW_FILE_BYTES) {
          return `Error: file "${path}" is too large to return in full (${fileStat.size} bytes). Use read_raw_span with targeted line ranges instead.`;
        }
        return await readFile(absolute, 'utf-8');
      } catch (err) {
        return `Error: file "${path}" not found. (${err instanceof Error ? err.message : String(err)})`;
      }
    },
  });
```

In `packages/context/src/ingest/tools/read-raw-span.tool.ts`, make the same import replacement and change the returned tool to `createAgentTool({ name: 'read_raw_span', description: ..., inputSchema: ..., execute: ... })`, preserving the existing description, schema, and execute body exactly.

- [ ] **Step 5: Convert stage, eviction, fallback, and evidence tools**

For each creator below, replace `tool({ ... })` with `createAgentTool({ name: '<tool_name>', ... })` and keep the current description, input schema, and execute body:

```text
packages/context/src/ingest/tools/stage-list.tool.ts -> name: 'stage_list'
packages/context/src/ingest/tools/stage-diff.tool.ts -> name: 'stage_diff'
packages/context/src/ingest/tools/eviction-list.tool.ts -> name: 'eviction_list'
packages/context/src/ingest/tools/emit-unmapped-fallback.tool.ts -> name: 'emit_unmapped_fallback'
packages/context/src/ingest/adapters/historic-sql/evidence-tool.ts -> name: 'emit_historic_sql_evidence'
```

The resulting imports in each file must include:

```typescript
import { createAgentTool } from '../../agent/index.js';
```

For `packages/context/src/ingest/adapters/historic-sql/evidence-tool.ts`, the relative import is:

```typescript
import { createAgentTool } from '../../../agent/index.js';
```

- [ ] **Step 6: Convert verification ledger wrapper**

In `packages/context/src/ingest/tools/verification-ledger.tool.ts`, replace the AI SDK import with:

```typescript
import { createAgentTool, type AgentToolDefinition, type AgentToolSet } from '../../agent/index.js';
```

Change `withVerificationLedger` to:

```typescript
export function withVerificationLedger(tools: AgentToolSet, state: VerificationLedgerState): AgentToolSet {
  const wrapped: AgentToolSet = {};
  for (const [name, original] of Object.entries(tools)) {
    if (!WRITE_TOOL_NAMES.has(name)) {
      wrapped[name] = original;
      continue;
    }
    const guardedTool: AgentToolDefinition<any> = {
      ...original,
      execute: async (input, options) => {
        if (state.entries.length === 0) {
          return verificationRequiredOutput(name);
        }
        return original.execute(input, options);
      },
    };
    wrapped[name] = guardedTool;
  }
  wrapped.record_verification_ledger = createRecordVerificationLedgerTool(state);
  return wrapped;
}
```

Change `createRecordVerificationLedgerTool` to:

```typescript
function createRecordVerificationLedgerTool(state: VerificationLedgerState) {
  return createAgentTool({
    name: 'record_verification_ledger',
    description:
      'Record the pre-write verification ledger required by loaded ingest skills. Call this before wiki/SL/fallback writes to state what was verified, which tool calls support it, and what remains intentionally unverified.',
    inputSchema: verificationLedgerInputSchema,
    execute: async (input) => {
      const entry = verificationLedgerInputSchema.parse(input);
      state.entries.push(entry);
      return {
        markdown:
          `Verification ledger recorded. Summary: ${entry.summary}\n` +
          `Verified identifiers: ${entry.verifiedIdentifiers.length ? entry.verifiedIdentifiers.join(', ') : '(none)'}\n` +
          `Unverified identifiers: ${
            entry.unverifiedIdentifiers.length ? entry.unverifiedIdentifiers.join(', ') : '(none)'
          }`,
        structured: { success: true, entry },
      };
    },
  });
}
```

- [ ] **Step 7: Convert inline load_skill tools**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, replace each inline `load_skill: tool({ ... })` with `load_skill: createAgentTool({ name: 'load_skill', ... })`, preserving the current descriptions and execute bodies.

In `packages/context/src/memory/memory-agent.service.ts`, make the same replacement.

Both files must import:

```typescript
import { createAgentTool } from '../agent/index.js';
```

For `memory-agent.service.ts`, the relative import is also:

```typescript
import { createAgentTool } from '../agent/index.js';
```

- [ ] **Step 8: Replace final call-site conversion names**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, replace:

```typescript
toolsetTools: wuToolset.toAiSdkTools(wuToolContext),
```

with:

```typescript
toolsetTools: wuToolset.toAgentTools(wuToolContext),
```

Replace both reconciliation instances of `rcToolset.toAiSdkTools(rcToolContext)` with `rcToolset.toAgentTools(rcToolContext)`.

In `packages/context/src/memory/memory-agent.service.ts`, replace:

```typescript
toolSet: { ...toolset.toAiSdkTools(toolContext), ...loadSkillTool },
```

with:

```typescript
toolSet: { ...toolset.toAgentTools(toolContext), ...loadSkillTool },
```

- [ ] **Step 9: Run focused toolset tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/stages/build-wu-context.test.ts src/ingest/stages/build-reconcile-context.test.ts src/ingest/tools/verification-ledger.tool.test.ts src/ingest/tools/read-raw-file.tool.test.ts src/ingest/tools/read-raw-span.tool.test.ts src/ingest/tools/stage-list.tool.test.ts src/ingest/tools/stage-diff.tool.test.ts src/ingest/tools/eviction-list.tool.test.ts src/ingest/adapters/historic-sql/evidence-tool.test.ts
```

Expected: PASS.

- [ ] **Step 10: Run type-check and fix remaining call sites**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: initial FAIL if any `toAiSdkTools` or `ToolSet` references remain in final agent-loop tool composition. Replace those with `toAgentTools` and `AgentToolSet`, then rerun until PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/context/src/ingest packages/context/src/memory packages/context/src/agent packages/context/src/tools
git commit -m "feat: pass backend-neutral tools to agent runners"
```

---

### Task 4: Introduce AgentRunnerPort And Preserve AI SDK Behavior

**Files:**
- Modify: `packages/context/src/agent/agent-runner.service.ts`
- Modify: `packages/context/src/agent/index.ts`
- Modify: `packages/context/src/ingest/ports.ts`
- Modify: `packages/context/src/ingest/stages/stage-3-work-units.ts`
- Modify: `packages/context/src/ingest/stages/stage-4-reconciliation.ts`
- Modify: `packages/context/src/ingest/context-candidates/curator-pagination.service.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Modify: `packages/context/src/ingest/local-ingest.ts`
- Modify: `packages/context/src/memory/types.ts`
- Modify: `packages/context/src/memory/local-memory.ts`
- Test: `packages/context/src/agent/agent-runner.service.test.ts`

- [ ] **Step 1: Add failing AI SDK conversion test**

In `packages/context/src/agent/agent-runner.service.test.ts`, add this test:

```typescript
  it('converts AgentToolSet to AI SDK tools before generateText', async () => {
    generateTextMock.mockResolvedValue({} as never);
    await runner.runLoop({
      modelRole: 'default',
      systemPrompt: 'system',
      userPrompt: 'user',
      toolSet: {
        emit_candidate: createAgentTool({
          name: 'emit_candidate',
          description: 'Emit candidate',
          inputSchema: z.object({ key: z.string() }),
          execute: async ({ key }) => ({ markdown: key, structured: { key } }),
        }),
      },
      stepBudget: 3,
      telemetryTags: {},
    });

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          emit_candidate: expect.objectContaining({ description: 'Emit candidate' }),
        }),
      }),
    );
  });
```

Make sure the test imports:

```typescript
import { createAgentTool } from './agent-tool.js';
import { z } from 'zod';
```

- [ ] **Step 2: Run runner test and verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/agent/agent-runner.service.test.ts
```

Expected: FAIL because `RunLoopParams.toolSet` still expects AI SDK tools.

- [ ] **Step 3: Retype the runner contract**

In `packages/context/src/agent/agent-runner.service.ts`, change the AI SDK import to remove `type Tool` and add the neutral tool import:

```typescript
import { generateText, stepCountIs, type TelemetrySettings } from 'ai';
import { toAiSdkToolSet, type AgentToolSet } from './agent-tool.js';
```

Change `RunLoopParams.toolSet`:

```typescript
  toolSet: AgentToolSet;
```

Add the port interface after `RunLoopResult`:

```typescript
export interface AgentRunnerPort {
  runLoop(params: RunLoopParams): Promise<RunLoopResult>;
}
```

Change the class declaration:

```typescript
export class AgentRunnerService implements AgentRunnerPort {
```

Before building messages in `runLoop`, add:

```typescript
      const aiToolSet = toAiSdkToolSet(params.toolSet);
```

Change both `tools: params.toolSet` and `tools: built.tools as Record<string, Tool>` usage so the wrapped prompt and `generateText` receive `aiToolSet`:

```typescript
        tools: aiToolSet,
```

and:

```typescript
        tools: built.tools,
```

- [ ] **Step 4: Export AgentRunnerPort**

In `packages/context/src/agent/index.ts`, add `AgentRunnerPort` to the exported type list from `agent-runner.service.js`.

- [ ] **Step 5: Retype DI fields**

Replace imports and fields currently typed as `AgentRunnerService` with `AgentRunnerPort` in these files:

```text
packages/context/src/ingest/ports.ts
packages/context/src/ingest/stages/stage-3-work-units.ts
packages/context/src/ingest/stages/stage-4-reconciliation.ts
packages/context/src/ingest/context-candidates/curator-pagination.service.ts
packages/context/src/ingest/local-bundle-runtime.ts
packages/context/src/ingest/local-ingest.ts
packages/context/src/memory/types.ts
packages/context/src/memory/local-memory.ts
```

Use this import form where a type-only import is needed:

```typescript
import type { AgentRunnerPort } from '../agent/index.js';
```

For stage files that import through the package export, use:

```typescript
import type { AgentRunnerPort } from '@ktx/context/agent';
```

- [ ] **Step 6: Run runner and type-check tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/agent/agent-runner.service.test.ts
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/context/src/agent packages/context/src/ingest packages/context/src/memory
git commit -m "feat: add agent runner port"
```

---

### Task 5: Implement Claude Agent SDK Runner

**Files:**
- Create: `packages/context/src/agent/claude-agent-sdk-runner.service.ts`
- Create: `packages/context/src/agent/claude-agent-sdk-runner.service.test.ts`
- Modify: `packages/context/src/agent/index.ts`

- [ ] **Step 1: Add failing Claude runner tests**

Create `packages/context/src/agent/claude-agent-sdk-runner.service.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgentTool } from './agent-tool.js';
import { ClaudeAgentSdkRunnerService } from './claude-agent-sdk-runner.service.js';

function asyncMessages(messages: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    },
    close: vi.fn(),
  };
}

describe('ClaudeAgentSdkRunnerService', () => {
  it('runs with isolated settings, no built-ins, KTX MCP tools, and role model mapping', async () => {
    const query = vi.fn(() =>
      asyncMessages([
        { type: 'system', subtype: 'init', mcp_servers: [{ name: 'ktx', status: 'connected' }] },
        {
          type: 'result',
          subtype: 'success',
          terminal_reason: 'completed',
          result: 'done',
          is_error: false,
          permission_denials: [],
          errors: [],
        },
      ]),
    );
    const runner = new ClaudeAgentSdkRunnerService({
      projectDir: '/tmp/project',
      modelSlots: { default: 'claude-sonnet-4-6', reconcile: 'claude-opus-4-6' },
      query: query as never,
      createSdkMcpServer: vi.fn((input) => ({ type: 'sdk', name: input.name, instance: {} })) as never,
      tool: vi.fn((name, description, inputSchema, handler) => ({ name, description, inputSchema, handler })) as never,
    });

    const result = await runner.runLoop({
      modelRole: 'reconcile',
      systemPrompt: 'system',
      userPrompt: 'user',
      stepBudget: 7,
      telemetryTags: {},
      toolSet: {
        ping: createAgentTool({
          name: 'ping',
          description: 'Ping',
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => ({ markdown: `pong ${value}`, structured: { value } }),
        }),
      },
    });

    expect(result).toEqual({ stopReason: 'natural' });
    expect(query).toHaveBeenCalledWith({
      prompt: 'user',
      options: expect.objectContaining({
        cwd: '/tmp/project',
        systemPrompt: 'system',
        model: 'claude-opus-4-6',
        maxTurns: 7,
        tools: [],
        settingSources: [],
        skills: [],
        allowedTools: ['mcp__ktx__*'],
        permissionMode: 'dontAsk',
      }),
    });
  });

  it('maps max-turn terminal results to budget', async () => {
    const query = vi.fn(() =>
      asyncMessages([
        {
          type: 'result',
          subtype: 'error_max_turns',
          terminal_reason: 'max_turns',
          is_error: true,
          errors: [],
          permission_denials: [],
        },
      ]),
    );
    const runner = new ClaudeAgentSdkRunnerService({
      projectDir: '/tmp/project',
      modelSlots: {},
      query: query as never,
    });

    await expect(
      runner.runLoop({
        modelRole: 'default',
        systemPrompt: 'system',
        userPrompt: 'user',
        stepBudget: 1,
        telemetryTags: {},
        toolSet: {},
      }),
    ).resolves.toEqual({ stopReason: 'budget' });
  });

  it('denies non-KTX tool permission checks', async () => {
    const query = vi.fn(() =>
      asyncMessages([{ type: 'result', subtype: 'success', terminal_reason: 'completed', result: 'done' }]),
    );
    const runner = new ClaudeAgentSdkRunnerService({
      projectDir: '/tmp/project',
      modelSlots: {},
      query: query as never,
    });

    await runner.runLoop({
      modelRole: 'default',
      systemPrompt: 'system',
      userPrompt: 'user',
      stepBudget: 1,
      telemetryTags: {},
      toolSet: {},
    });

    const options = query.mock.calls[0][0].options;
    await expect(options.canUseTool('Bash', {}, { signal: new AbortController().signal, toolUseID: '1' })).resolves.toEqual({
      behavior: 'deny',
      message: 'Only KTX MCP tools are available in this session.',
    });
  });
});
```

- [ ] **Step 2: Run Claude runner tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/agent/claude-agent-sdk-runner.service.test.ts
```

Expected: FAIL because `claude-agent-sdk-runner.service.ts` does not exist.

- [ ] **Step 3: Implement Claude runner**

Create `packages/context/src/agent/claude-agent-sdk-runner.service.ts`:

```typescript
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { KtxModelRole } from '@ktx/llm';
import { noopLogger, type KtxLogger } from '../core/index.js';
import {
  agentToolOutputToText,
  assertAgentToolSet,
  type AgentToolDefinition,
  type AgentToolSet,
} from './agent-tool.js';
import type { AgentRunnerPort, RunLoopParams, RunLoopResult, RunLoopStopReason } from './agent-runner.service.js';

type QueryFn = typeof query;
type CreateSdkMcpServerFn = typeof createSdkMcpServer;
type ToolFn = typeof tool;

const BUILT_IN_TOOLS = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'ListMcpResources',
  'NotebookEdit',
  'Read',
  'ReadMcpResource',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
];

export interface ClaudeAgentSdkRunnerServiceDeps {
  projectDir: string;
  modelSlots: Partial<Record<KtxModelRole, string>>;
  query?: QueryFn;
  createSdkMcpServer?: CreateSdkMcpServerFn;
  tool?: ToolFn;
  logger?: KtxLogger;
}

export class ClaudeAgentSdkRunnerService implements AgentRunnerPort {
  private readonly query: QueryFn;
  private readonly createSdkMcpServer: CreateSdkMcpServerFn;
  private readonly tool: ToolFn;
  private readonly logger: KtxLogger;

  constructor(private readonly deps: ClaudeAgentSdkRunnerServiceDeps) {
    this.query = deps.query ?? query;
    this.createSdkMcpServer = deps.createSdkMcpServer ?? createSdkMcpServer;
    this.tool = deps.tool ?? tool;
    this.logger = deps.logger ?? noopLogger;
  }

  async runLoop(params: RunLoopParams): Promise<RunLoopResult> {
    try {
      assertAgentToolSet(params.toolSet);
      const result = await this.consumeQuery(params);
      return { stopReason: this.mapResultToStopReason(result) };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`[claude-agent-sdk-runner] loop failed: ${err.message}`);
      return { stopReason: 'error', error: err };
    }
  }

  private async consumeQuery(params: RunLoopParams): Promise<SDKResultMessage | undefined> {
    let result: SDKResultMessage | undefined;
    let stepIndex = 0;
    const session = this.query({
      prompt: params.userPrompt,
      options: {
        cwd: this.deps.projectDir,
        systemPrompt: params.systemPrompt,
        maxTurns: params.stepBudget,
        ...this.modelOption(params.modelRole),
        mcpServers: {
          ktx: this.createSdkMcpServer({
            name: 'ktx',
            version: '1.0.0',
            tools: Object.values(params.toolSet).map((definition) => this.toSdkTool(definition)),
          }),
        },
        tools: [],
        settingSources: [],
        skills: [],
        allowedTools: ['mcp__ktx__*'],
        disallowedTools: BUILT_IN_TOOLS,
        permissionMode: 'dontAsk',
        canUseTool: this.canUseKtxTool,
      },
    });

    for await (const message of session as AsyncIterable<SDKMessage>) {
      if (message.type === 'assistant') {
        stepIndex += 1;
        if (params.onStepFinish) {
          await params.onStepFinish({ stepIndex, stepBudget: params.stepBudget });
        }
      }
      if (message.type === 'result') {
        result = message;
      }
    }
    return result;
  }

  private modelOption(role: KtxModelRole): { model?: string } {
    const model = this.deps.modelSlots[role] ?? this.deps.modelSlots.default;
    return model ? { model } : {};
  }

  private toSdkTool(definition: AgentToolDefinition) {
    return this.tool(definition.name, definition.description, definition.inputSchema.shape, async (args) => {
      const output = await definition.execute(definition.inputSchema.parse(args), {});
      return { content: [{ type: 'text' as const, text: agentToolOutputToText(output) }] };
    });
  }

  private readonly canUseKtxTool: CanUseTool = async (toolName) => {
    if (toolName.startsWith('mcp__ktx__')) {
      return { behavior: 'allow', updatedInput: undefined };
    }
    return {
      behavior: 'deny',
      message: 'Only KTX MCP tools are available in this session.',
    };
  };

  private mapResultToStopReason(result: SDKResultMessage | undefined): RunLoopStopReason {
    if (!result) {
      return 'error';
    }
    if (result.subtype === 'error_max_turns' || result.terminal_reason === 'max_turns') {
      return 'budget';
    }
    if (result.subtype === 'success' && (!result.terminal_reason || result.terminal_reason === 'completed')) {
      return 'natural';
    }
    return 'error';
  }
}
```

- [ ] **Step 4: Export Claude runner**

In `packages/context/src/agent/index.ts`, add:

```typescript
export type { ClaudeAgentSdkRunnerServiceDeps } from './claude-agent-sdk-runner.service.js';
export { ClaudeAgentSdkRunnerService } from './claude-agent-sdk-runner.service.js';
```

- [ ] **Step 5: Run Claude runner tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/agent/claude-agent-sdk-runner.service.test.ts
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/agent/claude-agent-sdk-runner.service.ts packages/context/src/agent/claude-agent-sdk-runner.service.test.ts packages/context/src/agent/index.ts
git commit -m "feat: add claude agent sdk runner"
```

---

### Task 6: Wire Ingest, Memory, Setup, And Docs

**Files:**
- Modify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.test.ts`
- Modify: `packages/context/src/memory/local-memory.ts`
- Modify: `packages/context/src/memory/local-memory.test.ts`
- Modify: `packages/cli/src/commands/setup-commands.ts`
- Modify: `packages/cli/src/setup-models.ts`
- Modify: `packages/cli/src/index.test.ts`
- Modify: `docs-site/content/docs/getting-started/quickstart.mdx`
- Modify: `docs-site/content/docs/concepts/the-context-layer.mdx`

- [ ] **Step 1: Add failing DI tests**

In `packages/context/src/ingest/local-bundle-runtime.test.ts`, add:

```typescript
  it('constructs a Claude Agent SDK runner when llm.agentRunner.backend is claude-code', () => {
    const project = createTestProject({
      llm: {
        provider: { backend: 'none' },
        models: { default: 'claude-sonnet-4-6' },
        agentRunner: { backend: 'claude-code' },
      },
    });

    const resolved = resolveAgentRunnerForTest({ project, adapters: [] });

    expect(resolved.agentRunner.constructor.name).toBe('ClaudeAgentSdkRunnerService');
  });
```

If the test file does not expose `resolveAgentRunner`, export a test-only helper from `local-bundle-runtime.ts`:

```typescript
export const resolveAgentRunnerForTest = resolveAgentRunner;
```

In `packages/context/src/memory/local-memory.test.ts`, add an equivalent test around `createLocalProjectMemoryCapture` using a project whose config has `llm.agentRunner.backend: claude-code`.

- [ ] **Step 2: Run DI tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-bundle-runtime.test.ts src/memory/local-memory.test.ts
```

Expected: FAIL because DI always constructs `AgentRunnerService`.

- [ ] **Step 3: Wire ingest DI**

In `packages/context/src/ingest/local-bundle-runtime.ts`, import the Claude runner:

```typescript
import { ClaudeAgentSdkRunnerService } from '../agent/index.js';
```

Change the `resolveAgentRunner` return type to `AgentRunnerPort`.

Replace the final return in `resolveAgentRunner` with:

```typescript
  if (options.project.config.llm.agentRunner.backend === 'claude-code') {
    return {
      agentRunner: new ClaudeAgentSdkRunnerService({
        projectDir: options.project.projectDir,
        modelSlots: options.project.config.llm.models,
        logger: options.logger ?? noopLogger,
      }),
      ...(llmProvider ? { llmProvider } : {}),
    };
  }

  if (!llmProvider) {
    throw new Error(localIngestLlmProviderGuardMessage(options.project.projectDir));
  }

  return {
    agentRunner: new DefaultAgentRunnerService({
      llmProvider,
      logger: options.logger ?? noopLogger,
      ...(options.llmDebugRequestFile
        ? { debugRequestRecorder: createJsonlKtxLlmDebugRequestRecorder(options.llmDebugRequestFile) }
        : {}),
    }),
    llmProvider,
  };
```

Update `localIngestLlmProviderGuardMessage`:

```typescript
    'ktx ingest requires llm.provider.backend: anthropic, vertex, or gateway; llm.agentRunner.backend: claude-code; or an injected agentRunner.',
```

- [ ] **Step 4: Wire memory DI**

In `packages/context/src/memory/local-memory.ts`, import:

```typescript
import { AgentRunnerService, ClaudeAgentSdkRunnerService } from '../agent/index.js';
```

Replace the `agentRunner` construction with:

```typescript
  const agentRunner =
    options.agentRunner ??
    (project.config.llm.agentRunner.backend === 'claude-code'
      ? new ClaudeAgentSdkRunnerService({
          projectDir: project.projectDir,
          modelSlots: project.config.llm.models,
          logger,
        })
      : new AgentRunnerService({
          llmProvider: requireLlmProvider(llmProvider),
          logger,
        }));
```

Update the missing-provider error:

```typescript
    throw new Error('createLocalProjectMemoryCapture requires llm.provider.backend, llm.agentRunner.backend: claude-code, or an injected agentRunner');
```

- [ ] **Step 5: Run DI tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-bundle-runtime.test.ts src/memory/local-memory.test.ts
```

Expected: PASS.

- [ ] **Step 6: Add setup auth probe tests**

In `packages/cli/src/index.test.ts`, add a no-input setup test:

```typescript
  it('writes claude-code agent runner config when requested as the LLM backend', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-claude-code-'));
    const result = await runCli([
      '--project-dir',
      tempDir,
      'setup',
      '--llm-backend',
      'claude-code',
      '--anthropic-model',
      'claude-sonnet-4-6',
      '--no-input',
    ]);

    expect(result.stderr).toBe('');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.provider.backend).toBe('none');
    expect(config.llm.agentRunner.backend).toBe('claude-code');
    expect(config.llm.models.default).toBe('claude-sonnet-4-6');
  });
```

- [ ] **Step 7: Run setup tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/index.test.ts -t "claude-code agent runner config"
```

Expected: FAIL because `llmBackend` rejects `claude-code`.

- [ ] **Step 8: Implement setup support**

In `packages/cli/src/setup-models.ts`, change:

```typescript
export type KtxSetupLlmBackend = 'anthropic' | 'vertex';
```

to:

```typescript
export type KtxSetupLlmBackend = 'anthropic' | 'vertex' | 'claude-code';
```

Add to `KtxSetupModelDeps`:

```typescript
  claudeCodeAuthProbe?: () => Promise<{ ok: true } | { ok: false; message: string }>;
```

Add this helper:

```typescript
async function defaultClaudeCodeAuthProbe(): Promise<{ ok: true } | { ok: false; message: string }> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const session = query({
    prompt: '',
    options: {
      tools: [],
      settingSources: [],
      skills: [],
      allowedTools: [],
      disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task'],
      permissionMode: 'dontAsk',
      maxTurns: 1,
    },
  });
  try {
    await session.accountInfo();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    session.close();
  }
}
```

Add this persistence helper:

```typescript
async function persistClaudeCodeAgentRunnerConfig(projectDir: string, model: string): Promise<void> {
  const project = await loadKtxProject(projectDir);
  const nextConfig: KtxProjectConfig = {
    ...project.config,
    llm: {
      ...project.config.llm,
      provider: { backend: 'none' },
      models: { ...project.config.llm.models, default: model },
      agentRunner: { backend: 'claude-code' },
    },
  };
  await writeFile(project.configPath, serializeKtxProjectConfig(nextConfig), 'utf-8');
  await markKtxSetupStateStepComplete(projectDir, 'llm');
}
```

In `chooseBackend`, add this option before `Back`:

```typescript
      { value: 'claude-code', label: 'Claude Code local session (agent runner only)' },
```

Return it:

```typescript
  return { status: 'ready', backend: choice === 'vertex' ? 'vertex' : choice === 'claude-code' ? 'claude-code' : 'anthropic', prompted: true };
```

In `setupModels`, immediately after `backendArgs` is computed and before the Vertex branch, add:

```typescript
    if (backendChoice.backend === 'claude-code') {
      const model = backendArgs.anthropicModel ?? 'claude-sonnet-4-6';
      const probe = await (deps.claudeCodeAuthProbe ?? defaultClaudeCodeAuthProbe)();
      if (!probe.ok) {
        io.stderr.write(`Claude Code authentication check failed: ${probe.message}\n`);
        return { status: 'failed', projectDir: args.projectDir };
      }
      await persistClaudeCodeAgentRunnerConfig(args.projectDir, model);
      io.stdout.write(`│  LLM ready: yes (Claude Code agent runner, ${model})\n`);
      return { status: 'ready', projectDir: args.projectDir };
    }
```

In `packages/cli/src/commands/setup-commands.ts`, update `llmBackend` to accept `claude-code`:

```typescript
  if (value === 'anthropic' || value === 'vertex' || value === 'claude-code') {
    return value;
  }
```

Update validation so Anthropic API key flags are invalid for `vertex` and `claude-code`, and Vertex flags are invalid for `anthropic` and `claude-code`.

- [ ] **Step 9: Run setup tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/index.test.ts -t "claude-code agent runner config"
pnpm --filter @ktx/cli exec vitest run src/setup-models.test.ts src/commands/setup-commands.test.ts
```

Expected: PASS.

- [ ] **Step 10: Update docs**

In `docs-site/content/docs/getting-started/quickstart.mdx`, add this section after the LLM setup section:

```mdx
### Use a local Claude Code session for ingest agents

KTX can run ingest and memory-agent loops through your local Claude Code
session. This affects only agentic loops; scan enrichment, page triage, and
relationship proposals still use `llm.provider`.

```bash
ktx setup --llm-backend claude-code --anthropic-model claude-sonnet-4-6
```

The generated `ktx.yaml` uses:

```yaml
llm:
  provider:
    backend: none
  agentRunner:
    backend: claude-code
  models:
    default: claude-sonnet-4-6
```
```

In `docs-site/content/docs/concepts/the-context-layer.mdx`, add:

```mdx
### Agent runner backends

KTX separates the global LLM provider from the agent runner. The global
provider powers non-agent calls such as scan enrichment and relationship
proposals. The agent runner powers curated tool loops used by ingest and memory
capture.

Use `llm.agentRunner.backend: claude-code` when you want those curated loops to
run through the Claude Agent SDK. KTX registers only its stage-specific MCP
tools for the session and disables Claude Code built-in tools for that backend.
```

- [ ] **Step 11: Run docs and TypeScript checks**

Run:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/context run test
pnpm --filter @ktx/cli run type-check
pnpm --filter @ktx/cli run test
pnpm run dead-code
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/context packages/cli docs-site/content/docs/getting-started/quickstart.mdx docs-site/content/docs/concepts/the-context-layer.mdx
git commit -m "feat: wire claude-code agent runner backend"
```

---

## Final Verification

- [ ] Run focused context and CLI checks:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/context run test
pnpm --filter @ktx/cli run type-check
pnpm --filter @ktx/cli run test
```

Expected: PASS.

- [ ] Run workspace dead-code analysis:

```bash
pnpm run dead-code
```

Expected: PASS or only pre-existing findings unrelated to the files changed by this plan.

- [ ] Run a no-input setup smoke:

```bash
tmpdir="$(mktemp -d)"
pnpm --filter @ktx/cli exec tsx src/bin.ts --project-dir "$tmpdir" setup --llm-backend claude-code --anthropic-model claude-sonnet-4-6 --no-input
cat "$tmpdir/ktx.yaml"
```

Expected: `ktx.yaml` contains `llm.agentRunner.backend: claude-code`, `llm.provider.backend: none`, and `llm.models.default: claude-sonnet-4-6`.

- [ ] Run final status check:

```bash
git status --short
```

Expected: clean after the commits above.

## Audit Notes

The repository currently has `claude-code` support only for external agent-client setup. That code installs KTX MCP configuration for Claude Code, but it does not route KTX ingest or memory-agent LLM loops through the Claude Agent SDK. The v1 backend remains blocked until this plan lands.

The current TypeScript Agent SDK reference and the 0.3.142 type declarations disagree about the default behavior for filesystem settings. This plan sets `settingSources: []` explicitly, sets `skills: []` explicitly, disables built-in tools with `tools: []`, and uses a `canUseTool` deny-by-default guard so KTX does not rely on SDK defaults.
