import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gdriveConnectionToPullConfig,
  parseGdriveConnectionConfig,
  resolveGdriveServiceAccountKey,
} from './gdrive-config.js';

describe('standalone gdrive connection config', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-gdrive-config-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('parses config with safe defaults', () => {
    const parsed = parseGdriveConnectionConfig({
      driver: 'gdrive',
      service_account_key_ref: 'file:/tmp/google-key.json',
      folder_id: 'folder-123',
    });

    expect(parsed).toEqual({
      driver: 'gdrive',
      service_account_key_ref: 'file:/tmp/google-key.json',
      folder_id: 'folder-123',
      recursive: false,
    });
  });

  it('requires file-based service account keys', () => {
    expect(() =>
      parseGdriveConnectionConfig({
        driver: 'gdrive',
        service_account_key_ref: 'env:GOOGLE_KEY',
        folder_id: 'folder-123',
      }),
    ).toThrow('gdrive service_account_key_ref must use file:/path/to/key.json');
  });

  it('resolves service account key files', async () => {
    const keyPath = join(tempDir, 'google-key.json');
    await writeFile(keyPath, '{"client_email":"bot@example.com","private_key":"line-1"}\n', 'utf-8');
    await expect(resolveGdriveServiceAccountKey(`file:${keyPath}`)).resolves.toContain('"client_email":"bot@example.com"');
  });

  it('converts config into adapter pull config', async () => {
    const keyPath = join(tempDir, 'google-key.json');
    await writeFile(keyPath, '{"client_email":"bot@example.com","private_key":"line-1"}\n', 'utf-8');
    const pullConfig = await gdriveConnectionToPullConfig(
      parseGdriveConnectionConfig({
        driver: 'gdrive',
        service_account_key_ref: `file:${keyPath}`,
        folder_id: 'folder-123',
        recursive: true,
      }),
    );

    expect(pullConfig).toEqual({
      serviceAccountKey: '{"client_email":"bot@example.com","private_key":"line-1"}',
      folderId: 'folder-123',
      recursive: true,
    });
  });
});
