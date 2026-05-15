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
  commands must not become invokable in KTX agent loops. The Agent SDK init
  message may still report host-discovered slash commands, skills, and agents;
  KTX treats that metadata as diagnostic only and restricts execution through
  `tools: []`, exact KTX MCP `allowedTools`, `disallowedTools`, and
  deny-by-default `canUseTool`.
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
    tools: [],
    allowedTools: [/* exact mcp__ktx__<toolName> ids generated from the tool map */],
    canUseTool: ktxCanUseTool,
    permissionMode: "dontAsk",
    persistSession: false,
    env: ktxClaudeCodeEnv
  }
});
```

`ktxClaudeCodeEnv` is the controlled environment described in
"Agent SDK environment and auth boundary" below; it must be passed on every
KTX `query()` call.

For plain text generation:

- Use the same `query()` runtime with `maxTurns: 1`.
- Pass `settingSources: []`, `skills: []`, `plugins: []`, `tools: []`,
  `permissionMode: "dontAsk"`, `persistSession: false`, and
  `env: ktxClaudeCodeEnv`.
- Do not expose MCP tools unless the KTX call explicitly passed tools.
- Return the final result message text.

For structured object generation:

- Use the same `query()` runtime with the Agent SDK structured output option
  for JSON schema output, plus the same isolation tuple including
  `env: ktxClaudeCodeEnv`.
- Convert KTX Zod schemas at the runtime boundary.
- Parse and validate the returned object with the original KTX schema before
  returning it to the caller.

The plan must confirm the exact option names against the pinned SDK version, but
the required outcome is fixed:

- Filesystem settings are not loaded. The SDK's documented default for an
  omitted `settingSources` is `["user", "project", "local"]`
  (`@anthropic-ai/claude-agent-sdk@0.3.142` `sdk.d.ts:1686-1695`),
  which would inherit the user's Claude Code filesystem settings. Every KTX
  `query()` call site - agent loops, text generation, object generation, and
  the auth probe - MUST pass `settingSources: []` explicitly, along with
  `skills: []`, `plugins: []`, `tools: []`, `persistSession: false`, and no
  `mcpServers` entries other than the KTX MCP server (omitted entirely when
  the call site does not expose tools). The implementation MUST assert from
  the SDK init message that the controlled execution surface matches KTX's
  expectations:

  - `message.tools` equals the exact generated KTX MCP tool ids for the current
    call.
  - `message.mcp_servers` equals the expected KTX MCP server set: `[]` when the
    call exposes no tools, or `["ktx"]` when it does.
  - `message.plugins` is empty.

  The implementation MUST NOT reject a run solely because
  `message.slash_commands`, `message.skills`, or `message.agents` contain
  host-discovered names. In `@anthropic-ai/claude-agent-sdk@0.3.142`, those
  fields can report host discovery even when KTX passes the isolation options.
  They are not part of the KTX execution surface when `tools: []`,
  `allowedTools`, `disallowedTools`, and deny-by-default `canUseTool` are set.
- `skills: []` is a context filter in the pinned SDK
  (`sdk.d.ts:1697-1718`): unlisted skills are hidden from the model's skill
  listing and rejected by the Skill tool, but discovered skill names may still
  appear in init metadata. KTX must still pass `skills: []`.
- Plugins are disabled with `plugins: []`, and the runtime asserts that
  `message.plugins` is empty in the init message.
- Built-in tools are disabled by setting `tools: []`. The pinned SDK type
  (`@anthropic-ai/claude-agent-sdk@0.3.142`, `sdk.d.ts`) documents `tools` as
  the base set of built-in tools, with `[]` meaning "disable all built-ins";
  `tools` does not accept MCP tool ids and cannot be used to restrict MCP
  availability.
- MCP tool availability is granted by registering the KTX MCP server through
  `mcpServers`. The SDK does not document a wildcard like `mcp__ktx__*` for
  any tool field; KTX must enumerate exact generated MCP tool ids of the form
  `mcp__ktx__<toolName>` (derived from the tool map handed to
  `createSdkMcpServer`) wherever a list of tool ids is required.
- Pre-approval under `permissionMode: "dontAsk"` is configured by listing those
  same exact `mcp__ktx__<toolName>` ids in `allowedTools` (documented as
  auto-allow without prompting). Treat `allowedTools` as auto-approval, not
  restriction.
- Defense-in-depth restriction uses `canUseTool`. The KTX runtime supplies a
  `canUseTool` handler that allows only tool names in the current KTX MCP tool
  map and denies everything else, so host-discovered slash commands, skills,
  agents, future SDK defaults, or a misconfigured MCP server cannot expand the
  execution surface.
- `disallowedTools` MUST additionally list the current built-in tool names
  (`Agent`, `Task`, `AskUserQuestion`, `Bash`, `Read`, `Edit`, `Write`, `Glob`,
  `Grep`, `WebFetch`, `WebSearch`, `TodoWrite`) as redundant insurance.
- `cwd` is `project.projectDir`, resolved at startup via `resolveKtxProjectDir`,
  not `process.cwd()`.
- Sessions are not persisted unless the plan identifies a concrete debugging
  feature that needs persistence.

## Agent SDK environment and auth boundary

The Agent SDK's `query()` option `env` (`@anthropic-ai/claude-agent-sdk@0.3.142`
`sdk.d.ts:1265-1279`) is the environment passed to the Claude Code child
process and defaults to `process.env`. Without an explicit `env`, the SDK
inherits the parent's environment, including any `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, gateway/AI-Gateway tokens,
`GOOGLE_APPLICATION_CREDENTIALS` / `CLOUD_ML_REGION` (Vertex), and
`AWS_*` (Bedrock) credentials — any of which can switch the Claude Code CLI's
authentication source to API-key or another provider, bypassing the user's
local Claude Code session. That would silently violate the core requirement
that `claude-code` runs through the user's existing local Claude Code session
and that there is no silent fallback to gateway, Anthropic API-key, or other
provider execution.

Every `claude-code` `query()` call site - agent loops, text generation,
object generation, and the auth probe - MUST pass an explicit `env`
(`ktxClaudeCodeEnv`) constructed from `process.env` with the following
denylist removed:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_MODEL` (provider-routing override)
- `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
  `AWS_REGION`, `AWS_PROFILE`
- `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`
- Any future provider-routing variables the pinned SDK version documents

The denylist is the source of truth and lives next to the runtime constructor
so adding a variable is a single-file change.

Acceptance criteria:

- The constructed `ktxClaudeCodeEnv` does not contain any denylisted key, and
  this is verified by a unit test that seeds each denylisted key in a fake
  `process.env`.
- The auth probe fails with the same "authenticate Claude Code locally"
  message even when `ANTHROPIC_API_KEY` (or any other denylisted credential)
  is present in `process.env` and no valid local Claude Code session exists.
- Every KTX-originated `query()` invocation is spied to assert that `env`
  was passed and that it does not contain any denylisted key; the test fails
  if any code path falls back to the SDK default `process.env`.
- The "no silent fallback" rule is preserved end-to-end: a machine with
  `ANTHROPIC_API_KEY` set but no local Claude Code authentication still fails
  setup/status/doctor on `claude-code`.

## Tool boundary

Agent-loop tools cannot remain only raw AI SDK `Record<string, Tool>` values if
two backends must consume them. The plan must define a backend-neutral tool
descriptor for the final tool map handed to an agent loop:

```ts
interface KtxRuntimeToolDescriptor<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  execute(input: TInput): Promise<KtxRuntimeToolOutput<TOutput>>;
}

interface KtxRuntimeToolOutput<TOutput> {
  // What the model sees as the tool_result content. Always a markdown string;
  // never a raw JS object. This matches BaseTool's existing
  // `toModelOutput` contract (`packages/context/src/tools/base-tool.ts:154-162`)
  // which sends only markdown to the LLM.
  markdown: string;
  // Out-of-band payload preserved for tool callers (transcripts, debug,
  // verification ledger, downstream KTX consumers). Not sent to the model.
  structured?: TOutput;
}
```

Every composed tool entry must produce this descriptor shape, including:

- `BaseTool` outputs from factory toolsets, which already return
  `{ markdown, structured }`.
- Source-specific raw tools such as `emit_historic_sql_evidence` in
  `packages/context/src/ingest/local-bundle-runtime.ts`.
- Stage-local tools in `buildWuToolSet` and `buildReconcileToolSet`.
- Inline `load_skill`, read/raw/span, stage/diff, eviction, and emit tools in
  `packages/context/src/ingest/ingest-bundle.runner.ts`.
- Memory-agent `load_skill` in
  `packages/context/src/memory/memory-agent.service.ts`.
- The `withVerificationLedger` wrapping layer, whose markdown/structured
  guard outputs (`packages/context/src/ingest/tools/verification-ledger.tool.ts:40-97`)
  already match the contract.

### Tool output contract

The runtime defines a single output contract for both backends so the model
sees the same content regardless of provider:

- **Model-visible content**: the `markdown` field, mapped to the Agent SDK
  tool handler return as `{ content: [{ type: "text", text: markdown }] }` for
  `claude-code`, and surfaced through the existing `toModelOutput` markdown
  path for AI SDK backends. The model never sees raw JS objects.
- **Structured payload**: the optional `structured` field, preserved on the
  in-process tool-result envelope for transcript/debug capture, the
  verification ledger, and any KTX caller that introspects results. The
  Claude adapter does not put structured JSON into model-visible content
  unless an individual call site explicitly opts in.
- **Normalization of existing raw tools**: tools that today return a bare
  string (e.g. `load_skill` "Skill not available" responses in
  `packages/context/src/ingest/ingest-bundle.runner.ts:697-721` and
  `:924-936`, and `packages/context/src/memory/memory-agent.service.ts:128-152`)
  must be wrapped at the descriptor boundary so `markdown` is the string and
  `structured` is omitted. Tools that today return a plain object (e.g.
  skill payload `{ name, content, skillDirectory }`) must be wrapped so
  `markdown` is a deterministic human-readable rendering (e.g. the skill
  body with a header) and the original object is preserved on `structured`.
  No KTX tool may return a raw object as the model-visible payload on the
  Claude Code backend, because the Agent SDK MCP handler will otherwise
  stringify it and drop the structured fields.
- **AI SDK parity**: the AI SDK adapter MUST preserve BaseTool's existing
  `toModelOutput` markdown-only behavior. Migrating BaseTool-derived tools
  to the descriptor must not start sending structured JSON to the model.

The AI SDK adapter converts descriptors to `tool(...)` with a `toModelOutput`
that emits `markdown` only. The Claude Code adapter converts descriptors to
Agent SDK `tool(name, description, schema.shape, handler)` entries inside
`createSdkMcpServer(...)` and returns `{ content: [{ type: "text", text:
markdown }] }`.

Non-object schemas are unsupported for `claude-code` and must be rejected at
startup with a clear error. In practice KTX tool inputs are already `z.object`.

## Stop reasons and failures

The Claude runner maps the SDK's typed `SDKResultMessage` (union of
`SDKResultSuccess` and `SDKResultError` in
`@anthropic-ai/claude-agent-sdk@0.3.142`, `sdk.d.ts`) to
`RunLoopStopReason = "budget" | "natural" | "error"`. The mapping must consider
three typed signals in this precedence order, because each successive signal
may be present where the previous one is absent:

1. `subtype`: `"error_max_turns"` -> `"budget"`; `"success"` -> `"natural"`;
   other error subtypes (`"error_during_execution"`,
   `"error_max_budget_usd"`, `"error_max_structured_output_retries"`) ->
   `"error"`.
2. `terminal_reason` (optional `TerminalReason` field on both success and
   error results): `"max_turns"` -> `"budget"`; `"completed"` -> `"natural"`;
   any other terminal reason such as `"blocking_limit"`,
   `"rapid_refill_breaker"`, `"prompt_too_long"`, `"image_error"`,
   `"model_error"`, `"aborted_streaming"`, `"aborted_tools"`,
   `"stop_hook_prevented"`, `"hook_stopped"`, or `"tool_deferred"` ->
   `"error"`.
3. The assistant message `stop_reason`: `"max_turns"` -> `"budget"`; any
   other non-null unsuccessful stop reason -> `"error"`.

A `max_turns` signal arriving through any of the three sources must map to
`"budget"`; the runner MUST NOT classify a max-turn termination as
`"natural"` or as a generic `"error"` because it was reported via
`terminal_reason` instead of `subtype`.

`Stop` hooks are not the authoritative stop-reason source because they do not
carry the terminal reason. They remain useful for lifecycle logging. Tool failure
counting should use `PostToolUseFailure` and feed the same mechanism that
`stage-3-work-units.ts` checks through `toolFailureCount?(wu.unitKey)`.

For text and object generation, SDK authentication, billing, rate-limit,
permission, max-turn, structured-output, and execution errors must map to the
same error surfaces that KTX uses for the Anthropic API-key backend.

## Agent-loop progress callbacks

`RunLoopParams.onStepFinish`
(`packages/context/src/agent/agent-runner.service.ts:20`) is part of the
current agent-loop contract. The AI SDK runner increments `stepIndex` on each
`generateText` step and invokes the callback
(`agent-runner.service.ts:83-97`). KTX consumers depend on this:
`packages/context/src/ingest/ingest-bundle.runner.ts:782` emits
`work_unit_step` events from it, and `:1036` / `:1089` update reconciliation
progress for the user-visible "Reconciling results · step N" status.

The `claude-code` runner MUST preserve `onStepFinish` semantics:

- It MUST invoke `onStepFinish` exactly once per assistant turn (i.e. once per
  step the SDK reports), incrementing `stepIndex` starting at 1.
- The plan MUST name the concrete SDK stream event used as the step boundary
  (the implementation plan picks one of the documented assistant/result
  message events from the pinned SDK version and justifies it). The chosen
  event must produce the same `stepIndex` count as the AI SDK runner for an
  equivalent run: N tool-using turns yield N callbacks.
- Callback errors MUST be caught and logged at `warn` level without aborting
  the loop, matching `agent-runner.service.ts:90-96`.
- `stepBudget` passed to the callback MUST equal the `maxTurns` configured on
  the SDK `query()` call.

Acceptance criteria:

- A `claude-code` agent loop run with `stepBudget: N` produces N
  `work_unit_step` events when the loop runs to budget.
- A reconciliation run under `claude-code` produces the same
  `updateProgress` calls (count and `stepIndex / stepBudget` ratio) as the
  Anthropic API-key backend for an equivalent fixture.
- An `onStepFinish` callback that throws does not surface the error as the
  loop result.

## Prompt caching parity

`packages/llm/src/types.ts:44, :61` exposes `llm.promptCaching` as a config
field, and the AI SDK message builder
(`packages/llm/src/message-builder.ts:62-114, :141-218`) applies
`anthropic.cacheControl: { type: "ephemeral", ttl }` markers to the system
message, the last history message, and sorted tools, with TTLs split into
`systemTtl`, `toolsTtl`, and `historyTtl`. `model-provider.test.ts:276`
verifies caching is enabled by default with those three TTLs.

The Agent SDK does not expose KTX's marker-based contract. The closest
mechanism is `systemPrompt: string[]` with
`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (`sdk.d.ts:1746-1799`), which marks a static
prefix as cacheable but provides no per-tool, per-history, or per-TTL knobs.

For the `claude-code` backend, the spec treats `llm.promptCaching` as
**partial parity**:

- The Claude runtime MAY map a non-empty static system prefix to a cacheable
  `systemPrompt` array using `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` when
  `cacheSystem` is enabled in the resolved `KtxPromptCachingConfig`. The
  implementation plan decides whether to ship this mapping in the first pass
  or defer it.
- `cacheTools`, `cacheHistory`, and the `systemTtl` / `toolsTtl` /
  `historyTtl` fields have no Agent SDK equivalent. The runtime MUST NOT
  silently drop them: when a user sets non-default values under
  `llm.promptCaching` and the backend is `claude-code`, status/doctor and the
  setup wizard MUST surface that these fields are ignored on this backend.
- Docs under `docs-site/content/docs/` MUST document this divergence in the
  same pages that describe `claude-code` setup, so users do not assume the
  TTL/tool/history knobs apply.

Acceptance criteria:

- A `claude-code` runtime constructed from a config with default
  `promptCaching` does not throw and does not pass KTX `cacheControl`
  markers to the Agent SDK (the AI-SDK-only markers stay on the AI SDK
  path).
- A `claude-code` runtime constructed from a config with non-default
  `promptCaching` values yields a warning surfaced through doctor/status
  output identifying the ignored fields.

## Auth and setup

`ktx setup`, status, and doctor flows must validate that Claude Code SDK auth is
usable, not just that `~/.claude/` exists. Acceptable validation strategies:

- A minimal SDK probe call with `settingSources: []`, `skills: []`,
  `plugins: []`, `tools: []`, `persistSession: false`, no `mcpServers`,
  `env: ktxClaudeCodeEnv`, and `maxTurns: 1`. The probe MUST NOT rely on
  the SDK's documented default for any of these fields, because the default
  for `settingSources` is `["user", "project", "local"]` (loads filesystem
  settings) and the default for `env` is `process.env` (can route auth
  through `ANTHROPIC_API_KEY` or other provider credentials and hide a
  missing local Claude Code session). See "Agent SDK environment and auth
  boundary" above for the `env` denylist.
  The auth probe MUST tolerate init messages with non-empty `slash_commands`,
  `skills`, and `agents` when `message.tools` is empty, `message.mcp_servers`
  is empty, `message.plugins` is empty, and the query options contain the KTX
  isolation tuple. Host discovery metadata is not an auth failure.
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
- The Agent SDK TypeScript reference (`@anthropic-ai/claude-agent-sdk@0.3.142`,
  `sdk.d.ts:1690-1697` and the `sdk.mjs` runtime default
  `["user","project","local"]`) documents `settingSources` **defaulting to
  loading user, project, and local filesystem settings** when omitted; passing
  `[]` is the explicit opt-out ("SDK isolation mode"). The same reference
  documents `allowedTools` as auto-approval rather than restriction,
  `canUseTool` as the programmatic permission handler,
  `permissionMode: "dontAsk"`, `tools` as the base built-in set with `[]`
  meaning "disable all built-ins" and no MCP-id support, `disallowedTools`,
  `maxTurns`, `mcpServers`, `cwd`, `persistSession`, and SDK result/hook
  message shapes.
- `SDKResultMessage = SDKResultSuccess | SDKResultError` in
  `@anthropic-ai/claude-agent-sdk@0.3.142` (`sdk.d.ts`); both variants expose
  an optional `terminal_reason: TerminalReason`, where `TerminalReason`
  includes `'max_turns' | 'completed'` alongside other terminal reasons.
- The Agent SDK MCP docs and SDK examples (e.g. Context7
  `/nothflare/claude-agent-sdk-docs` custom-tools guide) show registering MCP
  servers in `query()` options and listing exact `mcp__<server>__<tool>` ids
  in `allowedTools`; no SDK doc or type currently documents a wildcard form.
- BaseTool's `toModelOutput` already sends only `markdown` to the model while
  preserving structured output for callers
  (`packages/context/src/tools/base-tool.ts:154-162`); some raw AI SDK tools
  in `packages/context/src/ingest/ingest-bundle.runner.ts:697-721, :924-936`
  and `packages/context/src/memory/memory-agent.service.ts:128-152` currently
  return bare strings or plain objects and must be normalized at the
  descriptor boundary so both backends preserve the contract.
- The Agent SDK skills docs say the `skills` option is a context filter rather
  than a sandbox. KTX must pass `skills: []`, but must not assert that
  `message.skills` is empty in the SDK init message.
- `Options.env` in `@anthropic-ai/claude-agent-sdk@0.3.142`
  (`sdk.d.ts:1265-1279`) is the environment passed to the Claude Code
  process and defaults to `process.env`. Without an explicit `env`, the SDK
  inherits the parent environment, including any provider-routing variables
  (`ANTHROPIC_API_KEY`, Vertex/Bedrock credentials, gateway tokens) that
  could change the active authentication source of the Claude Code CLI and
  hide a missing local Claude Code session.

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
8. Write tests proving a raw built-in Claude Code tool request is denied,
   host-discovered Skill/Agent/SlashCommand requests are denied by `canUseTool`,
   and only exact `mcp__ktx__*` tools are allowed during KTX agent loops.
9. Write a test that asserts every KTX-originated `query()` invocation
   (agent loop, text generation, object generation, auth probe) is called
   with `settingSources: []`, `skills: []`, `plugins: []`, `tools: []`, and
   `persistSession: false`, by spying on the SDK entry point. The test must
   fail if any path falls back to SDK defaults for those fields. The test must
   also prove that non-empty host-discovered `slash_commands`, `skills`, and
   `agents` in the init message do not fail the auth probe or runtime when the
   controlled tool, MCP server, and plugin surfaces match KTX expectations.
10. Write a test that asserts `onStepFinish` is invoked the expected number
    of times for a fixed-budget `claude-code` agent loop, including the
    work-unit and reconciliation progress paths.
11. Write a test that asserts every KTX-originated `query()` invocation
    (agent loop, text generation, object generation, auth probe) is called
    with an explicit `env` and that none of the denylisted provider-routing
    variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
    `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_VERTEX_PROJECT_ID`,
    `CLOUD_ML_REGION`, `GOOGLE_APPLICATION_CREDENTIALS`,
    `GOOGLE_CLOUD_PROJECT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
    `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_PROFILE`,
    `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`) are present in
    that env, by seeding each variable in a fake `process.env`. The test
    must also assert that the auth probe still fails when
    `ANTHROPIC_API_KEY` is set in `process.env` but no local Claude Code
    session exists.
