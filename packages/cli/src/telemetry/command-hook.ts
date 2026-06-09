import { formatErrorDetail, scrubErrorClass } from './scrubber.js';

export type CommandOutcome = 'ok' | 'error' | 'aborted';

interface CommandSpan {
  commandPath: string[];
  flagsPresent: Record<string, boolean>;
  projectDir?: string;
  hasProject: boolean;
  attachProjectGroup: boolean;
  startedAt: number;
  annotatedOutcome?: CommandOutcome;
  annotatedErrorClass?: string;
  annotatedErrorDetail?: string;
}

export interface CompletedCommandSpan {
  commandPath: string[];
  durationMs: number;
  outcome: CommandOutcome;
  errorClass?: string;
  errorDetail?: string;
  flagsPresent: Record<string, boolean>;
  hasProject: boolean;
  projectDir?: string;
  projectGroupAttached: boolean;
}

let activeCommandSpan: CommandSpan | undefined;

export function beginCommandSpan(input: CommandSpan): void {
  activeCommandSpan = input;
}

/**
 * Let a command action record the true outcome and reason on the active span.
 *
 * The Commander wrapper can only derive an outcome from a thrown error or the
 * process exit code, so a command that exits non-zero *without throwing* (e.g.
 * `ktx setup` when the user abandons the wizard) lands as `outcome: 'error'`
 * with no `errorClass`/`errorDetail` — an unactionable blank in the dashboard.
 * The action is the decision-maker: it can mark the run `aborted`, or attach a
 * scrubbed reason so the next occurrence is self-diagnosing. A later thrown
 * error still wins (see {@link completeCommandSpan}), since that is the most
 * authoritative signal and also feeds the `$exception` stream. No-ops when no
 * span is active so call sites stay safe in tests and bare-help paths.
 *
 * Values are emitted verbatim and must already satisfy the telemetry privacy
 * rules — pass synthetic or already-scrubbed strings, never raw user input.
 */
export function annotateCommandOutcome(input: {
  outcome?: CommandOutcome;
  errorClass?: string;
  errorDetail?: string;
}): void {
  if (!activeCommandSpan) {
    return;
  }
  if (input.outcome !== undefined) {
    activeCommandSpan.annotatedOutcome = input.outcome;
  }
  if (input.errorClass !== undefined) {
    activeCommandSpan.annotatedErrorClass = input.errorClass;
  }
  if (input.errorDetail !== undefined) {
    activeCommandSpan.annotatedErrorDetail = input.errorDetail;
  }
}

export function completeCommandSpan(input: {
  completedAt: number;
  outcome: CommandOutcome;
  error?: unknown;
}): CompletedCommandSpan | undefined {
  const span = activeCommandSpan;
  activeCommandSpan = undefined;
  if (!span) {
    return undefined;
  }

  // Precedence: a thrown error is authoritative; otherwise an action's own
  // annotation; otherwise the wrapper's exit-code-derived outcome.
  const thrown = Boolean(input.error);
  const outcome = thrown ? input.outcome : (span.annotatedOutcome ?? input.outcome);
  const errorClass = thrown ? scrubErrorClass(input.error) : span.annotatedErrorClass;
  const errorDetail = thrown ? formatErrorDetail(input.error) : span.annotatedErrorDetail;

  return {
    commandPath: span.commandPath,
    durationMs: Math.max(0, input.completedAt - span.startedAt),
    outcome,
    ...(errorClass ? { errorClass } : {}),
    ...(errorDetail ? { errorDetail } : {}),
    flagsPresent: span.flagsPresent,
    hasProject: span.hasProject,
    projectDir: span.projectDir,
    projectGroupAttached: span.attachProjectGroup,
  };
}

/** @internal */
export function resetCommandSpan(): void {
  activeCommandSpan = undefined;
}
