type MemoryFlowReplayMode = 'full' | 'deterministic' | 'replay' | 'seeded';
type MemoryFlowReplayOrigin = 'captured' | 'packaged' | 'synthetic-report';
type MemoryFlowReplayTiming = 'captured' | 'synthetic' | 'not-captured' | 'prebuilt';

interface MemoryFlowReplayMetadata {
  schemaVersion: 1;
  mode: MemoryFlowReplayMode;
  origin: MemoryFlowReplayOrigin;
  timing: MemoryFlowReplayTiming;
  capturedAt: string | null;
  sourceReportId: string | null;
  sourceReportPath: string | null;
  fallbackReason: string | null;
}

type MemoryFlowEventPayload =
  | {
      type: 'source_acquired';
      adapter: string;
      trigger: string;
      fileCount: number;
    }
  | { type: 'scope_detected'; fingerprint: string | null }
  | {
      type: 'raw_snapshot_written';
      syncId: string;
      rawFileCount: number;
    }
  | {
      type: 'diff_computed';
      added: number;
      modified: number;
      deleted: number;
      unchanged: number;
    }
  | {
      type: 'chunks_planned';
      chunkCount: number;
      workUnitCount: number;
      evictionCount: number;
    }
  | {
      type: 'stage_skipped';
      stage: MemoryFlowColumnId;
      reason: string;
    }
  | {
      type: 'stage_progress';
      stage:
        | 'source'
        | 'integration'
        | 'reconciliation'
        | 'finalization'
        | 'wiki_sl_ref_repair'
        | 'final_gates'
        | 'save'
        | 'provenance'
        | 'report';
      percent: number;
      message: string;
      transient?: boolean;
    }
  | {
      type: 'rate_limit_wait';
      provider: string;
      rateLimitType?: string;
      resumeAtMs: number;
      remainingMs: number;
    }
  | {
      type: 'work_unit_started';
      unitKey: string;
      skills: string[];
    }
  | {
      type: 'work_unit_step';
      unitKey: string;
      toolCalls: number;
    }
  | {
      type: 'candidate_action';
      unitKey: string;
      target: 'wiki' | 'sl';
      action: string;
      key: string;
    }
  | {
      type: 'work_unit_finished';
      unitKey: string;
      status: 'success' | 'failed';
      reason?: string;
    }
  | {
      type: 'reconciliation_finished';
      conflictCount: number;
      fallbackCount: number;
    }
  | {
      type: 'saved';
      commitSha: string | null;
      wikiCount: number;
      slCount: number;
    }
  | { type: 'provenance_recorded'; rowCount: number }
  | { type: 'report_created'; runId: string; reportPath?: string };

export type MemoryFlowEvent = MemoryFlowEventPayload & { emittedAt?: string };

export type MemoryFlowRunStatus = 'running' | 'done' | 'error';

export interface MemoryFlowPlannedWorkUnit {
  unitKey: string;
  rawFiles: string[];
  peerFileCount: number;
  dependencyCount: number;
}

export interface MemoryFlowActionDetail {
  unitKey: string;
  target: 'wiki' | 'sl';
  action: 'created' | 'updated' | 'removed';
  key: string;
  summary: string;
  rawFiles: string[];
  status: 'success' | 'failed';
}

interface MemoryFlowProvenanceDetail {
  rawPath: string;
  artifactKind: 'sl' | 'wiki' | null;
  artifactKey: string | null;
  actionType: string;
}

interface MemoryFlowTranscriptDetail {
  unitKey: string;
  path: string;
  toolCallCount: number;
  errorCount: number;
  toolNames: string[];
}

export interface MemoryFlowDetailSections {
  actions: MemoryFlowActionDetail[];
  provenance: MemoryFlowProvenanceDetail[];
  transcripts: MemoryFlowTranscriptDetail[];
}

export interface MemoryFlowReplayInput {
  metadata?: MemoryFlowReplayMetadata;
  runId: string;
  connectionId: string;
  adapter: string;
  status: MemoryFlowRunStatus;
  sourceDir: string | null;
  syncId: string;
  reportId?: string;
  reportPath?: string;
  errors: string[];
  events: MemoryFlowEvent[];
  plannedWorkUnits: MemoryFlowPlannedWorkUnit[];
  details: MemoryFlowDetailSections;
}

export type MemoryFlowReplayPatch = Partial<Omit<MemoryFlowReplayInput, 'events'>>;

export interface MemoryFlowEventSink {
  emit(event: MemoryFlowEvent): void;
  update(patch: MemoryFlowReplayPatch): void;
  finish(status: MemoryFlowRunStatus, errors?: string[]): void;
  snapshot(): MemoryFlowReplayInput;
}

export interface MemoryFlowLiveBufferOptions {
  onChange?(snapshot: MemoryFlowReplayInput): void;
  now?: () => Date;
}

export type MemoryFlowColumnId = 'source' | 'chunks' | 'workUnits' | 'actions' | 'gates' | 'saved';
export type MemoryFlowDisplayStatus = 'waiting' | 'active' | 'complete' | 'warning' | 'failed';

export interface MemoryFlowChip {
  label: string;
  status: MemoryFlowDisplayStatus;
  detail?: string;
}

export interface MemoryFlowColumnView {
  id: MemoryFlowColumnId;
  title: string;
  status: MemoryFlowDisplayStatus;
  headline: string;
  counters: string[];
  chips: MemoryFlowChip[];
  details: string[];
}

export interface MemoryFlowTrustIssue {
  id: string;
  severity: 'warning' | 'failed';
  title: string;
  detail: string;
  columnId: MemoryFlowColumnId;
  targetLabel?: string;
}

export interface MemoryFlowSearchMatch {
  columnId: MemoryFlowColumnId;
  chipIndex?: number;
  label: string;
  detail: string;
}

export interface MemoryFlowViewModel {
  title: string;
  subtitle: string;
  status: MemoryFlowRunStatus;
  activeLine: string;
  columns: MemoryFlowColumnView[];
  trustIssues: MemoryFlowTrustIssue[];
  selectedTitle: string;
  selectedDetails: string[];
  completionLine: string | null;
  details: MemoryFlowDetailSections;
}

export interface MemoryFlowRenderOptions {
  terminalWidth?: number;
}

export type MemoryFlowPaneId = 'overview' | 'trust' | 'details' | 'log' | 'provenance' | 'transcript';
export type MemoryFlowFilterMode = 'all' | 'failed_or_flagged';

interface MemoryFlowSearchState {
  editing: boolean;
  query: string;
  matchIndex: number;
}

export interface MemoryFlowInteractionState {
  selectedColumnId: MemoryFlowColumnId;
  selectedChipIndex: number;
  expanded: boolean;
  pane: MemoryFlowPaneId;
  filter: MemoryFlowFilterMode;
  search: MemoryFlowSearchState;
  shouldQuit: boolean;
}

export type MemoryFlowInteractionCommand =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'enter'
  | 'tab'
  | 'filter'
  | 'provenance'
  | 'transcript'
  | 'search-start'
  | 'search-submit'
  | 'search-backspace'
  | 'search-clear'
  | 'search-next'
  | 'search-previous'
  | 'quit'
  | { type: 'search-input'; value: string };
