# Claude Code Backend V1 Isolation Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining v1-blocking Claude Code backend gaps around SDK
init isolation assertions and setup-time prompt-caching warnings.

**Architecture:** Keep the existing runtime port and Claude Code runtime. Add
the missing init-message checks inside the Claude runtime, then share the
prompt-caching warning formatter between status/doctor and setup so all
user-facing readiness flows report ignored Claude Code cache knobs consistently.

**Tech Stack:** TypeScript, pnpm, Vitest, Zod, `@anthropic-ai/claude-agent-sdk@0.3.142`.

---

## Audit Summary

The May 15 Claude Code backend v1 plan is mostly implemented. Remaining
v1-blocking gaps from the original spec are:

- `packages/context/src/llm/claude-code-runtime.ts` asserts init-message tools,
  slash commands, skills, and plugins, but does not assert `agents` or
  unexpected `mcp_servers`. The spec requires asserting that settings-derived
  commands, skills, agents, plugins, and MCP servers are inactive.
- `packages/cli/src/setup-models.ts` validates Claude Code auth but does not
  surface ignored `llm.promptCaching` fields during setup. The spec requires
  setup, status, and doctor to surface ignored prompt-caching fields for the
  `claude-code` backend. Status and doctor already warn.

Non-blocking gaps:

- Same-step tool-call repair parity remains out of scope for v1.
- OTEL telemetry parity remains out of scope for v1.
- Embedding parity remains out of scope because embeddings are configured
  independently.
- Full prompt-caching parity for tools, history, and per-section TTLs remains
  out of scope; v1 only needs explicit warnings and no AI SDK cache markers on
  the Claude Code path.

## File Structure

Modify these files:

- `packages/context/src/llm/claude-code-runtime.ts` adds complete init-message
  isolation checks for agents and MCP servers.
- `packages/context/src/llm/claude-code-runtime.test.ts` adds regression tests
  for rejected agents/MCP servers, object/agent env scrubbing, and callback
  error handling.
- `packages/cli/src/claude-code-prompt-caching.ts` is created as the shared
  formatter for ignored prompt-caching fields.
- `packages/cli/src/status-project.ts` imports the shared formatter instead of
  keeping a local helper.
- `packages/cli/src/setup-models.ts` emits the shared warning when setup saves
  `llm.provider.backend: claude-code` and existing prompt-caching fields are
  present.
- `packages/cli/src/setup-models.test.ts` covers setup warning output.
- `packages/cli/src/doctor.test.ts` keeps coverage for doctor output using the
  shared formatter.

### Task 1: Complete Claude Code init isolation checks

**Files:**

- Modify: `packages/context/src/llm/claude-code-runtime.test.ts`
- Modify: `packages/context/src/llm/claude-code-runtime.ts`

- [ ] **Step 1: Add failing isolation and runtime behavior tests**

Add these tests inside `describe('ClaudeCodeKtxLlmRuntime', ...)` in
`packages/context/src/llm/claude-code-runtime.test.ts`:

```ts
  it('rejects settings-derived agents and non-KTX MCP servers from init messages', async () => {
    const query = vi.fn((_input: any) =>
      stream([
        initMessage({
          agents: ['project-agent'],
          mcp_servers: [{ name: 'filesystem', status: 'connected' }],
        }),
        resultMessage({ result: 'hello' }),
      ]),
    );
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
    });

    await expect(runtime.generateText({ role: 'default', prompt: 'say hello' })).rejects.toThrow(
      /Claude Code runtime isolation failed: .*mcp_servers=filesystem.*agents=project-agent/,
    );
  });

  it('passes scrubbed env to object generation and agent loops', async () => {
    const schema = z.object({ answer: z.string() });
    const objectQuery = vi.fn((_input: any) =>
      stream([initMessage(), resultMessage({ structured_output: { answer: 'yes' } })]),
    );
    const objectRuntime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query: objectQuery,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test', AWS_PROFILE: 'prod', PATH: '/usr/bin' }, // pragma: allowlist secret
    });

    await expect(objectRuntime.generateObject({ role: 'default', prompt: 'json', schema })).resolves.toEqual({
      answer: 'yes',
    });
    expect(objectQuery.mock.calls[0][0].options.env).toEqual(
      expect.objectContaining({ PATH: '/usr/bin' }),
    );
    expect(objectQuery.mock.calls[0][0].options.env).not.toEqual(
      expect.objectContaining({ ANTHROPIC_API_KEY: 'sk-ant-test', AWS_PROFILE: 'prod' }), // pragma: allowlist secret
    );

    const agentQuery = vi.fn((_input: any) =>
      stream([
        initMessage({ tools: ['mcp__ktx__load_skill'], mcp_servers: [{ name: 'ktx', status: 'connected' }] }),
        {
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          parent_tool_use_id: null,
          uuid: '00000000-0000-4000-8000-000000000004',
          session_id: 'session-id',
        } as unknown as SDKMessage,
        resultMessage({ subtype: 'error_max_turns', is_error: true }),
      ]),
    );
    const agentRuntime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query: agentQuery,
      env: { ANTHROPIC_AUTH_TOKEN: 'token', CLAUDE_CODE_USE_VERTEX: '1', HOME: '/Users/test' },
    });

    await agentRuntime.runAgentLoop({
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
    });
    expect(agentQuery.mock.calls[0][0].options.env).toEqual(expect.objectContaining({ HOME: '/Users/test' }));
    expect(agentQuery.mock.calls[0][0].options.env).not.toEqual(
      expect.objectContaining({ ANTHROPIC_AUTH_TOKEN: 'token', CLAUDE_CODE_USE_VERTEX: '1' }),
    );
  });

  it('logs and ignores onStepFinish callback errors', async () => {
    const query = vi.fn((_input: any) =>
      stream([
        initMessage(),
        {
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          parent_tool_use_id: null,
          uuid: '00000000-0000-4000-8000-000000000005',
          session_id: 'session-id',
        } as unknown as SDKMessage,
        resultMessage({ subtype: 'success', terminal_reason: 'completed' }),
      ]),
    );
    const logger = {
      debug: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
      logger,
    });

    await expect(
      runtime.runAgentLoop({
        modelRole: 'default',
        systemPrompt: 'system',
        userPrompt: 'user',
        toolSet: {},
        stepBudget: 1,
        telemetryTags: { operationName: 'test' },
        onStepFinish: async () => {
          throw new Error('callback exploded');
        },
      }),
    ).resolves.toEqual({ stopReason: 'natural' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('callback exploded'));
  });
```

- [ ] **Step 2: Run the Claude runtime test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/llm/claude-code-runtime.test.ts
```

Expected: FAIL because the new agents/MCP-server isolation test resolves
successfully instead of throwing.

- [ ] **Step 3: Add expected MCP server metadata and complete init assertions**

In `packages/context/src/llm/claude-code-runtime.ts`, replace
`assertInitIsolation` and add the helper below it:

```ts
function assertInitIsolation(
  message: SDKMessage,
  allowedToolIds: Set<string>,
  expectedMcpServerNames: Set<string>,
): void {
  if (message.type !== 'system' || message.subtype !== 'init') {
    return;
  }
  const unexpectedTools = message.tools.filter((toolName) => !allowedToolIds.has(toolName));
  const activeMcpServerNames = message.mcp_servers.map((server) => server.name);
  const unexpectedMcpServers = activeMcpServerNames.filter((name) => !expectedMcpServerNames.has(name));
  const missingMcpServers = [...expectedMcpServerNames].filter((name) => !activeMcpServerNames.includes(name));
  const unexpectedAgents = message.agents ?? [];
  if (
    unexpectedTools.length > 0 ||
    unexpectedMcpServers.length > 0 ||
    missingMcpServers.length > 0 ||
    message.slash_commands.length > 0 ||
    message.skills.length > 0 ||
    message.plugins.length > 0 ||
    unexpectedAgents.length > 0
  ) {
    throw new Error(
      `Claude Code runtime isolation failed: tools=${unexpectedTools.join(',') || '(none)'} mcp_servers=${
        unexpectedMcpServers.join(',') || '(none)'
      } missing_mcp_servers=${missingMcpServers.join(',') || '(none)'} slash_commands=${
        message.slash_commands.length
      } skills=${message.skills.length} plugins=${message.plugins.length} agents=${
        unexpectedAgents.join(',') || '(none)'
      }`,
    );
  }
}

function expectedMcpServerNames(tools: KtxRuntimeToolSet | undefined): Set<string> {
  return tools && Object.keys(tools).length > 0 ? new Set(['ktx']) : new Set();
}
```

Update `collectResult` parameters:

```ts
async function collectResult(params: {
  query: QueryFn;
  prompt: string;
  options: Options;
  allowedToolIds: Set<string>;
  expectedMcpServerNames: Set<string>;
  onAssistantTurn?: () => Promise<void>;
}): Promise<SDKResultMessage> {
  let result: SDKResultMessage | undefined;
  for await (const message of params.query({ prompt: params.prompt, options: params.options })) {
    assertInitIsolation(message, params.allowedToolIds, params.expectedMcpServerNames);
```

Update the four `collectResult(...)` calls:

```ts
    const tools = input.tools ?? {};
    const result = await collectResult({
      query: this.runQuery,
      prompt: [input.system, input.prompt].filter(Boolean).join('\n\n'),
      options,
      allowedToolIds: new Set(mcpToolIds(tools)),
      expectedMcpServerNames: expectedMcpServerNames(input.tools),
    });
```

For `runAgentLoop(...)`, use:

```ts
      const result = await collectResult({
        query: this.runQuery,
        prompt: params.userPrompt,
        options: { ...options, systemPrompt: params.systemPrompt },
        allowedToolIds: new Set(mcpToolIds(params.toolSet)),
        expectedMcpServerNames: expectedMcpServerNames(params.toolSet),
        onAssistantTurn: async () => {
```

For `runClaudeCodeAuthProbe(...)`, use:

```ts
    const result = await collectResult({
      query: input.query ?? defaultQuery,
      prompt: 'Reply with exactly: ok',
      options,
      allowedToolIds: new Set(),
      expectedMcpServerNames: new Set(),
    });
```

- [ ] **Step 4: Run the Claude runtime test to verify it passes**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/llm/claude-code-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/context/src/llm/claude-code-runtime.ts packages/context/src/llm/claude-code-runtime.test.ts
git commit -m "fix: close claude-code runtime isolation checks"
```

### Task 2: Surface Claude Code prompt-caching warnings during setup

**Files:**

- Create: `packages/cli/src/claude-code-prompt-caching.ts`
- Modify: `packages/cli/src/status-project.ts`
- Modify: `packages/cli/src/setup-models.ts`
- Modify: `packages/cli/src/setup-models.test.ts`
- Modify: `packages/cli/src/doctor.test.ts`

- [ ] **Step 1: Add failing setup warning test**

Add this test to `packages/cli/src/setup-models.test.ts`:

```ts
  it('warns during Claude Code setup when existing prompt-caching fields will be ignored', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-6',
        '  promptCaching:',
        '    enabled: true',
        '    systemTtl: 1h',
        '    toolsTtl: 1h',
        '    historyTtl: 5m',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'claude-code',
        skipLlm: false,
      },
      io.io,
      {
        claudeCodeAuthProbe: async () => ({ ok: true as const }),
      },
    );

    expect(result.status).toBe('ready');
    expect(io.stderr()).toContain('claude-code ignores llm.promptCaching.systemTtl');
    expect(io.stderr()).toContain('Claude Agent SDK does not expose KTX prompt-cache TTL, tool, or history markers');
  });
```

- [ ] **Step 2: Run setup tests to verify the new test fails**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-models.test.ts
```

Expected: FAIL because setup does not emit the ignored prompt-caching warning.

- [ ] **Step 3: Create the shared prompt-caching warning helper**

Create `packages/cli/src/claude-code-prompt-caching.ts`:

```ts
import type { KtxProjectLlmConfig } from '@ktx/context/project';

const CLAUDE_CODE_IGNORED_PROMPT_CACHING_FIELDS = [
  'systemTtl',
  'toolsTtl',
  'historyTtl',
  'vertexFallbackTo5m',
] as const;

export function ignoredClaudeCodePromptCachingFields(config: KtxProjectLlmConfig): string[] {
  if (config.provider.backend !== 'claude-code' || !config.promptCaching) {
    return [];
  }
  return CLAUDE_CODE_IGNORED_PROMPT_CACHING_FIELDS.filter((key) => key in config.promptCaching).map(
    (key) => `llm.promptCaching.${key}`,
  );
}

export function formatClaudeCodePromptCachingWarning(fields: string[]): string | null {
  if (fields.length === 0) {
    return null;
  }
  return `claude-code ignores ${fields.join(', ')} because the Claude Agent SDK does not expose KTX prompt-cache TTL, tool, or history markers.`;
}

export function formatClaudeCodePromptCachingFix(): string {
  return 'Remove those promptCaching fields or use anthropic, vertex, or gateway when those cache knobs are required.';
}
```

- [ ] **Step 4: Update status/doctor to use the shared helper**

In `packages/cli/src/status-project.ts`, add:

```ts
import {
  formatClaudeCodePromptCachingFix,
  formatClaudeCodePromptCachingWarning,
  ignoredClaudeCodePromptCachingFields,
} from './claude-code-prompt-caching.js';
```

Delete the local `ignoredClaudeCodePromptCachingFields(...)` function.

Replace the warning block in `buildWarnings(...)` with:

```ts
  const warning = formatClaudeCodePromptCachingWarning(ignoredClaudeCodePromptCachingFields(config.llm));
  if (warning) {
    warnings.push({
      message: warning,
      fix: formatClaudeCodePromptCachingFix(),
    });
  }
```

- [ ] **Step 5: Emit the setup warning before persisting Claude Code config**

In `packages/cli/src/setup-models.ts`, add:

```ts
import {
  formatClaudeCodePromptCachingWarning,
  ignoredClaudeCodePromptCachingFields,
} from './claude-code-prompt-caching.js';
```

Inside the `backendChoice.backend === 'claude-code'` branch, immediately before
`await persistLlmConfig(...)`, add:

```ts
      const warning = formatClaudeCodePromptCachingWarning(
        ignoredClaudeCodePromptCachingFields(buildProjectLlmConfig(project.config.llm, { backend: 'claude-code' }, model)),
      );
      if (warning) {
        io.stderr.write(`${warning}\n`);
      }
```

- [ ] **Step 6: Run CLI tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-models.test.ts src/doctor.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add packages/cli/src/claude-code-prompt-caching.ts packages/cli/src/status-project.ts packages/cli/src/setup-models.ts packages/cli/src/setup-models.test.ts packages/cli/src/doctor.test.ts
git commit -m "fix: warn on claude-code prompt caching during setup"
```

### Task 3: Final verification

**Files:**

- Verify: `packages/context/src/llm/claude-code-runtime.ts`
- Verify: `packages/cli/src/setup-models.ts`
- Verify: `packages/cli/src/status-project.ts`

- [ ] **Step 1: Run targeted tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/llm/claude-code-runtime.test.ts src/llm/runtime-tools.test.ts src/llm/claude-code-env.test.ts src/llm/claude-code-models.test.ts src/llm/runtime-local-config.test.ts
pnpm --filter @ktx/cli exec vitest run src/setup-models.test.ts src/doctor.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package type-checks**

Run:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 3: Run the LLM boundary audit**

Run:

```bash
rg -n "generateKtxText\\(|generateKtxObject\\(|new AgentRunnerService\\(|AgentRunnerService\\b|llmProvider\\b|getModel\\(|getModelByName\\(" packages/context/src packages/cli/src packages/llm/src --glob '!**/*.test.ts'
```

Expected: remaining matches are limited to:

- `packages/llm/src/**`
- `packages/context/src/llm/ai-sdk-runtime.ts`
- `packages/context/src/llm/local-config.ts`
- `packages/context/src/agent/agent-runner.service.ts`
- type/export declarations that intentionally preserve the AI SDK adapter
  boundary.

- [ ] **Step 4: Run dead-code check**

Run:

```bash
pnpm run dead-code
```

Expected: PASS or only pre-existing unrelated findings. Investigate and fix
any finding caused by the new helper file.

- [ ] **Step 5: Commit verification cleanup if needed**

If verification required small cleanup, run:

```bash
git add packages/context/src/llm/claude-code-runtime.ts packages/context/src/llm/claude-code-runtime.test.ts packages/cli/src/claude-code-prompt-caching.ts packages/cli/src/status-project.ts packages/cli/src/setup-models.ts packages/cli/src/setup-models.test.ts packages/cli/src/doctor.test.ts
git commit -m "chore: verify claude-code v1 closure"
```

If no files changed after verification, skip this commit.

## Self-Review

- Spec coverage: The plan closes the remaining v1-blocking isolation assertion
  and setup-warning requirements from the original spec.
- Placeholder scan: No placeholders remain; every task includes file paths,
  code, commands, and expected output.
- Type consistency: The helper names and runtime function signatures are used
  consistently across tasks.
