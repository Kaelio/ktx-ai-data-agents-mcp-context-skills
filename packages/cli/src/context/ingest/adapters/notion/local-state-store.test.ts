import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalNotionRuntimeStore } from './local-state-store.js';

describe('LocalNotionRuntimeStore', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-notion-state-'));
    dbPath = join(tempDir, '.ktx', 'db.sqlite');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('stores Notion cursors in local state and clears them after complete snapshots', async () => {
    const cursor = '{"phase":"all_accessible_pages","cursor":"cursor-1"}';
    const store = new LocalNotionRuntimeStore({
      dbPath,
      now: () => new Date('2026-05-13T10:00:00.000Z'),
    });

    await expect(store.readCursor('notion-main')).resolves.toBeNull();
    await store.setCursor('notion-main', cursor);

    const reopened = new LocalNotionRuntimeStore({ dbPath });
    await expect(reopened.readCursor('notion-main')).resolves.toBe(cursor);

    await reopened.setCursor('notion-main', null);
    await expect(reopened.readCursor('notion-main')).resolves.toBeNull();
  });
});
