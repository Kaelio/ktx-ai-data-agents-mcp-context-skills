import { describe, expect, it } from 'vitest';
import {
  HISTORIC_SQL_PATTERN_WORKUNIT_MAX_BYTES,
  isHistoricSqlPatternInputShardPath,
  serializedStagedPatternsInputByteLength,
  splitHistoricSqlPatternInputs,
} from '../../../../../src/context/ingest/adapters/historic-sql/pattern-inputs.js';
import type { StagedPatternsInput } from '../../../../../src/context/ingest/adapters/historic-sql/types.js';

type PatternTemplate = StagedPatternsInput['templates'][number];

function template(id: string, tablesTouched: string[], canonicalSql = 'select 1'): PatternTemplate {
  return {
    id,
    canonicalSql,
    tablesTouched,
    executionsBucket: '10-100',
    distinctUsersBucket: '2-5',
    dialect: 'postgres',
  };
}

describe('historic-SQL pattern input sharding', () => {
  it('keeps the audit input complete while sharding only cross-table pattern candidates', () => {
    const largeSql = `select * from public.orders join public.customers on true where marker = '${'x'.repeat(260)}'`;
    const input: StagedPatternsInput = {
      templates: [
        template('single-table-orders', ['public.orders']),
        template('orders-customers-2', ['public.orders', 'public.customers'], largeSql),
        template('orders-customers-1', ['public.customers', 'public.orders'], largeSql),
        template('orders-customers-payments', ['public.orders', 'public.customers', 'public.payments'], largeSql),
      ],
    };

    const result = splitHistoricSqlPatternInputs(input, { maxBytes: 760 });

    expect(result.auditInput.templates.map((entry) => entry.id)).toEqual([
      'orders-customers-1',
      'orders-customers-2',
      'orders-customers-payments',
      'single-table-orders',
    ]);
    expect(result.shards.length).toBeGreaterThan(1);
    expect(result.shards.map((shard) => shard.path)).toEqual([
      'patterns-input/part-0001.json',
      'patterns-input/part-0002.json',
      'patterns-input/part-0003.json',
    ]);
    expect(result.shards.flatMap((shard) => shard.input.templates.map((entry) => entry.id))).toEqual([
      'orders-customers-payments',
      'orders-customers-1',
      'orders-customers-2',
    ]);
    expect(result.shards.every((shard) => shard.byteLength <= 760)).toBe(true);
    expect(result.shards.flatMap((shard) => shard.input.templates).some((entry) => entry.id === 'single-table-orders')).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('omits a single oversized template from shards and reports a manifest warning', () => {
    const input: StagedPatternsInput = {
      templates: [
        template(
          'oversized-cross-table',
          ['public.orders', 'public.customers'],
          `select * from public.orders join public.customers on true where payload = '${'x'.repeat(500)}'`,
        ),
      ],
    };

    const result = splitHistoricSqlPatternInputs(input, { maxBytes: 240 });

    expect(result.auditInput.templates.map((entry) => entry.id)).toEqual(['oversized-cross-table']);
    expect(result.shards).toEqual([]);
    expect(result.warnings).toEqual(['patterns_input_template_too_large:oversized-cross-table']);
  });

  it('recognizes only generated pattern shard paths', () => {
    expect(isHistoricSqlPatternInputShardPath('patterns-input/part-0001.json')).toBe(true);
    expect(isHistoricSqlPatternInputShardPath('patterns-input/part-0012.json')).toBe(true);
    expect(isHistoricSqlPatternInputShardPath('patterns-input.json')).toBe(false);
    expect(isHistoricSqlPatternInputShardPath('patterns-input/part-1.json')).toBe(false);
    expect(isHistoricSqlPatternInputShardPath('patterns-input/readme.md')).toBe(false);
  });

  it('uses a production byte budget below read_raw_file maximum size', () => {
    expect(HISTORIC_SQL_PATTERN_WORKUNIT_MAX_BYTES).toBeLessThan(120_000);
    expect(serializedStagedPatternsInputByteLength({ templates: [] })).toBeGreaterThan(0);
  });
});
