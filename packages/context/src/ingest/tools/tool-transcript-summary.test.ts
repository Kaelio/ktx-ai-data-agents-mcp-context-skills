import { describe, expect, it } from 'vitest';
import type { ToolCallLogEntry } from './tool-call-logger.js';
import { createMutableToolTranscriptSummary, recordToolTranscriptEntry } from './tool-transcript-summary.js';

function entry(overrides: Partial<ToolCallLogEntry>): ToolCallLogEntry {
  return {
    ts: '2026-05-11T00:00:00.000Z',
    wuKey: 'wu-1',
    toolName: 'wiki_write',
    durationMs: 1,
    input: {},
    ...overrides,
  };
}

describe('tool transcript summaries', () => {
  it('keeps recovered wiki_write structured failures out of fatal failures', () => {
    const summary = createMutableToolTranscriptSummary('wu-1', '/tmp/wu-1.jsonl');

    recordToolTranscriptEntry(
      summary,
      entry({
        input: { key: 'orbit-customers' },
        output: { structured: { success: false, key: 'orbit-customers' } },
      }),
    );
    recordToolTranscriptEntry(
      summary,
      entry({
        input: { key: 'orbit-customers' },
        output: { structured: { success: true, key: 'orbit-customers' } },
      }),
    );

    expect(summary.errorCount).toBe(1);
    expect(summary.fatalErrorCount).toBe(0);
  });

  it('counts unrecovered wiki_remove structured failures as fatal transcript errors', () => {
    const summary = createMutableToolTranscriptSummary('reconcile', '/tmp/reconcile.jsonl');

    recordToolTranscriptEntry(summary, {
      ts: '2026-05-11T00:00:00.000Z',
      wuKey: 'reconcile',
      toolCallId: 'remove-1',
      toolName: 'wiki_remove',
      durationMs: 1,
      input: { key: 'duplicate-page' },
      output: { structured: { success: false, key: 'duplicate-page' } },
    });

    expect(summary.errorCount).toBe(1);
    expect(summary.fatalErrorCount).toBe(1);
  });

  it('keeps unrecovered structured write failures fatal', () => {
    const summary = createMutableToolTranscriptSummary('wu-1', '/tmp/wu-1.jsonl');

    recordToolTranscriptEntry(
      summary,
      entry({
        input: { key: 'orbit-customers' },
        output: { structured: { success: false, key: 'orbit-customers' } },
      }),
    );

    expect(summary.errorCount).toBe(1);
    expect(summary.fatalErrorCount).toBe(1);
  });

  it('treats a later sl_edit_source success as recovery for the same SL source', () => {
    const summary = createMutableToolTranscriptSummary('wu-1', '/tmp/wu-1.jsonl');

    recordToolTranscriptEntry(
      summary,
      entry({
        toolName: 'sl_write_source',
        input: { connectionId: 'warehouse', sourceName: 'orbit_customers' },
        output: { structured: { success: false, sourceName: 'orbit_customers' } },
      }),
    );
    recordToolTranscriptEntry(
      summary,
      entry({
        toolName: 'sl_edit_source',
        input: { connectionId: 'warehouse', sourceName: 'orbit_customers' },
        output: { structured: { success: true, sourceName: 'orbit_customers' } },
      }),
    );

    expect(summary.errorCount).toBe(1);
    expect(summary.fatalErrorCount).toBe(0);
  });

  it('treats explicit unmapped fallback as recovery for guarded SL write failures', () => {
    const summary = createMutableToolTranscriptSummary('wu-1', '/tmp/wu-1.jsonl');

    recordToolTranscriptEntry(
      summary,
      entry({
        toolName: 'sl_write_source',
        input: { connectionId: 'dbt-main', sourceName: 'stg_accounts' },
        output: { structured: { success: false, sourceName: 'stg_accounts' } },
      }),
    );
    recordToolTranscriptEntry(
      summary,
      entry({
        toolName: 'emit_unmapped_fallback',
        input: { rawPath: 'models/schema.yml', reason: 'no_physical_table', tableRef: 'stg_accounts', fallback: 'wiki_only' },
        output: 'recorded unmapped fallback for models/schema.yml (wiki_only)',
      }),
    );

    expect(summary.errorCount).toBe(1);
    expect(summary.fatalErrorCount).toBe(0);
  });

  it('treats an untargeted unmapped fallback as recovery when there is only one pending SL failure', () => {
    const summary = createMutableToolTranscriptSummary('wu-1', '/tmp/wu-1.jsonl');

    recordToolTranscriptEntry(
      summary,
      entry({
        toolName: 'sl_write_source',
        input: { connectionId: 'dbt-main', sourceName: 'stg_accounts' },
        output: { structured: { success: false, sourceName: 'stg_accounts' } },
      }),
    );
    recordToolTranscriptEntry(
      summary,
      entry({
        toolName: 'emit_unmapped_fallback',
        input: { rawPath: 'models/schema.yml', reason: 'no_physical_table', fallback: 'wiki_only' },
        output: 'recorded unmapped fallback for models/schema.yml (wiki_only)',
      }),
    );

    expect(summary.errorCount).toBe(1);
    expect(summary.fatalErrorCount).toBe(0);
  });

  it('keeps unrelated SL write failures fatal when one source gets an unmapped fallback', () => {
    const summary = createMutableToolTranscriptSummary('wu-1', '/tmp/wu-1.jsonl');

    recordToolTranscriptEntry(
      summary,
      entry({
        toolName: 'sl_write_source',
        input: { connectionId: 'dbt-main', sourceName: 'stg_accounts' },
        output: { structured: { success: false, sourceName: 'stg_accounts' } },
      }),
    );
    recordToolTranscriptEntry(
      summary,
      entry({
        toolName: 'sl_write_source',
        input: { connectionId: 'dbt-main', sourceName: 'stg_orders' },
        output: { structured: { success: false, sourceName: 'stg_orders' } },
      }),
    );
    recordToolTranscriptEntry(
      summary,
      entry({
        toolName: 'emit_unmapped_fallback',
        input: { rawPath: 'models/schema.yml', reason: 'no_physical_table', tableRef: 'stg_accounts', fallback: 'wiki_only' },
        output: 'recorded unmapped fallback for models/schema.yml (wiki_only)',
      }),
    );

    expect(summary.errorCount).toBe(2);
    expect(summary.fatalErrorCount).toBe(1);
  });

  it('keeps thrown tool errors fatal even after a successful write', () => {
    const summary = createMutableToolTranscriptSummary('wu-1', '/tmp/wu-1.jsonl');

    recordToolTranscriptEntry(
      summary,
      entry({
        input: { key: 'orbit-customers' },
        error: { message: 'tool crashed' },
      }),
    );
    recordToolTranscriptEntry(
      summary,
      entry({
        input: { key: 'orbit-customers' },
        output: { structured: { success: true, key: 'orbit-customers' } },
      }),
    );

    expect(summary.errorCount).toBe(1);
    expect(summary.fatalErrorCount).toBe(1);
  });
});
