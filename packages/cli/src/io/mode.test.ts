import { describe, expect, it } from 'vitest';
import type { KtxCliIo } from '../cli-runtime.js';
import { resolveOutputMode } from './mode.js';

function ioWith(isTTY: boolean | undefined): KtxCliIo {
  return {
    stdout: { isTTY, write: () => {} },
    stderr: { write: () => {} },
  };
}

describe('resolveOutputMode', () => {
  it('uses explicit value when provided', () => {
    expect(resolveOutputMode({ explicit: 'pretty', io: ioWith(false), env: {} })).toBe('pretty');
    expect(resolveOutputMode({ explicit: 'plain', io: ioWith(true), env: {} })).toBe('plain');
    expect(resolveOutputMode({ explicit: 'json', io: ioWith(true), env: {} })).toBe('json');
  });

  it('json:true takes precedence over explicit value', () => {
    expect(resolveOutputMode({ explicit: 'pretty', json: true, io: ioWith(true), env: {} })).toBe('json');
  });

  it('prefers explicit JSON over every other output setting', () => {
    expect(resolveOutputMode({ json: true, explicit: 'pretty', io: ioWith(true), env: { KTX_OUTPUT: 'plain' } })).toBe(
      'json',
    );
  });

  it('throws on unknown explicit value', () => {
    expect(() => resolveOutputMode({ explicit: 'fancy', io: ioWith(true), env: {} })).toThrow(/Invalid --output/);
  });

  it('honors KTX_OUTPUT env var when no explicit value', () => {
    expect(resolveOutputMode({ io: ioWith(true), env: { KTX_OUTPUT: 'plain' } })).toBe('plain');
    expect(resolveOutputMode({ io: ioWith(false), env: { KTX_OUTPUT: 'pretty' } })).toBe('pretty');
    expect(resolveOutputMode({ io: ioWith(false), env: { KTX_OUTPUT: 'json' } })).toBe('json');
  });

  it('throws on unknown KTX_OUTPUT', () => {
    expect(() => resolveOutputMode({ io: ioWith(true), env: { KTX_OUTPUT: 'fancy' } })).toThrow(/Invalid KTX_OUTPUT/);
  });

  it('rejects invalid KTX_OUTPUT values', () => {
    expect(() => resolveOutputMode({ io: ioWith(false), env: { KTX_OUTPUT: 'verbose' } })).toThrow(
      'Invalid KTX_OUTPUT value: verbose. Expected one of pretty, plain, json.',
    );
  });

  it('returns plain when CI is set to a truthy value', () => {
    expect(resolveOutputMode({ io: ioWith(true), env: { CI: 'true' } })).toBe('plain');
    expect(resolveOutputMode({ io: ioWith(true), env: { CI: '1' } })).toBe('plain');
  });

  it('ignores CI when set to a falsy value', () => {
    expect(resolveOutputMode({ io: ioWith(true), env: { CI: '' } })).toBe('pretty');
    expect(resolveOutputMode({ io: ioWith(true), env: { CI: '0' } })).toBe('pretty');
    expect(resolveOutputMode({ io: ioWith(true), env: { CI: 'false' } })).toBe('pretty');
  });

  it('returns pretty when stdout is a TTY and CI is not set', () => {
    expect(resolveOutputMode({ io: ioWith(true), env: {} })).toBe('pretty');
  });

  it('returns plain when stdout is not a TTY', () => {
    expect(resolveOutputMode({ io: ioWith(false), env: {} })).toBe('plain');
    expect(resolveOutputMode({ io: ioWith(undefined), env: {} })).toBe('plain');
  });

  it('explicit value beats KTX_OUTPUT env var', () => {
    expect(resolveOutputMode({ explicit: 'json', io: ioWith(true), env: { KTX_OUTPUT: 'plain' } })).toBe('json');
  });
});
