import type { KtxCliIo } from './cli-runtime.js';
import type { KtxSetupPromptOption } from './setup-prompts.js';

export type RecoveryOutcome = 'ready' | 'skip' | 'back' | 'failed';

/** @internal */
export interface RecoveryAction {
  value: string;
  label: string;
  run: () => Promise<void>;
}

export type ConfigureResult = 'configured' | 'back' | 'cancelled';

export type ValidateResult =
  | { status: 'ok' }
  | { status: 'back' }
  | { status: 'failed'; extraActions?: RecoveryAction[] };

export interface ConnectionRecoveryInput {
  label: string;
  interactive: boolean;
  allowSkip: boolean;
  io: KtxCliIo;
  prompts: {
    select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
  };
  snapshot: () => Promise<() => Promise<void>>;
  configure: () => Promise<ConfigureResult>;
  validate: () => Promise<ValidateResult>;
}

async function runRollbackOnce(input: {
  rollback: () => Promise<void>;
  state: { rolledBack: boolean };
}): Promise<void> {
  if (input.state.rolledBack) {
    return;
  }
  input.state.rolledBack = true;
  await input.rollback();
}

function recoveryOptions(input: {
  allowSkip: boolean;
  extraActions?: RecoveryAction[];
}): KtxSetupPromptOption[] {
  return [
    { value: 'retry', label: 'Retry connection test' },
    { value: 're-enter', label: 'Re-enter connection details' },
    ...(input.extraActions ?? []).map((action) => ({
      value: action.value,
      label: action.label,
    })),
    ...(input.allowSkip ? [{ value: 'skip', label: 'Skip this connection' }] : []),
    { value: 'back', label: 'Back' },
  ];
}

export async function runConnectionSetupWithRecovery(
  input: ConnectionRecoveryInput,
): Promise<RecoveryOutcome> {
  const rollback = await input.snapshot();
  const rollbackState = { rolledBack: false };

  const firstConfig = await input.configure();
  if (firstConfig === 'back') {
    await runRollbackOnce({ rollback, state: rollbackState });
    return 'back';
  }
  if (firstConfig === 'cancelled') {
    await runRollbackOnce({ rollback, state: rollbackState });
    return 'failed';
  }

  let validation = await input.validate();
  while (validation.status !== 'ok') {
    if (validation.status === 'back') {
      await runRollbackOnce({ rollback, state: rollbackState });
      return 'back';
    }

    if (!input.interactive) {
      return 'failed';
    }

    const action = await input.prompts.select({
      message: `Connection setup failed for ${input.label}`,
      options: recoveryOptions({
        allowSkip: input.allowSkip,
        extraActions: validation.extraActions,
      }),
    });

    if (action === 'back') {
      await runRollbackOnce({ rollback, state: rollbackState });
      return 'back';
    }
    if (action === 'skip' && input.allowSkip) {
      await runRollbackOnce({ rollback, state: rollbackState });
      return 'skip';
    }
    if (action === 're-enter') {
      const nextConfig = await input.configure();
      if (nextConfig === 'back') {
        await runRollbackOnce({ rollback, state: rollbackState });
        return 'back';
      }
      if (nextConfig === 'cancelled') {
        await runRollbackOnce({ rollback, state: rollbackState });
        return 'failed';
      }
      validation = await input.validate();
      continue;
    }
    if (action === 'retry') {
      validation = await input.validate();
      continue;
    }

    const extraAction = validation.extraActions?.find((candidate) => candidate.value === action);
    if (extraAction) {
      await extraAction.run();
      validation = await input.validate();
      continue;
    }

    validation = await input.validate();
  }

  return 'ready';
}
