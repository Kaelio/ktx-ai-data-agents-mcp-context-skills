import { describe, expect, it } from 'vitest';
import { actionTargetConnectionId, memoryActionIdentity } from '../../../src/context/ingest/action-identity.js';

describe('memory action target identity', () => {
  it('keys SL actions by target connection and wiki actions by run connection', () => {
    expect(
      memoryActionIdentity(
        { target: 'sl', type: 'created', key: 'orders', detail: '', targetConnectionId: 'warehouse-b' },
        'looker-run',
      ),
    ).toBe('sl:warehouse-b:orders');

    expect(memoryActionIdentity({ target: 'sl', type: 'created', key: 'orders', detail: '' }, 'warehouse-a')).toBe(
      'sl:warehouse-a:orders',
    );

    expect(
      memoryActionIdentity(
        {
          target: 'wiki',
          type: 'created',
          key: 'wiki/global/orders.md',
          detail: '',
          targetConnectionId: 'ignored',
        },
        'looker-run',
      ),
    ).toBe('wiki:looker-run:wiki/global/orders.md');
  });

  it('resolves action target connection only for SL actions', () => {
    expect(
      actionTargetConnectionId(
        { target: 'sl', type: 'updated', key: 'orders', detail: '', targetConnectionId: 'warehouse-b' },
        'looker-run',
      ),
    ).toBe('warehouse-b');
    expect(actionTargetConnectionId({ target: 'wiki', type: 'updated', key: 'orders', detail: '' }, 'looker-run')).toBe(
      'looker-run',
    );
  });
});
