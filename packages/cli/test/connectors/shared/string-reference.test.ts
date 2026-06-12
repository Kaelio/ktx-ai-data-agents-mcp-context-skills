import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStringReference } from '../../../src/connectors/shared/string-reference.js';

describe('resolveStringReference', () => {
  it('returns plain values unchanged', () => {
    expect(resolveStringReference('postgres://localhost/db', {})).toBe('postgres://localhost/db');
  });

  it('resolves env: references from the provided env', () => {
    expect(resolveStringReference('env:MY_URL', { MY_URL: 'resolved-url' })).toBe('resolved-url');
  });

  it('returns empty string for a missing env var', () => {
    expect(resolveStringReference('env:NOPE', {})).toBe('');
  });

  it('resolves file: references and trims whitespace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ktx-strref-'));
    const file = join(dir, 'secret.txt');
    writeFileSync(file, '  hunter2\n');
    try {
      expect(resolveStringReference(`file:${file}`, {})).toBe('hunter2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
