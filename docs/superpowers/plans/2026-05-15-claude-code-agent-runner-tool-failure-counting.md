# Claude Code Agent Runner Tool Failure Counting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Claude Agent SDK tool failures, including schema failures that happen before a KTX tool handler runs, are counted by the existing ingest WorkUnit failure path.

**Architecture:** Add a runner-level tool-failure callback to the shared `RunLoopParams` port. The Claude runner wires the SDK `PostToolUseFailure` hook into that callback, and bundle ingest records those failures as normal `ToolCallLogEntry` transcript entries so `toolFailureCount` marks the WorkUnit failed.

**Tech Stack:** TypeScript, Zod 4, `@anthropic-ai/claude-agent-sdk` 0.3.142, Vitest, pnpm.

---

## File Structure

- Modify `packages/context/src/agent/agent-runner.service.ts` for the shared `RunLoopToolFailure` type and callback.
- Modify `packages/context/src/agent/index.ts` to export the new type.
- Modify `packages/context/src/agent/claude-agent-sdk-runner.service.ts` to add the SDK failure hook and propagate SDK tool-use IDs into KTX tool execution.
- Modify `packages/context/src/agent/claude-agent-sdk-runner.service.test.ts` for hook and tool-use ID coverage.
- Modify `packages/context/src/ingest/stages/stage-3-work-units.ts` so WorkUnit execution forwards runner tool failures with the current unit key.
- Modify `packages/context/src/ingest/stages/stage-3-work-units.test.ts` for WorkUnit callback forwarding.
- Modify `packages/context/src/ingest/ingest-bundle.runner.ts` so SDK tool failures enter the existing transcript summary path.
- Modify `packages/context/src/ingest/ingest-bundle.runner.test.ts` for end-to-end WorkUnit failure counting.

---

### Task 1: Add Runner-Level SDK Tool Failure Reporting

**Files:**
- Modify: `packages/context/src/agent/agent-runner.service.ts`
- Modify: `packages/context/src/agent/index.ts`
- Modify: `packages/context/src/agent/claude-agent-sdk-runner.service.ts`
- Test: `packages/context/src/agent/claude-agent-sdk-runner.service.test.ts`

- [ ] **Step 1: Add failing Claude runner tests**

Append these tests inside `describe('ClaudeAgentSdkRunnerService', () => { ... })` in `packages/context/src/agent/claude-agent-sdk-runner.service.test.ts`:

```typescript
  it('reports SDK tool failures through the run-loop callback', async () => {
    const query = vi.fn(() =>
      asyncMessages([{ type: 'result', subtype: 'success', terminal_reason: 'completed', result: 'done' }]),
    );
    const failures: unknown[] = [];
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
      onToolFailure: async (failure) => {
        failures.push(failure);
      },
    });

    const options = (query as any).mock.calls[0][0].options;
    const hook = options.hooks.PostToolUseFailure[0].hooks[0];
    const output = await hook(
      {
        hook_event_name: 'PostToolUseFailure',
        session_id: 'session-1',
        transcript_path: '/tmp/project/transcript.jsonl',
        cwd: '/tmp/project',
        tool_name: 'mcp__ktx__read_raw_span',
        tool_input: { path: 42 },
        tool_use_id: 'tool-1',
        error: 'Input validation failed: expected path to be a string',
        duration_ms: 12,
      },
      'tool-1',
      { signal: new AbortController().signal },
    );

    expect(output).toEqual({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUseFailure' },
    });
    expect(failures).toEqual([
      {
        toolName: 'read_raw_span',
        input: { path: 42 },
        toolCallId: 'tool-1',
        error: 'Input validation failed: expected path to be a string',
        durationMs: 12,
      },
    ]);
  });

  it('passes SDK tool-use identifiers to KTX tool execution', async () => {
    const query = vi.fn(() =>
      asyncMessages([{ type: 'result', subtype: 'success', terminal_reason: 'completed', result: 'done' }]),
    );
    const execute = vi.fn(async ({ value }: { value: string }) => ({
      markdown: `pong ${value}`,
      structured: { value },
    }));
    const toolMock = vi.fn((name, description, inputSchema, handler) => ({
      name,
      description,
      inputSchema,
      handler,
    }));
    const runner = new ClaudeAgentSdkRunnerService({
      projectDir: '/tmp/project',
      modelSlots: {},
      query: query as never,
      tool: toolMock as never,
    });

    await runner.runLoop({
      modelRole: 'default',
      systemPrompt: 'system',
      userPrompt: 'user',
      stepBudget: 1,
      telemetryTags: {},
      toolSet: {
        ping: createAgentTool({
          name: 'ping',
          description: 'Ping',
          inputSchema: z.object({ value: z.string() }),
          execute,
        }),
      },
    });

    const handler = toolMock.mock.calls[0][3];
    await handler({ value: 'Ada' }, { toolUseID: 'tool-42' });

    expect(execute).toHaveBeenCalledWith({ value: 'Ada' }, { toolCallId: 'tool-42' });
  });
```

- [ ] **Step 2: Run the Claude runner tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/agent/claude-agent-sdk-runner.service.test.ts
```

Expected: FAIL because `RunLoopParams` has no `onToolFailure` callback, the Claude runner does not install `PostToolUseFailure` hooks, and SDK tool-use IDs are not passed to `definition.execute`.

- [ ] **Step 3: Add the shared callback type**

In `packages/context/src/agent/agent-runner.service.ts`, add this interface after `RunLoopStepInfo`:

```typescript
export interface RunLoopToolFailure {
  toolName: string;
  input: unknown;
  toolCallId?: string;
  error: string;
  durationMs?: number;
}
```

Then add this optional field to `RunLoopParams`:

```typescript
  onToolFailure?: (failure: RunLoopToolFailure) => void | Promise<void>;
```

In `packages/context/src/agent/index.ts`, add `RunLoopToolFailure` to the exported type list from `agent-runner.service.js`:

```typescript
  RunLoopToolFailure,
```

- [ ] **Step 4: Wire the Claude SDK failure hook**

In `packages/context/src/agent/claude-agent-sdk-runner.service.ts`, add `HookCallbackMatcher` to the SDK type imports:

```typescript
  type HookCallbackMatcher,
```

Add these helpers near `BUILT_IN_TOOLS`:

```typescript
function normalizeSdkToolName(toolName: string): string {
  return toolName.startsWith('mcp__ktx__') ? toolName.slice('mcp__ktx__'.length) : toolName;
}

function sdkToolCallId(extra: unknown): string | undefined {
  if (!extra || typeof extra !== 'object') {
    return undefined;
  }
  const record = extra as Record<string, unknown>;
  const id = record.toolUseID ?? record.tool_use_id ?? record.toolCallId;
  return typeof id === 'string' ? id : undefined;
}
```

In `consumeQuery`, add this before `const session = this.query({`:

```typescript
    const hooks = this.toolFailureHooks(params);
```

Then add this option inside `options` after `canUseTool: this.canUseKtxTool,`:

```typescript
        ...(hooks ? { hooks } : {}),
```

Add this method to the class:

```typescript
  private toolFailureHooks(
    params: RunLoopParams,
  ): Partial<Record<'PostToolUseFailure', HookCallbackMatcher[]>> | undefined {
    if (!params.onToolFailure) {
      return undefined;
    }

    const hook: HookCallbackMatcher['hooks'][number] = async (input) => {
      if (input.hook_event_name !== 'PostToolUseFailure') {
        return { continue: true };
      }
      await params.onToolFailure?.({
        toolName: normalizeSdkToolName(input.tool_name),
        input: input.tool_input,
        toolCallId: input.tool_use_id,
        error: input.error,
        ...(typeof input.duration_ms === 'number' ? { durationMs: input.duration_ms } : {}),
      });
      return {
        continue: true,
        hookSpecificOutput: { hookEventName: 'PostToolUseFailure' as const },
      };
    };

    return { PostToolUseFailure: [{ hooks: [hook] }] };
  }
```

Update `toSdkTool` so it passes SDK tool-use IDs through to KTX tools:

```typescript
  private toSdkTool(definition: AgentToolDefinition) {
    return this.tool(definition.name, definition.description, definition.inputSchema.shape, async (args, extra) => {
      const toolCallId = sdkToolCallId(extra);
      const output = await definition.execute(definition.inputSchema.parse(args), {
        ...(toolCallId ? { toolCallId } : {}),
      });
      return { content: [{ type: 'text' as const, text: agentToolOutputToText(output) }] };
    });
  }
```

- [ ] **Step 5: Run the Claude runner tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/agent/claude-agent-sdk-runner.service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/agent/agent-runner.service.ts packages/context/src/agent/index.ts packages/context/src/agent/claude-agent-sdk-runner.service.ts packages/context/src/agent/claude-agent-sdk-runner.service.test.ts
git commit -m "fix: report claude sdk tool failures"
```

---

### Task 2: Feed SDK Tool Failures Into WorkUnit Transcript Counts

**Files:**
- Modify: `packages/context/src/ingest/stages/stage-3-work-units.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Test: `packages/context/src/ingest/stages/stage-3-work-units.test.ts`
- Test: `packages/context/src/ingest/ingest-bundle.runner.test.ts`

- [ ] **Step 1: Add a failing WorkUnit forwarding test**

Append this test inside `describe('Stage 3 — executeWorkUnit', () => { ... })` in `packages/context/src/ingest/stages/stage-3-work-units.test.ts`:

```typescript
  it('forwards runner tool failures with the current WorkUnit key', async () => {
    const deps = makeDeps();
    const onToolFailure = vi.fn();
    deps.onToolFailure = onToolFailure;
    deps.sessionWorktreeGit.revParseHead = vi.fn().mockResolvedValueOnce('pre').mockResolvedValueOnce('post');
    deps.agentRunner.runLoop = vi.fn().mockImplementation(async (params: any) => {
      await params.onToolFailure?.({
        toolName: 'read_raw_span',
        input: { path: 42 },
        toolCallId: 'tool-1',
        error: 'Input validation failed',
        durationMs: 3,
      });
      return { stopReason: 'natural' };
    });

    await executeWorkUnit(deps, makeWu());

    expect(onToolFailure).toHaveBeenCalledWith('u1', {
      toolName: 'read_raw_span',
      input: { path: 42 },
      toolCallId: 'tool-1',
      error: 'Input validation failed',
      durationMs: 3,
    });
  });
```

- [ ] **Step 2: Add a failing bundle-ingest transcript test**

Append this test near the other `IngestBundleRunner` WorkUnit tests in `packages/context/src/ingest/ingest-bundle.runner.test.ts`:

```typescript
  it('records SDK tool failures as fatal WorkUnit transcript failures', async () => {
    const deps = makeDeps();
    deps.agentRunner.runLoop.mockImplementation(async (params: any) => {
      if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
        await params.onToolFailure?.({
          toolName: 'read_raw_span',
          input: { path: 42 },
          toolCallId: 'schema-1',
          error: 'Input validation failed: expected path to be a string',
          durationMs: 4,
        });
      }
      return { stopReason: 'natural' };
    });

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    expect(deps.reportsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          failedWorkUnits: ['u1'],
          toolTranscripts: [
            expect.objectContaining({
              unitKey: 'u1',
              toolCallCount: 1,
              errorCount: 1,
              toolNames: ['read_raw_span'],
            }),
          ],
        }),
      }),
    );
  });
```

- [ ] **Step 3: Run the WorkUnit tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/stages/stage-3-work-units.test.ts src/ingest/ingest-bundle.runner.test.ts -t "tool failures"
```

Expected: FAIL because `WorkUnitExecutionDeps` has no `onToolFailure` field and bundle ingest does not record SDK hook failures as transcript entries.

- [ ] **Step 4: Forward tool failures from WorkUnit execution**

In `packages/context/src/ingest/stages/stage-3-work-units.ts`, update the import:

```typescript
import type { AgentRunnerPort, AgentToolSet, RunLoopToolFailure } from '@ktx/context/agent';
```

Add this field to `WorkUnitExecutionDeps`:

```typescript
  onToolFailure?: (unitKey: string, failure: RunLoopToolFailure) => void | Promise<void>;
```

Add this field to the `deps.agentRunner.runLoop({ ... })` call:

```typescript
      onToolFailure: deps.onToolFailure ? (failure) => deps.onToolFailure?.(wu.unitKey, failure) : undefined,
```

- [ ] **Step 5: Record SDK failures through the existing transcript path**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, update the agent import:

```typescript
import { createAgentTool, type AgentToolSet, type RunLoopToolFailure } from '../agent/index.js';
```

Replace the transcript setup block in `runInner` with:

```typescript
    const transcriptDir = this.deps.storage.resolveTranscriptDir(job.jobId);
    const transcriptSummaries = new Map<string, MutableToolTranscriptSummary>();
    const recordedToolErrorKeys = new Set<string>();
    const transcriptErrorKey = (
      entry: Pick<ToolCallLogEntry, 'wuKey' | 'toolName' | 'toolCallId' | 'error'>,
    ): string | null => (entry.error && entry.toolCallId ? `${entry.wuKey}:${entry.toolName}:${entry.toolCallId}` : null);
    const recordTranscriptEntry =
      (path: string) =>
      (entry: ToolCallLogEntry): void => {
        const errorKey = transcriptErrorKey(entry);
        if (errorKey) {
          recordedToolErrorKeys.add(errorKey);
        }
        const current =
          transcriptSummaries.get(entry.wuKey) ?? createMutableToolTranscriptSummary(entry.wuKey, path);
        recordToolTranscriptEntry(current, entry);
        transcriptSummaries.set(entry.wuKey, current);
      };
    const recordSdkToolFailure =
      (path: string, unitKey: string) =>
      (failure: RunLoopToolFailure): void => {
        const entry: ToolCallLogEntry = {
          ts: new Date().toISOString(),
          wuKey: unitKey,
          ...(failure.toolCallId ? { toolCallId: failure.toolCallId } : {}),
          toolName: failure.toolName,
          durationMs: failure.durationMs ?? 0,
          input: failure.input,
          error: { message: failure.error },
        };
        const errorKey = transcriptErrorKey(entry);
        if (errorKey && recordedToolErrorKeys.has(errorKey)) {
          return;
        }
        recordTranscriptEntry(path)(entry);
      };
```

In the `executeWorkUnit` dependency object, add this field next to `toolFailureCount`:

```typescript
              onToolFailure: (unitKey, failure) =>
                recordSdkToolFailure(join(transcriptDir, `${unitKey}.jsonl`), unitKey)(failure),
```

- [ ] **Step 6: Run the WorkUnit and bundle-ingest tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/stages/stage-3-work-units.test.ts src/ingest/ingest-bundle.runner.test.ts -t "tool failures"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/context/src/ingest/stages/stage-3-work-units.ts packages/context/src/ingest/stages/stage-3-work-units.test.ts packages/context/src/ingest/ingest-bundle.runner.ts packages/context/src/ingest/ingest-bundle.runner.test.ts
git commit -m "fix: count claude sdk tool failures in work units"
```

---

### Task 3: Verification

**Files:**
- Verify: `packages/context/src/agent/claude-agent-sdk-runner.service.test.ts`
- Verify: `packages/context/src/ingest/stages/stage-3-work-units.test.ts`
- Verify: `packages/context/src/ingest/ingest-bundle.runner.test.ts`
- Verify: `packages/context/src/agent/agent-runner.service.test.ts`

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/agent/claude-agent-sdk-runner.service.test.ts src/agent/agent-runner.service.test.ts src/ingest/stages/stage-3-work-units.test.ts src/ingest/ingest-bundle.runner.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run context type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Run context package tests**

Run:

```bash
pnpm --filter @ktx/context run test
```

Expected: PASS.

- [ ] **Step 4: Run dead-code analysis**

Run:

```bash
pnpm run dead-code
```

Expected: PASS or only pre-existing findings unrelated to `packages/context/src/agent/` and `packages/context/src/ingest/`.

---

## Self-Review

Spec coverage:

- The plan closes the original spec's open item for tool failure counting by wiring Claude Agent SDK `PostToolUseFailure` into the existing WorkUnit transcript summary and `toolFailureCount` path.
- The plan preserves the already implemented `llm.agentRunner.backend` split, final `AgentToolSet` boundary, Claude runner isolation settings, model mapping, auth probe, and docs behavior.
- No docs-site update is required because this is internal correctness behavior for an already documented backend.

Placeholder scan:

- The plan uses concrete paths, commands, test code, and implementation code.
- There are no deferred implementation sections.

Type consistency:

- `RunLoopToolFailure` is exported from `packages/context/src/agent/index.ts`, imported by Stage 3 and bundle ingest, and passed through `RunLoopParams.onToolFailure`.
- Tool names are normalized from `mcp__ktx__read_raw_span` to `read_raw_span` before transcript recording, matching existing transcript summaries.
