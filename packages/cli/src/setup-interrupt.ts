import { stdin } from 'node:process';
import type { Key } from 'node:readline';
import { cancel, confirm, isCancel as isClackCancel } from '@clack/prompts';

export class KtxSetupExitError extends Error {
  constructor() {
    super('KTX setup exit requested');
    this.name = 'KtxSetupExitError';
  }
}

export interface SetupInterruptTracker {
  track<T>(run: () => Promise<T>): Promise<T>;
  wasCtrlC(): boolean;
}

interface SetupInterruptOptions {
  confirmExit?: () => Promise<boolean | symbol>;
  isCancel?: (value: unknown) => value is symbol;
  tracker?: SetupInterruptTracker;
}

const NON_INTERACTIVE_SETUP_MESSAGE =
  'Interactive setup requires a terminal. Re-run this command in a TTY, or pass --no-input with the required options.';

function refSetupInput(input: NodeJS.ReadStream = stdin): void {
  input.ref?.();
}

function createSetupInterruptTracker(input: NodeJS.ReadStream = stdin): SetupInterruptTracker {
  let ctrlCPressed = false;
  const onKeypress = (char: string | undefined, key: Key) => {
    if (char === '\x03' || key.sequence === '\x03') {
      ctrlCPressed = true;
    }
  };

  return {
    async track(run) {
      ctrlCPressed = false;
      input.on('keypress', onKeypress);
      try {
        return await run();
      } finally {
        input.off('keypress', onKeypress);
      }
    },
    wasCtrlC() {
      return ctrlCPressed;
    },
  };
}

async function defaultConfirmExit(): Promise<boolean | symbol> {
  return await confirm({
    message: 'Exit setup wizard?',
    active: 'Yes, exit',
    inactive: 'No, continue setup',
    initialValue: false,
  });
}

export function isKtxSetupExitError(error: unknown): error is KtxSetupExitError {
  return error instanceof KtxSetupExitError;
}

export async function withSetupInterruptConfirmation<T>(
  prompt: () => Promise<T | symbol>,
  options: SetupInterruptOptions = {},
): Promise<T | symbol> {
  if (!options.tracker && stdin.isTTY !== true) {
    throw new Error(NON_INTERACTIVE_SETUP_MESSAGE);
  }

  const isCancel = options.isCancel ?? isClackCancel;
  const tracker = options.tracker ?? createSetupInterruptTracker();
  const confirmExit = options.confirmExit ?? defaultConfirmExit;

  while (true) {
    if (!options.tracker) {
      refSetupInput();
    }
    const value = await tracker.track(prompt);
    if (!isCancel(value)) {
      return value;
    }
    if (!tracker.wasCtrlC()) {
      return value;
    }

    const shouldExit = await confirmExit();
    if (isCancel(shouldExit) || shouldExit === true) {
      cancel('Setup cancelled.');
      throw new KtxSetupExitError();
    }
  }
}
