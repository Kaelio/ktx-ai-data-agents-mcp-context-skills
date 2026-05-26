import { describe, expect, it } from 'vitest';
import { CardReferenceCycleError, expandCardReferences } from '../../../../../src/context/ingest/adapters/metabase/card-references.js';

describe('expandCardReferences', () => {
  const fetchCard = (id: number): Promise<{ native_query: string }> => {
    const cards: Record<number, string> = {
      100: 'SELECT id FROM base_table',
      101: 'SELECT * FROM {{#100}}',
      102: 'SELECT * FROM {{#101}} WHERE x = 1',
      200: 'SELECT * FROM {{#201}}',
      201: 'SELECT * FROM {{#200}}',
    };
    if (!(id in cards)) {
      return Promise.reject(new Error(`no card ${id}`));
    }
    return Promise.resolve({ native_query: cards[id] });
  };

  it('returns SQL unchanged when there are no references', async () => {
    const result = await expandCardReferences('SELECT 1', { fetchCard });
    expect(result).toBe('SELECT 1');
  });

  it('inlines a single card reference as a subquery', async () => {
    const result = await expandCardReferences('SELECT * FROM {{#100}}', { fetchCard });
    expect(result).toBe('SELECT * FROM (SELECT id FROM base_table)');
  });

  it('handles slugged references like {{#100-pretty-slug}}', async () => {
    const result = await expandCardReferences('SELECT * FROM {{#100-pretty-slug}}', { fetchCard });
    expect(result).toBe('SELECT * FROM (SELECT id FROM base_table)');
  });

  it('recursively resolves nested references', async () => {
    const result = await expandCardReferences('SELECT * FROM {{#102}}', { fetchCard });
    expect(result).toBe('SELECT * FROM (SELECT * FROM (SELECT * FROM (SELECT id FROM base_table)) WHERE x = 1)');
  });

  it('detects cycles and throws CardReferenceCycleError', async () => {
    await expect(expandCardReferences('SELECT * FROM {{#200}}', { fetchCard })).rejects.toBeInstanceOf(
      CardReferenceCycleError,
    );
  });
});
