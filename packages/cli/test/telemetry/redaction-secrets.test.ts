import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseKtxProjectConfig, serializeKtxProjectConfig } from '../../src/context/project/config.js';
import { initKtxProject } from '../../src/context/project/project.js';
import { collectTelemetryRedactionSecrets } from '../../src/telemetry/redaction-secrets.js';

describe('collectTelemetryRedactionSecrets', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-redaction-secrets-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(projectDir: string): Promise<void> {
    const configPath = join(projectDir, 'ktx.yaml');
    const config = parseKtxProjectConfig(await readFile(configPath, 'utf-8'));
    await writeFile(
      configPath,
      serializeKtxProjectConfig({
        ...config,
        llm: {
          ...config.llm,
          provider: {
            backend: 'anthropic',
            anthropic: { api_key: 'env:ANTHROPIC_API_KEY' }, // pragma: allowlist secret
          },
          models: { default: 'claude-sonnet-4-6' },
        },
        ingest: {
          ...config.ingest,
          embeddings: {
            backend: 'openai',
            model: 'text-embedding-3-small',
            dimensions: 1536,
            openai: { api_key: 'file:~/.ktx/secrets/openai-key' }, // pragma: allowlist secret
          },
        },
        scan: {
          ...config.scan,
          enrichment: {
            ...config.scan.enrichment,
            embeddings: {
              backend: 'openai',
              model: 'text-embedding-3-small',
              dimensions: 1536,
              openai: { api_key: 'env:SCAN_OPENAI_API_KEY' }, // pragma: allowlist secret
            },
          },
        },
        connections: {
          warehouse: {
            driver: 'postgres',
            url: 'env:DATABASE_URL',
            password: 'file:~/.ktx/secrets/db-password', // pragma: allowlist secret
          },
          docs: {
            driver: 'notion',
            auth_token_ref: 'env:NOTION_TOKEN', // pragma: allowlist secret
          },
        },
      }),
      'utf-8',
    );
  }

  it('derives only declared project secrets and parsed URL credentials', async () => {
    const homeDir = join(tempDir, 'home');
    const projectDir = join(tempDir, 'project');
    await mkdir(join(homeDir, '.ktx', 'secrets'), { recursive: true });
    await writeFile(join(homeDir, '.ktx', 'secrets', 'openai-key'), 'openai-file-secret\n', 'utf-8');
    await writeFile(join(homeDir, '.ktx', 'secrets', 'db-password'), 'db-file-password\n', 'utf-8');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-env-secret');
    vi.stubEnv('SCAN_OPENAI_API_KEY', 'scan-openai-env-secret');
    vi.stubEnv('DATABASE_URL', 'postgres://svc:db-url-password@db.example.test/analytics'); // pragma: allowlist secret
    vi.stubEnv('NOTION_TOKEN', 'notion-env-secret');
    vi.stubEnv('UNDECLARED_SECRET', 'must-not-appear');
    await initKtxProject({ projectDir });
    await writeConfig(projectDir);

    const secrets = await collectTelemetryRedactionSecrets({
      projectDir,
      connectionId: 'warehouse',
      includeLlm: true,
      includeEmbeddings: true,
      env: process.env,
    });

    expect(secrets).toEqual(
      expect.arrayContaining([
        'anthropic-env-secret',
        'openai-file-secret',
        'scan-openai-env-secret',
        'postgres://svc:db-url-password@db.example.test/analytics', // pragma: allowlist secret
        'db-url-password',
        'db-file-password',
      ]),
    );
    expect(secrets).not.toContain('notion-env-secret');
    expect(secrets).not.toContain('must-not-appear');
  });

  it('can derive a named non-database connection secret', async () => {
    const projectDir = join(tempDir, 'project');
    vi.stubEnv('NOTION_TOKEN', 'notion-env-secret');
    await initKtxProject({ projectDir });
    await writeConfig(projectDir);

    const secrets = await collectTelemetryRedactionSecrets({
      projectDir,
      connectionId: 'docs',
      includeLlm: false,
      includeEmbeddings: false,
      env: process.env,
    });

    expect(secrets).toEqual(['notion-env-secret']);
  });
});
