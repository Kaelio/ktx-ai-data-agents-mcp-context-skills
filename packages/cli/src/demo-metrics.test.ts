import type { MemoryFlowEvent, MemoryFlowReplayInput } from './context/ingest/memory-flow/types.js';
import { describe, expect, it } from 'vitest';
import {
  buildDemoMetrics,
  formatCost,
  formatDuration,
  formatEta,
  formatTokens,
  formatTokensPerSec,
  progressBar,
} from './demo-metrics.js';

function snapshot(events: MemoryFlowEvent[], overrides: Partial<MemoryFlowReplayInput> = {}): MemoryFlowReplayInput {
  return {
    runId: 'run-1',
    connectionId: 'orbit_demo',
    adapter: 'live-database',
    status: 'running',
    sourceDir: null,
    syncId: 'sync-1',
    errors: [],
    events,
    plannedWorkUnits: [],
    details: { actions: [], provenance: [], transcripts: [] },
    ...overrides,
  };
}

describe('buildDemoMetrics', () => {
  it('estimates elapsed, agent steps, tool calls, and cost from event stream', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const input = snapshot(
      [
        { type: 'source_acquired', adapter: 'live-database', trigger: 'demo_full', fileCount: 5, emittedAt: new Date(start).toISOString() },
        { type: 'work_unit_started', unitKey: 'orders', skills: [], stepBudget: 40, emittedAt: new Date(start + 1000).toISOString() },
        { type: 'work_unit_step', unitKey: 'orders', stepIndex: 6, stepBudget: 40, emittedAt: new Date(start + 6000).toISOString() },
      ],
      {
        plannedWorkUnits: [
          { unitKey: 'orders', rawFiles: [], peerFileCount: 0, dependencyCount: 0 },
          { unitKey: 'customers', rawFiles: [], peerFileCount: 0, dependencyCount: 0 },
        ],
        details: {
          actions: [],
          provenance: [],
          transcripts: [{ unitKey: 'orders', path: '/tmp/orders.jsonl', toolCallCount: 3, errorCount: 0, toolNames: ['x'] }],
        },
      },
    );

    const metrics = buildDemoMetrics(input, { now: () => start + 10_000 });

    expect(metrics.elapsedMs).toBe(10_000);
    expect(metrics.agentSteps).toBe(6);
    expect(metrics.agentStepBudget).toBe(40);
    expect(metrics.toolCalls).toBe(3);
    expect(metrics.workUnitsTotal).toBe(2);
    expect(metrics.estimatedTokens).toBeGreaterThan(0);
    expect(metrics.estimatedCostUsd).toBeGreaterThan(0);
    expect(metrics.isCostEstimated).toBe(true);
  });

  it('returns null ETA before the first work unit completes', () => {
    const input = snapshot([{ type: 'source_acquired', adapter: 'live-database', trigger: 'x', fileCount: 1 }]);
    const metrics = buildDemoMetrics(input, { now: () => Date.now() });
    expect(metrics.etaMs).toBeNull();
  });

  it('extrapolates ETA from completed/total ratio when at least one unit finishes', () => {
    const start = Date.UTC(2026, 0, 1);
    const input = snapshot(
      [
        { type: 'source_acquired', adapter: 'a', trigger: 't', fileCount: 1, emittedAt: new Date(start).toISOString() },
        { type: 'work_unit_started', unitKey: 'a', skills: [], stepBudget: 10, emittedAt: new Date(start + 1000).toISOString() },
        { type: 'work_unit_finished', unitKey: 'a', status: 'success', emittedAt: new Date(start + 5000).toISOString() },
      ],
      {
        plannedWorkUnits: [
          { unitKey: 'a', rawFiles: [], peerFileCount: 0, dependencyCount: 0 },
          { unitKey: 'b', rawFiles: [], peerFileCount: 0, dependencyCount: 0 },
          { unitKey: 'c', rawFiles: [], peerFileCount: 0, dependencyCount: 0 },
        ],
      },
    );

    const metrics = buildDemoMetrics(input, { now: () => start + 6_000 });
    expect(metrics.etaMs).toBe(12_000);
  });

  it('reports ETA=0 when the run is finished', () => {
    const input = snapshot([], { status: 'done' });
    const metrics = buildDemoMetrics(input, { now: () => Date.now() });
    expect(metrics.etaMs).toBe(0);
  });
});

describe('format helpers', () => {
  it('formats duration in s/m/h cascades', () => {
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(95_000)).toBe('1m35s');
    expect(formatDuration(3_700_000)).toBe('1h01m');
    expect(formatDuration(-1)).toBe('--');
  });

  it('formats ETA as estimating before any data and as duration once running', () => {
    expect(formatEta(null, 'running')).toBe('estimating...');
    expect(formatEta(8_000, 'running')).toBe('8s');
    expect(formatEta(8_000, 'done')).toBe('done');
  });

  it('formats cost with sub-cent guard', () => {
    expect(formatCost(0)).toBe('$0.000');
    expect(formatCost(0.0005)).toBe('<$0.001');
    expect(formatCost(0.012)).toBe('$0.012');
    expect(formatCost(2.5)).toBe('$2.50');
  });

  it('formats token counts with K/M abbreviations', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(450)).toBe('450');
    expect(formatTokens(2_300)).toBe('2.3K');
    expect(formatTokens(1_500_000)).toBe('1.50M');
  });

  it('formats tokens per second', () => {
    expect(formatTokensPerSec(0)).toBe('0/s');
    expect(formatTokensPerSec(450)).toBe('450/s');
    expect(formatTokensPerSec(2300)).toBe('2.3K/s');
  });

  it('renders a deterministic progress bar with hash and dash characters', () => {
    expect(progressBar(0, 10)).toBe('----------');
    expect(progressBar(0.5, 10)).toBe('#####-----');
    expect(progressBar(1, 10)).toBe('##########');
    expect(progressBar(1.4, 10)).toBe('##########');
  });
});
