import { describe, expect, it } from 'vitest';

import { isDemoConnection } from '../../src/telemetry/demo-detect.js';

describe('isDemoConnection', () => {
  it('detects only the packaged Orbit SQLite demo recipe', () => {
    expect(
      isDemoConnection('orbit_demo', {
        driver: 'sqlite',
        path: '/tmp/ktx-demo/demo.db',
      }),
    ).toBe(true);

    expect(
      isDemoConnection('orbit_demo', {
        driver: 'postgres',
        path: '/tmp/ktx-demo/demo.db',
      }),
    ).toBe(false);
    expect(
      isDemoConnection('warehouse', {
        driver: 'sqlite',
        path: '/tmp/ktx-demo/demo.db',
      }),
    ).toBe(false);
    expect(
      isDemoConnection('orbit_demo', {
        driver: 'sqlite',
        path: '/tmp/ktx-demo/private.db',
      }),
    ).toBe(false);
  });
});
