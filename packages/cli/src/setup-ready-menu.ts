import {
  createKtxSetupPromptAdapter,
  type KtxSetupPromptOption,
} from './setup-prompts.js';
import type { KtxSetupStatus } from './setup.js';

export type KtxSetupReadyAction =
  | 'models'
  | 'embeddings'
  | 'databases'
  | 'sources'
  | 'runtime'
  | 'context'
  | 'agents'
  | 'exit';

/**
 * Where a project stands once its `ktx.yaml` exists. Single source of truth for the
 * end-of-setup interception: each state maps to exactly one obvious next action.
 */
export type KtxSetupCompletion = 'incomplete' | 'needs-context' | 'needs-agents' | 'ready';

interface KtxSetupReadyMenuPromptAdapter {
  select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
  cancel(message: string): void;
}

export interface KtxSetupReadyMenuDeps {
  prompts?: KtxSetupReadyMenuPromptAdapter;
}

export function setupHasContextTargets(status: KtxSetupStatus): boolean {
  return status.databases.length > 0 || status.sources.length > 0;
}

function setupConfigReady(status: KtxSetupStatus): boolean {
  return (
    status.project.ready &&
    status.llm.ready &&
    status.embeddings.ready &&
    status.databases.every((database) => database.ready) &&
    status.sources.every((source) => source.ready) &&
    status.runtime.ready &&
    setupHasContextTargets(status)
  );
}

export function classifyKtxSetupCompletion(status: KtxSetupStatus): KtxSetupCompletion {
  if (!setupConfigReady(status)) {
    return 'incomplete';
  }
  if (!status.context.ready) {
    return 'needs-context';
  }
  if (!status.agents.some((agent) => agent.ready)) {
    return 'needs-agents';
  }
  return 'ready';
}

function createPromptAdapter(): KtxSetupReadyMenuPromptAdapter {
  return createKtxSetupPromptAdapter({ selectCancelValue: 'exit' });
}

/**
 * Shown when a returning user re-runs `ktx setup` on a fully-ready project. Leads with
 * "you're done" (the readiness note is printed by the caller first) and keeps the
 * section editor one explicit step away rather than defaulting into it.
 */
export async function runKtxSetupReadyMenu(
  status: KtxSetupStatus,
  deps: KtxSetupReadyMenuDeps = {},
): Promise<{ action: KtxSetupReadyAction }> {
  const prompts = deps.prompts ?? createPromptAdapter();
  const choice = await prompts.select({
    message: 'Anything else?',
    options: [
      { value: 'done', label: "Done — I'll start using ktx" },
      { value: 'change', label: 'Change a setting' },
    ],
  });
  if (choice !== 'change') {
    return { action: 'exit' };
  }
  return runKtxSetupReadyChangeMenu(status, { prompts });
}

/** @internal Reached only through {@link runKtxSetupReadyMenu}; exported for unit tests. */
export async function runKtxSetupReadyChangeMenu(
  status: KtxSetupStatus,
  deps: KtxSetupReadyMenuDeps = {},
): Promise<{ action: KtxSetupReadyAction }> {
  const prompts = deps.prompts ?? createPromptAdapter();
  const action = (await prompts.select({
    message: 'What would you like to change?',
    options: [
      { value: 'models', label: 'Models' },
      { value: 'embeddings', label: 'Embeddings' },
      { value: 'databases', label: 'Databases' },
      { value: 'sources', label: 'Context sources' },
      ...(status.runtime.required ? [{ value: 'runtime', label: 'Runtime' }] : []),
      { value: 'context', label: 'Rebuild ktx context' },
      { value: 'agents', label: 'Agent integration' },
      { value: 'exit', label: 'Exit' },
    ],
  })) as KtxSetupReadyAction;
  return { action };
}
