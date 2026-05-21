import { describe, expect, it, vi } from 'vitest';
import { validateWuTouchedSources } from './validate-wu-sources.js';

describe('validateWuTouchedSources', () => {
  it('validates each touched source against its own connection', async () => {
    const validateSingleSource = vi
      .fn()
      .mockImplementation((_deps: unknown, conn: string, name: string) =>
        Promise.resolve(
          conn === 'warehouse-a' && name === 'good'
            ? { errors: [], warnings: [] }
            : { errors: ['invalid measure'], warnings: [] },
        ),
      );
    const deps = { slValidator: { validateSingleSource } } as any;

    const result = await validateWuTouchedSources(deps, [
      { connectionId: 'warehouse-a', sourceName: 'good' },
      { connectionId: 'warehouse-b', sourceName: 'bad' },
    ]);

    expect(result.validSources).toEqual(['warehouse-a:good']);
    expect(result.invalidSources).toEqual(['warehouse-b:bad']);
    expect(validateSingleSource).toHaveBeenNthCalledWith(1, deps, 'warehouse-a', 'good');
    expect(validateSingleSource).toHaveBeenNthCalledWith(2, deps, 'warehouse-b', 'bad');
  });

  it('returns empty arrays when no sources are touched', async () => {
    const validateSingleSource = vi.fn();
    const deps = { slValidator: { validateSingleSource } } as any;
    const result = await validateWuTouchedSources(deps, []);
    expect(result).toEqual({ validSources: [], invalidSources: [] });
    expect(validateSingleSource).not.toHaveBeenCalled();
  });
});
