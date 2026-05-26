import { describe, expect, it } from 'vitest';
import { SourceAdapterRegistry } from '../../../src/context/ingest/source-adapter-registry.js';
import type { SourceAdapter } from '../../../src/context/ingest/types.js';

const makeAdapter = (source: string): SourceAdapter => ({
  source,
  skillNames: [],
  detect() {
    return Promise.resolve(true);
  },
  chunk() {
    return Promise.resolve({ workUnits: [] });
  },
});

describe('SourceAdapterRegistry', () => {
  it('returns a registered adapter by sourceKey', () => {
    const registry = new SourceAdapterRegistry();
    const fake = makeAdapter('fake');
    registry.register(fake);
    expect(registry.get('fake')).toBe(fake);
  });

  it('throws for an unknown sourceKey', () => {
    const registry = new SourceAdapterRegistry();
    expect(() => registry.get('missing')).toThrow(/no source adapter registered for 'missing'/);
  });

  it('throws when a sourceKey is registered twice', () => {
    const registry = new SourceAdapterRegistry();
    registry.register(makeAdapter('fake'));
    expect(() => registry.register(makeAdapter('fake'))).toThrow(/already registered/);
  });

  it('has returns true only after registration', () => {
    const registry = new SourceAdapterRegistry();
    expect(registry.has('fake')).toBe(false);
    registry.register(makeAdapter('fake'));
    expect(registry.has('fake')).toBe(true);
  });
});
