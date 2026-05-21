import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createKtxSetupPromptAdapter,
  type KtxSetupPromptOption,
} from './setup-prompts.js';

const mocks = vi.hoisted(() => {
  const cancelSymbol = Symbol('cancel');
  return {
    cancelSymbol,
    cancel: vi.fn(),
    confirm: vi.fn(),
    intro: vi.fn(),
    isCancel: vi.fn((value: unknown): value is symbol => value === cancelSymbol),
    log: { info: vi.fn() },
    multiselect: vi.fn(),
    autocomplete: vi.fn(),
    autocompleteMultiselect: vi.fn(),
    note: vi.fn(),
    password: vi.fn(),
    select: vi.fn(),
    text: vi.fn(),
    withSetupInterruptConfirmation: vi.fn((prompt: () => Promise<unknown>) => prompt()),
  };
});

vi.mock('@clack/prompts', () => ({
  cancel: mocks.cancel,
  confirm: mocks.confirm,
  intro: mocks.intro,
  isCancel: mocks.isCancel,
  log: mocks.log,
  multiselect: mocks.multiselect,
  autocomplete: mocks.autocomplete,
  autocompleteMultiselect: mocks.autocompleteMultiselect,
  note: mocks.note,
  password: mocks.password,
  select: mocks.select,
  text: mocks.text,
}));

vi.mock('./setup-interrupt.js', () => ({
  withSetupInterruptConfirmation: mocks.withSetupInterruptConfirmation,
}));

describe('setup prompt adapter', () => {
  beforeEach(() => {
    mocks.cancel.mockReset();
    mocks.confirm.mockReset();
    mocks.intro.mockReset();
    mocks.isCancel.mockClear();
    mocks.log.info.mockReset();
    mocks.multiselect.mockReset();
    mocks.autocomplete.mockReset();
    mocks.autocompleteMultiselect.mockReset();
    mocks.note.mockReset();
    mocks.password.mockReset();
    mocks.select.mockReset();
    mocks.text.mockReset();
    mocks.withSetupInterruptConfirmation.mockClear();
  });

  it('passes select hint and disabled options through Clack and delegates cancellation handling', async () => {
    mocks.select.mockResolvedValueOnce('openai');
    const adapter = createKtxSetupPromptAdapter({ selectCancelValue: 'back' });
    const options: KtxSetupPromptOption[] = [
      { value: 'local', label: 'Local embeddings', disabled: true },
      { value: 'openai', label: 'OpenAI embeddings', hint: 'recommended' },
    ];

    await expect(
      adapter.select({
        message: 'Which embedding option should KTX use?\n\nKTX uses embeddings for search.',
        options,
      }),
    ).resolves.toBe('openai');

    expect(mocks.withSetupInterruptConfirmation).toHaveBeenCalledTimes(1);
    expect(mocks.select).toHaveBeenCalledWith({
      message: 'Which embedding option should KTX use?\n\nKTX uses embeddings for search.\n',
      options,
    });
  });

  it('maps select cancellation to the configured sentinel', async () => {
    mocks.select.mockResolvedValueOnce(mocks.cancelSymbol);
    const adapter = createKtxSetupPromptAdapter({
      selectCancelValue: 'exit',
      cancelOnSelectCancel: false,
    });

    await expect(adapter.select({ message: 'What do you want to do?', options: [] })).resolves.toBe('exit');

    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('decorates text and password prompts with setup navigation copy', async () => {
    mocks.text.mockResolvedValueOnce('analytics-ktx');
    mocks.password.mockResolvedValueOnce('secret');
    const adapter = createKtxSetupPromptAdapter({ selectCancelValue: 'back' });

    await expect(adapter.text({ message: 'Project folder path', placeholder: './analytics-ktx' })).resolves.toBe(
      'analytics-ktx',
    );
    await expect(adapter.password({ message: 'Anthropic API key' })).resolves.toBe('secret');

    expect(mocks.text).toHaveBeenCalledWith({
      message: 'Project folder path\n│  Press Escape to go back.\n│',
      placeholder: './analytics-ktx',
    });
    expect(mocks.password).toHaveBeenCalledWith({
      message: 'Anthropic API key\n│  Press Escape to go back.\n│',
    });
  });

  it('passes multiselect hint and disabled options through Clack', async () => {
    mocks.multiselect.mockResolvedValueOnce(['postgres']);
    const adapter = createKtxSetupPromptAdapter({
      selectCancelValue: 'back',
      multiselectCancelValue: 'back',
      confirmEmptyOptionalMultiselect: true,
    });
    const options: KtxSetupPromptOption[] = [
      { value: 'postgres', label: 'PostgreSQL', hint: 'recommended' },
      { value: 'snowflake', label: 'Snowflake', disabled: true },
    ];

    await expect(adapter.multiselect({ message: 'Which primary sources?', options, required: true })).resolves.toEqual([
      'postgres',
    ]);

    expect(mocks.multiselect).toHaveBeenCalledWith({
      message: 'Which primary sources?',
      options,
      required: true,
    });
  });

  it('confirms an empty optional multiselect and retries when skip is declined', async () => {
    mocks.multiselect.mockResolvedValueOnce([]).mockResolvedValueOnce(['postgres']);
    mocks.confirm.mockResolvedValueOnce(false);
    const adapter = createKtxSetupPromptAdapter({
      selectCancelValue: 'back',
      multiselectCancelValue: 'back',
      confirmEmptyOptionalMultiselect: true,
    });

    await expect(adapter.multiselect({ message: 'Which primary sources?', options: [], required: false })).resolves.toEqual([
      'postgres',
    ]);

    expect(mocks.confirm).toHaveBeenCalledWith({ message: 'Nothing selected. Skip this step?', initialValue: false });
    expect(mocks.multiselect).toHaveBeenCalledTimes(2);
  });

  it('maps multiselect cancellation to the configured back value', async () => {
    mocks.multiselect.mockResolvedValueOnce(mocks.cancelSymbol);
    const adapter = createKtxSetupPromptAdapter({
      selectCancelValue: 'back',
      multiselectCancelValue: 'back',
      confirmEmptyOptionalMultiselect: true,
    });

    await expect(adapter.multiselect({ message: 'Which primary sources?', options: [] })).resolves.toEqual(['back']);

    expect(mocks.cancel).toHaveBeenCalledWith('Setup cancelled.');
  });

  it('returns autocomplete selections and maps cancel to back', async () => {
    mocks.autocomplete.mockResolvedValueOnce('analytics');
    const adapter = createKtxSetupPromptAdapter({ selectCancelValue: 'back' });

    await expect(
      adapter.autocomplete({
        message: 'Dataset',
        placeholder: 'Type to search',
        options: [{ value: 'analytics', label: 'analytics' }],
      }),
    ).resolves.toBe('analytics');

    mocks.autocomplete.mockResolvedValueOnce(mocks.cancelSymbol);
    await expect(
      adapter.autocomplete({
        message: 'Dataset',
        options: [{ value: 'analytics', label: 'analytics' }],
      }),
    ).resolves.toBe('back');
  });

  it('returns autocomplete multiselect selections and maps cancel to back', async () => {
    mocks.autocompleteMultiselect.mockResolvedValueOnce(['analytics', 'mart']);
    const adapter = createKtxSetupPromptAdapter({ selectCancelValue: 'back', multiselectCancelValue: 'back' });

    await expect(
      adapter.autocompleteMultiselect({
        message: 'Datasets',
        placeholder: 'Type to filter',
        options: [
          { value: 'analytics', label: 'analytics', hint: 'suggested' },
          { value: 'mart', label: 'mart' },
        ],
        initialValues: ['analytics'],
      }),
    ).resolves.toEqual(['analytics', 'mart']);

    mocks.autocompleteMultiselect.mockResolvedValueOnce(mocks.cancelSymbol);
    await expect(
      adapter.autocompleteMultiselect({
        message: 'Datasets',
        options: [{ value: 'analytics', label: 'analytics' }],
      }),
    ).resolves.toEqual(['back']);
  });

  it('keeps setup intro and note plain for non-stream output', async () => {
    const { createKtxSetupUiAdapter } = await import('./setup-prompts.js');
    const chunks: string[] = [];
    const io = {
      stdout: {
        isTTY: true,
        write(chunk: string) {
          chunks.push(chunk);
        },
      },
      stderr: { write: vi.fn() },
    };

    const ui = createKtxSetupUiAdapter();
    ui.intro('KTX setup', io);
    ui.note('  $ ktx status', 'What you can do next', io);

    expect(chunks.join('')).toBe('KTX setup\n\nWhat you can do next:\n  $ ktx status\n');
    expect(mocks.intro).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it('uses Clack intro and note for writable TTY output', async () => {
    const { createKtxSetupUiAdapter } = await import('./setup-prompts.js');
    const output = {
      columns: 80,
      isTTY: true,
      on: vi.fn(),
      write: vi.fn(),
    };
    const io = {
      stdout: output,
      stderr: { write: vi.fn() },
    };

    const ui = createKtxSetupUiAdapter();
    ui.intro('KTX setup', io);
    ui.note('  $ ktx status', 'What you can do next', io);

    expect(mocks.intro).toHaveBeenCalledWith('KTX setup', { output });
    expect(mocks.note).toHaveBeenCalledWith('  $ ktx status', 'What you can do next', { output });
  });
});
