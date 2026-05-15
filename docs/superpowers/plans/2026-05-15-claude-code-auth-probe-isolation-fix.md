# Claude Code Auth Probe Isolation Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `claude-code` auth probe and runtime tolerate host-discovered
Claude Code init metadata while preserving KTX-owned tool, MCP, and plugin
restrictions.

**Architecture:** Keep the existing Claude Code runtime and SDK option tuple.
Change the init-message assertion from "no host discovery appears" to "only the
KTX-controlled execution surface is active." Align the design spec and user docs
with the pinned SDK behavior: `settingSources: []` disables filesystem settings,
`skills: []` is a context filter, and deny-by-default `canUseTool` is the
runtime enforcement boundary.

**Tech Stack:** TypeScript, pnpm, Vitest, Markdown, Fumadocs MDX,
`@anthropic-ai/claude-agent-sdk@0.3.142`.

---

## Audit result

The current strict isolation assertion is a v1-blocking bug. A real authenticated
Claude Code host can report non-empty `slash_commands`, `skills`, and `agents`
in the SDK init message even when KTX passes `settingSources: []`, `skills: []`,
`plugins: []`, `tools: []`, exact KTX MCP `allowedTools`, `disallowedTools`, and
deny-by-default `canUseTool`.

Spec findings:

- `docs/superpowers/specs/2026-05-15-claude-code-backend-design.md:45-47`
  requires host-discovered capabilities not to expand the KTX agent-loop tool
  surface. That requirement is about invocation, not necessarily about zero
  diagnostic metadata in the init message.
- `docs/superpowers/specs/2026-05-15-claude-code-backend-design.md:254-265`
  overreaches by asking the implementation to assert that unexpected
  settings-derived commands, skills, agents, plugins, or MCP servers are
  inactive from the SDK init message. In `@anthropic-ai/claude-agent-sdk@0.3.142`,
  the available SDK controls cannot make `message.slash_commands`,
  `message.skills`, or `message.agents` reliably empty on an authenticated host.
- `docs/superpowers/specs/2026-05-15-claude-code-backend-design.md:266-267`
  says skills are disabled with `skills: []`. The pinned SDK type definitions
  document `skills` as a context filter, not a sandbox.
- `docs/superpowers/specs/2026-05-15-claude-code-backend-design.md:543-545`
  correctly requires the auth probe to pass the isolation option tuple and no
  MCP servers. It does not require failing when host discovery metadata is
  present.

SDK evidence from
`node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.142_zod@4.4.3/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

- Lines `1686-1695`: `settingSources: []` disables filesystem settings only.
- Lines `1697-1718`: `skills: []` is a context filter; unlisted skills are
  hidden from listing and rejected by the Skill tool, but files remain on disk.
- Lines `1202-1213`: `allowedTools` is auto-approval, while `canUseTool` is the
  permission handler for controlling tool execution.
- Lines `1224-1228`: `disallowedTools` removes listed tools from context and
  prevents use.
- Lines `1255-1264`: `tools: []` disables built-in tools.
- Lines `1545-1558`: `plugins` loads plugins when supplied; KTX supplies `[]`.
- Lines `3465-3489`: the init message reports `agents`, `tools`,
  `mcp_servers`, `slash_commands`, `skills`, and `plugins`.

Implemented plan audit:

- `2026-05-15-claude-code-backend-v1-runtime.md` is implemented for config,
  runtime port, SDK dependency, model aliases, environment scrubbing, Claude Code
  text/object/agent execution, setup/status/doctor support, docs, and LLM
  call-site migration.
- `2026-05-15-claude-code-backend-v1-isolation-closure.md` is implemented, but
  it converted the spec's ambiguous "assert inactive" line into an impossible
  assertion against non-empty `slash_commands`, `skills`, and `agents`.
- `2026-05-15-claude-code-backend-v1-ingest-guidance-closure.md` is implemented
  for the ingest missing-LLM guidance and associated CLI/context tests.

Remaining v1-blocking gaps:

- `packages/context/src/llm/claude-code-runtime.ts:94-101` throws on
  host-discovered slash commands, skills, and agents.
- `packages/context/src/llm/claude-code-runtime.test.ts:158-178` encodes the
  wrong behavior by requiring the runtime to reject any init message with
  discovered agents.
- The auth probe has no regression coverage for an authenticated host whose init
  message reports non-empty `slash_commands`, `skills`, and `agents`.
- User docs under `docs-site/content/docs/guides/` say KTX "disables" skills,
  agents, hooks, and slash commands. That wording is stronger than the SDK
  contract and must be changed to "not invokable by KTX agent loops."

Non-blocking gaps:

- Same-step AI SDK tool-call repair parity remains out of scope for v1.
- OTEL telemetry parity remains out of scope for v1.
- Embedding parity remains out of scope because embeddings are configured
  separately.
- Full prompt-caching parity remains out of scope. V1 keeps warning on ignored
  prompt-cache fields and avoids AI SDK cache markers on the Claude Code path.

Decision:

- Choose option (a): relax the assertion in code and align the spec text. Do not
  rely on an invented SDK mechanism. The pinned type definitions expose
  `settingSources`, `skills`, `plugins`, `tools`, `allowedTools`,
  `disallowedTools`, and `canUseTool`, but they do not expose a query option that
  disables all host-discovered slash commands or user-level subagent names in the
  init message.

## File structure

Modify these files:

- `docs/superpowers/specs/2026-05-15-claude-code-backend-design.md` aligns the
  design with the real SDK contract.
- `packages/context/src/llm/claude-code-runtime.test.ts` adds the failing
  regression tests for auth probe and runtime init metadata.
- `packages/context/src/llm/claude-code-runtime.ts` relaxes init metadata checks
  while tightening exact tool equality.
- `docs-site/content/docs/guides/llm-configuration.mdx` changes user docs from
  "disabled" to "not invokable."
- `docs-site/content/docs/guides/building-context.mdx` applies the same
  user-facing wording at the ingest guide boundary.

### Task 1: Align the design spec with SDK reality

**Files:**

- Modify: `docs/superpowers/specs/2026-05-15-claude-code-backend-design.md`

- [ ] **Step 1: Update the tool-boundary goal**

Replace the goal bullet at lines `45-47` with:

```markdown
- Preserve KTX's curated tool boundaries. Claude Code built-ins,
  filesystem-discovered MCP servers, hooks, skills, plugins, agents, and slash
  commands must not become invokable in KTX agent loops. The Agent SDK init
  message may still report host-discovered slash commands, skills, and agents;
  KTX treats that metadata as diagnostic only and restricts execution through
  `tools: []`, exact KTX MCP `allowedTools`, `disallowedTools`, and
  deny-by-default `canUseTool`.
```

- [ ] **Step 2: Replace the over-broad init assertion requirement**

Replace the bullet at lines `254-265` with:

```markdown
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
```

- [ ] **Step 3: Replace the skills/plugin wording**

Replace the bullets at lines `266-289` with:

```markdown
- `skills: []` is a context filter in the pinned SDK
  (`sdk.d.ts:1697-1718`): unlisted skills are hidden from the model's skill
  listing and rejected by the Skill tool, but discovered skill names may still
  appear in init metadata. KTX must still pass `skills: []`.
- Plugins are disabled with `plugins: []`, and the runtime asserts that
  `message.plugins` is empty in the init message.
- Built-in tools are disabled by setting `tools: []`. The pinned SDK type
  (`@anthropic-ai/claude-agent-sdk@0.3.142`, `sdk.d.ts:1255-1264`) documents
  `tools` as the base set of built-in tools, with `[]` meaning "disable all
  built-ins"; `tools` does not accept MCP tool ids and cannot be used to
  restrict MCP availability.
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
```

- [ ] **Step 4: Update auth probe acceptance text**

After the auth probe option list at lines `543-545`, add:

```markdown
  The auth probe MUST tolerate init messages with non-empty
  `slash_commands`, `skills`, and `agents` when `message.tools` is empty,
  `message.mcp_servers` is empty, `message.plugins` is empty, and the query
  options contain the KTX isolation tuple. Host discovery metadata is not an
  auth failure.
```

- [ ] **Step 5: Update verified evidence and open items**

Replace lines `621-623` with:

```markdown
- The Agent SDK skills docs say the `skills` option is a context filter rather
  than a sandbox. KTX must pass `skills: []`, but must not assert that
  `message.skills` is empty in the SDK init message.
```

Replace open item `8` at lines `648-649` with:

```markdown
8. Write tests proving a raw built-in Claude Code tool request is denied,
   host-discovered Skill/Agent/SlashCommand requests are denied by `canUseTool`,
   and only exact `mcp__ktx__*` tools are allowed during KTX agent loops.
```

Replace open item `9` at lines `650-654` with:

```markdown
9. Write a test that asserts every KTX-originated `query()` invocation
   (agent loop, text generation, object generation, auth probe) is called
   with `settingSources: []`, `skills: []`, `plugins: []`, `tools: []`, and
   `persistSession: false`, by spying on the SDK entry point. The test must
   fail if any path falls back to SDK defaults for those fields. The test must
   also prove that non-empty host-discovered `slash_commands`, `skills`, and
   `agents` in the init message do not fail the auth probe or runtime when the
   controlled tool, MCP server, and plugin surfaces match KTX expectations.
```

- [ ] **Step 6: Commit the spec alignment**

Run:

```bash
git add docs/superpowers/specs/2026-05-15-claude-code-backend-design.md
git commit -m "docs: align claude-code isolation spec with sdk metadata"
```

Expected: the design spec no longer requires zero host-discovery metadata in
the SDK init message.

### Task 2: Add regression tests for host-discovered init metadata

**Files:**

- Modify: `packages/context/src/llm/claude-code-runtime.test.ts`

- [ ] **Step 1: Replace the invalid agent rejection test**

In `packages/context/src/llm/claude-code-runtime.test.ts`, replace the test named
`rejects settings-derived agents and non-KTX MCP servers from init messages`
with these tests:

```ts
  it('treats host-discovered commands skills and agents as non-fatal init metadata for text and auth probe', async () => {
    const hostDiscoveredInit = initMessage({
      slash_commands: ['/help', '/compact', '/clear', '/user-command'],
      skills: ['pdf', 'docx'],
      agents: ['claude', 'Explore', 'general-purpose'],
    });
    const textQuery = vi.fn((_input: any) =>
      stream([hostDiscoveredInit, resultMessage({ result: 'hello' })]),
    );
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query: textQuery,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test', PATH: '/usr/bin' }, // pragma: allowlist secret
    });

    await expect(runtime.generateText({ role: 'default', prompt: 'say hello' })).resolves.toBe('hello');
    const textOptions = textQuery.mock.calls[0][0].options;
    expect(textOptions).toMatchObject({
      settingSources: [],
      skills: [],
      plugins: [],
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      persistSession: false,
      env: expect.not.objectContaining({ ANTHROPIC_API_KEY: 'sk-ant-test' }),
    });
    expect(textOptions.disallowedTools).toEqual(expect.arrayContaining(['Agent', 'Task', 'Bash']));
    expect(await textOptions.canUseTool('Agent', {}, { signal: new AbortController().signal, toolUseID: 'agent' })).toMatchObject({
      behavior: 'deny',
      toolUseID: 'agent',
    });
    expect(await textOptions.canUseTool('Skill', {}, { signal: new AbortController().signal, toolUseID: 'skill' })).toMatchObject({
      behavior: 'deny',
      toolUseID: 'skill',
    });
    expect(
      await textOptions.canUseTool('SlashCommand', {}, { signal: new AbortController().signal, toolUseID: 'slash' }),
    ).toMatchObject({
      behavior: 'deny',
      toolUseID: 'slash',
    });

    const probeQuery = vi.fn((_input: any) =>
      stream([hostDiscoveredInit, resultMessage({ result: 'ok' })]),
    );
    await expect(
      runClaudeCodeAuthProbe({
        projectDir: '/tmp/project',
        model: 'sonnet',
        query: probeQuery,
        env: { ANTHROPIC_AUTH_TOKEN: 'token', HOME: '/Users/test' },
      }),
    ).resolves.toEqual({ ok: true });
    expect(probeQuery.mock.calls[0][0].options).toMatchObject({
      settingSources: [],
      skills: [],
      plugins: [],
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      persistSession: false,
      env: expect.objectContaining({ HOME: '/Users/test' }),
    });
    expect(probeQuery.mock.calls[0][0].options.env).not.toEqual(
      expect.objectContaining({ ANTHROPIC_AUTH_TOKEN: 'token' }),
    );
  });

  it('allows host-discovered context during agent loops while requiring exact KTX MCP tools and servers', async () => {
    const query = vi.fn((_input: any) =>
      stream([
        initMessage({
          tools: ['mcp__ktx__load_skill'],
          mcp_servers: [{ name: 'ktx', status: 'connected' }],
          slash_commands: ['/help', '/compact', '/clear'],
          skills: ['memory-agent', 'doc-reader'],
          agents: ['claude', 'Plan', 'Explore'],
        }),
        {
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          parent_tool_use_id: null,
          uuid: '00000000-0000-4000-8000-000000000006',
          session_id: 'session-id',
        } as unknown as SDKMessage,
        resultMessage({ subtype: 'error_max_turns', is_error: true }),
      ]),
    );
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
    });

    await expect(
      runtime.runAgentLoop({
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
      }),
    ).resolves.toEqual({ stopReason: 'budget' });

    const options = query.mock.calls[0][0].options;
    expect(options.allowedTools).toEqual(['mcp__ktx__load_skill']);
    expect(await options.canUseTool('mcp__ktx__load_skill', {}, { signal: new AbortController().signal, toolUseID: '1' })).toEqual({
      behavior: 'allow',
      toolUseID: '1',
    });
    expect(await options.canUseTool('Task', {}, { signal: new AbortController().signal, toolUseID: '2' })).toMatchObject({
      behavior: 'deny',
      toolUseID: '2',
    });
    expect(await options.canUseTool('Skill', {}, { signal: new AbortController().signal, toolUseID: '3' })).toMatchObject({
      behavior: 'deny',
      toolUseID: '3',
    });
  });

  it('still rejects unexpected tools, missing KTX tools, plugins, and non-KTX MCP servers from init messages', async () => {
    const query = vi.fn((_input: any) =>
      stream([
        initMessage({
          tools: ['Bash'],
          mcp_servers: [{ name: 'filesystem', status: 'connected' }],
          plugins: [{ name: 'host-plugin', path: '/tmp/plugin' }],
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

    await expect(
      runtime.generateText({
        role: 'default',
        prompt: 'say hello',
        tools: {
          load_skill: {
            name: 'load_skill',
            description: 'Load skill.',
            inputSchema: z.object({ name: z.string() }),
            execute: async () => ({ markdown: 'loaded' }),
          },
        },
      }),
    ).rejects.toThrow(
      /Claude Code runtime isolation failed: .*tools=Bash.*missing_tools=mcp__ktx__load_skill.*mcp_servers=filesystem.*plugins=host-plugin/,
    );
  });
```

- [ ] **Step 2: Run the runtime test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/llm/claude-code-runtime.test.ts
```

Expected: FAIL. The first new test fails because `runClaudeCodeAuthProbe(...)`
returns `{ ok: false, ... }` and `generateText(...)` rejects when init metadata
contains non-empty `slash_commands`, `skills`, or `agents`. The second new test
fails because `runAgentLoop(...)` returns `{ stopReason: 'error', ... }` for the
same reason.

- [ ] **Step 3: Commit the failing regression test**

Run:

```bash
git add packages/context/src/llm/claude-code-runtime.test.ts
git commit -m "test: cover claude-code host discovery metadata"
```

Expected: the commit contains tests that fail before the runtime assertion is
fixed.

### Task 3: Relax init metadata assertions to the controlled execution surface

**Files:**

- Modify: `packages/context/src/llm/claude-code-runtime.ts`

- [ ] **Step 1: Replace `assertInitIsolation`**

In `packages/context/src/llm/claude-code-runtime.ts`, replace the full
`assertInitIsolation(...)` function with:

```ts
function assertInitIsolation(
  message: SDKMessage,
  allowedToolIds: Set<string>,
  expectedMcpServerNames: Set<string>,
): void {
  if (message.type !== 'system' || message.subtype !== 'init') {
    return;
  }
  const activeToolIds = new Set(message.tools);
  const unexpectedTools = message.tools.filter((toolName) => !allowedToolIds.has(toolName));
  const missingTools = [...allowedToolIds].filter((toolName) => !activeToolIds.has(toolName));
  const activeMcpServerNames = message.mcp_servers.map((server) => server.name);
  const unexpectedMcpServers = activeMcpServerNames.filter((name) => !expectedMcpServerNames.has(name));
  const missingMcpServers = [...expectedMcpServerNames].filter((name) => !activeMcpServerNames.includes(name));
  const unexpectedPlugins = message.plugins.map((plugin) => plugin.name);
  if (
    unexpectedTools.length > 0 ||
    missingTools.length > 0 ||
    unexpectedMcpServers.length > 0 ||
    missingMcpServers.length > 0 ||
    unexpectedPlugins.length > 0
  ) {
    throw new Error(
      `Claude Code runtime isolation failed: tools=${unexpectedTools.join(',') || '(none)'} missing_tools=${
        missingTools.join(',') || '(none)'
      } mcp_servers=${unexpectedMcpServers.join(',') || '(none)'} missing_mcp_servers=${
        missingMcpServers.join(',') || '(none)'
      } plugins=${unexpectedPlugins.join(',') || '(none)'} host_slash_commands=${
        message.slash_commands.length
      } host_skills=${message.skills.length} host_agents=${message.agents?.join(',') || '(none)'}`,
    );
  }
}
```

This preserves strict checks for the KTX-controlled execution surface:

- `message.tools` must exactly equal the generated KTX MCP tool ids for the
  current call.
- `message.mcp_servers` must exactly equal the expected KTX MCP server names.
- `message.plugins` must be empty.

It deliberately stops treating `message.slash_commands`, `message.skills`, and
`message.agents` as fatal because those fields can contain host-discovered
metadata that KTX cannot disable through the pinned SDK options.

- [ ] **Step 2: Run the runtime test to verify it passes**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/llm/claude-code-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit the runtime fix**

Run:

```bash
git add packages/context/src/llm/claude-code-runtime.ts packages/context/src/llm/claude-code-runtime.test.ts
git commit -m "fix: tolerate claude-code host discovery metadata"
```

Expected: the auth probe and runtime no longer fail solely because the SDK init
message reports host-discovered slash commands, skills, or agents.

### Task 4: Correct user-facing docs wording

**Files:**

- Modify: `docs-site/content/docs/guides/llm-configuration.mdx`
- Modify: `docs-site/content/docs/guides/building-context.mdx`

- [ ] **Step 1: Update the LLM configuration guide wording**

In `docs-site/content/docs/guides/llm-configuration.mdx`, replace lines `39-41`
with:

```mdx
`claude-code` keeps KTX tool boundaries intact. KTX exposes only the MCP tools
needed for the current KTX agent loop, disables Claude Code built-in tools,
keeps plugins empty, and denies every non-KTX tool request through
`canUseTool`. The Claude Agent SDK may still report host-discovered slash
commands, skills, and subagent names in init metadata; that metadata is not an
execution grant for KTX agent loops.
```

- [ ] **Step 2: Update the building context guide wording**

In `docs-site/content/docs/guides/building-context.mdx`, replace lines `61-63`
with:

```mdx
When you use `claude-code`, KTX still controls the tool surface for ingest and
memory capture. Claude Code built-in tools, discovered MCP servers, plugins,
skills, agents, and slash commands are not invokable by KTX agent loops unless
they are exact KTX MCP tools for the current run.
```

- [ ] **Step 3: Run docs tests**

Run:

```bash
pnpm --filter ktx-docs run test
```

Expected: PASS.

- [ ] **Step 4: Commit docs wording**

Run:

```bash
git add docs-site/content/docs/guides/llm-configuration.mdx docs-site/content/docs/guides/building-context.mdx
git commit -m "docs: clarify claude-code host discovery metadata"
```

Expected: user docs describe invocation control rather than promising zero
host-discovery metadata.

### Task 5: Final verification

**Files:**

- Verify: `docs/superpowers/specs/2026-05-15-claude-code-backend-design.md`
- Verify: `packages/context/src/llm/claude-code-runtime.ts`
- Verify: `packages/context/src/llm/claude-code-runtime.test.ts`
- Verify: `docs-site/content/docs/guides/llm-configuration.mdx`
- Verify: `docs-site/content/docs/guides/building-context.mdx`

- [ ] **Step 1: Run targeted runtime tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/llm/claude-code-runtime.test.ts src/llm/runtime-tools.test.ts src/llm/claude-code-env.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Run docs verification**

Run:

```bash
pnpm --filter ktx-docs run test
```

Expected: PASS.

- [ ] **Step 4: Run dead-code checks**

Run:

```bash
pnpm run dead-code
```

Expected: PASS or only pre-existing unrelated findings. Investigate and fix any
finding caused by the runtime assertion or test changes.

- [ ] **Step 5: Inspect git status**

Run:

```bash
git status --short
```

Expected: only files from this plan are modified, or the working tree is clean
if each task was committed.

## Self-review

- Spec coverage: This plan addresses the v1-blocking auth probe failure,
  aligns the spec with the SDK contract, preserves the real KTX execution
  boundary, and adds regression coverage for non-empty host-discovered
  `slash_commands`, `skills`, and `agents` in both auth probe and runtime paths.
- Placeholder scan: No placeholder markers remain. Every code-changing step
  includes exact file paths, code blocks, commands, and expected results.
- Type consistency: The plan uses existing names from the codebase:
  `ClaudeCodeKtxLlmRuntime`, `runClaudeCodeAuthProbe`, `initMessage`,
  `resultMessage`, `assertInitIsolation`, `mcpToolIds`, `KtxRuntimeToolSet`, and
  `canUseTool`.
