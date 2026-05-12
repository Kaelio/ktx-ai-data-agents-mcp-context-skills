import { cancel, confirm, isCancel, log, spinner } from '@clack/prompts';

export interface KtxCliSpinner {
  start(message: string): void;
  stop(message: string): void;
  error(message: string): void;
}

export interface KtxCliPromptAdapter {
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean>;
  cancel(message: string): void;
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    success(message: string): void;
    step(message: string): void;
  };
  spinner(): KtxCliSpinner;
}

export class KtxCliPromptCancelledError extends Error {
  constructor(message = 'Operation cancelled.') {
    super(message);
    this.name = 'KtxCliPromptCancelledError';
  }
}

export function createClackSpinner(): KtxCliSpinner {
  return spinner();
}

export function createClackPromptAdapter(): KtxCliPromptAdapter {
  return {
    async confirm(options) {
      const value = await confirm(options);
      if (isCancel(value)) {
        cancel('Operation cancelled.');
        throw new KtxCliPromptCancelledError();
      }
      return value;
    },
    cancel(message) {
      cancel(message);
    },
    log: {
      info(message) {
        log.info(message);
      },
      warn(message) {
        log.warn(message);
      },
      error(message) {
        log.error(message);
      },
      success(message) {
        log.success(message);
      },
      step(message) {
        log.step(message);
      },
    },
    spinner() {
      return createClackSpinner();
    },
  };
}
