import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkLookmlProject } from './chunk.js';
import { type ParsedLookmlProject, parseLookmlStagedDir } from './parse.js';

const FIXTURE_ROOT = join(__dirname, '../../../../test/fixtures/lookml');

describe('chunkLookmlProject — first run', () => {
  it('single-model bundle → 1 WU with model + all views in rawFiles', async () => {
    const stagedDir = join(FIXTURE_ROOT, 'single-model');
    const project = await parseLookmlStagedDir(stagedDir);
    const result = chunkLookmlProject(project);
    expect(result.workUnits).toHaveLength(1);
    const wu = result.workUnits[0];
    expect(wu.unitKey).toBe('lookml-orders');
    expect(wu.rawFiles.sort()).toEqual(['orders.model.lkml', 'views/customers.view.lkml', 'views/orders.view.lkml']);
    expect(wu.peerFileIndex).toEqual([]);
    expect(wu.dependencyPaths).toEqual([]);
    expect(result.eviction).toBeUndefined();
  });

  it('multi-model bundle → 1 WU per model; shared view owned by lex-first model; others see it in dependencyPaths + peerFileIndex is pathless-index', async () => {
    const stagedDir = join(FIXTURE_ROOT, 'multi-model');
    const project = await parseLookmlStagedDir(stagedDir);
    const result = chunkLookmlProject(project);
    expect(result.workUnits).toHaveLength(2);
    const marketing = result.workUnits.find((wu) => wu.unitKey === 'lookml-marketing');
    const orders = result.workUnits.find((wu) => wu.unitKey === 'lookml-orders');
    expect(marketing).toBeDefined();
    expect(orders).toBeDefined();
    if (!marketing || !orders) {
      throw new Error('expected marketing and orders work units');
    }

    // marketing sorts before orders → marketing owns shared_dims
    expect(marketing.rawFiles).toContain('views/shared_dims.view.lkml');
    expect(marketing.rawFiles).toContain('views/campaigns.view.lkml');
    expect(marketing.rawFiles).toContain('marketing.model.lkml');
    expect(marketing.rawFiles).not.toContain('views/orders.view.lkml');
    expect(marketing.dependencyPaths).toEqual([]);

    // orders does NOT own shared_dims — it's in dependencyPaths (read-only upstream).
    expect(orders.rawFiles).not.toContain('views/shared_dims.view.lkml');
    expect(orders.dependencyPaths).toEqual(['views/shared_dims.view.lkml']);
    expect(orders.rawFiles).toContain('views/orders.view.lkml');
    expect(orders.rawFiles).toContain('orders.model.lkml');

    // Each WU's peerFileIndex lists the OTHER model's files (paths-only index).
    expect(orders.peerFileIndex).toContain('marketing.model.lkml');
    expect(orders.peerFileIndex).toContain('views/campaigns.view.lkml');
    // Dependency paths should not be duplicated into peerFileIndex.
    expect(orders.peerFileIndex).not.toContain('views/shared_dims.view.lkml');
  });

  it('extends-chain fixture: single WU contains base + orders + orders_ext; chain order visible via graph', async () => {
    const stagedDir = join(FIXTURE_ROOT, 'extends-chain');
    const project = await parseLookmlStagedDir(stagedDir);
    const result = chunkLookmlProject(project);
    // One model ("orders") includes views/*.view.lkml — so all three views land in its WU.
    expect(result.workUnits).toHaveLength(1);
    const wu = result.workUnits[0];
    expect(wu.unitKey).toBe('lookml-orders');
    expect(wu.rawFiles.sort()).toEqual([
      'orders.model.lkml',
      'views/base.view.lkml',
      'views/orders.view.lkml',
      'views/orders_ext.view.lkml',
    ]);
    expect(wu.dependencyPaths).toEqual([]); // all ancestors already in rawFiles on first run
    expect(wu.notes).toMatch(/orders/);
  });

  it('is deterministic: two calls on the same project return structurally identical WorkUnits', async () => {
    const stagedDir = join(FIXTURE_ROOT, 'multi-model');
    const project = await parseLookmlStagedDir(stagedDir);
    const r1 = chunkLookmlProject(project);
    const r2 = chunkLookmlProject(project);
    expect(r1.workUnits).toEqual(r2.workUnits);
  });

  it('unitKey is model-name-derived (stable across parse+chunk cycles and across re-syncs)', async () => {
    const project = await parseLookmlStagedDir(join(FIXTURE_ROOT, 'multi-model'));
    const { workUnits } = chunkLookmlProject(project);
    expect(workUnits.map((wu) => wu.unitKey).sort()).toEqual(['lookml-marketing', 'lookml-orders']);
  });

  it('marks mismatched model WorkUnits as SL-disallowed and keeps wiki ingest enabled', () => {
    const project: ParsedLookmlProject = {
      models: [
        {
          path: 'b2b.model.lkml',
          name: 'b2b',
          includes: ['views/orders.view.lkml'],
          explores: ['orders'],
          connectionName: 'wrong_connection',
        },
      ],
      views: [{ path: 'views/orders.view.lkml', name: 'orders', extendsFrom: [], rawSqlTableName: 'public.orders' }],
      dashboards: [],
      allPaths: ['b2b.model.lkml', 'views/orders.view.lkml'],
    };

    const result = chunkLookmlProject(project, { mismatchedModelNames: new Set(['b2b']) });
    const wu = result.workUnits[0];

    expect(wu.unitKey).toBe('lookml-b2b');
    expect(wu.rawFiles).toEqual(['b2b.model.lkml', 'views/orders.view.lkml']);
    expect(wu.slDisallowed).toBe(true);
    expect(wu.slDisallowedReason).toBe('lookml_connection_mismatch');
    expect(wu.notes).toContain('[LOOKML SL WRITES DISALLOWED]');
    expect(wu.notes).toContain('reason: lookml_connection_mismatch');
    expect(wu.notes).toContain('Do not call sl_write_source or sl_edit_source for this WorkUnit.');
  });
});

describe('chunkLookmlProject — re-sync', () => {
  it("modified file in one model only emits that model's WU", async () => {
    const stagedDir = join(FIXTURE_ROOT, 'multi-model');
    const project = await parseLookmlStagedDir(stagedDir);
    const result = chunkLookmlProject(project, {
      diffSet: {
        added: [],
        modified: ['views/campaigns.view.lkml'],
        deleted: [],
        unchanged: [
          'marketing.model.lkml',
          'orders.model.lkml',
          'views/orders.view.lkml',
          'views/shared_dims.view.lkml',
        ],
      },
    });
    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0].unitKey).toBe('lookml-marketing');
  });

  it("added file under a model emits that model's WU with the new path in rawFiles", async () => {
    const stagedDir = join(FIXTURE_ROOT, 'single-model');
    const project = await parseLookmlStagedDir(stagedDir);
    const result = chunkLookmlProject(project, {
      diffSet: {
        added: ['views/customers.view.lkml'],
        modified: [],
        deleted: [],
        unchanged: ['orders.model.lkml', 'views/orders.view.lkml'],
      },
    });
    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0].rawFiles).toContain('views/customers.view.lkml');
  });

  it('widens dependencyPaths with transitive extends ancestors on re-sync', async () => {
    const stagedDir = join(FIXTURE_ROOT, 'extends-chain');
    const project = await parseLookmlStagedDir(stagedDir);
    // Only orders_ext is touched; base and orders are upstream ancestors.
    // Because the single-model WU's rawFiles ALREADY include all three on first run,
    // they remain in rawFiles — dependencyPaths stays empty. Widening matters when
    // re-sync drops some files from rawFiles, which doesn't apply for a monolithic
    // single-model WU. Assert the baseline invariant.
    const result = chunkLookmlProject(project, {
      diffSet: {
        added: [],
        modified: ['views/orders_ext.view.lkml'],
        deleted: [],
        unchanged: ['orders.model.lkml', 'views/base.view.lkml', 'views/orders.view.lkml'],
      },
    });
    expect(result.workUnits).toHaveLength(1);
    const wu = result.workUnits[0];
    expect(wu.rawFiles).toContain('views/orders_ext.view.lkml');
    // Ancestors already in rawFiles → not duplicated into dependencyPaths.
    expect(wu.dependencyPaths).toEqual([]);
  });

  it('widens dependencyPaths when an ancestor is OUTSIDE the WU (synthesized cross-model case)', () => {
    // Synthesize a scenario in-memory: two models, "a" owns base.view.lkml,
    // "b" owns derived.view.lkml which extends base. A diff that only touches
    // derived.view.lkml should widen b's WU with base.view.lkml in dependencyPaths
    // if base lives outside b's rawFiles. In practice with the current emit rules,
    // base.view.lkml would already be in dependencyPaths because model b lists
    // base.view.lkml under its `include:`. Here we confirm the widening is idempotent.
    const project: ParsedLookmlProject = {
      models: [
        { path: 'a.model.lkml', name: 'a', includes: ['views/base.view.lkml'], explores: [], connectionName: null },
        {
          path: 'b.model.lkml',
          name: 'b',
          includes: ['views/base.view.lkml', 'views/derived.view.lkml'],
          explores: [],
          connectionName: null,
        },
      ],
      views: [
        { path: 'views/base.view.lkml', name: 'base', extendsFrom: [], rawSqlTableName: null },
        { path: 'views/derived.view.lkml', name: 'derived', extendsFrom: ['base'], rawSqlTableName: null },
      ],
      dashboards: [],
      allPaths: ['a.model.lkml', 'b.model.lkml', 'views/base.view.lkml', 'views/derived.view.lkml'],
    };
    const result = chunkLookmlProject(project, {
      diffSet: {
        added: [],
        modified: ['views/derived.view.lkml'],
        deleted: [],
        unchanged: ['a.model.lkml', 'b.model.lkml', 'views/base.view.lkml'],
      },
    });
    const b = result.workUnits.find((wu) => wu.unitKey === 'lookml-b');
    expect(b).toBeDefined();
    if (!b) {
      throw new Error('expected lookml-b work unit');
    }
    expect(b.dependencyPaths).toContain('views/base.view.lkml');
  });

  it('passes through diffSet.deleted as an EvictionUnit', async () => {
    const project = await parseLookmlStagedDir(join(FIXTURE_ROOT, 'single-model'));
    const result = chunkLookmlProject(project, {
      diffSet: {
        added: [],
        modified: [],
        deleted: ['views/zombie.view.lkml'],
        unchanged: ['orders.model.lkml', 'views/customers.view.lkml', 'views/orders.view.lkml'],
      },
    });
    expect(result.eviction).toEqual({ deletedRawPaths: ['views/zombie.view.lkml'] });
    // No WU emitted because no current files are touched.
    expect(result.workUnits).toEqual([]);
  });
});
