# Claude Code Backend V1 Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `llm.provider.backend: claude-code` as a first-class KTX LLM backend for text generation, structured object generation, and agent-loop execution.

**Architecture:** Keep `@ktx/llm` as the AI SDK provider package for `anthropic`, `vertex`, and `gateway`, and add a backend-neutral runtime port in `@ktx/context` for KTX operations. The AI SDK runtime wraps the existing provider behavior; the Claude Code runtime uses `@anthropic-ai/claude-agent-sdk@0.3.142` with explicit isolation options, a scrubbed environment, exact MCP tool ids, and KTX-owned tool descriptors.

**Tech Stack:** TypeScript, pnpm, Vitest, AI SDK v6, Zod v4, `@anthropic-ai/claude-agent-sdk@0.3.142`, Commander, Fumadocs MDX.

---

## Audit Result

No implemented plan exists for the May 15 Claude Code backend spec. The latest
plans in `docs/superpowers/plans/` stop at May 14 research-agent MCP work,
which configures external agent clients but does not make `claude-code` a KTX
LLM backend.

Current v1-blocking gaps:

- `packages/context/src/project/config.ts` accepts only `none`, `anthropic`,
  `vertex`, and `gateway`.
- `packages/llm/src/types.ts` defines `KtxLlmBackend` without `claude-code`.
- `@anthropic-ai/claude-agent-sdk` is not a workspace dependency.
- `packages/llm/src/model-provider.ts` falls through to gateway for unknown
  non-`anthropic` and non-`vertex` backends instead of throwing.
- No `KtxLlmRuntimePort` exists, and LLM call sites still depend directly on
  `KtxLlmProvider`, `AgentRunnerService`, `generateKtxText`, and
  `generateKtxObject`.
- Agent-loop tools are still AI SDK `Tool` objects. Several inline tools return
  bare strings or plain objects to the model path.
- `ktx setup`, `ktx status`, and doctor output do not understand
  `claude-code` as an LLM provider or validate local Claude Code authentication.
- Docs do not describe `claude-code` as a local Claude Code session backend or
  document prompt-caching divergence.

Non-blocking gaps from the spec:

- Same-step AI SDK tool-call repair parity can remain absent on the Claude Code
  runtime. Schema/tool errors can surface as normal tool failures and
  next-turn self-correction.
- OTEL telemetry parity can remain absent for the Claude Code runtime.
- Embedding parity is out of scope because embeddings stay configured under
  `ingest.embeddings` and scan enrichment embedding settings.
- Session persistence for Claude Code debugging is out of scope for v1 because
  the required runtime behavior sets `persistSession: false`.
- Full prompt-caching parity for tools, history, and per-section TTLs is out of
  scope. V1 must only avoid AI-SDK cache markers on `claude-code` and warn when
  users configure ignored prompt-caching fields.

## File Structure

Create these files:

- `packages/context/src/llm/runtime-port.ts` defines `KtxLlmRuntimePort`,
  text/object inputs, runtime tool descriptors, runtime tool outputs, and
  `AgentRunnerPort`.
- `packages/context/src/llm/runtime-tools.ts` converts runtime descriptors to
  AI SDK tools and Claude SDK MCP tools, normalizes markdown/structured output,
  and rejects non-object tool schemas.
- `packages/context/src/llm/ai-sdk-runtime.ts` implements
  `KtxLlmRuntimePort` for existing AI SDK backends.
- `packages/context/src/llm/claude-code-env.ts` owns the Claude Code
  environment denylist and scrubber.
- `packages/context/src/llm/claude-code-models.ts` maps `sonnet`, `opus`, and
  `haiku` aliases and validates full model ids.
- `packages/context/src/llm/claude-code-runtime.ts` implements text, object,
  auth probe, and agent loops through the Claude Agent SDK.
- `packages/context/src/llm/runtime-local-config.test.ts`,
  `packages/context/src/llm/runtime-tools.test.ts`,
  `packages/context/src/llm/claude-code-env.test.ts`,
  `packages/context/src/llm/claude-code-models.test.ts`, and
  `packages/context/src/llm/claude-code-runtime.test.ts` cover the new runtime
  boundary.

Modify these files:

- `packages/context/package.json` adds the pinned Claude Agent SDK dependency.
- `packages/llm/src/types.ts`, `packages/llm/src/model-provider.ts`,
  `packages/llm/src/model-provider.test.ts`, and
  `packages/llm/src/model-health.test.ts` add backend typing and explicit
  unsupported-provider behavior.
- `packages/context/src/project/config.ts` and
  `packages/context/src/project/config.test.ts` parse and serialize
  `claude-code`.
- `packages/context/src/llm/local-config.ts` and
  `packages/context/src/llm/index.ts` create and export the runtime factory.
- `packages/context/src/llm/generation.ts` makes `generateKtxText` and
  `generateKtxObject` runtime-backed helpers.
- `packages/context/src/agent/agent-runner.service.ts` uses runtime tool
  descriptors on the AI SDK path and exposes `AgentRunnerPort`.
- `packages/context/src/tools/base-tool.ts` adds `toRuntimeTool`.
- `packages/context/src/ingest/local-bundle-runtime.ts`,
  `packages/context/src/ingest/local-ingest.ts`,
  `packages/context/src/ingest/ports.ts`,
  `packages/context/src/ingest/page-triage/page-triage.service.ts`,
  `packages/context/src/ingest/stages/stage-3-work-units.ts`,
  `packages/context/src/ingest/stages/stage-4-reconciliation.ts`,
  `packages/context/src/ingest/context-candidates/curator-pagination.service.ts`,
  `packages/context/src/ingest/ingest-bundle.runner.ts`,
  `packages/context/src/ingest/stages/build-wu-context.ts`, and
  `packages/context/src/ingest/stages/build-reconcile-context.ts` move local
  ingest paths to the runtime boundary.
- `packages/context/src/memory/types.ts`,
  `packages/context/src/memory/local-memory.ts`, and
  `packages/context/src/memory/memory-agent.service.ts` move memory capture to
  runtime-backed agent loops.
- `packages/context/src/scan/local-scan.ts`,
  `packages/context/src/scan/local-enrichment.ts`,
  `packages/context/src/scan/description-generation.ts`, and
  `packages/context/src/scan/relationship-llm-proposal.ts` move scan
  enrichment and relationship proposals to runtime text/object operations.
- `packages/context/src/mcp/local-project-ports.ts` passes runtime-backed local
  ingest options into MCP-triggered ingest.
- `packages/cli/src/setup-commands.ts`, `packages/cli/src/setup-models.ts`,
  `packages/cli/src/setup-models.test.ts`, `packages/cli/src/status-project.ts`,
  and `packages/cli/src/doctor.test.ts` expose setup/status/doctor support.
- `docs-site/content/docs/getting-started/quickstart.mdx`,
  `docs-site/content/docs/cli-reference/ktx-setup.mdx`,
  `docs-site/content/docs/cli-reference/ktx-status.mdx`,
  `docs-site/content/docs/guides/building-context.mdx`,
  `docs-site/content/docs/guides/llm-configuration.mdx`, and
  `docs-site/content/docs/guides/meta.json` describe the backend.

### Task 1: Config, Dependency, and No-Fallback Guard

**Files:**

- Modify: `packages/context/package.json`
- Modify: `packages/context/src/project/config.ts`
- Modify: `packages/context/src/project/config.test.ts`
- Modify: `packages/llm/src/types.ts`
- Modify: `packages/llm/src/model-provider.ts`
- Modify: `packages/llm/src/model-provider.test.ts`
- Modify: `packages/llm/src/model-health.test.ts`

- [ ] **Step 1: Write failing config and provider tests**

Add this test to `packages/context/src/project/config.test.ts`:

```ts
it('parses Claude Code as a first-class LLM backend', () => {
  const config = parseKtxProjectConfig(`
llm:
  provider:
    backend: claude-code
  models:
    default: sonnet
    triage: haiku
    candidateExtraction: sonnet
    curator: sonnet
    reconcile: sonnet
    repair: opus
`);

  expect(config.llm.provider.backend).toBe('claude-code');
  expect(config.llm.models).toEqual({
    default: 'sonnet',
    triage: 'haiku',
    candidateExtraction: 'sonnet',
    curator: 'sonnet',
    reconcile: 'sonnet',
    repair: 'opus',
  });
});
```

Add this test to `packages/llm/src/model-provider.test.ts`:

```ts
it('throws instead of falling through when an unsupported LLM backend is passed to the AI SDK provider factory', () => {
  expect(() =>
    createKtxLlmProvider({
      backend: 'claude-code',
      modelSlots: { default: 'sonnet' },
      promptCaching: { enabled: false },
    }),
  ).toThrow('claude-code is not an AI SDK LanguageModel backend');
});
```

Add this test to `packages/llm/src/model-health.test.ts`:

```ts
it('reports claude-code as unsupported by the AI SDK health check', async () => {
  const result = await runKtxLlmHealthCheck({
    backend: 'claude-code',
    modelSlots: { default: 'sonnet' },
    promptCaching: { enabled: false },
  });

  expect(result).toEqual({
    ok: false,
    message: expect.stringContaining('claude-code is not an AI SDK LanguageModel backend'),
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/project/config.test.ts
pnpm --filter @ktx/llm exec vitest run src/model-provider.test.ts src/model-health.test.ts
```

Expected: the config test rejects `claude-code`, and the `@ktx/llm` tests fail
because `KtxLlmBackend` does not include `claude-code`.

- [ ] **Step 3: Add the pinned SDK dependency**

In `packages/context/package.json`, add this dependency inside
`dependencies`:

```json
"@anthropic-ai/claude-agent-sdk": "0.3.142"
```

Run:

```bash
pnpm install
```

Expected: `pnpm-lock.yaml` records `@anthropic-ai/claude-agent-sdk@0.3.142`.

- [ ] **Step 4: Extend backend config and types**

In `packages/context/src/project/config.ts`, update the backend list and
description:

```ts
const KTX_LLM_BACKENDS = ['none', 'anthropic', 'vertex', 'gateway', 'claude-code'] as const;
```

```ts
.describe(
  'LLM provider backend. "none" disables LLM features; "anthropic" / "vertex" / "gateway" require the matching nested credentials block; "claude-code" uses the local Claude Code session.',
),
```

In `packages/llm/src/types.ts`, update the backend type:

```ts
export type KtxLlmBackend = 'anthropic' | 'vertex' | 'gateway' | 'claude-code';
```

- [ ] **Step 5: Make unsupported AI SDK provider backends explicit**

In `packages/llm/src/model-provider.ts`, replace the gateway fallthrough in
`createModelFactory` with an explicit gateway branch and a final throw:

```ts
    if (config.backend === 'gateway') {
      const gateway = (deps.createGateway ?? createGateway)({
        ...(config.gateway?.apiKey ? { apiKey: config.gateway.apiKey } : {}),
        ...(config.gateway?.baseURL ? { baseURL: config.gateway.baseURL } : {}),
        headers: {
          'anthropic-beta': ANTHROPIC_BETA_HEADER,
        },
      });
      return (modelId) => gateway(modelId);
    }

    throw new Error(`${config.backend} is not an AI SDK LanguageModel backend; use KtxLlmRuntimePort`);
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/project/config.test.ts
pnpm --filter @ktx/llm exec vitest run src/model-provider.test.ts src/model-health.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/context/package.json pnpm-lock.yaml packages/context/src/project/config.ts packages/context/src/project/config.test.ts packages/llm/src/types.ts packages/llm/src/model-provider.ts packages/llm/src/model-provider.test.ts packages/llm/src/model-health.test.ts
git commit -m "feat: recognize claude-code llm backend"
```

### Task 2: Runtime Port, Tool Descriptors, and AI SDK Adapter

**Files:**

- Create: `packages/context/src/llm/runtime-port.ts`
- Create: `packages/context/src/llm/runtime-tools.ts`
- Create: `packages/context/src/llm/ai-sdk-runtime.ts`
- Create: `packages/context/src/llm/runtime-tools.test.ts`
- Modify: `packages/context/src/tools/base-tool.ts`
- Modify: `packages/context/src/agent/agent-runner.service.ts`
- Modify: `packages/context/src/llm/generation.ts`
- Modify: `packages/context/src/llm/index.ts`

- [ ] **Step 1: Write failing runtime tool tests**

Create `packages/context/src/llm/runtime-tools.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAiSdkToolSet, createClaudeSdkTools, normalizeKtxRuntimeToolOutput } from './runtime-tools.js';
import type { KtxRuntimeToolDescriptor } from './runtime-port.js';

describe('runtime tool descriptors', () => {
  const descriptor: KtxRuntimeToolDescriptor<{ id: string }, { ok: boolean }> = {
    name: 'read_thing',
    description: 'Read one thing.',
    inputSchema: z.object({ id: z.string() }),
    execute: vi.fn(async (input) => ({
      markdown: `Read ${input.id}`,
      structured: { ok: true },
    })),
  };

  it('normalizes string and object tool outputs into markdown plus optional structured payload', () => {
    expect(normalizeKtxRuntimeToolOutput('plain text')).toEqual({ markdown: 'plain text' });
    expect(normalizeKtxRuntimeToolOutput({ markdown: 'shown', structured: { id: 1 } })).toEqual({
      markdown: 'shown',
      structured: { id: 1 },
    });
    expect(normalizeKtxRuntimeToolOutput({ name: 'skill', content: 'body' })).toEqual({
      markdown: '```json\n{\n  "name": "skill",\n  "content": "body"\n}\n```',
      structured: { name: 'skill', content: 'body' },
    });
  });

  it('builds AI SDK tools that expose markdown to the model', async () => {
    const tools = createAiSdkToolSet({ read_thing: descriptor });
    const output = await tools.read_thing.execute?.({ id: 'a' }, { toolCallId: 'call-1', messages: [] } as never);
    const modelOutput = tools.read_thing.toModelOutput?.({ output } as never);

    expect(modelOutput).toEqual({ type: 'content', value: [{ type: 'text', text: 'Read a' }] });
  });

  it('builds Claude SDK tools that return text content only', async () => {
    const tools = createClaudeSdkTools({ read_thing: descriptor });
    const result = await tools[0].handler({ id: 'b' } as never, {});

    expect(result).toEqual({ content: [{ type: 'text', text: 'Read b' }] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/llm/runtime-tools.test.ts
```

Expected: FAIL because `runtime-tools.ts` and `runtime-port.ts` do not exist.

- [ ] **Step 3: Define the runtime port**

Create `packages/context/src/llm/runtime-port.ts`:

```ts
import type { KtxModelRole } from '@ktx/llm';
import type { z } from 'zod';

export interface KtxRuntimeToolOutput<TOutput = unknown> {
  markdown: string;
  structured?: TOutput;
}

export interface KtxRuntimeToolDescriptor<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  execute(input: TInput): Promise<KtxRuntimeToolOutput<TOutput>>;
}

export type KtxRuntimeToolSet = Record<string, KtxRuntimeToolDescriptor>;

export type RunLoopStopReason = 'budget' | 'natural' | 'error';

export interface RunLoopStepInfo {
  stepIndex: number;
  stepBudget: number;
}

export interface RunLoopParams {
  modelRole: KtxModelRole;
  systemPrompt: string;
  userPrompt: string;
  toolSet: KtxRuntimeToolSet;
  stepBudget: number;
  telemetryTags: Record<string, string>;
  onStepFinish?: (info: RunLoopStepInfo) => void | Promise<void>;
}

export interface RunLoopResult {
  stopReason: RunLoopStopReason;
  error?: Error;
}

export interface KtxGenerateTextInput {
  role: KtxModelRole;
  prompt: string;
  system?: string;
  tools?: KtxRuntimeToolSet;
  temperature?: number;
}

export interface KtxGenerateObjectInput<TOutput, TSchema extends z.ZodType<TOutput>> {
  role: KtxModelRole;
  prompt: string;
  system?: string;
  tools?: KtxRuntimeToolSet;
  temperature?: number;
  schema: TSchema;
}

export interface KtxLlmRuntimePort {
  generateText(input: KtxGenerateTextInput): Promise<string>;
  generateObject<TOutput, TSchema extends z.ZodType<TOutput>>(
    input: KtxGenerateObjectInput<TOutput, TSchema>,
  ): Promise<TOutput>;
  runAgentLoop(params: RunLoopParams): Promise<RunLoopResult>;
}

export interface AgentRunnerPort {
  runLoop(params: RunLoopParams): Promise<RunLoopResult>;
}

export class RuntimeAgentRunner implements AgentRunnerPort {
  constructor(private readonly runtime: KtxLlmRuntimePort) {}

  runLoop(params: RunLoopParams): Promise<RunLoopResult> {
    return this.runtime.runAgentLoop(params);
  }
}
```

- [ ] **Step 4: Implement runtime tool conversion**

Create `packages/context/src/llm/runtime-tools.ts`:

```ts
import { tool as aiTool, type ToolSet } from 'ai';
import {
  tool as claudeTool,
  type SdkMcpToolDefinition,
  type CallToolResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import type { KtxRuntimeToolDescriptor, KtxRuntimeToolOutput, KtxRuntimeToolSet } from './runtime-port.js';

function isRuntimeOutput(value: unknown): value is KtxRuntimeToolOutput {
  return Boolean(value && typeof value === 'object' && 'markdown' in value && typeof (value as { markdown?: unknown }).markdown === 'string');
}

export function normalizeKtxRuntimeToolOutput(value: unknown): KtxRuntimeToolOutput {
  if (isRuntimeOutput(value)) {
    return 'structured' in value
      ? { markdown: value.markdown, structured: value.structured }
      : { markdown: value.markdown };
  }
  if (typeof value === 'string') {
    return { markdown: value };
  }
  return {
    markdown: `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``,
    structured: value,
  };
}

function assertObjectSchema(name: string, schema: z.ZodType): asserts schema is z.ZodObject<z.ZodRawShape> {
  if (schema.def.type !== 'object') {
    throw new Error(`KTX runtime tool "${name}" must use z.object input schema for claude-code`);
  }
}

export function createAiSdkToolSet(tools: KtxRuntimeToolSet = {}): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, descriptor]) => [
      name,
      aiTool({
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        execute: async (input) => descriptor.execute(input),
        toModelOutput: ({ output }) => {
          const normalized = normalizeKtxRuntimeToolOutput(output);
          return { type: 'content', value: [{ type: 'text', text: normalized.markdown }] };
        },
      }),
    ]),
  );
}

export function createClaudeSdkTools(tools: KtxRuntimeToolSet = {}): Array<SdkMcpToolDefinition<z.ZodRawShape>> {
  return Object.values(tools).map((descriptor) => {
    assertObjectSchema(descriptor.name, descriptor.inputSchema);
    const sdkTool = claudeTool(
      descriptor.name,
      descriptor.description,
      descriptor.inputSchema.shape,
      async (input): Promise<CallToolResult> => {
        const normalized = normalizeKtxRuntimeToolOutput(await descriptor.execute(input));
        return { content: [{ type: 'text', text: normalized.markdown }] };
      },
    );
    return Object.assign(sdkTool, { handler: sdkTool.handler });
  });
}

export function mcpToolIds(tools: KtxRuntimeToolSet = {}): string[] {
  return Object.keys(tools).map((name) => `mcp__ktx__${name}`);
}
```

- [ ] **Step 5: Add `BaseTool.toRuntimeTool`**

In `packages/context/src/tools/base-tool.ts`, add this import:

```ts
import type { KtxRuntimeToolDescriptor } from '../llm/runtime-port.js';
import { normalizeKtxRuntimeToolOutput } from '../llm/runtime-tools.js';
```

Add this method beside `toAiSdkTool`:

```ts
  toRuntimeTool(context: ToolContext): KtxRuntimeToolDescriptor {
    const toolName = this.name;
    return {
      name: toolName,
      description: this.description,
      inputSchema: this.inputSchema as KtxRuntimeToolDescriptor['inputSchema'],
      execute: async (params) => {
        const callContext = { ...context };
        if (!callContext.userId) {
          throw new Error('Authentication required: userId must be provided in ToolContext');
        }
        const parsedInput = this.parseInput(params as Record<string, any>);
        return normalizeKtxRuntimeToolOutput(await this.call(parsedInput, callContext));
      },
    };
  }
```

- [ ] **Step 6: Implement the AI SDK runtime adapter**

Create `packages/context/src/llm/ai-sdk-runtime.ts`:

```ts
import { KtxMessageBuilder, splitKtxSystemMessages, type KtxLlmProvider } from '@ktx/llm';
import { generateText, Output, stepCountIs, type FlexibleSchema } from 'ai';
import type { z } from 'zod';
import { noopLogger, type KtxLogger } from '../core/index.js';
import { summarizeKtxLlmDebugRequest, type KtxLlmDebugRequestRecorder } from './debug-request-recorder.js';
import { createAiSdkToolSet } from './runtime-tools.js';
import type {
  KtxGenerateObjectInput,
  KtxGenerateTextInput,
  KtxLlmRuntimePort,
  RunLoopParams,
  RunLoopResult,
} from './runtime-port.js';

export interface AiSdkKtxLlmRuntimeDeps {
  llmProvider: KtxLlmProvider;
  logger?: KtxLogger;
  debugRequestRecorder?: KtxLlmDebugRequestRecorder;
}

export class AiSdkKtxLlmRuntime implements KtxLlmRuntimePort {
  private readonly logger: KtxLogger;

  constructor(private readonly deps: AiSdkKtxLlmRuntimeDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  async generateText(input: KtxGenerateTextInput): Promise<string> {
    const model = this.deps.llmProvider.getModel(input.role);
    if ((model as { provider?: string }).provider === 'deterministic') {
      return `Deterministic description for ${input.prompt.slice(0, 64).trim() || 'data source'}`;
    }
    const tools = createAiSdkToolSet(input.tools ?? {});
    const built = new KtxMessageBuilder(this.deps.llmProvider).wrapSimple({
      system: input.system,
      messages: [{ role: 'user', content: input.prompt }],
      tools,
      model,
    });
    const split = splitKtxSystemMessages(built.messages);
    const result = await generateText({
      model,
      temperature: input.temperature ?? 0,
      ...(split.system ? { system: split.system } : {}),
      messages: split.messages,
      tools: built.tools,
      ...(Object.keys(tools).length > 0
        ? {
            experimental_repairToolCall: this.deps.llmProvider.repairToolCallHandler({
              source: `ktx-${input.role}`,
            }),
          }
        : {}),
    });
    if (typeof result.text !== 'string') {
      throw new Error('KTX LLM text generation returned no text');
    }
    return result.text;
  }

  async generateObject<TOutput, TSchema extends z.ZodType<TOutput>>(
    input: KtxGenerateObjectInput<TOutput, TSchema>,
  ): Promise<TOutput> {
    const model = this.deps.llmProvider.getModel(input.role);
    const tools = createAiSdkToolSet(input.tools ?? {});
    const built = new KtxMessageBuilder(this.deps.llmProvider).wrapSimple({
      system: input.system,
      messages: [{ role: 'user', content: input.prompt }],
      tools,
      model,
    });
    const split = splitKtxSystemMessages(built.messages);
    const result = await generateText({
      model,
      temperature: input.temperature ?? 0,
      ...(split.system ? { system: split.system } : {}),
      messages: split.messages,
      tools: built.tools,
      ...(Object.keys(tools).length > 0
        ? {
            experimental_repairToolCall: this.deps.llmProvider.repairToolCallHandler({
              source: `ktx-${input.role}`,
            }),
          }
        : {}),
      output: Output.object({ schema: input.schema as unknown as FlexibleSchema<TOutput> }),
    });
    if (result.output == null) {
      throw new Error('KTX LLM object generation returned no output');
    }
    return result.output as TOutput;
  }

  async runAgentLoop(params: RunLoopParams): Promise<RunLoopResult> {
    let stepIndex = 0;
    try {
      const model = this.deps.llmProvider.getModel(params.modelRole);
      const tools = createAiSdkToolSet(params.toolSet);
      const builder = new KtxMessageBuilder(this.deps.llmProvider);
      const built = builder.wrapSimple({
        system: params.systemPrompt,
        messages: [{ role: 'user', content: params.userPrompt }],
        tools,
        model,
      });
      const promptMessages = splitKtxSystemMessages(built.messages);
      await this.deps.debugRequestRecorder?.record(
        summarizeKtxLlmDebugRequest({
          operationName: params.telemetryTags.operationName ?? 'ktx-agent-runner',
          source: params.telemetryTags.source,
          jobId: params.telemetryTags.jobId,
          unitKey: params.telemetryTags.unitKey,
          modelRole: params.modelRole,
          modelId: (model as { modelId?: string }).modelId ?? params.modelRole,
          messages: built.messages,
          tools: built.tools as Record<string, { providerOptions?: unknown }>,
        }),
      );
      await generateText({
        model,
        temperature: 0,
        stopWhen: stepCountIs(params.stepBudget),
        experimental_telemetry: this.deps.llmProvider.telemetryConfig(),
        experimental_repairToolCall: this.deps.llmProvider.repairToolCallHandler({
          source: params.telemetryTags.operationName ?? 'ktx-agent-runner',
        }),
        ...(promptMessages.system ? { system: promptMessages.system } : {}),
        messages: promptMessages.messages,
        tools: built.tools,
        onStepFinish: async () => {
          stepIndex += 1;
          if (!params.onStepFinish) return;
          try {
            await params.onStepFinish({ stepIndex, stepBudget: params.stepBudget });
          } catch (err) {
            this.logger.warn(`[agent-runner] onStepFinish callback threw; ignoring: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      });
      return { stopReason: 'natural' };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`[agent-runner] loop failed: ${err.message}`);
      return { stopReason: 'error', error: err };
    }
  }
}
```

- [ ] **Step 7: Keep `AgentRunnerService` as the AI SDK class**

In `packages/context/src/agent/agent-runner.service.ts`, import and re-export
the runtime loop types:

```ts
import { AiSdkKtxLlmRuntime } from '../llm/ai-sdk-runtime.js';
import type { AgentRunnerPort, RunLoopParams, RunLoopResult } from '../llm/runtime-port.js';
export type {
  AgentRunnerPort,
  RunLoopParams,
  RunLoopResult,
  RunLoopStepInfo,
  RunLoopStopReason,
} from '../llm/runtime-port.js';
```

Then replace the existing implementation with delegation to
`AiSdkKtxLlmRuntime`:

```ts
export class AgentRunnerService implements AgentRunnerPort {
  private readonly runtime: AiSdkKtxLlmRuntime;

  constructor(deps: AgentRunnerServiceDeps) {
    this.runtime = new AiSdkKtxLlmRuntime(deps);
  }

  runLoop(params: RunLoopParams): Promise<RunLoopResult> {
    return this.runtime.runAgentLoop(params);
  }
}
```

- [ ] **Step 8: Re-export the runtime API and adapt generation helpers**

In `packages/context/src/llm/index.ts`, export the new modules:

```ts
export { AiSdkKtxLlmRuntime } from './ai-sdk-runtime.js';
export type {
  AgentRunnerPort,
  KtxGenerateObjectInput,
  KtxGenerateTextInput,
  KtxLlmRuntimePort,
  KtxRuntimeToolDescriptor,
  KtxRuntimeToolOutput,
  KtxRuntimeToolSet,
} from './runtime-port.js';
export { RuntimeAgentRunner } from './runtime-port.js';
export { createAiSdkToolSet, createClaudeSdkTools, normalizeKtxRuntimeToolOutput } from './runtime-tools.js';
```

In `packages/context/src/llm/generation.ts`, replace direct provider use with
runtime-backed helpers:

```ts
import type { z } from 'zod';
import type { KtxGenerateObjectInput, KtxGenerateTextInput, KtxLlmRuntimePort } from './runtime-port.js';

export async function generateKtxText(input: KtxGenerateTextInput & { runtime: KtxLlmRuntimePort }): Promise<string> {
  return input.runtime.generateText(input);
}

export async function generateKtxObject<TOutput, TSchema extends z.ZodType<TOutput>>(
  input: KtxGenerateObjectInput<TOutput, TSchema> & { runtime: KtxLlmRuntimePort },
): Promise<TOutput> {
  return input.runtime.generateObject(input);
}
```

- [ ] **Step 9: Run runtime tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/llm/runtime-tools.test.ts src/agent/agent-runner.service.test.ts
```

Expected: selected tests pass after call sites in tests use runtime tool
descriptors.

- [ ] **Step 10: Commit**

```bash
git add packages/context/src/llm/runtime-port.ts packages/context/src/llm/runtime-tools.ts packages/context/src/llm/ai-sdk-runtime.ts packages/context/src/llm/runtime-tools.test.ts packages/context/src/tools/base-tool.ts packages/context/src/agent/agent-runner.service.ts packages/context/src/llm/generation.ts packages/context/src/llm/index.ts packages/context/src/agent/agent-runner.service.test.ts
git commit -m "feat: add ktx llm runtime port"
```

### Task 3: Claude Code Runtime, Auth Boundary, and Stop Reasons

**Files:**

- Create: `packages/context/src/llm/claude-code-env.ts`
- Create: `packages/context/src/llm/claude-code-env.test.ts`
- Create: `packages/context/src/llm/claude-code-models.ts`
- Create: `packages/context/src/llm/claude-code-models.test.ts`
- Create: `packages/context/src/llm/claude-code-runtime.ts`
- Create: `packages/context/src/llm/claude-code-runtime.test.ts`
- Modify: `packages/context/src/llm/index.ts`

- [ ] **Step 1: Write failing environment and model tests**

Create `packages/context/src/llm/claude-code-env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_PROVIDER_ENV_DENYLIST, createKtxClaudeCodeEnv } from './claude-code-env.js';

describe('createKtxClaudeCodeEnv', () => {
  it('strips provider-routing credentials from the Claude Code child environment', () => {
    const seeded = Object.fromEntries(CLAUDE_CODE_PROVIDER_ENV_DENYLIST.map((key) => [key, `${key}-value`]));
    const env = createKtxClaudeCodeEnv({
      ...seeded,
      PATH: '/usr/bin',
      HOME: '/Users/test',
    });

    for (const key of CLAUDE_CODE_PROVIDER_ENV_DENYLIST) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/test');
  });
});
```

Create `packages/context/src/llm/claude-code-models.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveClaudeCodeModel } from './claude-code-models.js';

describe('resolveClaudeCodeModel', () => {
  it.each([
    ['sonnet', 'claude-sonnet-4-6'],
    ['opus', 'claude-opus-4-7'],
    ['haiku', 'claude-haiku-4-5'],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
  ])('maps %s to %s', (input, expected) => {
    expect(resolveClaudeCodeModel(input)).toBe(expected);
  });

  it('rejects unsupported aliases', () => {
    expect(() => resolveClaudeCodeModel('gpt-5')).toThrow('Unsupported Claude Code model');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/llm/claude-code-env.test.ts src/llm/claude-code-models.test.ts
```

Expected: FAIL because the files do not exist.

- [ ] **Step 3: Implement environment scrubbing**

Create `packages/context/src/llm/claude-code-env.ts`:

```ts
export const CLAUDE_CODE_PROVIDER_ENV_DENYLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_PROFILE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

const DENYLIST = new Set<string>(CLAUDE_CODE_PROVIDER_ENV_DENYLIST);

export function createKtxClaudeCodeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !DENYLIST.has(key)));
}
```

- [ ] **Step 4: Implement model alias resolution**

Create `packages/context/src/llm/claude-code-models.ts`:

```ts
const CLAUDE_CODE_MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
  haiku: 'claude-haiku-4-5',
};

const FULL_MODEL_ID = /^claude-(sonnet|opus|haiku)-[0-9]+-[0-9]+$/;

export function resolveClaudeCodeModel(model: string): string {
  const normalized = model.trim();
  const alias = CLAUDE_CODE_MODEL_ALIASES[normalized];
  if (alias) {
    return alias;
  }
  if (FULL_MODEL_ID.test(normalized)) {
    return normalized;
  }
  throw new Error(`Unsupported Claude Code model "${model}". Use sonnet, opus, haiku, or a claude-* model id.`);
}
```

- [ ] **Step 5: Run environment and model tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/llm/claude-code-env.test.ts src/llm/claude-code-models.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write failing runtime tests for isolation, text, objects, tools, and progress**

Create `packages/context/src/llm/claude-code-runtime.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeKtxLlmRuntime, mapClaudeCodeStopReason, runClaudeCodeAuthProbe } from './claude-code-runtime.js';

async function* stream(messages: SDKMessage[]): AsyncGenerator<SDKMessage, void> {
  for (const message of messages) {
    yield message;
  }
}

function initMessage(overrides: Partial<Extract<SDKMessage, { type: 'system' }>> = {}): Extract<SDKMessage, { type: 'system' }> {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    claude_code_version: '0.3.142',
    cwd: '/tmp/project',
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-4-6',
    permissionMode: 'dontAsk',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    ...overrides,
  };
}

function resultMessage(overrides: Partial<Extract<SDKMessage, { type: 'result' }>> = {}): Extract<SDKMessage, { type: 'result' }> {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'ok',
    stop_reason: null,
    total_cost_usd: 0,
    usage: {} as never,
    modelUsage: {},
    permission_denials: [],
    uuid: 'result-id',
    session_id: 'session-id',
    ...overrides,
  };
}

describe('ClaudeCodeKtxLlmRuntime', () => {
  it('passes isolation options and scrubbed env to text generation', async () => {
    const query = vi.fn(() => stream([initMessage(), resultMessage({ result: 'hello' })]));
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test', PATH: '/usr/bin' },
    });

    await expect(runtime.generateText({ role: 'default', prompt: 'say hello' })).resolves.toBe('hello');
    expect(query).toHaveBeenCalledWith({
      prompt: 'say hello',
      options: expect.objectContaining({
        cwd: '/tmp/project',
        model: 'claude-sonnet-4-6',
        maxTurns: 1,
        settingSources: [],
        skills: [],
        plugins: [],
        tools: [],
        allowedTools: [],
        permissionMode: 'dontAsk',
        persistSession: false,
        env: expect.not.objectContaining({ ANTHROPIC_API_KEY: 'sk-ant-test' }),
      }),
    });
  });

  it('validates structured output with the caller schema', async () => {
    const schema = z.object({ answer: z.string() });
    const query = vi.fn(() => stream([initMessage(), resultMessage({ structured_output: { answer: 'yes' } })]));
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
    });

    await expect(runtime.generateObject({ role: 'default', prompt: 'json', schema })).resolves.toEqual({ answer: 'yes' });
    expect(query.mock.calls[0][0].options.outputFormat).toMatchObject({
      type: 'json_schema',
      schema: expect.objectContaining({ type: 'object' }),
    });
  });

  it('registers only exact KTX MCP tool ids and denies non-KTX tools', async () => {
    const query = vi.fn(() =>
      stream([
        initMessage({ tools: ['mcp__ktx__load_skill'], mcp_servers: [{ name: 'ktx', status: 'connected' }] }),
        { type: 'assistant', message: { role: 'assistant', content: [] }, parent_tool_use_id: null, uuid: 'assistant-1', session_id: 'session-id' } as SDKMessage,
        resultMessage({ subtype: 'error_max_turns', is_error: true }),
      ]),
    );
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
    });
    const onStepFinish = vi.fn();

    await runtime.runAgentLoop({
      modelRole: 'default',
      systemPrompt: 'system',
      userPrompt: 'user',
      toolSet: {
        load_skill: {
          name: 'load_skill',
          description: 'Load skill.',
          inputSchema: z.object({ name: z.string() }),
          execute: async () => ({ markdown: 'loaded' }),
        },
      },
      stepBudget: 1,
      telemetryTags: { operationName: 'test' },
      onStepFinish,
    });

    const options = query.mock.calls[0][0].options;
    expect(options.allowedTools).toEqual(['mcp__ktx__load_skill']);
    expect(await options.canUseTool('mcp__ktx__load_skill', {}, { signal: new AbortController().signal, toolUseID: '1' })).toEqual({ behavior: 'allow' });
    expect(await options.canUseTool('Bash', {}, { signal: new AbortController().signal, toolUseID: '2' })).toMatchObject({ behavior: 'deny' });
    expect(onStepFinish).toHaveBeenCalledWith({ stepIndex: 1, stepBudget: 1 });
  });

  it('maps max-turn terminal reasons to budget', () => {
    expect(mapClaudeCodeStopReason(resultMessage({ subtype: 'error_max_turns' }))).toBe('budget');
    expect(mapClaudeCodeStopReason(resultMessage({ terminal_reason: 'max_turns' }))).toBe('budget');
    expect(mapClaudeCodeStopReason(resultMessage({ stop_reason: 'max_turns' }))).toBe('budget');
    expect(mapClaudeCodeStopReason(resultMessage({ subtype: 'success', terminal_reason: 'completed' }))).toBe('natural');
    expect(mapClaudeCodeStopReason(resultMessage({ subtype: 'error_during_execution' }))).toBe('error');
  });

  it('auth probe uses isolation options and a scrubbed env', async () => {
    const query = vi.fn(() => stream([initMessage(), resultMessage({ result: 'ok' })]));

    await expect(runClaudeCodeAuthProbe({ projectDir: '/tmp/project', model: 'sonnet', query, env: { ANTHROPIC_API_KEY: 'sk-ant-test' } })).resolves.toEqual({ ok: true });
    expect(query.mock.calls[0][0].options).toMatchObject({
      settingSources: [],
      skills: [],
      plugins: [],
      tools: [],
      allowedTools: [],
      persistSession: false,
      env: expect.not.objectContaining({ ANTHROPIC_API_KEY: 'sk-ant-test' }),
    });
  });
});
```

- [ ] **Step 7: Run runtime tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/llm/claude-code-runtime.test.ts
```

Expected: FAIL because `claude-code-runtime.ts` does not exist.

- [ ] **Step 8: Implement Claude Code runtime**

Create `packages/context/src/llm/claude-code-runtime.ts` with these exported
types and functions:

```ts
import {
  createSdkMcpServer,
  query as defaultQuery,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { noopLogger, type KtxLogger } from '../core/index.js';
import type { RunLoopParams, RunLoopResult, RunLoopStopReason } from './runtime-port.js';
import { createKtxClaudeCodeEnv } from './claude-code-env.js';
import { resolveClaudeCodeModel } from './claude-code-models.js';
import { createClaudeSdkTools, mcpToolIds } from './runtime-tools.js';
import type { KtxGenerateObjectInput, KtxGenerateTextInput, KtxLlmRuntimePort, KtxRuntimeToolSet } from './runtime-port.js';

type QueryFn = typeof defaultQuery;

export interface ClaudeCodeKtxLlmRuntimeDeps {
  projectDir: string;
  modelSlots: { default: string } & Partial<Record<string, string>>;
  query?: QueryFn;
  env?: NodeJS.ProcessEnv;
  logger?: KtxLogger;
}

const BUILTIN_TOOLS = [
  'Agent',
  'Task',
  'AskUserQuestion',
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
];

function isResult(message: SDKMessage): message is SDKResultMessage {
  return message.type === 'result';
}

function resultError(result: SDKResultMessage): Error | undefined {
  if (result.subtype === 'success') return undefined;
  const details = result.errors.length > 0 ? `: ${result.errors.join('; ')}` : '';
  return new Error(`Claude Code query failed (${result.subtype})${details}`);
}

export function mapClaudeCodeStopReason(result: SDKResultMessage): RunLoopStopReason {
  if (result.subtype === 'error_max_turns') return 'budget';
  if (result.subtype === 'success') return result.terminal_reason && result.terminal_reason !== 'completed' ? result.terminal_reason === 'max_turns' ? 'budget' : 'error' : 'natural';
  if (result.terminal_reason === 'max_turns') return 'budget';
  if (result.stop_reason === 'max_turns') return 'budget';
  return 'error';
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
}

function modelForRole(modelSlots: ClaudeCodeKtxLlmRuntimeDeps['modelSlots'], role: string): string {
  return resolveClaudeCodeModel(modelSlots[role] ?? modelSlots.default);
}

function assertInitIsolation(message: SDKMessage, allowedToolIds: Set<string>): void {
  if (message.type !== 'system' || message.subtype !== 'init') return;
  const unexpectedTools = message.tools.filter((tool) => !allowedToolIds.has(tool));
  if (unexpectedTools.length > 0 || message.slash_commands.length > 0 || message.skills.length > 0 || message.plugins.length > 0) {
    throw new Error(
      `Claude Code runtime isolation failed: tools=${unexpectedTools.join(',') || '(none)'} slash_commands=${message.slash_commands.length} skills=${message.skills.length} plugins=${message.plugins.length}`,
    );
  }
}

function baseOptions(input: {
  projectDir: string;
  model: string;
  env: NodeJS.ProcessEnv | undefined;
  maxTurns: number;
  tools?: KtxRuntimeToolSet;
}): Options {
  const toolIds = mcpToolIds(input.tools ?? {});
  const allowedToolIds = new Set(toolIds);
  return {
    cwd: input.projectDir,
    model: input.model,
    maxTurns: input.maxTurns,
    settingSources: [],
    skills: [],
    plugins: [],
    tools: [],
    allowedTools: toolIds,
    disallowedTools: BUILTIN_TOOLS,
    canUseTool: async (toolName, _toolInput, options) =>
      allowedToolIds.has(toolName)
        ? { behavior: 'allow', toolUseID: options.toolUseID }
        : {
            behavior: 'deny',
            message: `KTX claude-code runtime only permits current KTX MCP tools; denied ${toolName}.`,
            toolUseID: options.toolUseID,
          },
    permissionMode: 'dontAsk',
    persistSession: false,
    env: createKtxClaudeCodeEnv(input.env),
    ...(input.tools && Object.keys(input.tools).length > 0
      ? { mcpServers: { ktx: createSdkMcpServer({ name: 'ktx', tools: createClaudeSdkTools(input.tools) }) } }
      : {}),
  };
}

async function collectResult(params: {
  query: QueryFn;
  prompt: string;
  options: Options;
  allowedToolIds: Set<string>;
  onAssistantTurn?: () => Promise<void>;
}): Promise<SDKResultMessage> {
  let result: SDKResultMessage | undefined;
  for await (const message of params.query({ prompt: params.prompt, options: params.options })) {
    assertInitIsolation(message, params.allowedToolIds);
    if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      await params.onAssistantTurn?.();
    }
    if (isResult(message)) {
      result = message;
    }
  }
  if (!result) {
    throw new Error('Claude Code query returned no result message');
  }
  return result;
}

export class ClaudeCodeKtxLlmRuntime implements KtxLlmRuntimePort {
  private readonly runQuery: QueryFn;
  private readonly logger: KtxLogger;

  constructor(private readonly deps: ClaudeCodeKtxLlmRuntimeDeps) {
    this.runQuery = deps.query ?? defaultQuery;
    this.logger = deps.logger ?? noopLogger;
  }

  async generateText(input: KtxGenerateTextInput): Promise<string> {
    const options = baseOptions({
      projectDir: this.deps.projectDir,
      model: modelForRole(this.deps.modelSlots, input.role),
      env: this.deps.env,
      maxTurns: 1,
      tools: input.tools,
    });
    const result = await collectResult({
      query: this.runQuery,
      prompt: [input.system, input.prompt].filter(Boolean).join('\n\n'),
      options,
      allowedToolIds: new Set(mcpToolIds(input.tools ?? {})),
    });
    const error = resultError(result);
    if (error) throw error;
    return result.result;
  }

  async generateObject<TOutput, TSchema extends z.ZodType<TOutput>>(
    input: KtxGenerateObjectInput<TOutput, TSchema>,
  ): Promise<TOutput> {
    const options = {
      ...baseOptions({
        projectDir: this.deps.projectDir,
        model: modelForRole(this.deps.modelSlots, input.role),
        env: this.deps.env,
        maxTurns: 1,
        tools: input.tools,
      }),
      outputFormat: { type: 'json_schema' as const, schema: jsonSchema(input.schema as z.ZodType) },
    };
    const result = await collectResult({
      query: this.runQuery,
      prompt: [input.system, input.prompt].filter(Boolean).join('\n\n'),
      options,
      allowedToolIds: new Set(mcpToolIds(input.tools ?? {})),
    });
    const error = resultError(result);
    if (error) throw error;
    return (input.schema as z.ZodType<TOutput>).parse(result.structured_output);
  }

  async runAgentLoop(params: RunLoopParams): Promise<RunLoopResult> {
    let stepIndex = 0;
    try {
      const options = baseOptions({
        projectDir: this.deps.projectDir,
        model: modelForRole(this.deps.modelSlots, params.modelRole),
        env: this.deps.env,
        maxTurns: params.stepBudget,
        tools: params.toolSet,
      });
      const result = await collectResult({
        query: this.runQuery,
        prompt: params.userPrompt,
        options: { ...options, systemPrompt: params.systemPrompt },
        allowedToolIds: new Set(mcpToolIds(params.toolSet)),
        onAssistantTurn: async () => {
          stepIndex += 1;
          if (!params.onStepFinish) return;
          try {
            await params.onStepFinish({ stepIndex, stepBudget: params.stepBudget });
          } catch (error) {
            this.logger.warn(`[claude-code-runner] onStepFinish callback threw; ignoring: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      });
      const stopReason = mapClaudeCodeStopReason(result);
      return { stopReason, ...(stopReason === 'error' && resultError(result) ? { error: resultError(result) } : {}) };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return { stopReason: 'error', error: err };
    }
  }
}

export async function runClaudeCodeAuthProbe(input: {
  projectDir: string;
  model: string;
  query?: QueryFn;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const options = baseOptions({
      projectDir: input.projectDir,
      model: resolveClaudeCodeModel(input.model),
      env: input.env,
      maxTurns: 1,
    });
    const result = await collectResult({
      query: input.query ?? defaultQuery,
      prompt: 'Reply with exactly: ok',
      options,
      allowedToolIds: new Set(),
    });
    const error = resultError(result);
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Claude Code authentication is not usable. Authenticate Claude Code locally with the Claude Code CLI, then rerun setup or the command. ${message}`,
    };
  }
}
```

- [ ] **Step 9: Export Claude Code runtime modules**

In `packages/context/src/llm/index.ts`, add:

```ts
export { createKtxClaudeCodeEnv, CLAUDE_CODE_PROVIDER_ENV_DENYLIST } from './claude-code-env.js';
export { resolveClaudeCodeModel } from './claude-code-models.js';
export { ClaudeCodeKtxLlmRuntime, mapClaudeCodeStopReason, runClaudeCodeAuthProbe } from './claude-code-runtime.js';
```

- [ ] **Step 10: Run runtime tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/llm/claude-code-env.test.ts src/llm/claude-code-models.test.ts src/llm/claude-code-runtime.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 11: Commit**

```bash
git add packages/context/src/llm/claude-code-env.ts packages/context/src/llm/claude-code-env.test.ts packages/context/src/llm/claude-code-models.ts packages/context/src/llm/claude-code-models.test.ts packages/context/src/llm/claude-code-runtime.ts packages/context/src/llm/claude-code-runtime.test.ts packages/context/src/llm/index.ts
git commit -m "feat: add claude-code llm runtime"
```

### Task 4: Local Runtime Factory and Non-Agent LLM Call Sites

**Files:**

- Create: `packages/context/src/llm/runtime-local-config.test.ts`
- Modify: `packages/context/src/llm/local-config.ts`
- Modify: `packages/context/src/llm/index.ts`
- Modify: `packages/context/src/ingest/page-triage/page-triage.service.ts`
- Modify: `packages/context/src/ingest/page-triage/page-triage.service.test.ts`
- Modify: `packages/context/src/scan/description-generation.ts`
- Modify: `packages/context/src/scan/description-generation.test.ts`
- Modify: `packages/context/src/scan/relationship-llm-proposal.ts`
- Modify: `packages/context/src/scan/relationship-llm-proposal.test.ts`
- Modify: `packages/context/src/scan/local-enrichment.ts`
- Modify: `packages/context/src/scan/local-scan.ts`
- Modify: `packages/context/src/scan/local-scan.test.ts`

- [ ] **Step 1: Write failing local runtime factory tests**

Create `packages/context/src/llm/runtime-local-config.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createLocalKtxLlmProviderFromConfig, createLocalKtxLlmRuntimeFromConfig } from './local-config.js';

describe('local KTX LLM runtime config', () => {
  it('creates a Claude Code runtime for claude-code backend without creating an AI SDK provider', () => {
    const runtime = createLocalKtxLlmRuntimeFromConfig(
      {
        provider: { backend: 'claude-code' },
        models: { default: 'sonnet', triage: 'haiku' },
      },
      { env: {}, projectDir: '/tmp/project', createClaudeCodeRuntime: vi.fn((deps) => ({ deps })) },
    );

    expect(runtime).toMatchObject({ deps: expect.objectContaining({ projectDir: '/tmp/project' }) });
  });

  it('returns null from the AI SDK provider factory for claude-code backend', () => {
    expect(
      createLocalKtxLlmProviderFromConfig({
        provider: { backend: 'claude-code' },
        models: { default: 'sonnet' },
      }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/llm/runtime-local-config.test.ts
```

Expected: FAIL because `createLocalKtxLlmRuntimeFromConfig` does not exist.

- [ ] **Step 3: Implement the local runtime factory**

In `packages/context/src/llm/local-config.ts`, extend `LocalConfigDeps`:

```ts
  projectDir?: string;
  createClaudeCodeRuntime?: (deps: ConstructorParameters<typeof ClaudeCodeKtxLlmRuntime>[0]) => KtxLlmRuntimePort;
  createAiSdkRuntime?: (deps: { llmProvider: KtxLlmProvider }) => KtxLlmRuntimePort;
```

Add imports:

```ts
import { AiSdkKtxLlmRuntime } from './ai-sdk-runtime.js';
import { ClaudeCodeKtxLlmRuntime } from './claude-code-runtime.js';
import type { KtxLlmRuntimePort } from './runtime-port.js';
```

Update `createLocalKtxLlmProviderFromConfig`:

```ts
  const resolved = resolveLocalKtxLlmConfig(config, deps.env ?? process.env);
  if (!resolved || resolved.backend === 'claude-code') {
    return null;
  }
  return (deps.createKtxLlmProvider ?? createKtxLlmProvider)(resolved);
```

Add `createLocalKtxLlmRuntimeFromConfig`:

```ts
export function createLocalKtxLlmRuntimeFromConfig(
  config: KtxProjectLlmConfig,
  deps: LocalConfigDeps = {},
): KtxLlmRuntimePort | null {
  const resolved = resolveLocalKtxLlmConfig(config, deps.env ?? process.env);
  if (!resolved) {
    return null;
  }
  if (resolved.backend === 'claude-code') {
    const projectDir = deps.projectDir;
    if (!projectDir) {
      throw new Error('projectDir is required when creating the claude-code LLM runtime');
    }
    return (deps.createClaudeCodeRuntime ?? ((runtimeDeps) => new ClaudeCodeKtxLlmRuntime(runtimeDeps)))({
      projectDir,
      modelSlots: resolved.modelSlots,
      env: deps.env,
    });
  }
  const llmProvider = (deps.createKtxLlmProvider ?? createKtxLlmProvider)(resolved);
  return (deps.createAiSdkRuntime ?? ((runtimeDeps) => new AiSdkKtxLlmRuntime(runtimeDeps)))({ llmProvider });
}
```

Export it from `packages/context/src/llm/index.ts`:

```ts
export { createLocalKtxLlmRuntimeFromConfig } from './local-config.js';
```

- [ ] **Step 4: Migrate page triage to runtime text generation**

In `packages/context/src/ingest/page-triage/page-triage.service.ts`, replace
the dependency:

```ts
import type { KtxLlmRuntimePort } from '../../llm/index.js';
```

```ts
  llmRuntime: KtxLlmRuntimePort;
```

Replace `callModel` with:

```ts
  private async callModel(params: {
    operationName: 'page-triage' | 'light-extraction';
    system: string;
    prompt: string;
    sourceKey: string;
    jobId: string;
    unitKey: string;
  }): Promise<string> {
    return this.deps.llmRuntime.generateText({
      role: 'triage',
      system: params.system,
      prompt: params.prompt,
      temperature: 0,
    });
  }
```

In `packages/context/src/ingest/page-triage/page-triage.service.test.ts`, replace
provider fakes with:

```ts
const llmRuntime = {
  generateText: vi.fn(async () => JSON.stringify({ action: 'keep', confidence: 0.9, reason: 'relevant' })),
  generateObject: vi.fn(),
  runAgentLoop: vi.fn(),
};
```

Assert the runtime call:

```ts
expect(llmRuntime.generateText).toHaveBeenCalledWith(expect.objectContaining({ role: 'triage' }));
```

- [ ] **Step 5: Migrate scan text and object generation**

In `packages/context/src/scan/description-generation.ts`, replace the provider
field with:

```ts
import type { KtxLlmRuntimePort } from '../llm/index.js';
```

```ts
  llmRuntime: KtxLlmRuntimePort;
```

Update `generateAiDescription`:

```ts
      const text = await generateKtxText({
        runtime: this.llmRuntime,
        role: 'candidateExtraction',
        system: prompt.system,
        prompt: prompt.user,
        temperature: this.settings.temperature,
      });
```

In `packages/context/src/scan/relationship-llm-proposal.ts`, change the input:

```ts
  llmRuntime: KtxLlmRuntimePort | null;
```

Remove `modelIsDeterministic` and skip only when `!input.llmRuntime`. Replace
the generation call:

```ts
    const generated = await generateKtxObject<
      KtxRelationshipLlmProposalOutput,
      typeof relationshipLlmProposalSchema
    >({
      runtime: input.llmRuntime,
      role: 'candidateExtraction',
      system,
      prompt,
      schema: relationshipLlmProposalSchema,
    });
```

In `packages/context/src/scan/local-scan.ts`, create runtime providers for LLM
mode:

```ts
const llmRuntime = createLocalKtxLlmRuntimeFromConfig(llmConfig, {
  ...deps,
  projectDir: deps.projectDir,
});
```

Thread `llmRuntime` through `KtxLocalScanEnrichmentProviders`.

- [ ] **Step 6: Update non-agent tests**

In each changed test file, use this runtime fake when the test needs LLM output:

```ts
const runtime = {
  generateText: vi.fn(async () => 'Generated description'),
  generateObject: vi.fn(async () => ({ relationships: [] })),
  runAgentLoop: vi.fn(),
};
```

Update assertions from `llmProvider.getModel` to the operation used:

```ts
expect(runtime.generateText).toHaveBeenCalledWith(expect.objectContaining({ role: 'candidateExtraction' }));
expect(runtime.generateObject).toHaveBeenCalledWith(expect.objectContaining({ role: 'candidateExtraction' }));
```

- [ ] **Step 7: Run non-agent runtime tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/llm/runtime-local-config.test.ts src/ingest/page-triage/page-triage.service.test.ts src/scan/description-generation.test.ts src/scan/relationship-llm-proposal.test.ts src/scan/local-scan.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/context/src/llm/local-config.ts packages/context/src/llm/index.ts packages/context/src/llm/runtime-local-config.test.ts packages/context/src/ingest/page-triage/page-triage.service.ts packages/context/src/ingest/page-triage/page-triage.service.test.ts packages/context/src/scan/description-generation.ts packages/context/src/scan/description-generation.test.ts packages/context/src/scan/relationship-llm-proposal.ts packages/context/src/scan/relationship-llm-proposal.test.ts packages/context/src/scan/local-enrichment.ts packages/context/src/scan/local-scan.ts packages/context/src/scan/local-scan.test.ts
git commit -m "feat: route non-agent llm calls through runtime"
```

### Task 5: Agent Loops, Local Ingest, Memory, and MCP Ingest

**Files:**

- Modify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.test.ts`
- Modify: `packages/context/src/ingest/local-ingest.ts`
- Modify: `packages/context/src/ingest/ports.ts`
- Modify: `packages/context/src/ingest/stages/stage-3-work-units.ts`
- Modify: `packages/context/src/ingest/stages/stage-3-work-units.test.ts`
- Modify: `packages/context/src/ingest/stages/stage-4-reconciliation.ts`
- Modify: `packages/context/src/ingest/stages/stage-4-reconciliation.test.ts`
- Modify: `packages/context/src/ingest/context-candidates/curator-pagination.service.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Modify: `packages/context/src/ingest/stages/build-wu-context.ts`
- Modify: `packages/context/src/ingest/stages/build-reconcile-context.ts`
- Modify: `packages/context/src/memory/types.ts`
- Modify: `packages/context/src/memory/local-memory.ts`
- Modify: `packages/context/src/memory/memory-agent.service.ts`
- Modify: `packages/context/src/memory/memory-agent.service.ingest.test.ts`
- Modify: `packages/context/src/mcp/local-project-ports.ts`
- Modify: `packages/context/src/mcp/local-project-ports.test.ts`

- [ ] **Step 1: Write failing runtime injection tests**

Add this test to `packages/context/src/ingest/local-bundle-runtime.test.ts`:

```ts
it('uses a runtime-backed agent runner when claude-code is configured', () => {
  const runtime = {
    generateText: vi.fn(),
    generateObject: vi.fn(),
    runAgentLoop: vi.fn(async () => ({ stopReason: 'natural' as const })),
  };
  project.config.llm = {
    provider: { backend: 'claude-code' },
    models: { default: 'sonnet' },
  };
  const createLlmRuntime = vi.fn(() => runtime);

  const created = createLocalBundleIngestRuntime({
    project,
    adapters: [],
    createLlmRuntime,
  });

  expect(created).toBeDefined();
  expect(createLlmRuntime).toHaveBeenCalledWith(
    project.config.llm,
    expect.objectContaining({ projectDir: project.projectDir }),
  );
});
```

Add this test to `packages/context/src/memory/memory-agent.service.ingest.test.ts`:

```ts
it('normalizes load_skill output to markdown while preserving structured payload', async () => {
  const agentRunner = {
    runLoop: vi.fn(async (params) => {
      const result = await params.toolSet.load_skill.execute({ name: 'memory_agent' });
      expect(result.markdown).toContain('memory_agent');
      expect(result.structured).toMatchObject({ name: 'memory_agent' });
      return { stopReason: 'natural' as const };
    }),
  };
  const mocks = buildMocks({
    agentRunner,
    skillsRegistry: {
      listSkills: vi.fn().mockResolvedValue([{ name: 'memory_agent', path: '/tmp/skills/memory_agent' }]),
      buildSkillsPrompt: vi.fn().mockReturnValue(''),
      getSkill: vi.fn().mockResolvedValue({ name: 'memory_agent', path: '/tmp/skills/memory_agent' }),
      stripFrontmatter: vi.fn().mockReturnValue('Skill body'),
    },
  });
  const svc = buildService(mocks);

  await svc.ingest(baseInput);
  expect(agentRunner.runLoop).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-bundle-runtime.test.ts src/memory/memory-agent.service.ingest.test.ts
```

Expected: FAIL because runtime injection and runtime tool descriptors are not
wired through local ingest and memory.

- [ ] **Step 3: Change agent-runner dependency types to the port**

Replace imports of concrete `AgentRunnerService` where services only call
`runLoop`:

```ts
import type { AgentRunnerPort } from '../llm/index.js';
```

or, from nested ingest stage files:

```ts
import type { AgentRunnerPort } from '../../llm/index.js';
```

Change fields such as:

```ts
  agentRunner: AgentRunnerService;
```

to:

```ts
  agentRunner: AgentRunnerPort;
```

Apply this in `ports.ts`, `stage-3-work-units.ts`,
`stage-4-reconciliation.ts`, `curator-pagination.service.ts`, and
`memory/types.ts`.

- [ ] **Step 4: Create runtime-backed local ingest runners**

In `packages/context/src/ingest/local-bundle-runtime.ts`, add runtime factory
support:

```ts
import {
  createLocalKtxLlmRuntimeFromConfig,
  RuntimeAgentRunner,
  type KtxLlmRuntimePort,
} from '../llm/index.js';
```

Extend `CreateLocalBundleIngestRuntimeOptions`:

```ts
  llmRuntime?: KtxLlmRuntimePort;
  createLlmRuntime?: typeof createLocalKtxLlmRuntimeFromConfig;
```

Replace `resolveAgentRunner` with:

```ts
function resolveAgentRunner(options: CreateLocalBundleIngestRuntimeOptions): {
  agentRunner: AgentRunnerPort;
  llmRuntime?: KtxLlmRuntimePort;
} {
  const llmRuntime =
    options.llmRuntime ??
    (options.createLlmRuntime ?? createLocalKtxLlmRuntimeFromConfig)(options.project.config.llm, {
      projectDir: options.project.projectDir,
      env: process.env,
    }) ??
    undefined;

  if (options.agentRunner) {
    return { agentRunner: options.agentRunner, ...(llmRuntime ? { llmRuntime } : {}) };
  }

  if (!llmRuntime) {
    throw new Error(localIngestLlmProviderGuardMessage(options.project.projectDir));
  }

  return {
    agentRunner: new RuntimeAgentRunner(llmRuntime),
    llmRuntime,
  };
}
```

Update the guard message:

```ts
'ktx ingest requires llm.provider.backend: anthropic, vertex, gateway, or claude-code, or an injected agentRunner.'
```

Pass `llmRuntime` to `PageTriageService`:

```ts
    pageTriage: llmRuntime
      ? new PageTriageService({
          store: contextStore,
          llmRuntime,
          settings: {
            enabled: true,
            maxConcurrency: 2,
            lightExtractionEnabled: true,
            classifierModel: null,
            lightExtractionMaxCandidates: 5,
          },
          promptService,
          logger,
        })
      : undefined,
```

- [ ] **Step 5: Normalize BaseTool factory outputs**

In `packages/context/src/ingest/local-bundle-runtime.ts`, replace
`toAiSdkTool(context)` with `toRuntimeTool(context)`:

```ts
return {
  ...Object.fromEntries(this.tools.map((tool) => [tool.name, tool.toRuntimeTool(context)])),
  ...this.sourceTools,
};
```

In `packages/context/src/memory/local-memory.ts`, make the same replacement:

```ts
return Object.fromEntries(this.tools.map((tool) => [tool.name, tool.toRuntimeTool(context)]));
```

Update `MemoryToolSetLike` in `packages/context/src/memory/types.ts`:

```ts
toRuntimeTools(context: ToolContext): KtxRuntimeToolSet;
```

- [ ] **Step 6: Convert inline ingest and memory tools to runtime descriptors**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, replace each inline
`tool(...)` wrapper with a `KtxRuntimeToolDescriptor`. For `load_skill`, use:

```ts
const loadSkillTool: KtxRuntimeToolSet = {
  load_skill: {
    name: 'load_skill',
    description:
      'Load a skill to get specialized instructions. Call this when a skill listed in the system prompt matches the current task.',
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      const skill = await this.deps.skillsRegistry.getSkill(name, 'memory_agent');
      if (!skill) {
        const available =
          (await this.deps.skillsRegistry.listSkills('memory_agent')).map((s) => s.name).join(', ') || '(none)';
        return { markdown: `Skill "${name}" not available. Available: ${available}` };
      }
      const body = await readFile(join(skill.path, 'SKILL.md'), 'utf-8');
      if (!skillsLoadedPerWu.includes(skill.name)) {
        skillsLoadedPerWu.push(skill.name);
      }
      const structured = {
        name: skill.name,
        skillDirectory: skill.path,
        content: this.deps.skillsRegistry.stripFrontmatter(body),
      };
      return {
        markdown: `# ${structured.name}\n\n${structured.content}`,
        structured,
      };
    },
  },
};
```

Use the same shape for reconciliation `rcLoadSkill`, including
`skillDirectory` in the structured payload.

In `packages/context/src/memory/memory-agent.service.ts`, use:

```ts
const loadSkillTool: KtxRuntimeToolSet = {
  load_skill: {
    name: 'load_skill',
    description:
      'Load a skill to get specialized instructions. Call this when a skill listed in the system prompt matches the current task.',
    inputSchema: z.object({
      name: z.string().describe('The skill name as listed in the system prompt.'),
    }),
    execute: async ({ name }) => {
      const skill = await this.deps.skillsRegistry.getSkill(name, 'memory_agent');
      if (!skill) {
        const available =
          (await this.deps.skillsRegistry.listSkills('memory_agent')).map((s) => s.name).join(', ') || '(none)';
        return { markdown: `Skill "${name}" not available to the memory agent. Available: ${available}` };
      }
      try {
        const body = await readFile(join(skill.path, 'SKILL.md'), 'utf-8');
        if (!skillsLoaded.includes(skill.name)) {
          skillsLoaded.push(skill.name);
        }
        const structured = {
          name: skill.name,
          skillDirectory: skill.path,
          content: this.deps.skillsRegistry.stripFrontmatter(body),
        };
        return {
          markdown: `# ${structured.name}\n\n${structured.content}`,
          structured,
        };
      } catch (error) {
        return { markdown: `Error loading skill "${name}": ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  },
};
```

- [ ] **Step 7: Convert ingest tool helper factories**

For every helper under `packages/context/src/ingest/tools/*.tool.ts` that
currently returns `tool({ ... })`, change the return type to
`KtxRuntimeToolDescriptor` and return:

```ts
return {
  name: '<existing_tool_name>',
  description: '<existing description>',
  inputSchema,
  execute: async (input) => normalizeKtxRuntimeToolOutput(await existingExecution(input)),
};
```

Apply this to:

- `stage-diff.tool.ts`
- `stage-list.tool.ts`
- `eviction-list.tool.ts`
- `read-raw-file.tool.ts`
- `read-raw-span.tool.ts`
- `emit-conflict-resolution.tool.ts`
- `emit-eviction-decision.tool.ts`
- `emit-artifact-resolution.tool.ts`
- `emit-unmapped-fallback.tool.ts`
- `verification-ledger.tool.ts`
- `adapters/historic-sql/evidence-tool.ts`
- `adapters/looker/tools/looker-query-to-sl.tool.ts`

- [ ] **Step 8: Pass runtime through local ingest and MCP trigger options**

In `packages/context/src/ingest/local-ingest.ts`, add `llmRuntime?: KtxLlmRuntimePort`
to local ingest options and pass it into `createLocalBundleIngestRuntime`.

In `packages/context/src/mcp/local-project-ports.ts`, pass
`options.localIngest?.llmRuntime` into `runLocalMetabaseIngest` and
`runLocalIngest`:

```ts
llmRuntime: options.localIngest?.llmRuntime,
```

Update `packages/context/src/ingest/ports.ts` to expose `llmRuntime` beside
`agentRunner` only for local wiring.

- [ ] **Step 9: Run agent-loop tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/stages/stage-3-work-units.test.ts src/ingest/stages/stage-4-reconciliation.test.ts src/ingest/local-bundle-runtime.test.ts src/memory/memory-agent.service.ingest.test.ts src/mcp/local-project-ports.test.ts
```

Expected: all selected tests pass, and test fakes call `runLoop` through
`AgentRunnerPort`.

- [ ] **Step 10: Commit**

```bash
git add packages/context/src/ingest/local-bundle-runtime.ts packages/context/src/ingest/local-bundle-runtime.test.ts packages/context/src/ingest/local-ingest.ts packages/context/src/ingest/ports.ts packages/context/src/ingest/stages/stage-3-work-units.ts packages/context/src/ingest/stages/stage-3-work-units.test.ts packages/context/src/ingest/stages/stage-4-reconciliation.ts packages/context/src/ingest/stages/stage-4-reconciliation.test.ts packages/context/src/ingest/context-candidates/curator-pagination.service.ts packages/context/src/ingest/ingest-bundle.runner.ts packages/context/src/ingest/stages/build-wu-context.ts packages/context/src/ingest/stages/build-reconcile-context.ts packages/context/src/ingest/tools packages/context/src/memory/types.ts packages/context/src/memory/local-memory.ts packages/context/src/memory/memory-agent.service.ts packages/context/src/memory/memory-agent.service.ingest.test.ts packages/context/src/mcp/local-project-ports.ts packages/context/src/mcp/local-project-ports.test.ts
git commit -m "feat: route agent loops through llm runtime"
```

### Task 6: Setup, Status, Doctor, Prompt-Caching Warnings, and Docs

**Files:**

- Modify: `packages/cli/src/setup-commands.ts`
- Modify: `packages/cli/src/setup-models.ts`
- Modify: `packages/cli/src/setup-models.test.ts`
- Modify: `packages/cli/src/status-project.ts`
- Modify: `packages/cli/src/doctor.test.ts`
- Modify: `docs-site/content/docs/getting-started/quickstart.mdx`
- Modify: `docs-site/content/docs/cli-reference/ktx-setup.mdx`
- Modify: `docs-site/content/docs/cli-reference/ktx-status.mdx`
- Modify: `docs-site/content/docs/guides/building-context.mdx`
- Create: `docs-site/content/docs/guides/llm-configuration.mdx`
- Modify: `docs-site/content/docs/guides/meta.json`

- [ ] **Step 1: Write failing CLI tests**

Add this test to `packages/cli/src/setup-models.test.ts`:

```ts
it('configures Claude Code backend and validates local auth', async () => {
  const io = makeIo();
  const authProbe = vi.fn(async () => ({ ok: true as const }));

  const result = await runKtxSetupAnthropicModelStep(
    {
      projectDir: tempDir,
      inputMode: 'disabled',
      llmBackend: 'claude-code',
      skipLlm: false,
    },
    io.io,
    { claudeCodeAuthProbe: authProbe },
  );

  expect(result.status).toBe('ready');
  const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
  expect(config.llm).toMatchObject({
    provider: { backend: 'claude-code' },
    models: { default: 'sonnet' },
  });
  expect(authProbe).toHaveBeenCalledWith(expect.objectContaining({ projectDir: tempDir, model: 'sonnet' }));
});
```

Add this test to `packages/cli/src/doctor.test.ts`:

```ts
it('reports Claude Code auth failures and ignored prompt-caching fields in project doctor output', async () => {
  await writeFile(
    join(tempDir, 'ktx.yaml'),
    [
      'llm:',
      '  provider:',
      '    backend: claude-code',
      '  models:',
      '    default: sonnet',
      '  promptCaching:',
      '    enabled: true',
      '    systemTtl: 1h',
      '    toolsTtl: 1h',
      '    historyTtl: 5m',
      '',
    ].join('\n'),
    'utf-8',
  );
  const testIo = makeIo();

  await expect(
    runKtxDoctor(
      { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
      testIo.io,
      {
        claudeCodeAuthProbe: async () => ({
          ok: false as const,
          message: 'Authenticate Claude Code locally.',
        }),
      },
    ),
  ).resolves.toBe(1);

  expect(testIo.stdout()).toContain('claude-code');
  expect(testIo.stdout()).toContain('Authenticate Claude Code locally');
  expect(testIo.stdout()).toContain('claude-code ignores llm.promptCaching');
});
```

- [ ] **Step 2: Run CLI tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-models.test.ts src/doctor.test.ts
```

Expected: FAIL because CLI backend parsing and status probing do not support
`claude-code`.

- [ ] **Step 3: Add setup backend parsing and auth probe dependency**

In `packages/cli/src/setup-models.ts`, update the backend type:

```ts
export type KtxSetupLlmBackend = 'anthropic' | 'vertex' | 'claude-code';
```

Add the dependency:

```ts
  claudeCodeAuthProbe?: (input: { projectDir: string; model: string; env?: NodeJS.ProcessEnv }) => Promise<{ ok: true } | { ok: false; message: string }>;
```

Update `buildProjectLlmConfig` to accept Claude Code:

```ts
    | { backend: 'claude-code' },
```

```ts
  if (provider.backend === 'claude-code') {
    return {
      provider: { backend: 'claude-code' },
      models: { ...existing.models, default: model },
      promptCaching: existing.promptCaching,
    };
  }
```

When `args.llmBackend === 'claude-code'`, set:

```ts
const model = args.anthropicModel ?? 'sonnet';
const probe = deps.claudeCodeAuthProbe ?? runClaudeCodeAuthProbe;
const health = await probe({ projectDir: args.projectDir, model, env: deps.env ?? process.env });
if (!health.ok) {
  io.stderr.write(`${health.message}\n`);
  return { status: 'failed', projectDir: args.projectDir };
}
project.config.llm = buildProjectLlmConfig(project.config.llm, { backend: 'claude-code' }, model);
```

In `packages/cli/src/setup-commands.ts`, update the hidden parser to accept
`claude-code`:

```ts
if (value === 'anthropic' || value === 'vertex' || value === 'claude-code') {
  return value;
}
```

- [ ] **Step 4: Add status and doctor auth validation**

In `packages/cli/src/status-project.ts`, extend `BuildProjectStatusOptions`:

```ts
  claudeCodeAuthProbe?: (input: { projectDir: string; model: string; env?: NodeJS.ProcessEnv }) => Promise<{ ok: true } | { ok: false; message: string }>;
```

Make `buildLlmStatus` async and add:

```ts
  if (backend === 'claude-code') {
    const modelName = model ?? 'sonnet';
    const probe = options.claudeCodeAuthProbe ?? runClaudeCodeAuthProbe;
    const auth = await probe({ projectDir, model: modelName, env });
    if (auth.ok) {
      return { backend, model: modelName, status: 'ok', detail: 'local Claude Code session authenticated' };
    }
    return {
      backend,
      model: modelName,
      status: 'fail',
      detail: auth.message,
      fix: 'Authenticate Claude Code locally with the Claude Code CLI, then rerun `ktx status`.',
    };
  }
```

Add prompt-caching warnings:

```ts
function ignoredClaudeCodePromptCachingFields(config: KtxProjectLlmConfig): string[] {
  if (config.provider.backend !== 'claude-code' || !config.promptCaching) return [];
  return Object.keys(config.promptCaching).map((key) => `llm.promptCaching.${key}`);
}
```

Append this warning in `buildWarnings`:

```ts
const ignored = ignoredClaudeCodePromptCachingFields(config.llm);
if (ignored.length > 0) {
  warnings.push({
    level: 'warn',
    message: `claude-code ignores ${ignored.join(', ')} because the Claude Agent SDK does not expose KTX prompt-cache TTL, tool, or history markers.`,
    fix: 'Remove those promptCaching fields or use anthropic, vertex, or gateway when those cache knobs are required.',
  });
}
```

- [ ] **Step 5: Update docs**

In `docs-site/content/docs/getting-started/quickstart.mdx`, add this provider
example in the LLM setup section:

````mdx
To use your local Claude Code session instead of an API key, set:

```yaml
llm:
  provider:
    backend: claude-code
  models:
    default: sonnet
    triage: haiku
    candidateExtraction: sonnet
    curator: sonnet
    reconcile: sonnet
    repair: sonnet
```

`claude-code` uses the Claude Code authentication already configured on your
machine. It doesn't use `ANTHROPIC_API_KEY`, Vertex credentials, AI Gateway
tokens, or Bedrock credentials.
````

In `docs-site/content/docs/cli-reference/ktx-setup.mdx`, document:

```mdx
| `--llm-backend claude-code` | Use the local Claude Code session for KTX LLM calls | - |
```

In `docs-site/content/docs/cli-reference/ktx-status.mdx`, add:

```mdx
For `llm.provider.backend: claude-code`, `ktx status` checks that the local
Claude Code session is usable. If auth fails, run the Claude Code CLI login
flow, then rerun `ktx status`.
```

In `docs-site/content/docs/guides/building-context.mdx`, add:

```mdx
When you use `claude-code`, KTX still controls the tool surface for ingest and
memory capture. Claude Code built-in tools, discovered MCP servers, hooks,
skills, plugins, agents, and slash commands are not exposed to KTX agent loops.
```

Create `docs-site/content/docs/guides/llm-configuration.mdx`:

````mdx
---
title: LLM configuration
description: Configure KTX LLM providers, model roles, and prompt caching.
---

KTX uses the top-level `llm` block in `ktx.yaml` for text generation,
structured extraction, and ingest or memory agent loops.

## Backends

Set `llm.provider.backend` to one of these values:

- `anthropic`: Use the Anthropic API through `ANTHROPIC_API_KEY` or the
  configured `api_key` reference.
- `vertex`: Use Vertex AI Anthropic models through Google Cloud credentials.
- `gateway`: Use AI Gateway-compatible Anthropic model ids.
- `claude-code`: Use your local Claude Code session through the Claude Agent
  SDK. KTX removes provider-routing environment variables from Claude Code
  child processes, so this backend doesn't silently fall back to
  `ANTHROPIC_API_KEY`, Vertex, Gateway, or Bedrock credentials.

## Claude Code

Use aliases or full Claude model ids in `llm.models`:

```yaml
llm:
  provider:
    backend: claude-code
  models:
    default: sonnet
    triage: haiku
    candidateExtraction: sonnet
    curator: sonnet
    reconcile: sonnet
    repair: sonnet
```

`claude-code` keeps KTX tool boundaries intact. KTX exposes only the MCP tools
needed for the current KTX agent loop and disables Claude Code built-in tools,
filesystem settings, skills, plugins, agents, hooks, and slash commands.

## Prompt caching

`llm.promptCaching` has partial parity on `claude-code`. KTX doesn't pass
Anthropic cache-control markers to the Claude Agent SDK. Status and doctor warn
when you configure prompt-cache TTL, tool, or history fields that the Claude
Agent SDK backend ignores.
````

In `docs-site/content/docs/guides/meta.json`, add the page:

```json
{
  "title": "Guides",
  "defaultOpen": true,
  "pages": ["building-context", "llm-configuration", "writing-context", "serving-agents"]
}
```

- [ ] **Step 6: Run CLI and docs tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-models.test.ts src/doctor.test.ts
pnpm --filter ktx-docs run test
```

Expected: selected CLI tests and docs tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/setup-commands.ts packages/cli/src/setup-models.ts packages/cli/src/setup-models.test.ts packages/cli/src/status-project.ts packages/cli/src/doctor.test.ts docs-site/content/docs/getting-started/quickstart.mdx docs-site/content/docs/cli-reference/ktx-setup.mdx docs-site/content/docs/cli-reference/ktx-status.mdx docs-site/content/docs/guides/building-context.mdx docs-site/content/docs/guides/llm-configuration.mdx docs-site/content/docs/guides/meta.json
git commit -m "feat: support claude-code setup and status"
```

### Task 7: Repo-Wide Audit and Final Verification

**Files:**

- Modify: any files still found by the required grep audit.
- Modify: `knip.json` only if the new Agent SDK entrypoints are intentionally
  dynamic and Knip cannot infer them.

- [ ] **Step 1: Run the required LLM call-site audit**

Run:

```bash
rg -n "getModel\\(|generateKtxText\\(|generateKtxObject\\(|AgentRunnerService|llmProvider" packages/context packages/cli packages/llm -g '!**/dist/**'
```

Expected remaining allowed matches:

- `packages/llm/src/model-provider.ts` and its tests for AI SDK provider
  construction.
- `packages/llm/src/model-health.ts` and its tests for AI SDK health checks.
- `packages/context/src/llm/ai-sdk-runtime.ts` for the AI SDK runtime adapter.
- `packages/context/src/llm/local-config.ts` for provider construction on
  non-`claude-code` backends.
- Test fakes where the test name explicitly covers AI SDK provider behavior.

Every runtime call site under ingest, memory, MCP-triggered ingest, page
triage, scan description generation, and relationship LLM proposals must use
`KtxLlmRuntimePort` or `AgentRunnerPort`.

- [ ] **Step 2: Fix disallowed audit matches**

For every disallowed match from Step 1, replace the dependency with one of
these patterns:

```ts
import type { KtxLlmRuntimePort } from '../llm/index.js';
```

```ts
import type { AgentRunnerPort } from '../llm/index.js';
```

Then call:

```ts
await runtime.generateText({ role, system, prompt, temperature });
await runtime.generateObject({ role, system, prompt, schema, temperature });
await agentRunner.runLoop(params);
```

- [ ] **Step 3: Run targeted package tests**

Run:

```bash
pnpm --filter @ktx/llm run test
pnpm --filter @ktx/context run test
pnpm --filter @ktx/cli run test
pnpm --filter ktx-docs run test
```

Expected: all selected package tests pass.

- [ ] **Step 4: Run type-checks**

Run:

```bash
pnpm run type-check
```

Expected: TypeScript compilation passes across packages.

- [ ] **Step 5: Run build/export verification**

Run:

```bash
pnpm run build
```

Expected: all package builds pass and exports resolve.

- [ ] **Step 6: Run dead-code checks**

Run:

```bash
pnpm run dead-code
```

Expected: Biome and Knip pass. If Knip reports the Agent SDK dependency as
unused despite static imports in `claude-code-runtime.ts`, inspect the report
and fix the import path or package dependency location before adding an ignore.

- [ ] **Step 7: Run full workspace test**

Run:

```bash
pnpm run test
```

Expected: workspace tests pass.

- [ ] **Step 8: Commit verification cleanup**

```bash
git status --short
git add packages docs-site pnpm-lock.yaml knip.json
git commit -m "test: verify claude-code backend runtime"
```

Use `git add packages docs-site pnpm-lock.yaml knip.json` only after inspecting
`git status --short` and confirming every staged file belongs to this backend
implementation.

## Self-Review

- Spec coverage: This plan covers first-class config, runtime port, text
  generation, structured object generation, agent loops, tool boundaries, exact
  MCP ids, `canUseTool`, isolation options, scrubbed environment, auth probe,
  stop reason mapping, `onStepFinish`, prompt-caching warnings, setup/status,
  docs, and the required grep audit.
- V1-blocking coverage: All blocking gaps from the audit are assigned to Tasks
  1 through 7.
- Non-blocking exclusions: Same-step repair parity, OTEL parity, embedding
  parity, persisted Claude sessions, and full prompt-caching parity are
  intentionally left outside v1.
