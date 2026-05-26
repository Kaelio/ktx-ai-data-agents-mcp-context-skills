import { describe, expect, it } from 'vitest';
import type { ToolOutput } from '../../../../../../src/context/tools/base-tool.js';
import { buildLookerSlProposal, createLookerQueryToSlTool, type LookerSlProposal } from '../../../../../../src/context/ingest/adapters/looker/tools/looker-query-to-sl.tool.js';

describe('buildLookerSlProposal', () => {
  it('suggests a measure and segment for an aggregated filtered Looker query', () => {
    const proposal = buildLookerSlProposal({
      contentTitle: 'Open Pipeline ARR',
      contentType: 'look',
      usage: { queryCount30d: 42, uniqueUsers30d: 7 },
      query: {
        model: 'b2b',
        view: 'sales_pipeline',
        fields: ['opportunities.arr', 'opportunities.stage'],
        filters: { 'opportunities.stage': 'open' },
        sorts: ['opportunities.arr desc'],
        limit: '500',
      },
    });

    expect(proposal.sourceName).toBe('looker__b2b__sales_pipeline');
    expect(proposal.triageLane).toBe('full');
    expect(proposal.decision).toBe('measure_added');
    expect(proposal.measures).toEqual([
      {
        name: 'arr',
        lookerField: 'opportunities.arr',
        expr: 'sum(opportunities.arr)',
        description: 'Suggested from Looker look "Open Pipeline ARR"; verify against explore field SQL before writing.',
      },
    ]);
    expect(proposal.dimensions).toEqual([{ name: 'stage', lookerField: 'opportunities.stage' }]);
    expect(proposal.segments).toEqual([
      {
        name: 'open_pipeline_arr',
        filters: { 'opportunities.stage': 'open' },
        suggestedPredicate: "opportunities.stage = 'open'",
        description: 'Reusable filter candidate from Looker look "Open Pipeline ARR".',
      },
    ]);
    expect(proposal.notes).toContain(
      'Usage signals can raise priority, but query counts, users, owners, and folders must not be written as wiki narrative.',
    );
  });

  it('keeps simple saved views as wiki-only candidates', () => {
    const proposal = buildLookerSlProposal({
      contentTitle: 'Accounts By Region',
      query: {
        model: 'b2b',
        view: 'accounts',
        fields: ['accounts.region', 'accounts.segment'],
        filters: {},
      },
    });

    expect(proposal.sourceName).toBe('looker__b2b__accounts');
    expect(proposal.triageLane).toBe('light');
    expect(proposal.decision).toBe('wiki_only');
    expect(proposal.measures).toEqual([]);
    expect(proposal.dimensions).toEqual([
      { name: 'region', lookerField: 'accounts.region' },
      { name: 'segment', lookerField: 'accounts.segment' },
    ]);
    expect(proposal.segments).toEqual([]);
  });

  it('promotes high-usage filter-only queries as derived-source candidates', () => {
    const proposal = buildLookerSlProposal({
      contentTitle: 'Active Customers',
      usage: { queryCount30d: 15, uniqueUsers30d: 4 },
      query: {
        model: 'b2b',
        view: 'customers',
        fields: ['customers.id', 'customers.name'],
        filters: { 'customers.status': 'active', 'customers.is_test': '-yes' },
      },
    });

    expect(proposal.sourceName).toBe('looker__b2b__customers');
    expect(proposal.decision).toBe('source_created');
    expect(proposal.segments).toEqual([
      {
        name: 'active_customers',
        filters: { 'customers.status': 'active', 'customers.is_test': '-yes' },
        suggestedPredicate: "customers.status = 'active' AND customers.is_test != 'yes'",
        description: 'Reusable filter candidate from Looker look "Active Customers".',
      },
    ]);
  });

  it('surfaces mapped warehouse target metadata for direct SL writes', () => {
    const proposal = buildLookerSlProposal({
      contentTitle: 'Open Pipeline ARR',
      contentType: 'dashboard_tile',
      usage: { queryCount30d: 42, uniqueUsers30d: 7 },
      query: {
        model: 'b2b',
        view: 'sales_pipeline',
        fields: ['opportunities.arr', 'opportunities.stage'],
        filters: { 'opportunities.stage': 'open' },
        targetWarehouseConnectionId: '22222222-2222-4222-8222-222222222222',
        targetTable: {
          ok: true,
          catalog: 'proj',
          schema: 'dataset',
          name: 'opportunities',
          canonicalTable: 'proj.dataset.opportunities',
        },
      },
    });

    expect(proposal.sourceName).toBe('looker__b2b__sales_pipeline');
    expect(proposal.targetStatus).toBe('mapped');
    expect(proposal.targetWarehouseConnectionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(proposal.sourceTable).toBe('proj.dataset.opportunities');
    expect(proposal.canWriteStandaloneSource).toBe(true);
    expect(proposal.targetTable).toEqual({
      ok: true,
      catalog: 'proj',
      schema: 'dataset',
      name: 'opportunities',
      canonicalTable: 'proj.dataset.opportunities',
    });
    expect(proposal.notes).toContain(
      'targetTable.ok is true: write or edit SL on targetWarehouseConnectionId using targetTable.canonicalTable as source.table.',
    );
  });

  it('surfaces unmapped and unparseable target reasons for wiki-only fallback', () => {
    const unmapped = buildLookerSlProposal({
      contentTitle: 'Revenue Trend',
      query: {
        model: 'b2b',
        view: 'revenue',
        fields: ['revenue.arr'],
        filters: {},
        targetWarehouseConnectionId: null,
        targetTable: {
          ok: false,
          reason: 'no_connection_mapping',
        },
      },
    });

    expect(unmapped.targetStatus).toBe('unmapped');
    expect(unmapped.targetWarehouseConnectionId).toBeNull();
    expect(unmapped.sourceTable).toBeNull();
    expect(unmapped.canWriteStandaloneSource).toBe(false);
    expect(unmapped.notes).toContain(
      'targetTable.ok is false (no_connection_mapping): keep this query wiki-only and pass the reason through emit_unmapped_fallback.',
    );

    const unparseable = buildLookerSlProposal({
      contentTitle: 'Templated Source',
      query: {
        model: 'b2b',
        view: 'templated',
        fields: ['templated.count'],
        filters: {},
        targetWarehouseConnectionId: '22222222-2222-4222-8222-222222222222',
        targetTable: {
          ok: false,
          reason: 'looker_template_unresolved',
          detail: 'The sql_table_name contains ${derived.SQL_TABLE_NAME}.',
        },
      },
    });

    expect(unparseable.targetStatus).toBe('unparseable');
    expect(unparseable.targetWarehouseConnectionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(unparseable.sourceTable).toBeNull();
    expect(unparseable.canWriteStandaloneSource).toBe(false);
    expect(unparseable.notes).toContain(
      'targetTable.ok is false (looker_template_unresolved): keep this query wiki-only and pass the reason through emit_unmapped_fallback.',
    );
  });
});

describe('createLookerQueryToSlTool', () => {
  it('returns markdown plus the structured proposal', async () => {
    const lookerQueryToSl = createLookerQueryToSlTool();
    if (!lookerQueryToSl.execute) {
      throw new Error('looker_query_to_sl tool must be executable');
    }
    const output = (await lookerQueryToSl.execute(
      {
        contentTitle: 'Revenue Trend',
        contentType: 'dashboard_tile',
        query: {
          model: 'finance',
          view: 'orders',
          fields: ['orders.total_revenue', 'orders.created_month'],
          filters: { 'orders.status': 'paid' },
          sorts: [],
          targetWarehouseConnectionId: null,
          targetTable: null,
        },
      },
      { toolCallId: 'call-1', messages: [] } as never,
    )) as ToolOutput<LookerSlProposal>;

    expect(output.markdown).toContain('Looker query SL proposal');
    expect(output.markdown).toContain('looker__finance__orders');
    expect(output.structured.sourceName).toBe('looker__finance__orders');
    expect(output.structured.measures[0]?.name).toBe('total_revenue');
  });

  it('prints target connection and canonical table in markdown output', async () => {
    const lookerQueryToSl = createLookerQueryToSlTool();
    if (!lookerQueryToSl.execute) {
      throw new Error('looker_query_to_sl tool must be executable');
    }

    const output = (await lookerQueryToSl.execute(
      {
        contentTitle: 'Revenue Trend',
        contentType: 'dashboard_tile',
        query: {
          model: 'finance',
          view: 'orders',
          fields: ['orders.total_revenue', 'orders.created_month'],
          filters: { 'orders.status': 'paid' },
          sorts: [],
          targetWarehouseConnectionId: '33333333-3333-4333-8333-333333333333',
          targetTable: {
            ok: true,
            catalog: 'proj',
            schema: 'finance',
            name: 'orders',
            canonicalTable: 'proj.finance.orders',
          },
        },
      },
      { toolCallId: 'call-1', messages: [] } as never,
    )) as ToolOutput<LookerSlProposal>;

    expect(output.markdown).toContain('- targetStatus: mapped');
    expect(output.markdown).toContain('- targetWarehouseConnectionId: 33333333-3333-4333-8333-333333333333');
    expect(output.markdown).toContain('- sourceTable: proj.finance.orders');
    expect(output.structured.canWriteStandaloneSource).toBe(true);
  });
});
