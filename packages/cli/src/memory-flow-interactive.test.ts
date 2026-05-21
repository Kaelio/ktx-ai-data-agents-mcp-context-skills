import { EventEmitter } from 'node:events';
import type { MemoryFlowReplayInput } from './context/ingest/index.js';
import { describe, expect, it, vi } from 'vitest';
import { memoryFlowCommandForKey, renderMemoryFlowInteractively } from './memory-flow-interactive.js';

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawModes: boolean[] = [];
  resume = vi.fn();
  pause = vi.fn();

  setRawMode(value: boolean): void {
    this.isRaw = value;
    this.rawModes.push(value);
  }
}

function replay(): MemoryFlowReplayInput {
  return {
    runId: 'run-1',
    connectionId: 'warehouse',
    adapter: 'metricflow',
    status: 'done',
    sourceDir: '/tmp/source',
    syncId: 'sync-1',
    errors: [],
    plannedWorkUnits: [
      {
        unitKey: 'orders',
        rawFiles: ['models/orders.yml'],
        peerFileCount: 0,
        dependencyCount: 1,
      },
      {
        unitKey: 'customers',
        rawFiles: ['models/customers.yml'],
        peerFileCount: 0,
        dependencyCount: 0,
      },
    ],
    details: { actions: [], provenance: [], transcripts: [] },
    events: [
      { type: 'source_acquired', adapter: 'metricflow', trigger: 'manual_resync', fileCount: 2 },
      { type: 'scope_detected', fingerprint: null },
      { type: 'raw_snapshot_written', syncId: 'sync-1', rawFileCount: 2 },
      { type: 'diff_computed', added: 1, modified: 1, deleted: 0, unchanged: 0 },
      { type: 'chunks_planned', chunkCount: 2, workUnitCount: 2, evictionCount: 0 },
      { type: 'work_unit_started', unitKey: 'orders', skills: ['wiki_capture'], stepBudget: 4 },
      { type: 'work_unit_finished', unitKey: 'orders', status: 'success' },
      { type: 'work_unit_started', unitKey: 'customers', skills: ['wiki_capture'], stepBudget: 4 },
      { type: 'work_unit_finished', unitKey: 'customers', status: 'failed', reason: 'validation reset' },
      { type: 'reconciliation_finished', conflictCount: 0, fallbackCount: 1 },
      { type: 'saved', commitSha: 'abc12345', wikiCount: 1, slCount: 1 },
      { type: 'provenance_recorded', rowCount: 2 },
      { type: 'report_created', runId: 'run-1', reportPath: 'report-1' },
    ],
  };
}

describe('memoryFlowCommandForKey', () => {
  it('maps supported terminal key names to memory-flow commands', () => {
    const idleSearch = { editing: false, query: '', matchIndex: 0 };
    const editingSearch = { editing: true, query: 'c', matchIndex: 0 };

    expect(memoryFlowCommandForKey('', idleSearch, { name: 'left' })).toBe('left');
    expect(memoryFlowCommandForKey('', idleSearch, { name: 'right' })).toBe('right');
    expect(memoryFlowCommandForKey('', idleSearch, { name: 'up' })).toBe('up');
    expect(memoryFlowCommandForKey('', idleSearch, { name: 'down' })).toBe('down');
    expect(memoryFlowCommandForKey('', idleSearch, { name: 'return' })).toBe('enter');
    expect(memoryFlowCommandForKey('', idleSearch, { name: 'tab' })).toBe('tab');
    expect(memoryFlowCommandForKey('', idleSearch, { name: 'f' })).toBe('filter');
    expect(memoryFlowCommandForKey('', idleSearch, { name: 'p' })).toBe('provenance');
    expect(memoryFlowCommandForKey('', idleSearch, { name: 't' })).toBe('transcript');
    expect(memoryFlowCommandForKey('', idleSearch, { name: 'q' })).toBe('quit');
    expect(memoryFlowCommandForKey('', idleSearch, { name: 'c', ctrl: true })).toBe('quit');
    expect(memoryFlowCommandForKey('/', { editing: false, query: '', matchIndex: 0 }, { name: '/' })).toBe(
      'search-start',
    );
    expect(memoryFlowCommandForKey('c', { editing: true, query: '', matchIndex: 0 }, { name: 'c' })).toEqual({
      type: 'search-input',
      value: 'c',
    });
    expect(memoryFlowCommandForKey('', editingSearch, { name: 'backspace' })).toBe('search-backspace');
    expect(memoryFlowCommandForKey('', editingSearch, { name: 'return' })).toBe('search-submit');
    expect(memoryFlowCommandForKey('', editingSearch, { name: 'escape' })).toBe('search-clear');
    expect(memoryFlowCommandForKey('', idleSearch, { name: 'x' })).toBeNull();
  });
});

describe('renderMemoryFlowInteractively', () => {
  it('repaints on keypress and restores raw mode on quit', async () => {
    let stdout = '';
    const stdin = new FakeStdin();
    const prepareKeypressEvents = vi.fn();

    const promise = renderMemoryFlowInteractively(
      replay(),
      {
        stdin,
        stdout: {
          isTTY: true,
          columns: 120,
          write: (chunk) => {
            stdout += chunk;
          },
        },
      },
      { prepareKeypressEvents },
    );

    stdin.emit('keypress', '', { name: 'right' });
    stdin.emit('keypress', '', { name: 'tab' });
    stdin.emit('keypress', '', { name: 'q' });

    await expect(promise).resolves.toBeUndefined();
    expect(prepareKeypressEvents).toHaveBeenCalledWith(stdin);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.resume).toHaveBeenCalledTimes(1);
    expect(stdin.pause).toHaveBeenCalledTimes(1);
    expect(stdout).toContain('\u001b[2J\u001b[H');
    expect(stdout).toContain('[ACTIONS]');
    expect(stdout).toContain('Pane: trust');
  });
});
