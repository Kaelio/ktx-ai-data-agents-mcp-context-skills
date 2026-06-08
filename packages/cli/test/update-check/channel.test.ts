import { describe, expect, it } from 'vitest';

import { decideUpdate, inferUpdateChannel } from '../../src/update-check/channel.js';

describe('inferUpdateChannel', () => {
  it.each([
    ['0.9.0', 'latest'],
    ['0.10.0-rc.3', 'next'],
    ['0.10.0-myfeat.2', null],
    ['0.0.0', null],
    ['not-a-version', null],
  ])('maps %s to %s', (installed, expected) => {
    expect(inferUpdateChannel(installed)).toBe(expected);
  });
});

describe('decideUpdate', () => {
  it.each([
    [
      'stable behind',
      '0.9.0',
      { latest: '0.10.0', next: '0.11.0-rc.1' },
      { status: 'available', channel: 'latest', target: '0.10.0' },
    ],
    [
      'stable equal',
      '0.10.0',
      { latest: '0.10.0', next: '0.11.0-rc.1' },
      { status: 'upToDate', channel: 'latest', target: '0.10.0' },
    ],
    [
      'stable ahead',
      '0.11.0',
      { latest: '0.10.0', next: '0.11.0-rc.1' },
      { status: 'upToDate', channel: 'latest', target: '0.10.0' },
    ],
    [
      'rc behind',
      '0.11.0-rc.1',
      { latest: '0.10.0', next: '0.11.0-rc.2' },
      { status: 'available', channel: 'next', target: '0.11.0-rc.2' },
    ],
    [
      'rc equal',
      '0.11.0-rc.2',
      { latest: '0.10.0', next: '0.11.0-rc.2' },
      { status: 'upToDate', channel: 'next', target: '0.11.0-rc.2' },
    ],
    ['branch prerelease', '0.11.0-myfeat.1', { latest: '0.10.0', next: '0.11.0-rc.2' }, { status: 'skip' }],
    ['missing channel tag', '0.9.0', { next: '0.11.0-rc.2' }, { status: 'skip' }],
    ['invalid installed version', 'bad', { latest: '0.10.0' }, { status: 'skip' }],
    ['invalid target version', '0.9.0', { latest: 'bad' }, { status: 'skip' }],
    ['local development version', '0.0.0', { latest: '0.10.0' }, { status: 'skip' }],
  ])('%s', (_name, installed, distTags, expected) => {
    expect(decideUpdate(installed, distTags)).toEqual(expected);
  });
});
