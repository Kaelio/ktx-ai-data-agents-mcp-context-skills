import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLookmlStagedDir } from './parse.js';

describe('parseLookmlStagedDir', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'lkml-parse-'));
  });

  afterEach(async () => rm(stagedDir, { recursive: true, force: true }));

  it('parses a single view file and reports it under views with a relative path', async () => {
    await writeFile(
      join(stagedDir, 'customers.view.lkml'),
      `view: customers {
  dimension: id {
    type: number
    primary_key: yes
    sql: \${TABLE}.id ;;
  }
}
`,
      'utf-8',
    );
    const result = await parseLookmlStagedDir(stagedDir);
    expect(result.views.map((v) => v.path)).toEqual(['customers.view.lkml']);
    expect(result.views[0].name).toBe('customers');
    expect(result.models).toEqual([]);
    expect(result.dashboards).toEqual([]);
  });

  it('parses a model file and extracts include globs', async () => {
    await mkdir(join(stagedDir, 'views'), { recursive: true });
    await writeFile(
      join(stagedDir, 'orders.model.lkml'),
      `connection: "my_bq"

include: "views/*.view.lkml"

explore: orders {}
`,
      'utf-8',
    );
    await writeFile(
      join(stagedDir, 'views', 'orders.view.lkml'),
      `view: orders {
  sql_table_name: public.orders ;;
}
`,
      'utf-8',
    );
    const result = await parseLookmlStagedDir(stagedDir);
    expect(result.models.map((m) => m.path)).toEqual(['orders.model.lkml']);
    expect(result.models[0].name).toBe('orders');
    expect(result.models[0].includes).toEqual(['views/*.view.lkml']);
    expect(result.models[0].explores).toEqual(['orders']);
    expect(result.views.map((v) => v.path)).toEqual(['views/orders.view.lkml']);
  });

  it('extracts model connection names and raw view sql_table_name declarations', async () => {
    await mkdir(join(stagedDir, 'views'), { recursive: true });
    await writeFile(
      join(stagedDir, 'b2b.model.lkml'),
      `connection: "b2b_sandbox_bq"

include: "views/*.view.lkml"

explore: orders {}
`,
      'utf-8',
    );
    await writeFile(
      join(stagedDir, 'views', 'orders.view.lkml'),
      `view: orders {
  sql_table_name: analytics.orders AS o ;;
}
`,
      'utf-8',
    );

    const result = await parseLookmlStagedDir(stagedDir);

    expect(result.models[0]).toMatchObject({
      path: 'b2b.model.lkml',
      name: 'b2b',
      connectionName: 'b2b_sandbox_bq',
    });
    expect(result.views[0]).toMatchObject({
      path: 'views/orders.view.lkml',
      name: 'orders',
      rawSqlTableName: 'analytics.orders AS o',
    });
  });

  it('captures extends declarations on views', async () => {
    await writeFile(
      join(stagedDir, 'base.view.lkml'),
      `view: base {
  dimension: id {
    type: number
    primary_key: yes
    sql: \${TABLE}.id ;;
  }
}
`,
      'utf-8',
    );
    await writeFile(
      join(stagedDir, 'orders.view.lkml'),
      `view: orders {
  extends: [base]
  sql_table_name: public.orders ;;
}
`,
      'utf-8',
    );
    const result = await parseLookmlStagedDir(stagedDir);
    const orders = result.views.find((v) => v.name === 'orders');
    expect(orders).toBeDefined();
    if (!orders) {
      throw new Error('expected orders view');
    }
    expect(orders.extendsFrom).toEqual(['base']);
  });

  it('collects .dashboard.lkml files structurally (no deep parsing)', async () => {
    await writeFile(join(stagedDir, 'overview.dashboard.lkml'), '- dashboard: overview\n  title: Overview\n', 'utf-8');
    const result = await parseLookmlStagedDir(stagedDir);
    expect(result.dashboards.map((d) => d.path)).toEqual(['overview.dashboard.lkml']);
    expect(result.dashboards[0].name).toBe('overview');
  });

  it('ignores non-.lkml files', async () => {
    await writeFile(join(stagedDir, 'README.md'), '# readme\n', 'utf-8');
    await writeFile(join(stagedDir, 'notes.txt'), 'note\n', 'utf-8');
    const result = await parseLookmlStagedDir(stagedDir);
    expect(result.models).toEqual([]);
    expect(result.views).toEqual([]);
    expect(result.dashboards).toEqual([]);
  });

  it('returns a sorted deterministic order across runs', async () => {
    await writeFile(
      join(stagedDir, 'zeta.view.lkml'),
      `view: zeta {
}
`,
      'utf-8',
    );
    await writeFile(
      join(stagedDir, 'alpha.view.lkml'),
      `view: alpha {
}
`,
      'utf-8',
    );
    const r1 = await parseLookmlStagedDir(stagedDir);
    const r2 = await parseLookmlStagedDir(stagedDir);
    expect(r1.views.map((v) => v.path)).toEqual(['alpha.view.lkml', 'zeta.view.lkml']);
    expect(r2.views.map((v) => v.path)).toEqual(r1.views.map((v) => v.path));
  });
});
