import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envCredentialReference, writeProjectLocalSecretReference } from '../src/setup-secrets.js';

describe('setup secrets', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-secrets-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('formats env credential references', () => {
    expect(envCredentialReference('ANTHROPIC_API_KEY')).toBe('env:ANTHROPIC_API_KEY');
  });

  it('writes project-local secrets with restricted permissions and returns a file reference', async () => {
    const result = await writeProjectLocalSecretReference({
      projectDir: tempDir,
      fileName: 'anthropic-api-key',
      value: 'sk-ant-test',
    });

    expect(result).toBe(`file:${resolve(tempDir, '.ktx/secrets/anthropic-api-key')}`);
    await expect(readFile(join(tempDir, '.ktx/secrets/anthropic-api-key'), 'utf-8')).resolves.toBe('sk-ant-test\n');

    if (process.platform !== 'win32') {
      const mode = (await stat(join(tempDir, '.ktx/secrets/anthropic-api-key'))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
