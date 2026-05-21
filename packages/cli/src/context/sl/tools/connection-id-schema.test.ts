import { describe, expect, it } from 'vitest';
import { slToolConnectionIdSchema } from './connection-id-schema.js';

describe('slToolConnectionIdSchema', () => {
  it('accepts app UUIDs and local project connection ids', () => {
    expect(slToolConnectionIdSchema.parse('00000000-0000-4000-8000-000000000001')).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(slToolConnectionIdSchema.parse('warehouse')).toBe('warehouse');
    expect(slToolConnectionIdSchema.parse('warehouse_prod-1')).toBe('warehouse_prod-1');
  });

  it('rejects empty, path-like, and hidden connection ids', () => {
    for (const value of ['', '../warehouse', 'warehouse/prod', '.warehouse', 'warehouse prod']) {
      expect(() => slToolConnectionIdSchema.parse(value)).toThrow();
    }
  });
});
