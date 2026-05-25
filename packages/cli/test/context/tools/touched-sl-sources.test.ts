import { describe, expect, it } from 'vitest';
import {
  addTouchedSlSource,
  createTouchedSlSources,
  deleteTouchedSlSource,
  hasTouchedSlSource,
  listTouchedSlSources,
  touchedSlSourceCount,
  touchedSlSourceNamesForConnection,
} from '../../../src/context/tools/touched-sl-sources.js';

describe('target-aware touched SL source helpers', () => {
  it('deduplicates by connectionId and sourceName while preserving target identity', () => {
    const touched = createTouchedSlSources();

    addTouchedSlSource(touched, 'warehouse-a', 'orders');
    addTouchedSlSource(touched, 'warehouse-a', 'orders');
    addTouchedSlSource(touched, 'warehouse-b', 'orders');

    expect(listTouchedSlSources(touched)).toEqual([
      { connectionId: 'warehouse-a', sourceName: 'orders' },
      { connectionId: 'warehouse-b', sourceName: 'orders' },
    ]);
    expect(touchedSlSourceCount(touched)).toBe(2);
    expect(hasTouchedSlSource(touched, 'warehouse-a', 'orders')).toBe(true);
    expect(hasTouchedSlSource(touched, 'warehouse-b', 'orders')).toBe(true);
  });

  it('lists touched names for one connection and deletes only that connection/source pair', () => {
    const touched = createTouchedSlSources([
      { connectionId: 'warehouse-a', sourceName: 'orders' },
      { connectionId: 'warehouse-a', sourceName: 'customers' },
      { connectionId: 'warehouse-b', sourceName: 'orders' },
    ]);

    deleteTouchedSlSource(touched, 'warehouse-a', 'orders');

    expect(touchedSlSourceNamesForConnection(touched, 'warehouse-a')).toEqual(['customers']);
    expect(touchedSlSourceNamesForConnection(touched, 'warehouse-b')).toEqual(['orders']);
    expect(listTouchedSlSources(touched)).toEqual([
      { connectionId: 'warehouse-a', sourceName: 'customers' },
      { connectionId: 'warehouse-b', sourceName: 'orders' },
    ]);
  });
});
