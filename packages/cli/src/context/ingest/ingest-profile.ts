import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export interface IngestProfilePaths {
  tracePath: string;
  transcriptDir: string;
}

/**
 * Post-processor over the ingest trace (`<home>/ingest-traces/<jobId>/trace.jsonl`)
 * and per-work-unit tool transcripts. Turns the durations recorded during a run
 * into a rolled-up "where did the time go" view. Gated for display by
 * `KTX_PROFILE_INGEST`; the durations themselves are always written to the trace.
 */

const traceEventSchema = z
  .object({
    at: z.string().optional(),
    phase: z.string(),
    event: z.string(),
    durationMs: z.number().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

/** @internal */
export type ProfiledTraceEvent = z.infer<typeof traceEventSchema>;

export interface IngestProfile {
  jobId: string;
  totalWallMs?: number;
  phases: Array<{
    phase: string;
    totalMs: number;
    /** Number of timed (durationMs-bearing) events that contributed to this phase. */
    count: number;
  }>;
  workUnits: Array<{
    unitKey: string;
    status?: string;
    /** Wall-clock for the whole work-unit run (agent loop + validation + git). */
    totalMs?: number;
    /** Pure `generateText` agent-loop time reported by the runtime. */
    agentLoopMs?: number;
    /** Summed tool-execution time from the work-unit transcript. */
    toolMs?: number;
    /** Derived model "thinking" time = agentLoopMs - toolMs (clamped at 0). */
    modelMs?: number;
    /** Worktree create time. */
    createMs?: number;
    /** Worktree teardown time. */
    cleanupMs?: number;
    stepCount?: number;
    totalTokens?: number;
  }>;
  workUnitCount: number;
  failedWorkUnitCount: number;
  /**
   * Plain-language diagnosis plus the raw numbers behind it, so a reader (human
   * or coding agent) gets the conclusion without re-deriving it from the tables.
   */
  summary: {
    /** One-sentence conclusion, e.g. which phase dominated and whether work was model- or tool-bound. */
    headline: string;
    dominantPhase?: { phase: string; totalMs: number; pctOfWall?: number };
    /** Aggregate across all work units, in milliseconds. */
    workUnits?: {
      count: number;
      failed: number;
      agentLoopMs: number;
      modelMs: number;
      toolMs: number;
      /** Percent of agent-loop time spent in model generation vs tool execution. */
      modelPct?: number;
    };
  };
}

type IngestWorkUnitTiming = IngestProfile['workUnits'][number];

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** @internal */
export function parseTraceEvents(traceText: string): ProfiledTraceEvent[] {
  const events: ProfiledTraceEvent[] = [];
  for (const line of traceText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = traceEventSchema.safeParse(json);
    if (parsed.success) {
      events.push(parsed.data);
    }
  }
  return events;
}

/** @internal */
export function aggregateIngestProfile(input: {
  jobId: string;
  events: ProfiledTraceEvent[];
  toolMsByUnit: Record<string, number>;
}): IngestProfile {
  const { jobId, events, toolMsByUnit } = input;

  const phaseTotals = new Map<string, { totalMs: number; count: number }>();
  const workUnits = new Map<string, IngestWorkUnitTiming>();

  const wu = (unitKey: string): IngestWorkUnitTiming => {
    let existing = workUnits.get(unitKey);
    if (!existing) {
      existing = { unitKey };
      workUnits.set(unitKey, existing);
    }
    return existing;
  };

  let minAt = Number.POSITIVE_INFINITY;
  let maxAt = Number.NEGATIVE_INFINITY;

  for (const event of events) {
    const at = event.at ? Date.parse(event.at) : Number.NaN;
    if (!Number.isNaN(at)) {
      minAt = Math.min(minAt, at);
      maxAt = Math.max(maxAt, at);
    }

    if (event.durationMs !== undefined) {
      const bucket = phaseTotals.get(event.phase) ?? { totalMs: 0, count: 0 };
      bucket.totalMs += event.durationMs;
      bucket.count += 1;
      phaseTotals.set(event.phase, bucket);
    }

    const data = event.data ?? {};
    const unitKey = asString(data.unitKey);
    if (unitKey) {
      const entry = wu(unitKey);
      if (event.event === 'work_unit_executed') {
        entry.totalMs = event.durationMs;
        entry.agentLoopMs = asNumber(data.agentLoopMs);
        entry.stepCount = asNumber(data.stepCount);
        entry.totalTokens = asNumber(data.totalTokens);
        entry.status = asString(data.status) ?? entry.status;
      } else if (event.event === 'work_unit_child_created') {
        entry.createMs = event.durationMs;
      } else if (event.event === 'work_unit_child_cleanup') {
        entry.cleanupMs = event.durationMs;
      } else if (event.event === 'work_unit_failed_before_patch') {
        entry.status = entry.status ?? 'failed';
      }
    }
  }

  for (const [unitKey, entry] of workUnits) {
    const toolMs = toolMsByUnit[unitKey];
    if (toolMs !== undefined) {
      entry.toolMs = toolMs;
      if (entry.agentLoopMs !== undefined) {
        entry.modelMs = Math.max(0, entry.agentLoopMs - toolMs);
      }
    } else if (entry.agentLoopMs !== undefined) {
      entry.modelMs = entry.agentLoopMs;
    }
  }

  const phases = [...phaseTotals.entries()]
    .map(([phase, { totalMs, count }]) => ({ phase, totalMs, count }))
    .sort((a, b) => b.totalMs - a.totalMs);

  const workUnitList = [...workUnits.values()].sort((a, b) => (b.totalMs ?? 0) - (a.totalMs ?? 0));
  const totalWallMs = Number.isFinite(minAt) && Number.isFinite(maxAt) && maxAt >= minAt ? maxAt - minAt : undefined;
  const failedWorkUnitCount = workUnitList.filter((entry) => entry.status === 'failed').length;

  return {
    jobId,
    ...(totalWallMs !== undefined ? { totalWallMs } : {}),
    phases,
    workUnits: workUnitList,
    workUnitCount: workUnitList.length,
    failedWorkUnitCount,
    summary: buildSummary(phases, workUnitList, failedWorkUnitCount, totalWallMs),
  };
}

function buildSummary(
  phases: IngestProfile['phases'],
  workUnits: IngestWorkUnitTiming[],
  failed: number,
  totalWallMs: number | undefined,
): IngestProfile['summary'] {
  const dominant = phases[0];
  const dominantPhase = dominant
    ? {
        phase: dominant.phase,
        totalMs: dominant.totalMs,
        ...(totalWallMs && totalWallMs > 0
          ? { pctOfWall: Math.round((dominant.totalMs / totalWallMs) * 100) }
          : {}),
      }
    : undefined;

  const agentLoopMs = workUnits.reduce((sum, wu) => sum + (wu.agentLoopMs ?? 0), 0);
  const toolMs = workUnits.reduce((sum, wu) => sum + (wu.toolMs ?? 0), 0);
  const modelMs = workUnits.reduce((sum, wu) => sum + (wu.modelMs ?? 0), 0);
  const workUnitAggregate =
    workUnits.length > 0
      ? {
          count: workUnits.length,
          failed,
          agentLoopMs,
          modelMs,
          toolMs,
          ...(agentLoopMs > 0 ? { modelPct: Math.round((modelMs / agentLoopMs) * 100) } : {}),
        }
      : undefined;

  const parts: string[] = [];
  if (dominantPhase) {
    const pct = dominantPhase.pctOfWall !== undefined ? `, ${dominantPhase.pctOfWall}% of wall time` : '';
    parts.push(`Slowest phase: ${dominantPhase.phase} (${formatMs(dominantPhase.totalMs)}${pct})`);
  }
  if (workUnitAggregate) {
    const split =
      workUnitAggregate.modelPct !== undefined
        ? `, ~${workUnitAggregate.modelPct}% model generation vs ~${100 - workUnitAggregate.modelPct}% tools`
        : '';
    parts.push(
      `${workUnitAggregate.count} work unit${workUnitAggregate.count === 1 ? '' : 's'}${
        failed > 0 ? ` (${failed} failed)` : ''
      }${split}`,
    );
  }
  const headline = parts.length > 0 ? parts.join('. ') + '.' : 'No timed phases recorded.';

  return {
    headline,
    ...(dominantPhase ? { dominantPhase } : {}),
    ...(workUnitAggregate ? { workUnits: workUnitAggregate } : {}),
  };
}

/** Read the trace and tool transcripts for a job and aggregate them into a profile. */
export async function readIngestProfile(
  jobId: string,
  paths: IngestProfilePaths,
): Promise<IngestProfile> {
  const traceText = await readFile(paths.tracePath, 'utf-8');
  const events = parseTraceEvents(traceText);
  const toolMsByUnit = await readToolMsByUnit(paths.transcriptDir);
  return aggregateIngestProfile({ jobId, events, toolMsByUnit });
}

async function listTranscriptFiles(dir: string): Promise<string[]> {
  // Work-unit keys can contain slashes (e.g. "cards/marketing"), so the runner
  // writes nested transcript files (".../cards/marketing.jsonl"). Walk
  // recursively and bucket by the `wuKey` field inside each entry rather than
  // by file name.
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTranscriptFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
  return files;
}

async function readToolMsByUnit(transcriptDir: string): Promise<Record<string, number>> {
  const toolMs: Record<string, number> = {};
  for (const file of await listTranscriptFiles(transcriptDir)) {
    let text: string;
    try {
      text = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const entry = JSON.parse(trimmed) as { wuKey?: unknown; durationMs?: unknown };
        const wuKey = asString(entry.wuKey);
        const ms = asNumber(entry.durationMs);
        if (wuKey && ms !== undefined) {
          toolMs[wuKey] = (toolMs[wuKey] ?? 0) + ms;
        }
      } catch {
        // skip malformed line
      }
    }
  }
  return toolMs;
}

function formatMs(ms: number | undefined): string {
  if (ms === undefined) {
    return '—';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds - minutes * 60);
  return `${minutes}m ${String(rem).padStart(2, '0')}s`;
}

function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) {
    return '—';
  }
  if (tokens < 1000) {
    return String(tokens);
  }
  return `${(tokens / 1000).toFixed(1)}k`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

/** Render a human-readable profile table for stderr / the admin command. */
export function formatIngestProfile(profile: IngestProfile, options: { topWorkUnits?: number } = {}): string {
  const topWorkUnits = options.topWorkUnits ?? 10;
  const lines: string[] = [];
  lines.push(`ktx ingest profile — job ${profile.jobId}`);
  if (profile.totalWallMs !== undefined) {
    lines.push(`  total wall time: ${formatMs(profile.totalWallMs)}`);
  }
  lines.push(`  ${profile.summary.headline}`);

  const wall = profile.totalWallMs;
  lines.push('');
  lines.push('  Phase breakdown (by total duration):');
  if (profile.phases.length === 0) {
    lines.push('    (no timed phases recorded)');
  }
  for (const phase of profile.phases) {
    const pct = wall && wall > 0 ? `(${((phase.totalMs / wall) * 100).toFixed(1)}%)` : '';
    lines.push(
      `    ${pad(phase.phase, 22)}${padStart(formatMs(phase.totalMs), 9)}  ${padStart(pct, 8)}  ${padStart(
        String(phase.count),
        4,
      )} event${phase.count === 1 ? '' : 's'}`,
    );
  }

  if (profile.workUnits.length > 0) {
    lines.push('');
    lines.push(`  Work units (top ${Math.min(topWorkUnits, profile.workUnits.length)} slowest):`);
    lines.push(
      `    ${pad('unitKey', 30)}${padStart('total', 9)}${padStart('model', 9)}${padStart('tool', 9)}${padStart(
        'steps',
        8,
      )}${padStart('tokens', 9)}  status`,
    );
    for (const entry of profile.workUnits.slice(0, topWorkUnits)) {
      const steps = entry.stepCount !== undefined ? String(entry.stepCount) : '—';
      lines.push(
        `    ${pad(entry.unitKey.slice(0, 30), 30)}${padStart(formatMs(entry.totalMs), 9)}${padStart(
          formatMs(entry.modelMs),
          9,
        )}${padStart(formatMs(entry.toolMs), 9)}${padStart(steps, 8)}${padStart(
          formatTokens(entry.totalTokens),
          9,
        )}  ${entry.status ?? '—'}`,
      );
    }
    lines.push(
      `    (${profile.workUnitCount} work unit${profile.workUnitCount === 1 ? '' : 's'} total; ${
        profile.failedWorkUnitCount
      } failed)`,
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Machine-readable rendering for coding agents: the full structured profile
 * (raw milliseconds and token counts, stable keys) as a single JSON object
 * under a stable marker line so it is easy to locate and parse in stderr.
 */
export function formatIngestProfileJson(profile: IngestProfile): string {
  return `ktx ingest profile (json)\n${JSON.stringify(profile, null, 2)}\n`;
}

export type IngestProfileMode = 'off' | 'table' | 'json';

/**
 * Resolve how (and whether) to emit the ingest profile, from the
 * `ingest.profile` config value and the `KTX_PROFILE_INGEST` env var. Either
 * source may request `json` (raw, agent-friendly) or a human `table`; `json`
 * wins if either asks for it.
 */
export function resolveIngestProfileMode(
  configValue: boolean | 'json' | undefined,
  env: NodeJS.ProcessEnv = process.env,
): IngestProfileMode {
  const envValue = env.KTX_PROFILE_INGEST;
  if (configValue === 'json' || envValue === 'json') {
    return 'json';
  }
  const wantsTable =
    configValue === true || envValue === '1' || envValue === 'true' || envValue === 'table';
  return wantsTable ? 'table' : 'off';
}
