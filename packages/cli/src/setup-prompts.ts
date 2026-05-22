import type { Writable } from 'node:stream';
import {
  autocomplete,
  autocompleteMultiselect,
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  password,
  select,
  text,
} from '@clack/prompts';
import type { KtxCliIo } from './cli-runtime.js';
import { withMenuOptionsSpacing, withTextInputNavigation } from './prompt-navigation.js';
import { withSetupInterruptConfirmation } from './setup-interrupt.js';

export interface KtxSetupPromptOption<Value extends string = string> {
  value: Value;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface KtxSetupSelectOptions<Value extends string = string> {
  message: string;
  options: Array<KtxSetupPromptOption<Value>>;
  initialValue?: Value;
  maxItems?: number;
}

interface KtxSetupMultiselectOptions<Value extends string = string> {
  message: string;
  options: Array<KtxSetupPromptOption<Value>>;
  required?: boolean;
  initialValues?: Value[];
  maxItems?: number;
  cursorAt?: Value;
}

interface KtxSetupAutocompleteOptions<Value extends string = string> {
  message: string;
  options: Array<KtxSetupPromptOption<Value>>;
  placeholder?: string;
  maxItems?: number;
}

interface KtxSetupAutocompleteMultiselectOptions<Value extends string = string> {
  message: string;
  options: Array<KtxSetupPromptOption<Value>>;
  placeholder?: string;
  required?: boolean;
  maxItems?: number;
  initialValues?: Value[];
}

interface KtxSetupTextOptions {
  message: string;
  placeholder?: string;
  initialValue?: string;
  defaultValue?: string;
}

interface KtxSetupPasswordOptions {
  message: string;
  mask?: string;
}

export interface KtxSetupPromptAdapter {
  select(options: KtxSetupSelectOptions): Promise<string>;
  multiselect(options: KtxSetupMultiselectOptions): Promise<string[]>;
  autocomplete(options: KtxSetupAutocompleteOptions): Promise<string>;
  autocompleteMultiselect(options: KtxSetupAutocompleteMultiselectOptions): Promise<string[]>;
  text(options: KtxSetupTextOptions): Promise<string | undefined>;
  password(options: KtxSetupPasswordOptions): Promise<string | undefined>;
  cancel(message: string): void;
  log(message: string): void;
}

export interface KtxSetupPromptAdapterOptions {
  selectCancelValue: 'back' | 'exit';
  multiselectCancelValue?: 'back';
  confirmEmptyOptionalMultiselect?: boolean;
  cancelOnSelectCancel?: boolean;
  cancelOnMultiselectCancel?: boolean;
  cancelMessage?: string;
}

const DEFAULT_SETUP_CANCEL_MESSAGE = 'Setup cancelled.';

export function createKtxSetupPromptAdapter(options: KtxSetupPromptAdapterOptions): KtxSetupPromptAdapter {
  const cancelMessage = options.cancelMessage ?? DEFAULT_SETUP_CANCEL_MESSAGE;
  const cancelOnSelectCancel = options.cancelOnSelectCancel ?? true;
  const cancelOnMultiselectCancel = options.cancelOnMultiselectCancel ?? true;
  const multiselectCancelValue = options.multiselectCancelValue ?? 'back';

  return {
    async select(promptOptions) {
      const value = await withSetupInterruptConfirmation(() => select(withMenuOptionsSpacing(promptOptions)));
      if (isCancel(value)) {
        if (cancelOnSelectCancel) {
          cancel(cancelMessage);
        }
        return options.selectCancelValue;
      }
      return String(value);
    },
    async multiselect(promptOptions) {
      while (true) {
        const value = await withSetupInterruptConfirmation(() => multiselect(withMenuOptionsSpacing(promptOptions)));
        if (isCancel(value)) {
          if (cancelOnMultiselectCancel) {
            cancel(cancelMessage);
          }
          return [multiselectCancelValue];
        }
        const selected = [...value].map(String);
        if (
          selected.length === 0 &&
          !promptOptions.required &&
          options.confirmEmptyOptionalMultiselect === true
        ) {
          const skipConfirmed = await confirm({
            message: 'Nothing selected. Skip this step?',
            initialValue: false,
          });
          if (isCancel(skipConfirmed)) {
            cancel(cancelMessage);
            return [multiselectCancelValue];
          }
          if (!skipConfirmed) {
            continue;
          }
        }
        return selected;
      }
    },
    async autocomplete(promptOptions) {
      const value = await withSetupInterruptConfirmation(() =>
        autocomplete(withMenuOptionsSpacing(promptOptions)),
      );
      if (isCancel(value)) {
        if (cancelOnSelectCancel) {
          cancel(cancelMessage);
        }
        return options.selectCancelValue;
      }
      return String(value);
    },
    async autocompleteMultiselect(promptOptions) {
      while (true) {
        const value = await withSetupInterruptConfirmation(() =>
          autocompleteMultiselect(withMenuOptionsSpacing(promptOptions)),
        );
        if (isCancel(value)) {
          if (cancelOnMultiselectCancel) {
            cancel(cancelMessage);
          }
          return [multiselectCancelValue];
        }
        const selected = [...value].map(String);
        if (
          selected.length === 0 &&
          !promptOptions.required &&
          options.confirmEmptyOptionalMultiselect === true
        ) {
          const skipConfirmed = await confirm({
            message: 'Nothing selected. Skip this step?',
            initialValue: false,
          });
          if (isCancel(skipConfirmed)) {
            cancel(cancelMessage);
            return [multiselectCancelValue];
          }
          if (!skipConfirmed) {
            continue;
          }
        }
        return selected;
      }
    },
    async text(promptOptions) {
      const value = await withSetupInterruptConfirmation(() =>
        text({ ...promptOptions, message: withTextInputNavigation(promptOptions.message) }),
      );
      return isCancel(value) ? undefined : String(value);
    },
    async password(promptOptions) {
      const value = await withSetupInterruptConfirmation(() =>
        password({ ...promptOptions, message: withTextInputNavigation(promptOptions.message) }),
      );
      return isCancel(value) ? undefined : String(value);
    },
    cancel(message) {
      cancel(message);
    },
    log(message) {
      log.info(message);
    },
  };
}

interface KtxSetupNoteOptions {
  format?: (line: string) => string;
}

export interface KtxSetupUiAdapter {
  intro(title: string, io: KtxCliIo): void;
  note(message: string, title: string, io: KtxCliIo, options?: KtxSetupNoteOptions): void;
}

function isWritableTtyOutput(output: KtxCliIo['stdout']): output is KtxCliIo['stdout'] & Writable {
  return (
    output.isTTY === true &&
    typeof (output as { on?: unknown }).on === 'function' &&
    typeof (output as { columns?: unknown }).columns !== 'undefined'
  );
}

export function createKtxSetupUiAdapter(): KtxSetupUiAdapter {
  return {
    intro(title, io) {
      if (isWritableTtyOutput(io.stdout)) {
        intro(title, { output: io.stdout });
        return;
      }
      io.stdout.write(`${title}\n`);
    },
    note(message, title, io, options) {
      if (isWritableTtyOutput(io.stdout)) {
        note(message, title, {
          output: io.stdout,
          ...(options?.format ? { format: options.format } : {}),
        });
        return;
      }
      io.stdout.write(`\n${title}:\n`);
      io.stdout.write(`${message}\n`);
    },
  };
}
