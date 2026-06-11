import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const metabaseDir = fileURLToPath(new URL('../../../../../src/context/ingest/adapters/metabase/', import.meta.url));

async function readMetabaseFile(name: string): Promise<string> {
  return readFile(join(metabaseDir, name), 'utf-8');
}

describe('ktx Metabase client boundary', () => {
  it('keeps NestJS, server data-source base classes, and server-relative imports out of the ktx client', async () => {
    const client = await readMetabaseFile('client.ts');
    expect(client).not.toContain(`@${'nestjs'}`);
    expect(client).not.toContain(`DataSource${'Client'}`);
    expect(client).not.toContain(`../base/data-source-${'client'}`);
    expect(client).not.toContain('../types');
    expect(client).not.toContain('../../types/brand');
  });

  it('keeps proxy implementation code out of the ktx v1 client', async () => {
    const client = await readMetabaseFile('client.ts');
    expect(client).not.toContain(`network-${'proxy'}`);
    expect(client).not.toContain(`ssh${'2'}`);
    expect(client).not.toContain(`tail${'scale'}`);
    expect(client).not.toContain('resolveNetworkProxy');
    expect(client).not.toContain('establishProxy');
    expect(client).not.toContain('executeProxiedRequest');
    expect(client).not.toContain('originalHost');
    expect(client).not.toContain('originalHostname');
    expect(client).not.toContain('servername');
  });

  it('keeps the runtime config proxy-free in v1', async () => {
    const port = await readMetabaseFile('client-port.ts');
    const runtimeConfigBlock = port.match(/export interface MetabaseClientRuntimeConfig \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(runtimeConfigBlock).toContain('apiUrl: string');
    expect(runtimeConfigBlock).toContain('apiKey: string');
    expect(runtimeConfigBlock).not.toContain('proxy');
    expect(runtimeConfigBlock).not.toContain('networkProxy');
  });
});
