import { scrubErrorClass } from './scrubber.js';

export type CommandOutcome = 'ok' | 'error' | 'aborted';

interface CommandSpan {
  commandPath: string[];
  flagsPresent: Record<string, boolean>;
  projectDir?: string;
  hasProject: boolean;
  attachProjectGroup: boolean;
  startedAt: number;
}

export interface CompletedCommandSpan {
  commandPath: string[];
  durationMs: number;
  outcome: CommandOutcome;
  errorClass?: string;
  flagsPresent: Record<string, boolean>;
  hasProject: boolean;
  projectDir?: string;
  projectGroupAttached: boolean;
}

let activeCommandSpan: CommandSpan | undefined;

export function beginCommandSpan(input: CommandSpan): void {
  activeCommandSpan = input;
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

  const errorClass = input.error ? scrubErrorClass(input.error) : undefined;

  return {
    commandPath: span.commandPath,
    durationMs: Math.max(0, input.completedAt - span.startedAt),
    outcome: input.outcome,
    ...(errorClass ? { errorClass } : {}),
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
