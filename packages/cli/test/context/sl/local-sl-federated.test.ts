import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDefaultKtxProjectConfig } from '../../../src/context/project/config.js';
import type { GitService } from '../../../src/context/core/git.service.js';
import { LocalGitFileStore } from '../../../src/context/project/local-git-file-store.js';
import type { KtxLocalProject } from '../../../src/context/project/project.js';
import { loadLocalSlSourceRecords } from '../../../src/context/sl/local-sl.js';

const BOOKS_MANIFEST = `tables:
  books:
    table: public.books
    columns:
      - name: book_id
        type: number
        pk: true
      - name: title
        type: string
`;

const REVIEWS_MANIFEST = `tables:
  reviews:
    table: main.reviews
    columns:
      - name: review_id
        type: number
        pk: true
      - name: rating
        type: number
`;

// Build a project backed only by an on-disk file store (no git init, no
// commit), so the fixture never hits the gpg-signing path during init.
function fakeProject(projectDir: string, connections: KtxLocalProject['config']['connections']): KtxLocalProject {
  const fileStore = new LocalGitFileStore({ rootDir: projectDir, git: {} as GitService });
  const config = { ...buildDefaultKtxProjectConfig(), connections };
  return {
    projectDir,
    configPath: join(projectDir, 'ktx.yaml'),
    config,
    coreConfig: {} as KtxLocalProject['coreConfig'],
    git: {} as GitService,
    fileStore,
  };
}

// `skipLock: true` writes the file to disk without committing, avoiding git.
async function seedManifest(project: KtxLocalProject, path: string, content: string): Promise<void> {
  await project.fileStore.writeFile(path, content, 'ktx', 'ktx@example.com', 'seed manifest', { skipLock: true });
}

describe('federated semantic-layer source loading', () => {
  let tempDir: string;
  let project: KtxLocalProject;
  let singleMemberProject: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-sl-fed-'));

    project = fakeProject(join(tempDir, 'project'), {
      pg_books: { driver: 'postgres' },
      sqlite_reviews: { driver: 'sqlite' },
    });
    await seedManifest(project, 'semantic-layer/pg_books/_schema/public.yaml', BOOKS_MANIFEST);
    await seedManifest(project, 'semantic-layer/sqlite_reviews/_schema/main.yaml', REVIEWS_MANIFEST);

    singleMemberProject = fakeProject(join(tempDir, 'single'), {
      pg_books: { driver: 'postgres' },
    });
    await seedManifest(singleMemberProject, 'semantic-layer/pg_books/_schema/public.yaml', BOOKS_MANIFEST);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('unions member source records for _ktx_federated', async () => {
    const records = await loadLocalSlSourceRecords(project, { connectionId: '_ktx_federated' });
    const names = records.map((r) => r.source.name).sort();
    expect(names).toEqual(['books', 'reviews']);
  });

  it('reads from member dirs, never a literal _ktx_federated dir', async () => {
    const records = await loadLocalSlSourceRecords(project, { connectionId: '_ktx_federated' });
    // The federated connection owns no directory; records carry their member
    // connection ids, proving the union read from member dirs only.
    expect(records.map((r) => r.connectionId).sort()).toEqual(['pg_books', 'sqlite_reviews']);
  });

  it('returns empty for _ktx_federated when fewer than 2 compatible members', async () => {
    const records = await loadLocalSlSourceRecords(singleMemberProject, { connectionId: '_ktx_federated' });
    expect(records).toEqual([]);
  });
});
