import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KtxProjectConnectionConfig } from '../../../../context/project/config.js';
import { metabaseRuntimeConfigFromLocalConnection } from './local-metabase.adapter.js';

describe('metabaseRuntimeConfigFromLocalConnection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-metabase-runtime-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves api_url and env-backed api_key_ref from a flat ktx.yaml connection', () => {
    const connection: KtxProjectConnectionConfig = {
      driver: 'metabase',
      api_url: 'https://metabase.example.com',
      api_key_ref: 'env:METABASE_API_KEY', // pragma: allowlist secret
    };

    expect(
      metabaseRuntimeConfigFromLocalConnection('prod-metabase', connection, {
        METABASE_API_KEY: 'mb_key', // pragma: allowlist secret
      }),
    ).toEqual({
      apiUrl: 'https://metabase.example.com',
      apiKey: 'mb_key', // pragma: allowlist secret
    });
  });

  it('resolves file-backed api_key_ref from pasted setup secrets', async () => {
    const keyPath = join(tempDir, 'metabase-main-api-key');
    await writeFile(keyPath, 'mb_file_key\n', 'utf-8'); // pragma: allowlist secret
    const connection: KtxProjectConnectionConfig = {
      driver: 'metabase',
      api_url: 'https://metabase.example.com',
      api_key_ref: `file:${keyPath}`, // pragma: allowlist secret
    };

    expect(metabaseRuntimeConfigFromLocalConnection('prod-metabase', connection)).toEqual({
      apiUrl: 'https://metabase.example.com',
      apiKey: 'mb_file_key', // pragma: allowlist secret
    });
  });

  it('rejects proxy-bearing local Metabase connections', () => {
    const connection: KtxProjectConnectionConfig = {
      driver: 'metabase',
      api_url: 'https://metabase.example.com',
      api_key: 'literal-test-key', // pragma: allowlist secret
      networkProxy: { type: 'ssh' },
    };

    expect(() => metabaseRuntimeConfigFromLocalConnection('prod-metabase', connection)).toThrow(
      'Standalone KTX does not support proxy-bearing Metabase connections yet',
    );
  });

  it('rejects non-Metabase source connections', () => {
    const connection: KtxProjectConnectionConfig = {
      driver: 'postgres',
      url: 'postgres://localhost/db',
    };

    expect(() => metabaseRuntimeConfigFromLocalConnection('warehouse', connection)).toThrow(
      'Connection "warehouse" is not a Metabase connection',
    );
  });
});
