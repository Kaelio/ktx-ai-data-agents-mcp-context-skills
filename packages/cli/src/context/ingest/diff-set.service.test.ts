import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDiffSetFromHashes, DiffSetService } from './diff-set.service.js';

function makeRepo(latest: Map<string, string>) {
  return {
    findLatestHashesForCompletedSyncs: () => Promise.resolve(latest),
  };
}

describe('DiffSetService', () => {
  let service: DiffSetService;
  const provenanceRepo = { findLatestHashesForCompletedSyncs: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new DiffSetService(provenanceRepo as any);
  });

  it('first run — no prior completed run — everything is added', async () => {
    provenanceRepo.findLatestHashesForCompletedSyncs.mockResolvedValue(new Map());
    const diff = await service.compute(
      'c1',
      'fake',
      new Map([
        ['a.yml', 'h1'],
        ['b.yml', 'h2'],
      ]),
    );
    expect(diff.added.sort()).toEqual(['a.yml', 'b.yml']);
    expect(diff.modified).toEqual([]);
    expect(diff.deleted).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it('classifies added / modified / deleted / unchanged against the latest-hash baseline', async () => {
    provenanceRepo.findLatestHashesForCompletedSyncs.mockResolvedValue(
      new Map([
        ['a.yml', 'h1'],
        ['b.yml', 'h_old'],
        ['c.yml', 'hc'],
      ]),
    );
    const now = new Map([
      ['a.yml', 'h1'],
      ['b.yml', 'h_new'],
      ['d.yml', 'hd'],
    ]);
    const diff = await service.compute('c1', 'fake', now);
    expect(diff.unchanged).toEqual(['a.yml']);
    expect(diff.modified).toEqual(['b.yml']);
    expect(diff.deleted).toEqual(['c.yml']);
    expect(diff.added).toEqual(['d.yml']);
  });

  it('computes a pure diff from current and prior hash maps', () => {
    const diff = computeDiffSetFromHashes(
      new Map([
        ['a.yml', 'h1'],
        ['b.yml', 'h2-new'],
        ['d.yml', 'h4'],
      ]),
      new Map([
        ['a.yml', 'h1'],
        ['b.yml', 'h2-old'],
        ['c.yml', 'h3'],
      ]),
    );

    expect(diff).toEqual({
      added: ['d.yml'],
      modified: ['b.yml'],
      deleted: ['c.yml'],
      unchanged: ['a.yml'],
    });
  });

  it('returns sorted arrays for deterministic hashing', async () => {
    provenanceRepo.findLatestHashesForCompletedSyncs.mockResolvedValue(new Map());
    const diff = await service.compute(
      'c1',
      'fake',
      new Map([
        ['z.yml', 'hz'],
        ['a.yml', 'ha'],
      ]),
    );
    expect(diff.added).toEqual(['a.yml', 'z.yml']);
  });

  it('with isPathInScope predicate, out-of-scope prior entries are not reported as deleted', async () => {
    const prior = new Map([
      ['cards/1.json', 'hashA'],
      ['cards/2.json', 'hashB'],
      ['cards/3.json', 'hashC'],
    ]);
    const current = new Map([
      ['cards/1.json', 'hashA'],
      ['cards/2.json', 'hashB'],
    ]);
    const inScope = new Set(['cards/1.json', 'cards/2.json']);
    const svc = new DiffSetService(makeRepo(prior) as any);
    const diff = await svc.compute('conn', 'metabase', current, (p) => inScope.has(p));
    expect(diff.deleted).toEqual([]);
    expect(diff.unchanged).toEqual(['cards/1.json', 'cards/2.json']);
  });

  it('with isPathInScope predicate, in-scope deletions are still reported', async () => {
    const prior = new Map([
      ['cards/1.json', 'hashA'],
      ['cards/2.json', 'hashB'],
    ]);
    const current = new Map([['cards/1.json', 'hashA']]);
    const inScope = new Set(['cards/1.json', 'cards/2.json']);
    const svc = new DiffSetService(makeRepo(prior) as any);
    const diff = await svc.compute('conn', 'metabase', current, (p) => inScope.has(p));
    expect(diff.deleted).toEqual(['cards/2.json']);
  });

  it('holds unchanged baseline across multiple incremental re-syncs (regression for skipped-row sync_id drift)', async () => {
    // After sync 1 wrote (a.yml, h1, sync=S1, skipped) and sync 2 computed a no-op,
    // sync 3 must still see a.yml as unchanged — the baseline comes from S1, not from
    // the most recent sync_id alone.
    provenanceRepo.findLatestHashesForCompletedSyncs.mockResolvedValue(
      new Map([
        ['a.yml', 'h1'],
        ['b.yml', 'h2'],
      ]),
    );
    const diff = await service.compute(
      'c1',
      'fake',
      new Map([
        ['a.yml', 'h1'],
        ['b.yml', 'h2'],
      ]),
    );
    expect(diff.added).toEqual([]);
    expect(diff.unchanged).toEqual(['a.yml', 'b.yml']);
  });
});

describe('DiffSetService — scope-narrowing scenario', () => {
  it('scope from [1,2,3] → [1,2] leaves no spurious deletions', async () => {
    const prior = new Map([
      ['cards/1.json', 'hashA'],
      ['cards/2.json', 'hashB'],
      ['cards/3.json', 'hashC'],
      ['sync-config.json', 'hashCfg'],
    ]);
    const current = new Map([
      ['cards/1.json', 'hashA'],
      ['cards/2.json', 'hashB'],
      ['sync-config.json', 'hashCfg2'],
    ]);
    const inScope = new Set(['cards/1.json', 'cards/2.json', 'sync-config.json']);
    const svc = new DiffSetService(makeRepo(prior) as any);
    const diff = await svc.compute('conn', 'metabase', current, (p) => inScope.has(p));
    expect(diff.deleted).toEqual([]);
    expect(diff.modified).toEqual(['sync-config.json']);
    expect(diff.unchanged).toEqual(['cards/1.json', 'cards/2.json']);
    expect(diff.added).toEqual([]);
  });
});
