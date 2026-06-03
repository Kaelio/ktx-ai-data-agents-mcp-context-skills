import { describe, expect, it, vi } from 'vitest';
import {
  runConnectionSetupWithRecovery,
  type ConfigureResult,
  type RecoveryAction,
  type ValidateResult,
} from '../src/connection-recovery.js';

function input(overrides: {
  interactive?: boolean;
  allowSkip?: boolean;
  configure?: () => Promise<ConfigureResult>;
  validate?: () => Promise<ValidateResult>;
  selectValues?: string[];
  extraActions?: RecoveryAction[];
}) {
  const selectValues = [...(overrides.selectValues ?? [])];
  const rollback = vi.fn(async () => {});
  const select = vi.fn(async () => selectValues.shift() ?? 'back');
  const validate = overrides.validate ?? vi.fn(async () => ({ status: 'ok' as const }));
  return {
    rollback,
    select,
    validate,
    run: () =>
      runConnectionSetupWithRecovery({
        label: 'warehouse',
        interactive: overrides.interactive ?? true,
        allowSkip: overrides.allowSkip ?? true,
        io: {
          stdout: { write: vi.fn() },
          stderr: { write: vi.fn() },
        },
        prompts: { select },
        snapshot: vi.fn(async () => rollback),
        configure: overrides.configure ?? vi.fn(async () => 'configured' as const),
        validate,
      }),
  };
}

describe('runConnectionSetupWithRecovery', () => {
  it('returns ready without opening the menu when first validation passes', async () => {
    const setup = input({});

    await expect(setup.run()).resolves.toBe('ready');

    expect(setup.select).not.toHaveBeenCalled();
    expect(setup.rollback).not.toHaveBeenCalled();
  });

  it('fails fast without prompting or rollback when noninteractive validation fails', async () => {
    const setup = input({
      interactive: false,
      validate: vi.fn(async () => ({ status: 'failed' as const })),
    });

    await expect(setup.run()).resolves.toBe('failed');

    expect(setup.select).not.toHaveBeenCalled();
    expect(setup.rollback).not.toHaveBeenCalled();
  });

  it('retries the same config after Retry and returns ready', async () => {
    let calls = 0;
    const setup = input({
      selectValues: ['retry'],
      validate: vi.fn(async () => {
        calls += 1;
        return calls === 1 ? { status: 'failed' as const } : { status: 'ok' as const };
      }),
    });

    await expect(setup.run()).resolves.toBe('ready');

    expect(setup.validate).toHaveBeenCalledTimes(2);
    expect(setup.rollback).not.toHaveBeenCalled();
  });

  it('re-enters config and validates the new attempt', async () => {
    let calls = 0;
    const configure = vi.fn(async () => 'configured' as const);
    const setup = input({
      configure,
      selectValues: ['re-enter'],
      validate: vi.fn(async () => {
        calls += 1;
        return calls === 1 ? { status: 'failed' as const } : { status: 'ok' as const };
      }),
    });

    await expect(setup.run()).resolves.toBe('ready');

    expect(configure).toHaveBeenCalledTimes(2);
    expect(setup.validate).toHaveBeenCalledTimes(2);
    expect(setup.rollback).not.toHaveBeenCalled();
  });

  it('rolls back once and returns skip when Skip is selected', async () => {
    const setup = input({
      selectValues: ['skip'],
      validate: vi.fn(async () => ({ status: 'failed' as const })),
    });

    await expect(setup.run()).resolves.toBe('skip');

    expect(setup.rollback).toHaveBeenCalledTimes(1);
  });

  it('omits Skip when allowSkip is false and rolls back on Back', async () => {
    const setup = input({
      allowSkip: false,
      selectValues: ['back'],
      validate: vi.fn(async () => ({ status: 'failed' as const })),
    });

    await expect(setup.run()).resolves.toBe('back');

    expect(setup.select).toHaveBeenCalledWith({
      message: 'Connection setup failed for warehouse',
      options: [
        { value: 'retry', label: 'Retry connection test' },
        { value: 're-enter', label: 'Re-enter connection details' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(setup.rollback).toHaveBeenCalledTimes(1);
  });

  it('runs an extra action and then revalidates', async () => {
    const action = vi.fn(async () => {});
    let calls = 0;
    const setup = input({
      selectValues: ['disable-query-history'],
      validate: vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? {
              status: 'failed' as const,
              extraActions: [
                { value: 'disable-query-history', label: 'Disable query history and retry', run: action },
              ],
            }
          : { status: 'ok' as const };
      }),
    });

    await expect(setup.run()).resolves.toBe('ready');

    expect(action).toHaveBeenCalledTimes(1);
    expect(setup.validate).toHaveBeenCalledTimes(2);
  });

  it('rolls back when re-enter returns back or cancelled', async () => {
    const backSetup = input({
      selectValues: ['re-enter'],
      configure: vi.fn(async () => 'back' as const),
      validate: vi.fn(async () => ({ status: 'failed' as const })),
    });
    await expect(backSetup.run()).resolves.toBe('back');
    expect(backSetup.rollback).toHaveBeenCalledTimes(1);

    const cancelledSetup = input({
      selectValues: ['re-enter'],
      configure: vi.fn(async () => 'cancelled' as const),
      validate: vi.fn(async () => ({ status: 'failed' as const })),
    });
    await expect(cancelledSetup.run()).resolves.toBe('failed');
    expect(cancelledSetup.rollback).toHaveBeenCalledTimes(1);
  });
});
