import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateIngestProfile,
  formatIngestProfile,
  formatIngestProfileJson,
  type IngestProfilePaths,
  parseTraceEvents,
  readIngestProfile,
  resolveIngestProfileMode,
  type ProfiledTraceEvent,
} from '../../../src/context/ingest/ingest-profile.js';
import { rm } from 'node:fs/promises';

function profilePaths(projectDir: string, jobId: string): IngestProfilePaths {
  return {
    tracePath: join(projectDir, '.ktx', 'ingest-traces', jobId, 'trace.jsonl'),
    transcriptDir: join(projectDir, '.ktx', 'ingest-transcripts', jobId),
  };
}

function traceLine(event: Partial<ProfiledTraceEvent> & { phase: string; event: string }): string {
  return JSON.stringify({ schemaVersion: 1, level: 'debug', ...event });
}

describe('parseTraceEvents', () => {
  it('parses valid JSONL lines and skips blank and malformed ones', () => {
    const text = [
      traceLine({ at: '2026-05-30T00:00:00.000Z', phase: 'fetch', event: 'fetch_finished', durationMs: 100 }),
      '',
      '{ not json',
      traceLine({ phase: 'diff', event: 'compute_diff_set_finished', durationMs: 5 }),
    ].join('\n');
    const events = parseTraceEvents(text);
    expect(events).toHaveLength(2);
    expect(events[0].phase).toBe('fetch');
    expect(events[1].event).toBe('compute_diff_set_finished');
  });
});

describe('aggregateIngestProfile', () => {
  it('sums durations per phase and sorts by total descending', () => {
    const events = parseTraceEvents(
      [
        traceLine({ phase: 'fetch', event: 'fetch_finished', durationMs: 1000 }),
        traceLine({ phase: 'work_unit', event: 'work_unit_executed', durationMs: 5000, data: { unitKey: 'a' } }),
        traceLine({ phase: 'work_unit', event: 'work_unit_executed', durationMs: 3000, data: { unitKey: 'b' } }),
        traceLine({ phase: 'diff', event: 'compute_diff_set_finished', durationMs: 50 }),
      ].join('\n'),
    );
    const profile = aggregateIngestProfile({ jobId: 'job-1', events, toolMsByUnit: {} });
    expect(profile.phases.map((p) => p.phase)).toEqual(['work_unit', 'fetch', 'diff']);
    expect(profile.phases[0]).toEqual({ phase: 'work_unit', totalMs: 8000, count: 2 });
  });

  it('builds per-work-unit rows and derives model time from agent loop minus tool time', () => {
    const events = parseTraceEvents(
      [
        traceLine({
          phase: 'work_unit',
          event: 'work_unit_child_created',
          durationMs: 200,
          data: { unitKey: 'cards/users' },
        }),
        traceLine({
          phase: 'work_unit',
          event: 'work_unit_executed',
          durationMs: 12000,
          data: { unitKey: 'cards/users', status: 'success', agentLoopMs: 10000, stepCount: 12, totalTokens: 48000 },
        }),
        traceLine({
          phase: 'work_unit',
          event: 'work_unit_child_cleanup',
          durationMs: 80,
          data: { unitKey: 'cards/users' },
        }),
      ].join('\n'),
    );
    const profile = aggregateIngestProfile({ jobId: 'job-1', events, toolMsByUnit: { 'cards/users': 2500 } });
    expect(profile.workUnitCount).toBe(1);
    const wu = profile.workUnits[0];
    expect(wu).toMatchObject({
      unitKey: 'cards/users',
      status: 'success',
      totalMs: 12000,
      agentLoopMs: 10000,
      toolMs: 2500,
      modelMs: 7500,
      createMs: 200,
      cleanupMs: 80,
      stepCount: 12,
      totalTokens: 48000,
    });
  });

  it('counts failed work units and tolerates missing tool transcripts', () => {
    const events = parseTraceEvents(
      [
        traceLine({
          phase: 'work_unit',
          event: 'work_unit_executed',
          durationMs: 4000,
          data: { unitKey: 'wu-ok', status: 'success', agentLoopMs: 3800 },
        }),
        traceLine({
          phase: 'work_unit',
          event: 'work_unit_executed',
          durationMs: 1000,
          data: { unitKey: 'wu-bad', status: 'failed', agentLoopMs: 900 },
        }),
      ].join('\n'),
    );
    const profile = aggregateIngestProfile({ jobId: 'job-1', events, toolMsByUnit: {} });
    expect(profile.failedWorkUnitCount).toBe(1);
    // No tool transcript → model time falls back to the full agent-loop time.
    expect(profile.workUnits.find((w) => w.unitKey === 'wu-ok')?.modelMs).toBe(3800);
  });

  it('derives total wall time from the first and last event timestamps', () => {
    const events = parseTraceEvents(
      [
        traceLine({ at: '2026-05-30T00:00:00.000Z', phase: 'fetch', event: 'fetch_started' }),
        traceLine({ at: '2026-05-30T00:01:30.000Z', phase: 'run', event: 'ingest_finished' }),
      ].join('\n'),
    );
    const profile = aggregateIngestProfile({ jobId: 'job-1', events, toolMsByUnit: {} });
    expect(profile.totalWallMs).toBe(90_000);
  });
});

describe('formatIngestProfile', () => {
  it('renders phase breakdown and work-unit rows', () => {
    const events = parseTraceEvents(
      [
        traceLine({ at: '2026-05-30T00:00:00.000Z', phase: 'work_unit', event: 'work_unit_executed', durationMs: 8000, data: { unitKey: 'cards/users', status: 'success', agentLoopMs: 8000, stepCount: 10, totalTokens: 12000 } }),
        traceLine({ at: '2026-05-30T00:00:10.000Z', phase: 'reconciliation', event: 'reconciliation_executed', durationMs: 2000 }),
      ].join('\n'),
    );
    const profile = aggregateIngestProfile({ jobId: 'job-xyz', events, toolMsByUnit: { 'cards/users': 1000 } });
    const text = formatIngestProfile(profile);
    expect(text).toContain('job-xyz');
    expect(text).toContain('Phase breakdown');
    expect(text).toContain('work_unit');
    expect(text).toContain('reconciliation');
    expect(text).toContain('cards/users');
    expect(text).toContain('success');
  });
});

describe('readIngestProfile', () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const dir of created.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('joins nested tool transcripts to work units by wuKey', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-profile-'));
    created.push(projectDir);
    const jobId = 'job-nested';
    const paths = profilePaths(projectDir, jobId);
    await mkdir(join(paths.transcriptDir, 'cards'), { recursive: true });
    await mkdir(join(paths.tracePath, '..'), { recursive: true });
    await writeFile(
      paths.tracePath,
      [
        JSON.stringify({
          phase: 'work_unit',
          event: 'work_unit_executed',
          durationMs: 10000,
          data: { unitKey: 'cards/marketing', status: 'success', agentLoopMs: 9000, stepCount: 12 },
        }),
      ].join('\n'),
      'utf-8',
    );
    // Work-unit key has a slash → transcript lives at cards/marketing.jsonl.
    await writeFile(
      join(paths.transcriptDir, 'cards', 'marketing.jsonl'),
      [
        JSON.stringify({ wuKey: 'cards/marketing', toolName: 'sl_write', durationMs: 2000, input: {} }),
        JSON.stringify({ wuKey: 'cards/marketing', toolName: 'sl_validate', durationMs: 1000, input: {} }),
      ].join('\n'),
      'utf-8',
    );

    const profile = await readIngestProfile(jobId, paths);
    const wu = profile.workUnits.find((entry) => entry.unitKey === 'cards/marketing');
    expect(wu?.toolMs).toBe(3000);
    expect(wu?.modelMs).toBe(6000);
  });
});

describe('resolveIngestProfileMode', () => {
  it('reads the table/json/off mode from the env var', () => {
    expect(resolveIngestProfileMode(undefined, { KTX_PROFILE_INGEST: '1' })).toBe('table');
    expect(resolveIngestProfileMode(undefined, { KTX_PROFILE_INGEST: 'true' })).toBe('table');
    expect(resolveIngestProfileMode(undefined, { KTX_PROFILE_INGEST: 'json' })).toBe('json');
    expect(resolveIngestProfileMode(undefined, { KTX_PROFILE_INGEST: '0' })).toBe('off');
    expect(resolveIngestProfileMode(undefined, {})).toBe('off');
  });

  it('reads the mode from the config value', () => {
    expect(resolveIngestProfileMode(true, {})).toBe('table');
    expect(resolveIngestProfileMode('json', {})).toBe('json');
    expect(resolveIngestProfileMode(false, {})).toBe('off');
  });

  it('lets either source request json (json wins)', () => {
    expect(resolveIngestProfileMode(true, { KTX_PROFILE_INGEST: 'json' })).toBe('json');
    expect(resolveIngestProfileMode('json', { KTX_PROFILE_INGEST: '1' })).toBe('json');
  });
});

describe('summary and JSON output', () => {
  function profileWithReconcileDominant() {
    const events = parseTraceEvents(
      [
        traceLine({ at: '2026-05-30T00:00:00.000Z', phase: 'work_unit', event: 'work_unit_executed', durationMs: 10000, data: { unitKey: 'a', status: 'success', agentLoopMs: 10000, stepCount: 12, totalTokens: 40000 } }),
        traceLine({ at: '2026-05-30T00:01:40.000Z', phase: 'reconciliation', event: 'reconciliation_executed', durationMs: 90000 }),
      ].join('\n'),
    );
    return aggregateIngestProfile({ jobId: 'job-sum', events, toolMsByUnit: { a: 2000 } });
  }

  it('produces a headline naming the dominant phase and the model/tool split', () => {
    const profile = profileWithReconcileDominant();
    expect(profile.summary.dominantPhase?.phase).toBe('reconciliation');
    expect(profile.summary.workUnits).toMatchObject({ count: 1, agentLoopMs: 10000, toolMs: 2000, modelMs: 8000, modelPct: 80 });
    expect(profile.summary.headline).toContain('reconciliation');
    expect(profile.summary.headline).toContain('80%');
  });

  it('emits raw structured JSON with stable keys for agents', () => {
    const profile = profileWithReconcileDominant();
    const text = formatIngestProfileJson(profile);
    expect(text).toContain('ktx ingest profile (json)');
    const json = JSON.parse(text.slice(text.indexOf('{')));
    expect(json.jobId).toBe('job-sum');
    expect(json.summary.headline).toEqual(expect.any(String));
    // Raw milliseconds, not human-formatted strings.
    expect(json.workUnits[0].agentLoopMs).toBe(10000);
    expect(json.phases[0].totalMs).toBe(90000);
  });
});
