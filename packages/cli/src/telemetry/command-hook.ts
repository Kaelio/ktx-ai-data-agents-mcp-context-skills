import { scrubErrorClass } from './scrubber.js';

export type CommandOutcome = 'ok' | 'error' | 'aborted';

interface CommandSpan {
  commandPath: string[];
  argv: string[];
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

/** @internal */
export function extractFlagsPresent(argv: string[]): Record<string, boolean> {
  const flags: Record<string, boolean> = {};

  for (const arg of argv) {
    if (arg.startsWith('--') && arg.length > 2) {
      const [name] = arg.slice(2).split('=', 1);
      if (name) {
        flags[name] = true;
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      for (const shortFlag of arg.slice(1)) {
        flags[shortFlag] = true;
      }
    }
  }

  return flags;
}

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
    flagsPresent: extractFlagsPresent(span.argv),
    hasProject: span.hasProject,
    projectDir: span.projectDir,
    projectGroupAttached: span.attachProjectGroup,
  };
}

/** @internal */
export function resetCommandSpan(): void {
  activeCommandSpan = undefined;
}
