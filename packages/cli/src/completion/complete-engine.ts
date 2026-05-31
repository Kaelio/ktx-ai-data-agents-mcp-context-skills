import type { CommandUnknownOpts, Option } from '@commander-js/extra-typings';

/**
 * Dynamic completion candidates that depend on project state (semantic-layer
 * source names, wiki page keys, connection ids). Injected so the engine stays
 * pure and unit-testable without touching the filesystem.
 */
export interface CompletionProviders {
  /** Candidate operands for a positional argument of the active command path. */
  positionalCandidates(commandPath: string[], typedTokens: string[]): Promise<string[]>;
  /** Candidate values for an option that has no static `choices` (e.g. `--connection-id`). */
  optionValueCandidates(commandPath: string[], optionFlag: string, typedTokens: string[]): Promise<string[]>;
}

interface ResolvedCommand {
  command: CommandUnknownOpts;
  /** Subcommand names from the root down to the active command (root name excluded). */
  commandPath: string[];
}

function isHiddenCommand(command: CommandUnknownOpts): boolean {
  // Completion mirrors `ktx --help`: commands registered with `{ hidden: true }`
  // (the `__complete` helper and `mcp serve-internal`) are internal and must not
  // surface. Commander exposes this only through the private `_hidden` field its
  // own help renderer reads, so a name heuristic like a `__` prefix is not enough.
  return (command as { _hidden?: boolean })._hidden === true;
}

function resolveCommand(program: CommandUnknownOpts, typedTokens: string[]): ResolvedCommand {
  let command: CommandUnknownOpts = program;
  const commandPath: string[] = [];
  for (let index = 0; index < typedTokens.length; index += 1) {
    const token = typedTokens[index];
    if (token.startsWith('-')) {
      // A value-taking option in the `--flag value` form consumes the next token
      // as its value, so skip that value before matching subcommands. Otherwise a
      // connection id like `query` would be resolved as the `sl query` subcommand
      // instead of being treated as the `--connection-id` value. The `--flag=value`
      // form carries its own value and consumes nothing extra.
      if (!token.includes('=')) {
        const option = findOption(command, token);
        if (option && !option.isBoolean()) {
          index += 1;
        }
      }
      continue;
    }
    const sub = command.commands.find((candidate) => candidate.name() === token || candidate.aliases().includes(token));
    if (sub) {
      command = sub;
      commandPath.push(sub.name());
    }
  }
  return { command, commandPath };
}

function collectOptions(command: CommandUnknownOpts): Option[] {
  const options: Option[] = [];
  let current: CommandUnknownOpts | null = command;
  while (current) {
    options.push(...current.options);
    current = current.parent;
  }
  return options;
}

function findOption(command: CommandUnknownOpts, flag: string): Option | undefined {
  return collectOptions(command).find((option) => option.long === flag || option.short === flag);
}

function isRepeatableOption(option: Option): boolean {
  // Variadic options, and options backed by a collector with an array default
  // (e.g. `--measure`/`--dimension`), may be supplied more than once.
  return option.variadic || Array.isArray(option.defaultValue);
}

function flagCandidates(command: CommandUnknownOpts, typedTokens: string[]): string[] {
  const present = new Set(typedTokens.filter((token) => token.startsWith('-')));
  const candidates: string[] = [];
  for (const option of collectOptions(command)) {
    if (option.hidden || !option.long) {
      continue;
    }
    if (present.has(option.long) && !isRepeatableOption(option)) {
      continue;
    }
    candidates.push(option.long);
  }
  return candidates;
}

async function optionValueCandidates(
  resolved: ResolvedCommand,
  option: Option,
  typedTokens: string[],
  providers: CompletionProviders,
): Promise<string[]> {
  if (option.argChoices && option.argChoices.length > 0) {
    return option.argChoices;
  }
  return providers.optionValueCandidates(resolved.commandPath, option.long ?? option.name(), typedTokens);
}

function dedupeSortFilter(candidates: string[], partial: string): string[] {
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.startsWith(partial) || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    matches.push(candidate);
  }
  return matches.sort();
}

/**
 * Compute completion candidates for the partial last element of `words`
 * (everything the shell has on the line after `ktx`). The active command and
 * its flags are derived by walking the live Commander tree, so completion never
 * drifts from the real command structure.
 */
export async function computeCompletions(
  program: CommandUnknownOpts,
  words: string[],
  providers: CompletionProviders,
): Promise<string[]> {
  const partial = words.length > 0 ? (words[words.length - 1] ?? '') : '';
  const typedTokens = words.slice(0, -1);
  const resolved = resolveCommand(program, typedTokens);

  // (a) Option value via the `--opt=value` form.
  const equalsMatch = /^(--[^=]+)=(.*)$/.exec(partial);
  if (equalsMatch) {
    const [, flag, valuePartial] = equalsMatch;
    const option = findOption(resolved.command, flag);
    if (!option || option.isBoolean()) {
      return [];
    }
    const values = await optionValueCandidates(resolved, option, typedTokens, providers);
    return dedupeSortFilter(
      values.map((value) => `${flag}=${value}`),
      `${flag}=${valuePartial}`,
    );
  }

  // (b) Option value via the `--opt value` form (previous token is a value-taking option).
  const previous = typedTokens[typedTokens.length - 1];
  if (previous && previous.startsWith('-') && !partial.startsWith('-')) {
    const option = findOption(resolved.command, previous);
    if (option && !option.isBoolean()) {
      return dedupeSortFilter(await optionValueCandidates(resolved, option, typedTokens, providers), partial);
    }
  }

  // (c) Flag completion.
  if (partial.startsWith('-')) {
    return dedupeSortFilter(flagCandidates(resolved.command, typedTokens), partial);
  }

  // (d) Positional: subcommand names union static argument choices union dynamic operand candidates.
  const candidates: string[] = resolved.command.commands
    .filter((sub) => !isHiddenCommand(sub))
    .map((sub) => sub.name());
  for (const argument of resolved.command.registeredArguments) {
    if (argument.argChoices) {
      candidates.push(...argument.argChoices);
    }
  }
  candidates.push(...(await providers.positionalCandidates(resolved.commandPath, typedTokens)));
  return dedupeSortFilter(candidates, partial);
}
