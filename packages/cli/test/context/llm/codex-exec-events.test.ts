import { describe, expect, it } from 'vitest';
import {
  parseCodexExecEventLine,
  summarizeCodexExecEvents,
} from '../../../src/context/llm/codex-exec-events.js';

describe('Codex exec event parsing', () => {
  it('uses the completed turn as one step when no MCP tools run', () => {
    const summary = summarizeCodexExecEvents(
      [
        { type: 'thread.started', thread_id: 'thr_1' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'hello from codex' } },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 12,
            cached_input_tokens: 4,
            output_tokens: 5,
            reasoning_output_tokens: 2,
          },
        },
      ],
      { startedAt: 100, now: () => 125 },
    );

    expect(summary).toEqual({
      finalText: 'hello from codex',
      stopReason: 'natural',
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      stepCount: 1,
      stepBoundariesMs: [25],
      toolCallCount: 0,
      toolFailures: [],
    });
  });

  it('uses completed MCP tool calls as loop steps', () => {
    const offsets = [115, 140, 175];
    const summary = summarizeCodexExecEvents(
      [
        { type: 'turn.started' },
        {
          type: 'item.started',
          item: { id: 'call_1', type: 'mcp_tool_call', server: 'ktx', tool: 'search', arguments: {}, status: 'in_progress' },
        },
        {
          type: 'item.completed',
          item: { id: 'call_1', type: 'mcp_tool_call', server: 'ktx', tool: 'search', arguments: {}, status: 'completed' },
        },
        {
          type: 'item.started',
          item: { id: 'call_2', type: 'mcp_tool_call', server: 'ktx', tool: 'lookup', arguments: {}, status: 'in_progress' },
        },
        {
          type: 'item.completed',
          item: {
            id: 'call_2',
            type: 'mcp_tool_call',
            server: 'ktx',
            tool: 'lookup',
            arguments: {},
            status: 'failed',
            error: { message: 'denied' },
          },
        },
        { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, reasoning_output_tokens: 0 } },
      ],
      { startedAt: 100, now: () => offsets.shift() ?? 175 },
    );

    expect(summary).toEqual({
      finalText: 'done',
      stopReason: 'natural',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      stepCount: 2,
      stepBoundariesMs: [15, 40],
      toolCallCount: 2,
      toolFailures: ['lookup: denied'],
    });
  });

  it('does not treat a completed MCP tool call as failed when Codex sends error: null', () => {
    // Captured verbatim from a real @openai/codex-sdk run: successful tool calls
    // carry `error: null` and `result` alongside `status: "completed"`.
    const summary = summarizeCodexExecEvents([
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'item_1',
          type: 'mcp_tool_call',
          server: 'ktx',
          tool: 'echo_value',
          arguments: { value: 'ktx_codex_tool_ok' },
          result: null,
          error: null,
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'mcp_tool_call',
          server: 'ktx',
          tool: 'echo_value',
          arguments: { value: 'ktx_codex_tool_ok' },
          result: { content: [{ type: 'text', text: 'echo:ktx_codex_tool_ok' }], structured_content: null },
          error: null,
          status: 'completed',
        },
      },
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);

    expect(summary.toolFailures).toEqual([]);
    expect(summary.toolCallCount).toBe(1);
  });

  it('counts built-in command executions as loop steps without failing the loop', () => {
    const offsets = [110, 130];
    const summary = summarizeCodexExecEvents(
      [
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', status: 'completed', exit_code: 0 } },
        { type: 'item.completed', item: { id: 'c2', type: 'command_execution', command: 'cat missing', status: 'failed', exit_code: 1 } },
        { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } },
      ],
      { startedAt: 100, now: () => offsets.shift() ?? 130 },
    );

    expect(summary.stepCount).toBe(2);
    expect(summary.stepBoundariesMs).toEqual([10, 30]);
    // A non-zero command exit is normal agent exploration, not a runtime tool failure.
    expect(summary.toolFailures).toEqual([]);
    expect(summary.toolCallCount).toBe(0);
  });

  it('maps turn failures into error stop reason', () => {
    const summary = summarizeCodexExecEvents([
      { type: 'turn.started' },
      { type: 'turn.failed', error: { message: 'Codex could not connect to required MCP server' } },
    ]);

    expect(summary.stopReason).toBe('error');
    expect(summary.error?.message).toContain('Codex could not connect to required MCP server');
  });

  it('unwraps the Codex API error envelope into its human-readable message', () => {
    // Codex serializes API errors as a JSON envelope inside the event message.
    const apiError = JSON.stringify({
      type: 'error',
      status: 400,
      error: {
        type: 'invalid_request_error',
        message: "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
      },
    });
    const summary = summarizeCodexExecEvents([
      { type: 'thread.started', thread_id: 'thr_1' },
      { type: 'turn.started' },
      { type: 'error', message: apiError },
      { type: 'turn.failed', error: { message: apiError } },
    ]);

    expect(summary.stopReason).toBe('error');
    expect(summary.error?.message).toBe(
      "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it('maps max-turns terminal reasons into budget stop reason when Codex emits one', () => {
    const summary = summarizeCodexExecEvents([
      { type: 'turn.started' },
      { type: 'turn.completed', reason: 'max_turns', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);

    expect(summary.stopReason).toBe('budget');
  });

  it('throws a clear error for malformed JSONL lines', () => {
    expect(() => parseCodexExecEventLine('{not-json')).toThrow('Codex JSONL event stream was malformed');
  });
});
