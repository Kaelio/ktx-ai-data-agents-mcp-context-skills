import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('LookerClient boundary', () => {
  it('does not import server or NestJS modules', async () => {
    const source = await readFile(new URL('../../../../../src/context/ingest/adapters/looker/client.ts', import.meta.url), 'utf-8');

    expect(source).not.toMatch(/@nestjs\/common/);
    expect(source).not.toMatch(/DataSourceClient/);
    expect(source).not.toMatch(/\.\.\/interfaces/);
    expect(source).not.toMatch(/\.\.\/types/);
    expect(source).not.toMatch(/server\/src/);
  });
});
