import { describe, expect, it, vi } from 'vitest';
import { createCliOperationalLogger, createNoopOperationalLogger } from '../../src/io/logger.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('createCliOperationalLogger', () => {
  it('routes operational messages to stderr outside JSON mode', () => {
    const io = makeIo();
    const logger = createCliOperationalLogger(io.io, 'plain');

    logger.log('progress');
    logger.warn('warning');
    logger.error('failure');
    logger.debug?.('debug');

    expect(io.stdout()).toBe('');
    expect(io.stderr()).toBe('progress\nwarning\nfailure\ndebug\n');
  });

  it('suppresses operational messages in JSON mode by default', () => {
    const io = makeIo();
    const logger = createCliOperationalLogger(io.io, 'json');

    logger.log('progress');
    logger.warn('warning');
    logger.error('failure');
    logger.debug?.('debug');

    expect(io.stdout()).toBe('');
    expect(io.stderr()).toBe('');
  });
});

describe('createNoopOperationalLogger', () => {
  it('never writes', () => {
    const logger = createNoopOperationalLogger();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    logger.log('progress');
    logger.warn('warning');
    logger.error('failure');
    logger.debug?.('debug');

    expect(warn).not.toHaveBeenCalled();
  });
});
