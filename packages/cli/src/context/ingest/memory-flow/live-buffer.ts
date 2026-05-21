import type {
  MemoryFlowEvent,
  MemoryFlowEventSink,
  MemoryFlowLiveBufferOptions,
  MemoryFlowReplayInput,
  MemoryFlowReplayPatch,
  MemoryFlowRunStatus,
} from './types.js';

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(password|passwd|pwd|token|api[_-]?key|secret)=([^\s&]+)/gi;

function copyReplayInput(input: MemoryFlowReplayInput): MemoryFlowReplayInput {
  return {
    ...input,
    errors: [...input.errors],
    events: [...input.events],
    plannedWorkUnits: input.plannedWorkUnits.map((workUnit) => ({
      ...workUnit,
      rawFiles: [...workUnit.rawFiles],
    })),
    details: {
      actions: input.details.actions.map((action) => ({ ...action, rawFiles: [...action.rawFiles] })),
      provenance: input.details.provenance.map((row) => ({ ...row })),
      transcripts: input.details.transcripts.map((summary) => ({ ...summary, toolNames: [...summary.toolNames] })),
    },
  };
}

function notify(input: MemoryFlowReplayInput, options: MemoryFlowLiveBufferOptions): void {
  options.onChange?.(copyReplayInput(input));
}

function stampEvent(event: MemoryFlowEvent, options: MemoryFlowLiveBufferOptions): MemoryFlowEvent {
  if (event.emittedAt) {
    return { ...event };
  }
  return { ...event, emittedAt: (options.now ?? (() => new Date()))().toISOString() };
}

export function sanitizeMemoryFlowError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(URL_PATTERN, (value) => `${value.slice(0, value.indexOf('://'))}://[redacted]`)
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1=[redacted]');
}

export function createMemoryFlowLiveBuffer(
  initialInput: MemoryFlowReplayInput,
  options: MemoryFlowLiveBufferOptions = {},
): MemoryFlowEventSink {
  let input = copyReplayInput(initialInput);

  return {
    emit(event: MemoryFlowEvent): void {
      input = { ...input, events: [...input.events, stampEvent(event, options)] };
      notify(input, options);
    },

    update(patch: MemoryFlowReplayPatch): void {
      input = copyReplayInput({ ...input, ...patch });
      notify(input, options);
    },

    finish(status: MemoryFlowRunStatus, errors: string[] = input.errors): void {
      input = copyReplayInput({ ...input, status, errors });
      notify(input, options);
    },

    snapshot(): MemoryFlowReplayInput {
      return copyReplayInput(input);
    },
  };
}
