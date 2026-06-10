import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../../../src/context/project/project.js';
import {
  resolveSlSourceFile,
  slSourceFileName,
  slSourceFilePath,
  slSourceNameForFile,
} from '../../../src/context/sl/source-files.js';

describe('slSourceFileName', () => {
  it('keeps safe lowercase snake_case names verbatim', () => {
    expect(slSourceFileName('orders')).toBe('orders.yaml');
    expect(slSourceFileName('mart_account_segments')).toBe('mart_account_segments.yaml');
    expect(slSourceFileName('orders2')).toBe('orders2.yaml');
  });

  it('derives a slug-hash filename for any other name and never throws', () => {
    expect(slSourceFileName('SIGNED_UP')).toMatch(/^signed_up-[0-9a-f]{8}\.yaml$/);
    expect(slSourceFileName('EVENT$LOG')).toMatch(/^event_log-[0-9a-f]{8}\.yaml$/);
    expect(slSourceFileName('my.dotted.name')).toMatch(/^my_dotted_name-[0-9a-f]{8}\.yaml$/);
    expect(slSourceFileName('汉字')).toMatch(/^src-[0-9a-f]{8}\.yaml$/);
    expect(slSourceFileName(' ')).toMatch(/^src-[0-9a-f]{8}\.yaml$/);
  });

  it('is deterministic', () => {
    expect(slSourceFileName('EVENT$LOG')).toBe(slSourceFileName('EVENT$LOG'));
  });

  it('never emits path separators or traversal segments', () => {
    for (const name of ['../orders', 'a/b', 'a\\b', '..', './x']) {
      const fileName = slSourceFileName(name);
      expect(fileName).not.toContain('/');
      expect(fileName).not.toContain('\\');
      expect(fileName).not.toContain('..');
    }
  });

  it('keeps case-differing names disjoint on case-insensitive filesystems', () => {
    // Safe-branch filenames contain no `-`; hash-branch filenames always end
    // in `-<8 hex>` with a hash of the raw name, so `events` vs `EVENTS`
    // cannot collide even when the filesystem folds case (macOS, Windows).
    const lower = slSourceFileName('events');
    const upper = slSourceFileName('EVENTS');
    expect(lower).toBe('events.yaml');
    expect(upper).toMatch(/^events-[0-9a-f]{8}\.yaml$/);
    expect(upper.toLowerCase()).not.toBe(lower.toLowerCase());
    expect(lower).not.toContain('-');
  });

  it('routes Windows reserved device basenames through the hash branch', () => {
    expect(slSourceFileName('con')).toMatch(/^con-[0-9a-f]{8}\.yaml$/);
    expect(slSourceFileName('lpt1')).toMatch(/^lpt1-[0-9a-f]{8}\.yaml$/);
  });

  it('caps overlong names', () => {
    const longName = `a${'b'.repeat(300)}`;
    const fileName = slSourceFileName(longName);
    expect(fileName.length).toBeLessThanOrEqual(64 + '-12345678.yaml'.length);
    expect(fileName).toMatch(/^ab+-[0-9a-f]{8}\.yaml$/);
  });
});

describe('slSourceFilePath', () => {
  it('rejects unsafe connection ids but accepts any source name', () => {
    expect(slSourceFilePath('warehouse', 'EVENT$LOG')).toMatch(
      /^semantic-layer\/warehouse\/event_log-[0-9a-f]{8}\.yaml$/,
    );
    expect(() => slSourceFilePath('../warehouse', 'orders')).toThrow('Unsafe connection id');
  });
});

describe('slSourceNameForFile', () => {
  it('prefers the in-file name and falls back to the filename', () => {
    expect(slSourceNameForFile('semantic-layer/warehouse/custom.yaml', 'name: SIGNED_UP\n')).toBe('SIGNED_UP');
    expect(slSourceNameForFile('semantic-layer/warehouse/orders.yaml', 'measures: []\n')).toBe('orders');
    expect(slSourceNameForFile('semantic-layer/warehouse/orders.yaml', 'measures: [unterminated\n')).toBe('orders');
  });

  it('recovers the declared name when the file is broken below the name: line', () => {
    // A human-renamed file left mid-edit keeps its identity: the syntax error is
    // under `measures:`, so the top-level `name:` is still recoverable and must
    // win over the (unrelated) filename.
    expect(slSourceNameForFile('semantic-layer/warehouse/renamed-by-hand.yaml', 'name: SIGNED_UP\nmeasures: [oops\n')).toBe(
      'SIGNED_UP',
    );
  });
});

describe('resolveSlSourceFile', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-sl-source-files-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seed(path: string, content: string): Promise<void> {
    await project.fileStore.writeFile(path, content, 'ktx', 'ktx@example.com', `seed ${path}`);
  }

  it('matches by in-file name regardless of the filename', async () => {
    await seed('semantic-layer/warehouse/renamed-by-hand.yaml', 'name: SIGNED_UP\nmeasures: []\n');

    await expect(resolveSlSourceFile(project.fileStore, 'warehouse', 'SIGNED_UP')).resolves.toEqual({
      path: 'semantic-layer/warehouse/renamed-by-hand.yaml',
      content: 'name: SIGNED_UP\nmeasures: []\n',
    });
  });

  it('returns null when no file declares the name and ignores manifest shards', async () => {
    await seed('semantic-layer/warehouse/_schema/public.yaml', 'tables:\n  orders:\n    table: public.orders\n');

    await expect(resolveSlSourceFile(project.fileStore, 'warehouse', 'orders')).resolves.toBeNull();
  });

  it('falls back to the filename for broken YAML', async () => {
    const broken = 'name: orders\nmeasures: [unterminated\n';
    await seed('semantic-layer/warehouse/orders.yaml', broken);

    await expect(resolveSlSourceFile(project.fileStore, 'warehouse', 'orders')).resolves.toEqual({
      path: 'semantic-layer/warehouse/orders.yaml',
      content: broken,
    });
  });

  it('matches a human-renamed broken file by its still-recoverable name', async () => {
    // Filename ≠ name, so the filename fallback cannot find it; resolution must
    // come from the intact top-level `name:` even though the YAML is broken.
    const broken = 'name: SIGNED_UP\nmeasures: [unterminated\n';
    await seed('semantic-layer/warehouse/renamed-by-hand.yaml', broken);

    await expect(resolveSlSourceFile(project.fileStore, 'warehouse', 'SIGNED_UP')).resolves.toEqual({
      path: 'semantic-layer/warehouse/renamed-by-hand.yaml',
      content: broken,
    });
  });

  it('throws when two files declare the same source name', async () => {
    await seed('semantic-layer/warehouse/orders.yaml', 'name: orders\nmeasures: []\n');
    await seed('semantic-layer/warehouse/orders_copy.yaml', 'name: orders\nmeasures: []\n');

    await expect(resolveSlSourceFile(project.fileStore, 'warehouse', 'orders')).rejects.toThrow(
      'Multiple semantic-layer files declare source "orders"',
    );
  });
});
