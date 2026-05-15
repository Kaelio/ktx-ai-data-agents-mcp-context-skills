# Brainstorm: `claude-code` backend with full KTX LLM parity

Adds a `claude-code` backend that gives KTX full parity with the existing
`ANTHROPIC_API_KEY`-based `anthropic` backend for **all KTX LLM calls**. The
backend uses `@anthropic-ai/claude-agent-sdk` and reuses the user's existing
local Claude Code authentication. Users select it in `ktx.yaml`.

This is not an implementation plan. It is the revised design after expanding
the requirement from "`ktx ingest` works with Claude Code" to "every KTX LLM
call works with Claude Code." The follow-up implementation plan should be
written separately.

## Core decision

`claude-code` is a first-class global LLM backend. Any code path that currently
works with `llm.provider.backend: anthropic` must work with
`llm.provider.backend: claude-code`, unless it is not an LLM call at all.

This includes:

- Agent loops implemented through `AgentRunnerService.runLoop(...)`.
- Text generation through `generateKtxText(...)`.
- Structured object generation through `generateKtxObject(...)`.
- Local ingest and MCP-triggered local ingest flows.
- Page triage and light extraction.
- Context-candidate curation and reconciliation.
- Memory capture.
- Scan/enrichment internals and relationship LLM proposals.
- Future KTX LLM call sites that use the shared runtime boundary.

Commands that do not use LLMs do not need special Claude Code behavior. There
must be no silent fallback from `claude-code` to gateway, Anthropic API-key
execution, or deterministic output.

## Goals

- Let a KTX user run all KTX LLM-backed behavior through their existing local
  Claude Code session without provisioning `ANTHROPIC_API_KEY`, Vertex
  credentials, or an AI Gateway key.
- Preserve the existing user-facing CLI and MCP behavior. `claude-code` changes
  how LLM calls execute, not which KTX workflows exist.
- Preserve role-based model selection. `llm.models.default`, `triage`,
  `candidateExtraction`, `curator`, `reconcile`, and `repair` remain the source
  of model selection for every LLM call.
- Preserve KTX's curated tool boundaries. Claude Code built-ins,
  filesystem-discovered MCP servers, hooks, skills, plugins, agents, and slash
  commands must not expand the tool surface for KTX agent loops.
- Keep embeddings independent. Claude does not provide embeddings; users keep
  configuring `ingest.embeddings` and scan/enrichment embeddings as they do
  today.
- Fail fast with a clear message if local Claude Code authentication is not
  usable.

## Non-goals

- **Embedding parity.** Embeddings remain separate from LLM execution.
- **Tool-call repair parity in the first pass.** The AI SDK runner uses
  `experimental_repairToolCall` (`packages/llm/src/repair.ts:35-88`). The Claude
  Agent SDK has no transparent same-step repair hook. MVP behavior is next-turn
  self-correction from schema errors or a normal tool-failure count.
- **OTEL telemetry parity in the first pass.** The AI SDK runner uses
  `experimental_telemetry`. The Agent SDK exposes hooks such as
  `PostToolUseFailure` and `SessionEnd`, but no drop-in OTEL switch. MVP ships
  without telemetry parity on this backend.
- **Productizing Claude subscription limits.** Documentation must frame this as
  "use your own local Claude Code session," not as a third-party Claude Max or
  Claude.ai product feature.

## Approaches considered

### Recommended: global LLM runtime port

Introduce a backend-neutral KTX LLM runtime port for operations, not just model
construction:

```ts
interface KtxLlmRuntimePort {
  generateText(input: KtxGenerateTextInput): Promise<string>;
  generateObject<T>(input: KtxGenerateObjectInput<T>): Promise<T>;
  runAgentLoop(params: RunLoopParams): Promise<RunLoopResult>;
}
```

The existing `anthropic`, `vertex`, and `gateway` backends implement the runtime
through the AI SDK and existing `KtxLlmProvider`. The new `claude-code` backend
implements the same runtime through `@anthropic-ai/claude-agent-sdk`.

This is the recommended approach because KTX call sites need operations:
"generate text," "generate a structured object," and "run an agent loop." They
do not inherently need direct access to an AI SDK `LanguageModel`. The Agent SDK
is a session/agent API, not an AI SDK model factory, so the runtime port avoids
pretending those APIs are the same.

### Rejected: fake AI SDK `LanguageModel` for Claude Code

Trying to make Claude Code look like an AI SDK `LanguageModel` would be brittle.
The Agent SDK owns session execution, permissions, MCP tools, structured output,
and result messages. Those semantics do not map cleanly onto a normal
`getModel(...)` return value.

### Rejected: branch at every call site

Adding `if backend === "claude-code"` around each LLM call would work briefly
but would duplicate prompt wrapping, structured output handling, debug logging,
tool conversion, auth checks, and error mapping. It would also make future LLM
call sites easy to miss.

## Architecture

```text
ktx.yaml
  llm.provider.backend: anthropic | vertex | gateway | claude-code
  llm.models.<role>: model alias or model ID

createLocalKtxLlmRuntimeFromConfig(project.config.llm)
  -> AiSdkKtxLlmRuntime
     - wraps existing KtxLlmProvider
     - generateText / Output.object / AgentRunnerService
  -> ClaudeCodeKtxLlmRuntime
     - uses @anthropic-ai/claude-agent-sdk query()
     - implements text, object, and agent-loop operations

All KTX LLM call sites
  -> KtxLlmRuntimePort
```

The runtime is selected at the same boundaries that currently construct an
`llmProvider` or `AgentRunnerService`:

- `packages/context/src/llm/local-config.ts`
- `packages/context/src/ingest/local-bundle-runtime.ts`
- `packages/context/src/memory/local-memory.ts`
- `packages/context/src/scan/local-scan.ts`
- `packages/context/src/mcp/local-project-ports.ts`
- Any CLI setup/status/doctor code that validates LLM readiness

After the change, services should not need to know whether the configured
backend is AI SDK based or Claude Code based. They call the runtime operation
they need.

## LLM call-site migration

The implementation plan must migrate every current KTX LLM call site to the
runtime port:

- `packages/context/src/llm/generation.ts`: `generateKtxText` and
  `generateKtxObject` become runtime-backed helpers or are folded into the
  runtime.
- `packages/context/src/agent/agent-runner.service.ts`: the AI SDK agent loop
  becomes the AI SDK implementation of `runAgentLoop`.
- `packages/context/src/ingest/page-triage/page-triage.service.ts`: page triage
  and light extraction depend on `KtxLlmRuntimePort`, not raw `KtxLlmProvider`.
- `packages/context/src/scan/description-generation.ts`: AI descriptions use
  the runtime text-generation operation.
- `packages/context/src/scan/relationship-llm-proposal.ts`: relationship
  proposals use the runtime object-generation operation.
- `packages/context/src/ingest/stages/stage-3-work-units.ts`,
  `packages/context/src/ingest/stages/stage-4-reconciliation.ts`,
  `packages/context/src/ingest/context-candidates/curator-pagination.service.ts`,
  and `packages/context/src/memory/memory-agent.service.ts`: agent loops use the
  runtime agent-loop operation or a thin `AgentRunnerPort` backed by it.
- Test helpers and MCP local project ports that inject `llmProvider` or
  `agentRunner` must either inject the runtime port or use compatibility test
  adapters during the migration.

The plan must include a grep-based audit so new or overlooked `getModel(...)`,
`generateKtxText(...)`, `generateKtxObject(...)`, `AgentRunnerService`, and
`llmProvider` usages are either migrated or explicitly proven non-runtime.

## Config design

The config should make `claude-code` a first-class backend:

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

Implementation implications:

- Extend `KTX_LLM_BACKENDS` in `packages/context/src/project/config.ts` and
  `KtxLlmBackend` in `packages/llm/src/types.ts`.
- Update setup, status, doctor, schema generation, examples, and docs so
  `claude-code` is understood everywhere `anthropic` is understood.
- Update `createKtxLlmProvider` / `createModelFactory` so unsupported backend
  values throw instead of falling through to gateway.
- Keep `llm.models` as the per-role binding source. The Claude Code runtime maps
  each KTX role to the configured model string for the current call.
- Define accepted model aliases, such as `sonnet`, `opus`, and `haiku`, and full
  model IDs supported by the pinned SDK version.

## Claude Agent SDK runtime behavior

Every Agent SDK call must be isolated enough for KTX execution. Use explicit
options even when SDK defaults currently match the desired value.

For agent loops with tools:

```ts
query({
  prompt,
  options: {
    cwd: project.projectDir,
    systemPrompt,
    model: resolveModel(modelRole),
    maxTurns: stepBudget,
    settingSources: [],
    skills: [],
    plugins: [],
    mcpServers: { ktx: createSdkMcpServer({ name: "ktx", tools }) },
    tools: ["mcp__ktx__*"],
    allowedTools: ["mcp__ktx__*"],
    permissionMode: "dontAsk",
    disallowedTools: [
      "Agent",
      "Task",
      "AskUserQuestion",
      "Bash",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "TodoWrite"
    ],
    persistSession: false
  }
});
```

For plain text generation:

- Use the same `query()` runtime with `maxTurns: 1`.
- Pass `settingSources: []`, `skills: []`, `plugins: []`, `tools: []`, and
  `permissionMode: "dontAsk"`.
- Do not expose MCP tools unless the KTX call explicitly passed tools.
- Return the final result message text.

For structured object generation:

- Use the Agent SDK structured output option for JSON schema output.
- Convert KTX Zod schemas at the runtime boundary.
- Parse and validate the returned object with the original KTX schema before
  returning it to the caller.

The plan must confirm the exact option names against the pinned SDK version, but
the required outcome is fixed:

- Filesystem settings are not loaded. `settingSources: []` is explicit, and the
  implementation should assert from the SDK init message that no unexpected
  settings-derived commands, skills, agents, plugins, or MCP servers are active.
- Skills are disabled with `skills: []`, and plugins are disabled with
  `plugins: []`.
- `allowedTools` alone is not sufficient because the current SDK docs describe
  it as auto-approval, not restriction. Use `tools`, `permissionMode:
  "dontAsk"`, and explicit `disallowedTools` for built-ins.
- Built-ins are denied even if a future SDK default changes.
- `cwd` is `project.projectDir`, resolved at startup via `resolveKtxProjectDir`,
  not `process.cwd()`.
- Sessions are not persisted unless the plan identifies a concrete debugging
  feature that needs persistence.

## Tool boundary

Agent-loop tools cannot remain only raw AI SDK `Record<string, Tool>` values if
two backends must consume them. The plan must define a backend-neutral tool
descriptor for the final tool map handed to an agent loop:

```ts
interface KtxRuntimeToolDescriptor<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  execute(input: TInput): Promise<ToolOutput<TOutput>>;
}
```

Every composed tool entry must preserve the descriptor, including:

- `BaseTool` outputs from factory toolsets.
- Source-specific raw tools such as `emit_historic_sql_evidence` in
  `packages/context/src/ingest/local-bundle-runtime.ts`.
- Stage-local tools in `buildWuToolSet` and `buildReconcileToolSet`.
- Inline `load_skill`, read/raw/span, stage/diff, eviction, and emit tools in
  `packages/context/src/ingest/ingest-bundle.runner.ts`.
- Memory-agent `load_skill` in
  `packages/context/src/memory/memory-agent.service.ts`.
- The `withVerificationLedger` wrapping layer.

The AI SDK adapter converts descriptors to `tool(...)`. The Claude Code adapter
converts descriptors to Agent SDK `tool(name, description, schema.shape,
handler)` entries inside `createSdkMcpServer(...)`. KTX tool handlers return
`{ markdown, structured }`; the Claude adapter returns markdown as text content
and may include structured JSON only if a caller needs it.

Non-object schemas are unsupported for `claude-code` and must be rejected at
startup with a clear error. In practice KTX tool inputs are already `z.object`.

## Stop reasons and failures

The Claude runner maps the SDK's typed result message to
`RunLoopStopReason = "budget" | "natural" | "error"`:

- `subtype: "error_max_turns"` or `stop_reason: "max_turns"` -> `"budget"`.
- `subtype: "success"` -> `"natural"`.
- Other error subtypes or non-null unsuccessful stop reasons -> `"error"`.

`Stop` hooks are not the authoritative stop-reason source because they do not
carry the terminal reason. They remain useful for lifecycle logging. Tool failure
counting should use `PostToolUseFailure` and feed the same mechanism that
`stage-3-work-units.ts` checks through `toolFailureCount?(wu.unitKey)`.

For text and object generation, SDK authentication, billing, rate-limit,
permission, max-turn, structured-output, and execution errors must map to the
same error surfaces that KTX uses for the Anthropic API-key backend.

## Auth and setup

`ktx setup`, status, and doctor flows must validate that Claude Code SDK auth is
usable, not just that `~/.claude/` exists. Acceptable validation strategies:

- A minimal SDK probe call with `settingSources: []`, `tools: []`, and
  `maxTurns: 1`.
- An SDK-provided account/auth status method if the pinned version exposes one.
- A docs-endorsed file-presence check only if the official SDK docs explicitly
  state that it proves auth usability.

Failure copy should tell the user to authenticate Claude Code locally with the
Claude Code CLI, then rerun setup or the command they attempted.

## Documentation impact

Docs updates are required because this changes user-visible setup and LLM
provider behavior:

- `docs-site/content/docs/getting-started/quickstart.mdx`
- `docs-site/content/docs/cli-reference/ktx-setup.mdx`
- `docs-site/content/docs/guides/building-context.mdx`
- Any config reference page that documents `llm.provider.backend`
- Any status or doctor docs that describe LLM readiness

The docs must say that `claude-code` uses the user's own local Claude Code
session. Do not describe it as a way for KTX to resell, pool, or productize
Claude subscription limits.

## Verified evidence

- Current `KtxLlmProvider` returns AI SDK `LanguageModel` instances and only
  supports `anthropic`, `vertex`, and `gateway`
  (`packages/llm/src/types.ts`, `packages/llm/src/model-provider.ts`).
- Project config currently accepts `llm.provider.backend: none | anthropic |
  vertex | gateway` (`packages/context/src/project/config.ts`).
- `generateKtxText` and `generateKtxObject` are shared non-agent generation
  helpers (`packages/context/src/llm/generation.ts`).
- `AgentRunnerService` is the shared AI SDK agent-loop implementation
  (`packages/context/src/agent/agent-runner.service.ts`).
- Page triage and light extraction currently use raw `KtxLlmProvider`
  (`packages/context/src/ingest/page-triage/page-triage.service.ts`).
- Scan/enrichment internals currently use `createLocalKtxLlmProviderFromConfig`,
  `generateKtxText`, and `generateKtxObject`
  (`packages/context/src/scan/local-scan.ts`,
  `packages/context/src/scan/description-generation.ts`,
  `packages/context/src/scan/relationship-llm-proposal.ts`).
- Local ingest and MCP local project ports inject `llmProvider` and
  `agentRunner` today (`packages/context/src/ingest/local-bundle-runtime.ts`,
  `packages/context/src/mcp/local-project-ports.ts`).
- The Agent SDK TypeScript reference documents `settingSources` defaulting to no
  filesystem settings, `allowedTools` as auto-approval rather than restriction,
  `permissionMode: "dontAsk"`, `tools`, `disallowedTools`, `maxTurns`,
  `mcpServers`, `cwd`, `persistSession`, and SDK result/hook message shapes.
- The Agent SDK MCP docs show registering MCP servers in `query()` options and
  using `allowedTools` for MCP tool access.
- The Agent SDK skills docs say discovered skills can be controlled with the
  `skills` option and disabled with `[]`; the runtime should set this
  explicitly.

## Open items for the implementation plan

1. Confirm exact TypeScript option names and result-message discriminants
   against the pinned `@anthropic-ai/claude-agent-sdk` version.
2. Define the final `KtxLlmRuntimePort` file location and package exports.
3. Define model alias validation for `sonnet`, `opus`, `haiku`, and full model
   IDs.
4. Define the auth probe and make setup/status/doctor report actionable
   messages.
5. Run a repo-wide audit for all LLM call sites and migrate each one to the
   runtime boundary.
6. Write tests proving `claude-code` works for text generation, structured
   object generation, and agent-loop execution.
7. Write tests proving page triage, scan/enrichment internals, memory capture,
   MCP-triggered local ingest, and normal local ingest all use the
   `claude-code` runtime when configured.
8. Write tests proving a raw built-in Claude Code tool request is denied and
   only `mcp__ktx__*` tools are available during KTX agent loops.
