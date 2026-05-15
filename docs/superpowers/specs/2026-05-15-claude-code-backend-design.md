# Brainstorm: `claude-code` LLM backend for KTX

Adds a fourth value to `KtxLlmBackend` (alongside `'anthropic' | 'vertex' | 'gateway'`) that routes KTX agentic LLM calls through `@anthropic-ai/claude-agent-sdk`, reusing the user's existing Claude Code authentication. Same KTX UX (`ktx ingest`, etc.); the backend is selected in `ktx.yaml`.

This is not a plan. It is the decided design after a `/brainstorming` session. The follow-up plan should be written separately.

## Goals

- Let a KTX user run `ktx ingest` (and the other agentic CLI paths) against their existing Claude Code session — without provisioning a new `ANTHROPIC_API_KEY` or Vertex credentials.
- Preserve KTX's per-stage tool curation: each `ktx ingest` stage continues to pass its own `Record<string, Tool>` into the runner; the new backend exposes exactly that set and nothing more.
- Preserve correctness of existing ingest output. The new backend must produce work-unit results equivalent to today's AI-SDK backend on the same inputs.

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
          └─ ClaudeAgentSdkRunnerService  (when llm.backend === 'claude-code')
              uses @anthropic-ai/claude-agent-sdk: query({
                prompt,
                options: {
                  cwd: project.projectDir,
                  systemPrompt,
                  mcpServers: { ktx: createSdkMcpServer({ tools: toolSet -> toClaudeAgentSdkTool() }) },
                  allowedTools: ['mcp__ktx__<each-tool>'],
                  maxTurns: stepBudget,
                }
              })
```

The two runner classes share the public `runLoop(params: RunLoopParams): Promise<RunLoopResult>` shape (see `packages/context/src/agent/agent-runner.service.ts:13-37` for the interface). Stage code does not change. The CLI DI layer in `packages/cli/src/runtime.ts` selects one runner or the other based on the resolved project config.

The Claude Agent SDK authenticates from `~/.claude/` (the existing `claude login` artifacts). No KTX-side login flow. No `ANTHROPIC_API_KEY`.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| Q1 | Same `ktx ingest`/`ktx scan`/etc. surface; backend selected via `ktx.yaml` | KTX UX stays unchanged; the new backend is invisible to the user except in config |
| Q2 | `@anthropic-ai/claude-agent-sdk` directly (not the OpenAI proxy, not `claude -p` subprocess) | Native Anthropic protocol; reuses `~/.claude/` auth; fewest hops |
| Q3 | KTX MCP tools only; Claude Code built-ins (`Bash`/`Read`/`Edit`/`Write`/`Grep`/`Glob`/`WebFetch`) disabled via `allowedTools` allow-list | Preserves current ingest determinism and blast-radius limits; tool set continues to come from each stage's `buildToolSet(wu)` |
| Q4 | New `ClaudeAgentSdkRunnerService` class alongside existing `AgentRunnerService`; both implement the same `runLoop` shape | Avoids polluting the AI-SDK runner with conditional dead deps; clean per-runner deps shape; both call sites in `stage-3-work-units.ts:91` etc. are untouched |
| `cwd` | Explicit `cwd: project.projectDir` (resolved at startup via `resolveKtxProjectDir`, not `process.cwd()`) | SDK's `cwd` is semantic (skills, `CLAUDE.md`, file checkpointing); KTX's existing convention is to anchor on `projectDir` regardless of invocation directory |
| Tool adapter | New `toClaudeAgentSdkTool()` in `packages/context/src/tools/base-tool.ts` next to existing `toAiSdkTool()` (`:117-165`) | KTX tools return `{ markdown, structured }`; Claude Agent SDK's `tool()` expects `{ content: [{ type: 'text', text }] }` — trivial shim that flattens `markdown` |
| Q5 | MVP: degraded repair + no telemetry; both documented as known gaps | Fastest path to a working backend; correctness preserved (model self-corrects); follow-up wires both through SDK hooks if/when needed |
| Naming | Config value: `'claude-code'` | Names the user-facing thing (the Claude Code session they already authenticated); fits enum semantics (each value names an auth/API surface); avoids productizing the Max subscription |

## Implementation surface

The plan should touch (at minimum) these areas. This is a sketch, not the plan.

- **`packages/llm/src/types.ts`** — extend `KtxLlmBackend` from `'anthropic' | 'vertex' | 'gateway'` to add `| 'claude-code'`. Confirm that `KtxLlmConfig` and downstream consumers tolerate the new value (the `claude-code` runner will not consume the AI-SDK provider; the config path can leave fields like `apiKey` optional for this backend).
- **`packages/context/src/tools/base-tool.ts`** — add `toClaudeAgentSdkTool()` parallel to `toAiSdkTool()`. Same input (a `BaseTool` subclass with zod schema + `ToolOutput` handler), different output wrapper (returns SDK's `tool(name, description, zodSchema, handler)` with a handler that calls the underlying KTX `execute()` and converts `ToolOutput.markdown` into `{ content: [{ type: 'text', text }] }`).
- **`packages/context/src/agent/`** — add `claude-agent-sdk-runner.service.ts` exposing `ClaudeAgentSdkRunnerService` with the same `runLoop(params: RunLoopParams)` shape as `AgentRunnerService`. Internals: wrap `toolSet` via `createSdkMcpServer`, set `cwd`, `systemPrompt`, `maxTurns: stepBudget`, `allowedTools: ['mcp__ktx__<name>', ...]`, and consume the async iterator to detect stop conditions and map onto `RunLoopResult`.
- **`packages/cli/src/runtime.ts`** (or equivalent DI wiring) — branch on `project.llm.backend === 'claude-code'` to construct `ClaudeAgentSdkRunnerService` instead of `AgentRunnerService`. All call sites (`stage-3-work-units.ts:91`, memory agent, etc.) receive the chosen runner via DI and don't change.
- **Setup / config validation** — when the user selects `claude-code` in `ktx setup`, detect whether `~/.claude/` is populated (i.e. whether `claude login` has been run) and surface a clear error if not. Exact detection mechanism is an implementation detail for the plan.
- **Docs** — `docs-site/content/docs/concepts/` and `docs-site/content/docs/getting-started/` need a section on the `claude-code` backend, framed as "use your own local Claude Code session." Avoid productizing-Max-sub language.

## Verified evidence

Findings cited during the brainstorm (each one already verified in this session):

1. **Auth reuse.** Claude Agent SDK docs (`/nothflare/claude-agent-sdk-docs` via context7): "if you have already authenticated Claude Code by running `claude` in your terminal, the SDK will use that authentication automatically."
2. **Tool config.** SDK uses `createSdkMcpServer({ name, version, tools: [tool(name, description, zodSchema, handler), ...] })` registered via `mcpServers` in `query()` options. `allowedTools` controls which tool names the agent may call.
3. **Disabling Claude Code built-ins.** Set `allowedTools` to the list of `mcp__<server>__<tool>` names; do not opt into the `'claude_code'` preset for `tools` or `systemPrompt`. Default is open; this is required.
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
2. **Auth presence check.** Before the first `query()` call, KTX should fail fast with a clear message if `~/.claude/` does not contain valid Claude Code credentials. The detection mechanism (file probe, SDK probe call, etc.) is open.
3. **`ktx.yaml` schema migration.** Adding `'claude-code'` to the enum is a config schema change. The plan needs to update any config validation (zod schemas under `packages/context/src/project/`) and the setup wizard (`packages/cli/src/setup-models.ts`) to surface the new choice.
4. **Stop-reason mapping.** The Agent SDK exposes session lifecycle via the async iterator and the `Stop` hook event. The plan needs to define how a Claude Agent SDK session maps to KTX's `RunLoopStopReason = 'budget' | 'natural' | 'error'` (`agent-runner.service.ts:6`). In particular: how to detect that `maxTurns` was hit vs natural completion vs error.
5. **Tool failure counting.** `stage-3-work-units.ts:132` reads `toolFailureCount?(wu.unitKey)` to fail a WU when any tool call failed. The new runner needs to surface tool failures via the same counting mechanism. The `PostToolUseFailure` hook is the natural integration point.
