/* @jsxImportSource react */
import type { MemoryFlowEvent, MemoryFlowReplayInput } from '@ktx/context/ingest/memory-flow';
import { Box, Text } from 'ink';
import { type ReactNode } from 'react';
import { buildDemoMetrics, formatCost, formatDuration } from './demo-metrics.js';
import { formatNextStepLines } from './next-steps.js';
import { profileMark } from './startup-profile.js';

profileMark('module:memory-flow-hud');

interface HudTheme {
  text: string;
  muted: string;
  active: string;
  complete: string;
  warning: string;
  failed: string;
  border: string;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

function spinner(frame: number): string {
  return SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '⠋';
}

function counterValue(target: number, frame: number, framesToFill = 12): number {
  if (target <= 0 || frame <= 0) return 0;
  if (frame >= framesToFill) return target;
  return Math.round((frame / framesToFill) * target);
}

function hasWorkStarted(input: MemoryFlowReplayInput): boolean {
  return input.events.some((e) => e.type === 'work_unit_started');
}

function isPrepopulatedDemoReplay(input: MemoryFlowReplayInput): boolean {
  return input.metadata?.origin === 'packaged' || input.metadata?.timing === 'prebuilt';
}

function progressBarOverall(
  finishedCount: number,
  activeCount: number,
  totalCount: number,
  width: number,
  frame: number,
): string {
  if (totalCount === 0) return '░'.repeat(width);

  const finishedWidth = Math.round((finishedCount / totalCount) * width);
  const activeWidth = Math.max(activeCount > 0 ? 1 : 0, Math.round((activeCount / totalCount) * width));
  const queuedWidth = Math.max(0, width - finishedWidth - activeWidth);

  const finished = '█'.repeat(finishedWidth);

  const pulse = ['░', '▒', '▓', '█', '▓', '▒'];
  const pulseLen = pulse.length;
  const offset = (frame * 2) % (activeWidth + pulseLen);
  const activeChars: string[] = [];
  for (let i = 0; i < activeWidth; i += 1) {
    const p = i - offset + pulseLen;
    activeChars.push(p >= 0 && p < pulseLen ? (pulse[p] ?? '▒') : '▒');
  }

  return finished + activeChars.join('') + '░'.repeat(queuedWidth);
}

function topicName(key: string): string {
  return (key.split('/').pop()?.replace(/\.md$/, '') ?? key).replace(/[_-]/g, ' ');
}

function tableName(key: string): string {
  return key.split('.').pop()?.replace(/[_-]/g, ' ') ?? key;
}

function humanizeInsight(key: string, target: 'sl' | 'wiki', summary: string | undefined): string {
  if (summary) return summary;
  const name = target === 'sl' ? tableName(key) : topicName(key);
  return target === 'sl' ? `Query definition: ${name}` : `Wiki page: ${name}`;
}

const INTERNAL_DEMO_CONNECTION_ID = 'orbit_demo';
const PUBLIC_DEMO_SOURCE_LABEL = 'Orbit Demo';

interface SourceInfo {
  type: string;
  name: string;
  sourceCount: string;
  itemNounPlural: string;
  readingVerb: string;
  ingestDescription: string;
}

const ADAPTER_LABELS: Record<string, { type: string; plural: string; verb: string; description: string }> = {
  'live-database': { type: 'Database', plural: 'tables', verb: 'Reading', description: 'Reading table schemas, understanding relationships, creating query definitions' },
  metricflow: { type: 'dbt project', plural: 'models', verb: 'Parsing', description: 'Parsing dbt models, extracting metric definitions, mapping dependencies' },
  looker: { type: 'Looker', plural: 'explores', verb: 'Analyzing', description: 'Analyzing explores, extracting dimensions and measures, mapping joins' },
  lookml: { type: 'LookML', plural: 'views', verb: 'Parsing', description: 'Parsing LookML views, extracting field definitions, mapping relationships' },
  metabase: { type: 'Metabase', plural: 'questions', verb: 'Analyzing', description: 'Analyzing saved questions, extracting query patterns, understanding dashboards' },
  notion: { type: 'Notion', plural: 'pages', verb: 'Reading', description: 'Reading pages, extracting structure, understanding your documentation' },
  'historic-sql': { type: 'SQL history', plural: 'queries', verb: 'Analyzing', description: 'Analyzing query patterns, identifying common joins, learning access patterns' },
  'dbt-descriptions': { type: 'dbt schema', plural: 'models', verb: 'Parsing', description: 'Parsing schema definitions, extracting descriptions, mapping lineage' },
  dbt_descriptions: { type: 'dbt', plural: 'models', verb: 'Parsing', description: 'Parsing schema definitions, extracting descriptions, mapping lineage' },
};

function sourceDescription(input: MemoryFlowReplayInput): SourceInfo {
  const adapter = input.adapter ?? 'source';
  const conn = input.connectionId ?? '';
  const sourceEvents = input.events.filter((e) => e.type === 'source_acquired') as Array<{ type: 'source_acquired'; adapter: string; fileCount: number }>;
  const isDemoSource = conn === INTERNAL_DEMO_CONNECTION_ID || isPrepopulatedDemoReplay(input);

  if (isDemoSource && sourceEvents.length <= 1) {
    const count = sourceEvents[0] ? String(sourceEvents[0].fileCount) : '?';
    return {
      type: PUBLIC_DEMO_SOURCE_LABEL,
      name: '',
      sourceCount: count,
      itemNounPlural: 'sources',
      readingVerb: 'Ingesting',
      ingestDescription: 'Ingesting warehouse, dbt, BI, and docs into a unified context layer',
    };
  }

  if (sourceEvents.length > 1) {
    const totalFiles = sourceEvents.reduce((sum, s) => sum + s.fileCount, 0);
    const labels = [...new Set(sourceEvents.map((s) => ADAPTER_LABELS[s.adapter]?.type ?? s.adapter))];
    return {
      type: labels.join(' + '),
      name: conn,
      sourceCount: String(totalFiles),
      itemNounPlural: 'sources',
      readingVerb: 'Ingesting',
      ingestDescription: 'Ingesting warehouse, dbt, BI, and docs into a unified context layer',
    };
  }

  const count = sourceEvents[0] ? String(sourceEvents[0].fileCount) : '?';
  const info = ADAPTER_LABELS[adapter] ?? { type: adapter, plural: 'sources', verb: 'Reading', description: 'Reading sources, understanding structure, creating definitions' };
  return { type: info.type, name: conn, sourceCount: count, itemNounPlural: info.plural, readingVerb: info.verb, ingestDescription: info.description };
}

function activeWorkUnits(
  input: MemoryFlowReplayInput,
): Array<{ unitKey: string; stepIndex: number; stepBudget: number }> {
  const finishedKeys = new Set<string>();
  const unitMap = new Map<string, { stepIndex: number; stepBudget: number }>();

  for (const e of input.events) {
    if (e.type === 'work_unit_started') {
      unitMap.set(e.unitKey, { stepIndex: 0, stepBudget: e.stepBudget });
    }
    if (e.type === 'work_unit_step') {
      const existing = unitMap.get(e.unitKey);
      if (existing) {
        existing.stepIndex = e.stepIndex;
        existing.stepBudget = e.stepBudget;
      }
    }
    if (e.type === 'work_unit_finished') finishedKeys.add(e.unitKey);
  }

  const result: Array<{ unitKey: string; stepIndex: number; stepBudget: number }> = [];
  for (const [unitKey, data] of unitMap) {
    if (!finishedKeys.has(unitKey)) result.push({ unitKey, ...data });
  }
  return result;
}

function queuedWorkUnits(input: MemoryFlowReplayInput): string[] {
  const startedKeys = new Set<string>();
  for (const e of input.events) {
    if (e.type === 'work_unit_started') startedKeys.add(e.unitKey);
  }
  return input.plannedWorkUnits.filter((u) => !startedKeys.has(u.unitKey)).map((u) => u.unitKey);
}

interface Insight {
  icon: string;
  text: string;
  unitKey: string;
  hasSummary: boolean;
}

function buildInsights(input: MemoryFlowReplayInput): Insight[] {
  return input.events
    .filter((e) => e.type === 'candidate_action')
    .map((e) => {
      const ca = e as { unitKey: string; target: 'sl' | 'wiki'; key: string };
      const detail = input.details.actions.find((a) => a.key === ca.key && a.unitKey === ca.unitKey);
      return {
        icon: ca.target === 'sl' ? '📊' : '📝',
        text: humanizeInsight(ca.key, ca.target, detail?.summary),
        unitKey: ca.unitKey,
        hasSummary: !!detail?.summary,
      };
    });
}

function finishedUnits(input: MemoryFlowReplayInput): Array<{ unitKey: string; artifactCount: number }> {
  const units: Array<{ unitKey: string; artifactCount: number }> = [];
  for (const e of input.events) {
    if (e.type === 'work_unit_finished' && e.status === 'success') {
      const count = input.events.filter((a) => a.type === 'candidate_action' && a.unitKey === e.unitKey).length;
      units.push({ unitKey: e.unitKey, artifactCount: count });
    }
  }
  return units;
}

const KTX_LOGO_SMALL = [
  '██╗  ██╗████████╗██╗  ██╗',
  '██║ ██╔╝╚══██╔══╝╚██╗██╔╝',
  '█████╔╝    ██║    ╚███╔╝ ',
  '██╔═██╗    ██║    ██╔██╗ ',
  '██║  ██╗   ██║   ██╔╝ ██╗',
  '╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝',
] as const;

export function Logo(props: { theme: HudTheme; done: boolean }): ReactNode {
  const color = props.done ? props.theme.complete : props.theme.active;
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      {KTX_LOGO_SMALL.map((line, idx) => (
        <Text key={idx} color={color}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

export function Hud(props: {
  input: MemoryFlowReplayInput;
  theme: HudTheme;
  frame: number;
  width: number;
  now?: () => number;
}): ReactNode {
  const src = sourceDescription(props.input);
  const metrics = buildDemoMetrics(props.input, props.now ? { now: props.now } : {});
  const workStarted = hasWorkStarted(props.input);

  const sourceEvents = props.input.events.filter((e) => e.type === 'source_acquired');
  const col1Content = sourceEvents.length > 1 || !src.name ? src.type : `${src.type} (${src.name})`;

  const innerWidth = Math.max(60, props.width - 6);

  const hLine = '─'.repeat(innerWidth);

  const elapsed = formatDuration(metrics.elapsedMs);
  let eta = '';
  if (metrics.status === 'running' && metrics.etaMs !== null) eta = `~${formatDuration(metrics.etaMs)} left`;
  else if (metrics.status !== 'running') eta = 'done';
  const cost = workStarted ? formatCost(metrics.estimatedCostUsd) : '';
  const statsParts = [`⏱ ${elapsed}`, eta, cost].filter(Boolean).join('    ');
  const prepopulatedCostDisclaimer =
    cost && isPrepopulatedDemoReplay(props.input)
      ? 'Pre-run demo: $ shown is illustrative; no money is being spent now.'
      : null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={props.theme.border}> ╭{hLine}╮</Text>
      <Text>
        <Text color={props.theme.border}> │ </Text>
        <Text color={props.theme.text}>{col1Content}</Text>
        <Text color={props.theme.muted}> — {src.sourceCount} {src.itemNounPlural}</Text>
      </Text>
      <Text>
        <Text color={props.theme.border}> │ </Text>
        <Text color="#b8860b">{statsParts}</Text>
      </Text>
      {prepopulatedCostDisclaimer && (
        <Text>
          <Text color={props.theme.border}> │ </Text>
          <Text color={props.theme.muted}>{prepopulatedCostDisclaimer}</Text>
        </Text>
      )}
      <Text color={props.theme.border}> ╰{hLine}╯</Text>
    </Box>
  );
}

export function ActivityFeed(props: {
  input: MemoryFlowReplayInput;
  theme: HudTheme;
  frame: number;
  width: number;
  completionFrame: number;
  showCompletion: boolean;
  holdComplete: boolean;
}): ReactNode {
  const actives = activeWorkUnits(props.input);
  const queued = queuedWorkUnits(props.input);
  const finished = finishedUnits(props.input);
  const insights = buildInsights(props.input);
  const src = sourceDescription(props.input);
  const isDone = props.input.status === 'done';
  const isError = props.input.status === 'error';

  const diffEvent = props.input.events.find((e) => e.type === 'diff_computed') as
    | (MemoryFlowEvent & { added: number; modified: number; deleted: number; unchanged: number })
    | undefined;
  const planEvent = props.input.events.find((e) => e.type === 'chunks_planned') as
    | (MemoryFlowEvent & { chunkCount: number; workUnitCount: number })
    | undefined;
  const reconEvent = props.input.events.find((e) => e.type === 'reconciliation_finished') as
    | (MemoryFlowEvent & { conflictCount: number })
    | undefined;
  const savedEvent = props.input.events.find((e) => e.type === 'saved');

  const workStarted = hasWorkStarted(props.input);
  const totalChunks = planEvent?.chunkCount ?? 0;
  const finishedAreas = totalChunks > 0 ? Math.min(finished.length, totalChunks) : finished.length;
  const allWorkDone = workStarted && actives.length === 0 && queued.length === 0;
  const isReconciling = allWorkDone && !reconEvent && !isDone && !isError;
  const isSaving = reconEvent && !savedEvent && !isDone && !isError;

  const isIncremental = diffEvent && (diffEvent.modified > 0 || diffEvent.deleted > 0 || diffEvent.unchanged > 0);

  const barWidth = Math.min(40, props.width - 20);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {/* Phase 1: Connecting */}
      {!diffEvent && !workStarted && (
        <Text color={props.theme.active}>
          {spinner(props.frame)} Connecting to {src.type.toLowerCase()}...
        </Text>
      )}

      {/* Phase 2: Connected */}
      {diffEvent && (
        <Text color={props.theme.complete}>
          ✓ Connected — found {src.sourceCount} {src.itemNounPlural} to ingest
        </Text>
      )}

      {/* Phase 2b: Diff (incremental runs only) */}
      {diffEvent && isIncremental && (
        <Text color={props.theme.complete}>
          ✓ Compared with last sync — only re-analyzing what changed
        </Text>
      )}

      {/* Phase 3: Planning */}
      {diffEvent && !planEvent && !workStarted && (
        <Text color={props.theme.active}>
          {spinner(props.frame)} Grouping related {src.itemNounPlural} together for deeper analysis...
        </Text>
      )}
      {planEvent && (
        <Text color={props.theme.complete}>
          ✓ Grouped into {planEvent.chunkCount} business area{planEvent.chunkCount === 1 ? '' : 's'}
        </Text>
      )}

      {/* Phase 4: Ingesting */}
      {workStarted && !allWorkDone && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={props.theme.active}>
            {spinner(props.frame)} Ingesting — {finishedAreas}/{totalChunks || '?'} business area{totalChunks === 1 ? '' : 's'} done
          </Text>
          <Text color={props.theme.muted}>
            {'  '}{src.ingestDescription}
          </Text>
          {totalChunks > 0 && (
            <Text color={props.theme.active}>
              {'  '}
              {progressBarOverall(finishedAreas, actives.length, totalChunks, barWidth, props.frame)}
            </Text>
          )}
        </Box>
      )}

      {/* Results — what KTX has created */}
      {insights.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={props.theme.text}>  Created so far:</Text>
          {insights.map((insight, idx) => (
            <Text key={`result-${idx}`} color={props.theme.muted}>
              {'    '}{insight.icon} {insight.text}
            </Text>
          ))}
        </Box>
      )}

      {/* Phase 5: Finalizing */}
      {isReconciling && (
        <Text color={props.theme.active}>
          {spinner(props.frame)} Deduplicating — removing overlaps between business areas and checking for conflicts...
        </Text>
      )}
      {reconEvent && (
        <Text color={props.theme.complete}>
          ✓ Deduplicated
          {reconEvent.conflictCount > 0
            ? ` — ${reconEvent.conflictCount} conflict${reconEvent.conflictCount === 1 ? '' : 's'} resolved`
            : ' — no conflicts'}
        </Text>
      )}

      {/* Phase 6: Saving */}
      {isSaving && (
        <Text color={props.theme.active}>{spinner(props.frame)} Saving to context layer...</Text>
      )}
      {savedEvent && (
        <Text color={props.theme.complete}>✓ Saved — your agents can now use the KTX context layer</Text>
      )}

      {/* Phase 7: Completion */}
      {props.showCompletion && (isDone || isError) && (
        <CompletionSummary input={props.input} theme={props.theme} frame={props.completionFrame} holdComplete={props.holdComplete} />
      )}
    </Box>
  );
}

function CompletionSummary(props: {
  input: MemoryFlowReplayInput;
  theme: HudTheme;
  frame: number;
  holdComplete: boolean;
}): ReactNode {
  const saved = [...props.input.events].reverse().find((e) => e.type === 'saved');
  const wikiCount = saved?.wikiCount ?? 0;
  const slCount = saved?.slCount ?? 0;
  const isError = props.input.status === 'error';

  const sl = counterValue(slCount, props.frame);
  const wiki = counterValue(wikiCount, props.frame);

  return (
    <Box flexDirection="column" marginTop={1}>
      {isError ? (
        <Text bold color={props.theme.failed}>
          ✗ Something went wrong — review the errors above.
        </Text>
      ) : (
        <>
          <Text color={props.theme.border}>{'─'.repeat(60)}</Text>
          <Text bold color={props.theme.complete}>
            ★ KTX finished ingesting your data
          </Text>
          {(sl > 0 || wiki > 0) && (
            <>
              <Text />
              <Text color={props.theme.text}>KTX created:</Text>
              {sl > 0 && (
                <Text color={props.theme.active}>
                  {'  '}📊 {sl} query definition{sl === 1 ? '' : 's'} — so agents can write accurate SQL for your data
                </Text>
              )}
              {wiki > 0 && (
                <Text color={props.theme.complete}>
                  {'  '}📝 {wiki} wiki page{wiki === 1 ? '' : 's'} — so agents understand your business context
                </Text>
              )}
            </>
          )}
          <Text />
          <Text color={props.theme.text}>What to do next:</Text>
          {formatNextStepLines().map((line) => (
            <Text key={line} color={props.theme.active}>
              {line}
            </Text>
          ))}
          {props.holdComplete && (
            <>
              <Text />
              <Text color={props.theme.muted}>Press q to exit</Text>
            </>
          )}
        </>
      )}
    </Box>
  );
}
