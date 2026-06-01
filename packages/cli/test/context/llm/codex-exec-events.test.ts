import { describe, expect, it } from 'vitest';
import {
  parseCodexExecEventLine,
  summarizeCodexExecEvents,
} from '../../../src/context/llm/codex-exec-events.js';

describe('Codex exec event parsing', () => {
  it('captures final agent text, SDK usage, steps, and natural completion', () => {
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

  it('maps turn failures into error stop reason', () => {
    const summary = summarizeCodexExecEvents([
      { type: 'turn.started' },
      { type: 'turn.failed', error: { message: 'Codex could not connect to required MCP server' } },
    ]);

    expect(summary.stopReason).toBe('error');
    expect(summary.error?.message).toContain('Codex could not connect to required MCP server');
  });

  it('maps max-turns terminal reasons into budget stop reason when Codex emits one', () => {
    const summary = summarizeCodexExecEvents([
      { type: 'turn.started' },
      { type: 'turn.completed', reason: 'max_turns', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);

    expect(summary.stopReason).toBe('budget');
  });

  it('counts SDK-shaped MCP tool calls and failed MCP tool calls', () => {
    const summary = summarizeCodexExecEvents([
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: { id: 'call_1', type: 'mcp_tool_call', server: 'ktx', tool: 'search', arguments: { query: 'revenue' }, status: 'in_progress' },
      },
      {
        type: 'item.completed',
        item: { id: 'call_1', type: 'mcp_tool_call', server: 'ktx', tool: 'search', arguments: { query: 'revenue' }, status: 'failed', error: { message: 'denied' } },
      },
      { type: 'turn.completed' },
    ]);

    expect(summary.toolCallCount).toBe(1);
    expect(summary.toolFailures).toEqual(['search: denied']);
  });

  it('throws a clear error for malformed JSONL lines', () => {
    expect(() => parseCodexExecEventLine('{not-json')).toThrow('Codex JSONL event stream was malformed');
  });
});
