# Brainstorm: `claude-code` agent-runner backend for KTX

Adds a `claude-code` selection that routes KTX **agent-runner** LLM calls through `@anthropic-ai/claude-agent-sdk`, reusing the user's existing Claude Code authentication. Same KTX UX (`ktx ingest`, etc.); the backend is selected in `ktx.yaml`.

**Scope of the new backend.** The `claude-code` selection is an **agent-runner backend**, not a drop-in replacement for the global `KtxLlmProvider`. Non-agent LLM call sites (page triage, scan enrichment, scan description generation, relationship LLM proposals) all consume `KtxLlmProvider` directly via `generateKtxText` / `generateKtxObject` (`packages/context/src/ingest/page-triage/page-triage.service.ts:342-356`, `packages/context/src/scan/local-scan.ts:377-382`, `packages/context/src/scan/description-generation.ts:780-788`, `packages/context/src/scan/relationship-discovery.ts:244-255`) and `createKtxLlmProvider` currently routes any unknown backend to gateway (`packages/llm/src/model-provider.ts:155-186`). The plan must decide one of: (a) introduce `llm.provider.backend: 'claude-code'` as a global LLM backend and define behavior for every non-agent consumer (likely by mapping it to an Anthropic provider construction that also reuses local Claude Code credentials, or by failing fast with a clear error), or (b) keep `llm.provider.backend` to its existing values and add a separate `llm.agentRunner.backend` (or equivalent) field whose `'claude-code'` value only swaps the agent runner. Option (b) preserves existing non-agent behavior with no risk of accidental gateway fall-through; option (a) requires explicit handling at every non-agent site. This decision is open for the plan-writing session — the brainstorm does not lock it.

This is not a plan. It is the decided design after a `/brainstorming` session. The follow-up plan should be written separately.

## Goals

- Let a KTX user run `ktx ingest` (and the other agentic CLI paths) against their existing Claude Code session — without provisioning a new `ANTHROPIC_API_KEY` or Vertex credentials.
- Preserve KTX's per-stage tool curation: each `ktx ingest` stage continues to pass its own curated tool set into the runner; the new backend exposes exactly that set and nothing more, with **no Claude Code built-ins** (`Bash` / `Read` / `Edit` / `Write` / `Grep` / `Glob` / `WebFetch` / `Task`) reachable by the model, and **no filesystem-discovered extensions** (MCP servers, hooks, skills, plugins, agents, slash commands from `~/.claude/` or `<projectDir>/.claude/`) loaded into the session.
- Preserve correctness of existing ingest output. The new backend must produce work-unit results equivalent to today's AI-SDK backend on the same inputs, **with the explicit exception of same-step malformed-tool-call repair**: the AI-SDK backend uses `experimental_repairToolCall` (`packages/llm/src/repair.ts:35-88`); the Claude Agent SDK has no transparent same-step equivalent. For malformed tool args under the `claude-code` backend the accepted MVP behavior is next-turn self-correction (the model receives a schema error and retries on its next turn) or a clear schema-error failure surfaced through normal tool-failure counting — see Non-goals and Q5.

## Non-goals (MVP)

- **Tool-call repair parity.** Today the AI-SDK runner uses `experimental_repairToolCall` to recover from malformed tool args (extract JSON from string input, or re-prompt the repair model against the schema — see `packages/llm/src/repair.ts:35-88`). The Claude Agent SDK has no transparent same-step equivalent. MVP accepts degraded behavior: the model sees a schema error and self-corrects on the next turn.
- **OTEL telemetry.** The AI-SDK runner uses `experimental_telemetry` (`packages/context/src/agent/agent-runner.service.ts:76`). The Claude Agent SDK exposes hook events (`PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, etc.) but no native OTEL plug. MVP ships without telemetry on this backend; observability follow-up wires OTEL through hooks.
- **Promoting this backend as a productized "use your Max subscription" feature.** Per Claude Agent SDK docs ("Anthropic generally does not permit third-party developers to offer `claude.ai` login or rate limits for their products"), this is framed as "use your own local Claude Code session." Documentation and setup messaging should reflect that.
- **Embeddings.** Embeddings (`createKtxEmbeddingProvider` in `packages/llm/src/embedding-provider.ts`) are independent of the LLM backend and unaffected by this change. Claude does not provide embeddings; users keep their existing embedding config.

## Architecture

```
ktx ingest
  └─ stage-3-work-units.ts (and other stages)
      └─ deps.agentRunner.runLoop({ systemPrompt, userPrompt, toolSet, stepBudget, modelRole, … })
          │
          ├─ AgentRunnerService           (when llm.backend !== 'claude-code')
          │   uses generateText() + llmProvider.getModel(role) + experimental_repairToolCall
          │
          └─ ClaudeAgentSdkRunnerService  (when agent-runner backend === 'claude-code')
              uses @anthropic-ai/claude-agent-sdk: query({
                prompt,
                options: {
                  cwd: project.projectDir,
                  systemPrompt,
                  // SDK isolation: do NOT load user/project Claude Code settings.
                  // Omitting `settingSources` loads all sources by default, which
                  // would let `~/.claude/` MCP servers, hooks, skills, plugins,
                  // and tool permissions leak into the KTX session. Default for
                  // this backend is `settingSources: []` (filesystem settings
                  // off). If the plan later decides KTX needs `CLAUDE.md` or
                  // project settings, it must enumerate exactly which sources
                  // are loaded and re-prove that filesystem MCP/hook/skill
                  // discovery still cannot add reachable tools.
                  settingSources: [],
                  mcpServers: { ktx: createSdkMcpServer({ tools: <curated KTX tools> }) },
                  // Make ONLY KTX MCP tools reachable. Two independent layers:
                  //   1. Disable built-in tools entirely (the current SDK
                  //      surface supports this via the `tools` / built-in tool
                  //      configuration — the plan must pick the exact option
                  //      against the version it pins; the goal is that no
                  //      Bash/Read/Edit/Write/Grep/Glob/WebFetch/Task call is
                  //      possible regardless of `allowedTools`).
                  //   2. Restrict callable tools to `mcp__ktx__*`. `allowedTools`
                  //      alone is documented as an auto-approval list, not a
                  //      restriction. Candidate restriction mechanisms:
                  //        - `disallowedTools` covering each built-in name, OR
                  //        - `canUseTool` / permission mode denying anything
                  //          not prefixed `mcp__ktx__`.
                  // Both layers are required: settingSources isolation closes
                  // the filesystem-extensions hole; built-in disabling +
                  // restriction closes the in-process built-in-tools hole.
                  maxTurns: stepBudget,
                }
              })
```

The two runner classes share the public `runLoop(params: RunLoopParams): Promise<RunLoopResult>` shape (see `packages/context/src/agent/agent-runner.service.ts:13-37` for the params/result types). However, the current `AgentRunnerService` class has private members (`logger`, `deps` at `packages/context/src/agent/agent-runner.service.ts:40-42`) and the live DI types `agentRunner` as the **concrete** `AgentRunnerService` class — `IngestBundleRunnerDeps.agentRunner` at `packages/context/src/ingest/ports.ts:353` and `MemoryAgentDeps.agentRunner` at `packages/context/src/memory/types.ts:153` — so a sibling class with the same public method is **not** structurally assignable. The plan must introduce a runner **port** (e.g. `AgentRunnerPort` with `runLoop(params: RunLoopParams): Promise<RunLoopResult>`) and retype these DI fields (and any other internal callers — see grep for `: AgentRunnerService` and `agentRunner: AgentRunnerService`) to the port. Both `AgentRunnerService` and `ClaudeAgentSdkRunnerService` implement that port. Stage call-site behavior does not change. The runner is selected at the **context-runtime DI factories** that today construct `AgentRunnerService` — `resolveAgentRunner` in `packages/context/src/ingest/local-bundle-runtime.ts:580-604` for ingest, and the corresponding agent-runner construction in `packages/context/src/memory/local-memory.ts:92-110` for the memory agent. (Note: `packages/cli/src/runtime.ts` is the Python-runtime command handler, not agent-runner DI; it is **not** the integration point.)

The Claude Agent SDK is documented to reuse local Claude Code authentication automatically when the user has run `claude` to authenticate (see Verified evidence #1). No KTX-side login flow. No `ANTHROPIC_API_KEY`.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| Q1 | Same `ktx ingest`/`ktx scan`/etc. surface; backend selected via `ktx.yaml` | KTX UX stays unchanged; the new backend is invisible to the user except in config |
| Q2 | `@anthropic-ai/claude-agent-sdk` directly (not the OpenAI proxy, not `claude -p` subprocess) | Native Anthropic protocol; reuses `~/.claude/` auth; fewest hops |
| Q3 | KTX MCP tools only; Claude Code built-ins (`Bash`/`Read`/`Edit`/`Write`/`Grep`/`Glob`/`WebFetch`/`Task`) must be unreachable to the model. The exact SDK mechanism (e.g. `disallowedTools`, `tools` configuration, `canUseTool` / permission mode) is an open item for the plan — `allowedTools` alone is auto-approval, not a restriction | Preserves current ingest determinism and blast-radius limits; tool set continues to come from each stage's curated set |
| Q4 | New `ClaudeAgentSdkRunnerService` class alongside existing `AgentRunnerService`; both implement the same `runLoop` shape | Avoids polluting the AI-SDK runner with conditional dead deps; clean per-runner deps shape; both call sites in `stage-3-work-units.ts:91` etc. are untouched |
| `cwd` | Explicit `cwd: project.projectDir` (resolved at startup via `resolveKtxProjectDir`, not `process.cwd()`) | SDK's `cwd` is semantic (skills, `CLAUDE.md`, file checkpointing); KTX's existing convention is to anchor on `projectDir` regardless of invocation directory |
| Tool adapter | A backend-neutral tool boundary that preserves enough KTX tool definition data to build an SDK `tool(name, description, zodSchema, handler)` for each entry. Today `RunLoopParams.toolSet` is `Record<string, Tool>` (AI SDK type) and source-specific tools (e.g. `emit_historic_sql_evidence`) are already raw AI SDK `Tool` objects, not `BaseTool` instances (`packages/context/src/ingest/local-bundle-runtime.ts:543-556`); the runner alone cannot recover the original Zod input schema and KTX handler from those. The plan must either (a) extend the toolset port (`createIngestWuToolset`, equivalents in memory/scan toolsets) so it returns a per-tool descriptor with `name`, `description`, `inputSchema` (a Zod **object** — see schema-shape note), and the KTX handler — convertible to **either** AI SDK or Claude Agent SDK tools at the boundary — and adapt source-specific raw tools to that descriptor, or (b) require both shapes to be produced upstream. `toClaudeAgentSdkTool()` on `BaseTool` is fine for the BaseTool subset but is not sufficient on its own. **Schema-shape note:** KTX's `BaseTool.inputSchema` is typed as `ZodType` (`packages/context/src/tools/base-tool.ts:74-85`) and AI SDK accepts that directly, but the Claude Agent SDK `tool()` helper requires a raw Zod object shape (`AnyZodRawShape`), not an arbitrary `ZodType`. The descriptor contract must therefore (i) constrain `inputSchema` to a `ZodObject` (in practice all KTX tool inputs already are `z.object({...})`) and (ii) extract `.shape` at the Claude-SDK boundary. Non-object tool schemas are unsupported on this backend and must be rejected at startup with a clear error rather than silently mis-adapted. | KTX tools return `{ markdown, structured }`; Claude Agent SDK's `tool()` expects `{ content: [{ type: 'text', text }] }` — flattening `markdown` is straightforward once the underlying schema + handler are reachable |
| Q5 | MVP: degraded repair + no telemetry; both documented as known gaps | Fastest path to a working backend; correctness preserved (model self-corrects); follow-up wires both through SDK hooks if/when needed |
| Naming | Config value: `'claude-code'` | Names the user-facing thing (the Claude Code session they already authenticated); fits enum semantics (each value names an auth/API surface); avoids productizing the Max subscription |

## Implementation surface

The plan should touch (at minimum) these areas. This is a sketch, not the plan.

- **Config schema** — depending on the open scope decision (see top of doc), either (a) extend `KtxLlmBackend` in `packages/llm/src/types.ts` and explicitly handle the new value in `createKtxLlmProvider` / `createModelFactory` (`packages/llm/src/model-provider.ts:155-186`) so it does not silently fall through to gateway, **and** at every non-agent LLM consumer (page triage, scan enrichment, scan description generation, relationship LLM proposals); or (b) leave `KtxLlmBackend` alone and add a separate agent-runner backend field to `KtxProjectLlmConfig` whose `'claude-code'` value is consumed only at the agent-runner DI boundary.
- **Tool boundary** — make the per-stage toolset port return descriptors that preserve `name`, `description`, Zod input schema, and the KTX handler so either an AI SDK tool or a Claude Agent SDK `tool()` can be built at the consumer. Touch `LocalIngestToolsetFactory.createIngestWuToolset` and the memory/scan toolset equivalents (`packages/context/src/ingest/local-bundle-runtime.ts:543-556`, `packages/context/src/memory/types.ts:120-126`). Source-specific raw AI SDK tools must be wrapped to the same descriptor shape. `BaseTool.toAiSdkTool()` (`:117-165`) stays; a parallel `toClaudeAgentSdkTool()` may live alongside it but is not the whole solution.
- **Runner port** — introduce an `AgentRunnerPort` interface (e.g. in `packages/context/src/agent/`) with `runLoop(params: RunLoopParams): Promise<RunLoopResult>` and retype `IngestBundleRunnerDeps.agentRunner` (`packages/context/src/ingest/ports.ts:353`) and `MemoryAgentDeps.agentRunner` (`packages/context/src/memory/types.ts:153`) — plus any other field annotated as the concrete `AgentRunnerService` — to the port. `AgentRunnerService` and the new `ClaudeAgentSdkRunnerService` both implement the port.
- **`packages/context/src/agent/`** — add `claude-agent-sdk-runner.service.ts` exposing `ClaudeAgentSdkRunnerService` with the same `runLoop(params: RunLoopParams)` shape as `AgentRunnerService`. Internals: register the curated KTX tools via `createSdkMcpServer` and `mcpServers`, set `cwd`, `systemPrompt`, `maxTurns: stepBudget`, **set `settingSources: []`** (or whichever value the plan settles on after re-reading the SDK types — the requirement is that no user/project filesystem settings, MCP servers, hooks, skills, plugins, or slash commands are loaded), disable built-in tools, restrict reachable tools to `mcp__ktx__*` (mechanism per the open Q3 item — not `allowedTools` alone), and consume the async iterator to detect stop conditions and map onto `RunLoopResult`.
- **DI wiring** — modify `resolveAgentRunner` in `packages/context/src/ingest/local-bundle-runtime.ts:580-604` and the agent-runner construction path in `packages/context/src/memory/local-memory.ts:92-110` to branch on the resolved agent-runner backend and construct `ClaudeAgentSdkRunnerService` instead of `AgentRunnerService` when applicable. All call sites (`stage-3-work-units.ts:91`, memory agent, etc.) receive the chosen runner via DI (typed as `AgentRunnerPort`) and do not change behavior.
- **Setup / config validation** — when the user selects `claude-code` in `ktx setup`, verify that the local Claude Code SDK auth is **usable**, not just that `~/.claude/` exists. SDK docs establish that the SDK reuses authentication automatically when the user has run `claude` to authenticate; they do not establish directory probing as a sufficient liveness test. The plan must define a usability check (e.g. a minimal SDK probe call that exercises auth, an SDK-provided auth-status helper if one exists, or a documented file-presence check that the SDK docs explicitly endorse). Pure existence-of-`~/.claude/` is not sufficient on its own.
- **Docs** — `docs-site/content/docs/concepts/` and `docs-site/content/docs/getting-started/` need a section on the `claude-code` backend, framed as "use your own local Claude Code session." Avoid productizing-Max-sub language.

## Verified evidence

Findings cited during the brainstorm (each one already verified in this session):

1. **Auth reuse.** Claude Agent SDK docs (`/nothflare/claude-agent-sdk-docs` via context7): "if you have already authenticated Claude Code by running `claude` in your terminal, the SDK will use that authentication automatically."
2. **Tool config.** SDK uses `createSdkMcpServer({ name, version, tools: [tool(name, description, zodSchema, handler), ...] })` registered via `mcpServers` in `query()` options.
3. **Disabling Claude Code built-ins.** Required outcome: only the registered `mcp__<server>__<tool>` names are reachable; `Bash` / `Read` / `Edit` / `Write` / `Grep` / `Glob` / `WebFetch` / `Task` and any other built-ins must not be invocable by the model. The exact SDK option that enforces this is open and must be confirmed against current SDK docs in the plan-writing session — `allowedTools` is documented as an auto-approval list and is **not** sufficient as a restriction; candidate enforcement mechanisms are `disallowedTools`, the `tools` option, or a `canUseTool` / permission-mode callback.
3a. **Disabling filesystem-loaded extensions.** Independent of built-in tool restriction, the Claude Agent SDK loads user/project Claude Code settings (`~/.claude/`, `<projectDir>/.claude/`) by default when `settingSources` is omitted — including MCP server definitions, hooks, skills, plugins, slash commands, and tool permissions. Any of those can introduce new reachable tools, side effects, or auto-approvals into the KTX session and silently break the "exactly curated KTX tools" boundary. The backend must set `settingSources: []` (filesystem settings off) by default. If the plan later decides to opt specific sources back in (for `CLAUDE.md` or project-specific behavior), it must enumerate them and re-prove the boundary.
4. **Step budget.** `maxTurns` option in `query()` maps to KTX's `stepBudget`.
5. **`cwd` semantics.** Skill loading (`.claude/skills/`), `CLAUDE.md` discovery (when `settingSources: ['project']`), and file checkpointing all resolve relative to `cwd`. Defaults to `process.cwd()`.
6. **No transparent repair hook.** SDK hook event list: `PreToolUse | PostToolUse | PostToolUseFailure | Notification | UserPromptSubmit | SessionStart | SessionEnd | Stop | SubagentStart | SubagentStop | PreCompact | PermissionRequest`. `PostToolUseFailure` fires on execution failure, not on pre-execution malformed args.
7. **No native OTEL plug.** Telemetry must be wired manually through the above hooks.
8. **KTX tool shape today.** `packages/context/src/tools/base-tool.ts:1` imports `tool` from `ai`. Handlers return `ToolOutput<T> = { markdown: string; structured: T }`. `toAiSdkTool()` at `:117-165` flattens to `{ type: 'content', value: [{ type: 'text', text: markdown }] }`. Tools close over per-WU state via `ToolSession`.
9. **KTX repair logic is portable.** `createKtxToolCallRepairHandler` (`packages/llm/src/repair.ts:35-88`) has no AI-SDK internals dependency; it could be plumbed onto any runner that exposes a comparable hook. For MVP we accept no repair on the `claude-code` backend.
10. **Projection of `projectDir`.** `resolveKtxProjectDir` (`packages/cli/src/project-resolver.ts:34-56`) resolves once at startup from `--project-dir`, `KTX_PROJECT_DIR`, or nearest `ktx.yaml`. Tools never read `process.cwd()` at execution time (`packages/context/src/tools/*.ts` has zero `process.cwd()` calls; the only repo-wide runtime use is a fallback in `packages/context/src/connections/sqlite-query-executor.ts:67` that's reached only if `input.projectDir` is undefined).
11. **Daemon precedent.** `packages/cli/src/managed-python-daemon.ts:182-188` spawns the Python daemon without an explicit `cwd`. State paths are explicitly project-rooted (`packages/cli/src/managed-python-runtime.ts:163-174`). The Agent SDK case is different because `cwd` is semantically meaningful to the SDK, unlike the Python daemon.
12. **Runtime dir convention.** `~/.ktx/runtime/<version>/` holds shared versioned infrastructure (venv, `ktx-daemon` binary). `<projectDir>/.ktx/runtime/` holds per-project execution state. The Claude Agent SDK runner is per-project execution; it runs from `projectDir`. If the plan later introduces shared infrastructure for this backend (e.g. a vendored Claude Code binary), that infrastructure goes under `~/.ktx/runtime/<version>/`.

## Open items for the plan-writing session

Real questions the plan will need to answer that we did not lock during brainstorm:

1. **Model selection per role.** Today KTX has `KtxModelRole = 'default' | 'triage' | 'candidateExtraction' | 'curator' | 'reconcile' | 'repair'` with per-role model IDs. Claude Agent SDK's `query()` accepts a single `model` string per call. The plan needs to decide whether the `claude-code` backend (a) maps each role to a specific Claude model ID per call, (b) uses a single configured model for all roles, or (c) reads role-to-model mapping from the same `ktx.yaml` shape used by other backends. The `'repair'` role specifically is degraded under Q5=A, but the rest still need a binding strategy.
2. **Auth presence check.** Before the first `query()` call, KTX should fail fast with a clear message if the local Claude Code SDK auth is not usable. The check must be a usability test, not just `~/.claude/` directory probing — directory presence does not prove the SDK can actually authenticate (see implementation surface). The detection mechanism (SDK probe call, SDK-provided helper, or a docs-endorsed file-presence test) is open.
3. **`ktx.yaml` schema migration & non-agent LLM consumers.** Decide between the two scope options at the top of this document (global `KtxLlmBackend` extension vs. separate agent-runner backend field). If extending `KtxLlmBackend`: update zod schemas under `packages/context/src/project/`, the setup wizard (`packages/cli/src/setup-models.ts`, `packages/cli/src/commands/setup-commands.ts`), `createKtxLlmProvider` / `createModelFactory` (`packages/llm/src/model-provider.ts:155-186`), and define behavior at every non-agent LLM consumer (`packages/context/src/ingest/page-triage/page-triage.service.ts`, `packages/context/src/scan/local-scan.ts`, `packages/context/src/scan/description-generation.ts`, `packages/context/src/scan/relationship-discovery.ts`). If adding a separate field: only the setup wizard, the project zod schema, and the agent-runner DI factories need to change.
4. **Stop-reason mapping.** The Agent SDK exposes session lifecycle via the async iterator and the `Stop` hook event. The plan needs to define how a Claude Agent SDK session maps to KTX's `RunLoopStopReason = 'budget' | 'natural' | 'error'` (`agent-runner.service.ts:6`). In particular: how to detect that `maxTurns` was hit vs natural completion vs error.
5. **Tool failure counting.** `stage-3-work-units.ts:132` reads `toolFailureCount?(wu.unitKey)` to fail a WU when any tool call failed. The new runner needs to surface tool failures via the same counting mechanism. The `PostToolUseFailure` hook is the natural integration point.
