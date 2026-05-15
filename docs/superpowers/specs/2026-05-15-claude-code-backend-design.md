# Brainstorm: `claude-code` backend for end-to-end KTX ingest

Adds a `claude-code` selection that makes **all `ktx ingest` LLM work** run
through `@anthropic-ai/claude-agent-sdk`, reusing the user's existing local
Claude Code authentication. The user experience stays the same: users run
`ktx ingest`; the backend is selected in `ktx.yaml`.

This is not an implementation plan. It is the revised design after iterating on
the brainstorm with the requirement that **all KTX ingest capabilities must work
with `claude-code`**. The follow-up implementation plan should be written
separately.

## Core decision

`claude-code` is no longer only an agent-runner backend. It is an ingest-capable
LLM runtime that covers both kinds of LLM work used by ingest:

- **Agent loops**: work-unit execution, reconciliation, context-candidate
  curation pagination, and memory-agent ingestion paths that call
  `agentRunner.runLoop(...)`.
- **Non-agent generation**: page triage and light extraction, which currently
  call `KtxLlmProvider` directly through `generateText`.

The implementation must not make page triage silently disappear when the user
chooses `claude-code`. Today `PageTriageService` is only constructed when
`resolveAgentRunner(...)` returns an AI SDK `llmProvider`
(`packages/context/src/ingest/local-bundle-runtime.ts:684-693`). Under the new
design, ingest gets a generation runtime for `claude-code`, so page triage and
light extraction still run.

## Goals

- Let a KTX user run every `ktx ingest` mode against their existing local Claude
  Code session without provisioning `ANTHROPIC_API_KEY`, Vertex credentials, or
  an AI Gateway key.
- Cover scheduled pulls, upload ingest, Metabase fan-out, page triage, light
  extraction, context-candidate curation, work-unit execution, reconciliation,
  memory capture invoked from ingest, and source-specific tools such as
  historic-SQL evidence emission.
- Preserve KTX's per-stage tool curation. Each stage exposes exactly the KTX
  tools it already selected; Claude Code built-ins, filesystem-discovered MCP
  servers, hooks, skills, plugins, agents, and slash commands must not expand
  the tool surface.
- Keep embeddings independent. Claude does not provide embeddings; users keep
  configuring `ingest.embeddings` as they do today.
- Fail fast with a clear message if local Claude Code authentication is not
  usable.

## Non-goals

- **Global `ktx scan` parity in the first plan.** The required target is
  end-to-end `ktx ingest`. `ktx scan` has separate non-agent LLM consumers
  (`packages/context/src/scan/description-generation.ts`,
  `packages/context/src/scan/relationship-llm-proposal.ts`,
  `packages/context/src/scan/local-scan.ts`). The config and runtime design must
  avoid accidental gateway fall-through for these paths, but the plan may either
  adapt them in the same pass or fail them clearly until scan support is planned.
- **Tool-call repair parity.** The AI SDK runner uses
  `experimental_repairToolCall` (`packages/llm/src/repair.ts:35-88`). The Claude
  Agent SDK has no transparent same-step repair hook. MVP behavior is next-turn
  self-correction from schema errors or a normal tool-failure count.
- **OTEL telemetry parity.** The AI SDK runner uses `experimental_telemetry`.
  The Agent SDK exposes hooks such as `PostToolUseFailure` and `SessionEnd`, but
  no drop-in OTEL switch. MVP ships without telemetry parity on this backend.
- **Productizing Claude subscription limits.** Documentation must frame this as
  "use your own local Claude Code session," not as a third-party Claude Max or
  Claude.ai product feature.

## Approaches considered

### Recommended: Ingest LLM runtime port

Introduce a backend-neutral KTX LLM runtime port for operations, not just model
construction:

```ts
interface KtxGenerationPort {
  generateText(input: KtxGenerateTextInput): Promise<string>;
  generateObject<T>(input: KtxGenerateObjectInput<T>): Promise<T>;
}

interface AgentRunnerPort {
  runLoop(params: RunLoopParams): Promise<RunLoopResult>;
}
```

The existing AI SDK implementation adapts `KtxLlmProvider` to these ports. The
new Claude Code implementation uses `query()` from
`@anthropic-ai/claude-agent-sdk`. Ingest services depend on the ports:

- `PageTriageService` depends on `KtxGenerationPort`, not raw
  `KtxLlmProvider`.
- `generateKtxText` / `generateKtxObject` become thin helpers over the
  generation port or move behind it.
- `AgentRunnerService` and `ClaudeAgentSdkRunnerService` both implement
  `AgentRunnerPort`.

This is the recommended approach because it matches the Agent SDK's actual
shape. The Agent SDK is an agent/session API, not an AI SDK `LanguageModel`
factory, so forcing it into `KtxLlmProvider.getModel(...)` would create a false
abstraction and leave page triage broken.

### Rejected: agent-runner-only backend

This was the previous version of the spec. It made work-unit and reconciliation
agent loops possible, but it did not cover page triage or light extraction.
Because `ktx ingest` uses those non-agent LLM calls for document-like sources,
this does not satisfy the updated requirement.

### Rejected for MVP: Claude Code OpenAI proxy

Using a proxy or `claude -p` subprocess would avoid some TypeScript adapter work,
but it would add another protocol boundary, make tool control harder to prove,
and move away from the official Agent SDK API.

## Architecture

```text
ktx ingest
  -> createLocalBundleIngestRuntime(...)
     -> resolveIngestLlmRuntime(...)
        -> AI SDK runtime
           - KtxGenerationPort via generateText / Output.object
           - AgentRunnerPort via current AgentRunnerService
        -> Claude Code runtime
           - KtxGenerationPort via Agent SDK query()
           - AgentRunnerPort via ClaudeAgentSdkRunnerService

  -> PageTriageService
     -> generation.generateText({ role: "triage", ... })

  -> IngestBundleRunner stages
     -> agentRunner.runLoop({ modelRole, toolSet, stepBudget, ... })
```

The runtime is selected once at the context-runtime DI boundary. The main ingest
integration point remains `resolveAgentRunner` /
`createLocalBundleIngestRuntime` in
`packages/context/src/ingest/local-bundle-runtime.ts`, but the function should
evolve from "resolve an agent runner plus optional AI SDK provider" into
"resolve the ingest LLM runtime ports." The memory-agent construction path in
`packages/context/src/memory/local-memory.ts` needs the same port treatment.

`packages/cli/src/runtime.ts` is the Python-runtime command handler; it is not
the agent-runner or generation-runtime integration point.

## Config design

The plan should make `claude-code` a first-class config value, not a hidden
side-channel. Recommended shape:

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
```

Implementation implications:

- Extend `KTX_LLM_BACKENDS` in `packages/context/src/project/config.ts` and
  `KtxLlmBackend` in `packages/llm/src/types.ts`.
- Update setup, status, doctor, and local provider resolution so
  `claude-code` does not fall through to `gateway`.
- For `claude-code`, do not construct a fake AI SDK `LanguageModel`. Construct
  the Claude Code generation/runtime ports.
- Keep `llm.models` as the per-role binding source. The Claude Code runtime maps
  each KTX role to the configured model string for the current call. The plan
  must decide and test the accepted model aliases, for example `sonnet`,
  `opus`, `haiku`, or full Claude model IDs supported by the SDK.
- If a non-ingest path such as `ktx scan` sees `backend: claude-code` before it
  has been ported, it must fail fast with a clear "not supported for this command
  yet" message. It must not silently route to gateway.

## Claude Agent SDK runtime behavior

Every Agent SDK call must be isolated and deterministic enough for KTX ingest.
Use explicit options even when SDK defaults currently match the desired value.

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

The plan must confirm the exact option names against the pinned SDK version, but
the required outcome is fixed:

- Filesystem settings are not loaded. `settingSources: []` is explicit, and the
  implementation should assert from the SDK init message that no unexpected
  settings-derived commands, skills, agents, or MCP servers are active.
- Skills are disabled with `skills: []`, and plugins are disabled with
  `plugins: []`.
- Only KTX MCP tools are available and auto-approved. `allowedTools` alone is
  not sufficient because the current SDK docs describe it as auto-approval, not
  restriction. Use `tools`, `permissionMode: "dontAsk"`, and explicit
  `disallowedTools` for built-ins.
- Built-ins are denied even if a future SDK default changes.
- `cwd` is `project.projectDir`, resolved at startup via `resolveKtxProjectDir`,
  not `process.cwd()`.
- Sessions are not persisted for ingest unless the plan identifies a concrete
  debugging feature that needs persistence.

For non-agent text generation, use the same isolated runtime with no MCP tools,
`maxTurns: 1`, and no filesystem settings. For structured outputs, use the Agent
SDK's JSON-schema output format and convert KTX's Zod schemas at the boundary.

## Tool boundary

The final `RunLoopParams.toolSet` cannot remain a raw AI SDK `Record<string,
Tool>` if two backends must consume it. The plan must define a backend-neutral
tool descriptor for the **final** tool map handed to the runner:

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
  `packages/context/src/ingest/local-bundle-runtime.ts:543-556`.
- Stage-local tools in `buildWuToolSet` and `buildReconcileToolSet`
  (`packages/context/src/ingest/stages/build-wu-context.ts`,
  `packages/context/src/ingest/stages/build-reconcile-context.ts`).
- Inline `load_skill`, read/raw/span, stage/diff, eviction, and emit tools in
  `packages/context/src/ingest/ingest-bundle.runner.ts`.
- Memory-agent `load_skill` in
  `packages/context/src/memory/memory-agent.service.ts`.
- The `withVerificationLedger` wrapping layer.

The AI SDK adapter converts descriptors to `tool(...)`. The Claude Code adapter
converts descriptors to Agent SDK `tool(name, description, schema.shape,
handler)` entries inside `createSdkMcpServer(...)`. KTX tool handlers return
`{ markdown, structured }`; the Claude adapter returns the markdown as text
content and may include structured JSON in the text only if a caller needs it.

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

## Auth and setup

`ktx setup` must validate that Claude Code SDK auth is usable, not just that
`~/.claude/` exists. Acceptable validation strategies:

- A minimal SDK probe call with `settingSources: []`, `tools: []`, and
  `maxTurns: 1`.
- An SDK-provided account/auth status method if the pinned version exposes one.
- A docs-endorsed file-presence check only if the official SDK docs explicitly
  state that it proves auth usability.

Failure copy should tell the user to authenticate Claude Code locally with the
Claude Code CLI, then rerun setup or ingest.

## Documentation impact

Docs updates are required because this changes user-visible setup and ingest
behavior:

- `docs-site/content/docs/getting-started/quickstart.mdx`
- `docs-site/content/docs/cli-reference/ktx-setup.mdx`
- `docs-site/content/docs/guides/building-context.mdx`
- Any config reference page that documents `llm.provider.backend`

The docs must say that `claude-code` uses the user's own local Claude Code
session. Do not describe it as a way for KTX to resell, pool, or productize
Claude subscription limits.

## Verified evidence

- Current `KtxLlmProvider` returns AI SDK `LanguageModel` instances and only
  supports `anthropic`, `vertex`, and `gateway`
  (`packages/llm/src/types.ts`, `packages/llm/src/model-provider.ts`).
- Project config currently accepts `llm.provider.backend: none | anthropic |
  vertex | gateway` (`packages/context/src/project/config.ts`).
- `resolveAgentRunner(...)` currently requires an AI SDK `llmProvider`, and
  page triage is only constructed when that provider exists
  (`packages/context/src/ingest/local-bundle-runtime.ts`).
- Page triage and light extraction are non-agent LLM calls using
  `llmProvider.getModel("triage")` and AI SDK `generateText`
  (`packages/context/src/ingest/page-triage/page-triage.service.ts`).
- The Agent SDK TypeScript reference documents `settingSources` defaulting to
  no filesystem settings, `allowedTools` as auto-approval rather than
  restriction, `permissionMode: "dontAsk"`, `tools`, `disallowedTools`,
  `maxTurns`, `mcpServers`, `cwd`, `persistSession`, and SDK result/hook
  message shapes.
- The Agent SDK MCP docs show registering MCP servers in `query()` options and
  using `allowedTools` for MCP tool access.
- The Agent SDK skills docs say discovered skills can be controlled with the
  `skills` option and disabled with `[]`; the runtime should set this
  explicitly.

## Open items for the implementation plan

1. Confirm exact TypeScript option names and result-message discriminants
   against the pinned `@anthropic-ai/claude-agent-sdk` version.
2. Decide whether to port `ktx scan` non-agent LLM consumers in the same pass or
   fail them clearly for `claude-code` until a scan-specific plan exists.
3. Define the final `KtxGenerationPort` and `AgentRunnerPort` file locations and
   package exports.
4. Define model alias validation for `sonnet`, `opus`, `haiku`, and full model
   IDs.
5. Define the auth probe and make setup/status/doctor report actionable
   messages.
6. Write tests that prove page triage is constructed and called under
   `llm.provider.backend: claude-code`.
7. Write tests that prove a raw built-in Claude Code tool request is denied and
   only `mcp__ktx__*` tools are available during ingest.
