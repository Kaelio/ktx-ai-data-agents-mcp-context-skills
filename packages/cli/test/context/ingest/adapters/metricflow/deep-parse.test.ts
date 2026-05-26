import { beforeEach, describe, expect, it } from 'vitest';
import { parseMetricflowFiles, translateMetricflowJinjaFilter } from '../../../../../src/context/ingest/adapters/metricflow/deep-parse.js';

function yaml(strings: TemplateStringsArray, ...values: unknown[]): string {
  return String.raw(strings, ...values);
}

function parseOne(content: string) {
  return parseMetricflowFiles([{ content, path: 'test.yml' }]);
}

describe('parseMetricflowFiles', () => {
  beforeEach(() => {
    // Keep this hook so the copied tests keep their grouping shape while the parser stays pure.
  });

  // ============ Semantic Model Parsing ============

  describe('parseFiles — semantic models', () => {
    it('extracts name, description, modelRef, and defaultTimeDimension', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    description: All completed orders
    model: ref('stg_orders')
    defaults:
      agg_time_dimension: order_date
    dimensions: []
    measures: []
`,
      );

      expect(result.semanticModels).toHaveLength(1);
      const sm = result.semanticModels[0];
      expect(sm.name).toBe('orders');
      expect(sm.description).toBe('All completed orders');
      expect(sm.modelRef).toBe('stg_orders');
      expect(sm.defaultTimeDimension).toBe('order_date');
    });

    it('extracts modelRef from source()', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: raw_events
    model: source('analytics', 'events')
    dimensions: []
    measures: []
`,
      );

      expect(result.semanticModels[0].modelRef).toBe('events');
    });

    it('uses raw string when model is not ref() or source()', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: custom
    model: my_table
    dimensions: []
    measures: []
`,
      );

      expect(result.semanticModels[0].modelRef).toBe('my_table');
    });

    it('sets description to null when missing', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures: []
`,
      );

      expect(result.semanticModels[0].description).toBeNull();
    });
  });

  // ============ Dimensions ============

  describe('parseFiles — dimensions', () => {
    it('maps categorical to string and time to time', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions:
      - name: status
        type: categorical
        description: Order status
      - name: created_at
        type: time
        description: When the order was placed
    measures: []
`,
      );

      const dims = result.semanticModels[0].dimensions;
      expect(dims).toHaveLength(2);
      expect(dims[0]).toEqual({
        name: 'status',
        column: 'status',
        type: 'string',
        label: 'Status',
        description: 'Order status',
      });
      expect(dims[1]).toEqual({
        name: 'created_at',
        column: 'created_at',
        type: 'time',
        label: 'Created At',
        description: 'When the order was placed',
      });
    });

    it('uses expr as column when provided', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions:
      - name: order_status
        type: categorical
        expr: status_code
    measures: []
`,
      );

      expect(result.semanticModels[0].dimensions[0].column).toBe('status_code');
    });

    it('uses explicit label over auto-generated one', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions:
      - name: order_status_code
        type: categorical
        label: Status
    measures: []
`,
      );

      expect(result.semanticModels[0].dimensions[0].label).toBe('Status');
    });
  });

  // ============ Measures ============

  describe('parseFiles — measures', () => {
    it('maps all standard aggregation types', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: total_amount
        agg: sum
        expr: amount
      - name: order_count
        agg: count
        expr: '1'
      - name: unique_customers
        agg: count_distinct
        expr: customer_id
      - name: avg_amount
        agg: average
        expr: amount
      - name: max_amount
        agg: max
        expr: amount
      - name: min_amount
        agg: min
        expr: amount
      - name: median_amount
        agg: median
        expr: amount
`,
      );

      const measures = result.semanticModels[0].measures;
      expect(measures).toHaveLength(7);
      expect(measures.map((m) => m.type === 'simple' && m.aggregation)).toEqual([
        'sum',
        'count',
        'count_distinct',
        'avg',
        'max',
        'min',
        'median',
      ]);
    });

    it('maps sum_boolean to sum', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: users
    model: ref('users')
    dimensions: []
    measures:
      - name: active_users
        agg: sum_boolean
        expr: is_active
`,
      );

      const m = result.semanticModels[0].measures[0];
      expect(m.type).toBe('simple');
      if (m.type === 'simple') {
        expect(m.aggregation).toBe('sum');
      }
    });

    it('maps percentile p50 to median', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: median_delivery_time
        agg: percentile
        expr: delivery_hours
        agg_params:
          percentile: 0.5
`,
      );

      const m = result.semanticModels[0].measures[0];
      expect(m.type).toBe('simple');
      if (m.type === 'simple') {
        expect(m.aggregation).toBe('median');
        expect(m.column).toBe('delivery_hours');
      }
    });

    it('maps percentile p95 to none with label', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: p95_delivery_time
        agg: percentile
        expr: delivery_hours
        agg_params:
          percentile: 0.95
`,
      );

      const m = result.semanticModels[0].measures[0];
      expect(m.type).toBe('simple');
      if (m.type === 'simple') {
        expect(m.aggregation).toBe('none');
        expect(m.label).toBe('P95 Delivery Time (p95)');
      }
    });

    it('skips unsupported aggregation types', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: total_amount
        agg: sum
        expr: amount
      - name: weird_measure
        agg: hyperloglog
        expr: user_id
`,
      );

      expect(result.semanticModels[0].measures).toHaveLength(1);
      expect(result.semanticModels[0].measures[0].name).toBe('total_amount');
    });

    it('uses measure name as column when expr is missing', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: amount
        agg: sum
`,
      );

      const m = result.semanticModels[0].measures[0];
      expect(m.type).toBe('simple');
      if (m.type === 'simple') {
        expect(m.column).toBe('amount');
      }
    });
  });

  // ============ Jinja Filter Translation ============

  describe('translateJinjaFilter', () => {
    it('translates Dimension references', () => {
      expect(translateMetricflowJinjaFilter("{{ Dimension('orders__status') }} = 'completed'")).toBe(
        "status = 'completed'",
      );
    });

    it('translates TimeDimension references', () => {
      expect(translateMetricflowJinjaFilter("{{ TimeDimension('orders__created_at', 'day') }} > '2024-01-01'")).toBe(
        "created_at > '2024-01-01'",
      );
    });

    it('translates TimeDimension without granularity arg', () => {
      expect(translateMetricflowJinjaFilter("{{ TimeDimension('orders__created_at') }} IS NOT NULL")).toBe(
        'created_at IS NOT NULL',
      );
    });

    it('translates Entity references', () => {
      expect(translateMetricflowJinjaFilter("{{ Entity('orders__customer_id') }} IS NOT NULL")).toBe(
        'customer_id IS NOT NULL',
      );
    });

    it('translates Metric with array params', () => {
      expect(translateMetricflowJinjaFilter("{{ Metric('total_revenue', ['product_category']) }} > 100")).toBe(
        'total_revenue > 100',
      );
    });

    it('translates Metric with object params', () => {
      expect(translateMetricflowJinjaFilter("{{ Metric('total_revenue', {'group': true}) }} > 100")).toBe(
        'total_revenue > 100',
      );
    });

    it('translates Metric without params', () => {
      expect(translateMetricflowJinjaFilter("{{ Metric('total_revenue') }} > 50")).toBe('total_revenue > 50');
    });

    it('handles combined filter with multiple Jinja references', () => {
      const filter =
        "{{ Dimension('orders__status') }} = 'active' AND {{ TimeDimension('orders__created_at', 'day') }} >= '2024-01-01'";
      expect(translateMetricflowJinjaFilter(filter)).toBe("status = 'active' AND created_at >= '2024-01-01'");
    });

    it('passes through plain SQL unchanged', () => {
      expect(translateMetricflowJinjaFilter("status = 'active'")).toBe("status = 'active'");
    });
  });

  // ============ Entity Relationships ============

  describe('parseFiles — relationships', () => {
    it('creates FK relationship when foreign entity matches primary entity by name', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: customers
    model: ref('dim_customers')
    entities:
      - name: customer_id
        type: primary
        expr: id
    dimensions: []
    measures: []
  - name: orders
    model: ref('fct_orders')
    entities:
      - name: order_id
        type: primary
      - name: customer_id
        type: foreign
    dimensions: []
    measures: []
`,
      );

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0]).toEqual({
        fromTable: 'fct_orders',
        fromColumn: 'customer_id',
        toTable: 'dim_customers',
        toColumn: 'id',
      });
    });

    it('uses primary_entity shorthand for FK matching', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: products
    model: ref('dim_products')
    primary_entity: product_id
    dimensions: []
    measures: []
  - name: order_items
    model: ref('fct_order_items')
    entities:
      - name: item_id
        type: primary
      - name: product_id
        type: foreign
    dimensions: []
    measures: []
`,
      );

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0]).toEqual({
        fromTable: 'fct_order_items',
        fromColumn: 'product_id',
        toTable: 'dim_products',
        toColumn: 'product_id',
      });
    });

    it('does not create self-referencing relationships', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    entities:
      - name: order_id
        type: primary
      - name: order_id
        type: foreign
    dimensions: []
    measures: []
`,
      );

      expect(result.relationships).toHaveLength(0);
    });

    it('deduplicates relationships across models in the same file', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: customers
    model: ref('customers')
    entities:
      - name: customer_id
        type: primary
    dimensions: []
    measures: []
  - name: orders
    model: ref('orders')
    entities:
      - name: order_id
        type: primary
      - name: customer_id
        type: foreign
    dimensions: []
    measures: []
  - name: returns
    model: ref('returns')
    entities:
      - name: return_id
        type: primary
      - name: customer_id
        type: foreign
    dimensions: []
    measures: []
`,
      );

      // orders→customers and returns→customers (2 unique relationships)
      expect(result.relationships).toHaveLength(2);
    });

    it('creates relationships when primary and foreign entities are split across files', () => {
      const result = parseMetricflowFiles([
        {
          content: yaml`
semantic_models:
  - name: salesforce_calls
    model: ref('fct_salesforce_calls')
    entities:
      - name: task_id
        type: primary
    dimensions: []
    measures: []
`,
          path: 'sem_fct_salesforce_calls.yml',
        },
        {
          content: yaml`
semantic_models:
  - name: daily_flash
    model: ref('rpt_daily_flash')
    entities:
      - name: rpt_daily_flash_uuid
        type: primary
      - name: task_id
        type: foreign
    dimensions: []
    measures: []
`,
          path: 'sem_rpt_daily_flash.yml',
        },
      ]);

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0]).toEqual({
        fromTable: 'rpt_daily_flash',
        fromColumn: 'task_id',
        toTable: 'fct_salesforce_calls',
        toColumn: 'task_id',
      });
    });

    it('skips foreign entity with no matching primary', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    entities:
      - name: order_id
        type: primary
      - name: nonexistent_id
        type: foreign
    dimensions: []
    measures: []
`,
      );

      expect(result.relationships).toHaveLength(0);
    });
  });

  // ============ Metric Resolution ============

  describe('parseFiles — metric resolution', () => {
    it('absorbs simple metric label/description onto parent measure', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: total_revenue
        agg: sum
        expr: amount
metrics:
  - name: revenue
    label: Total Revenue
    description: Sum of all order amounts
    type: simple
    type_params:
      measure: total_revenue
`,
      );

      const measure = result.semanticModels[0].measures[0];
      expect(measure.label).toBe('Total Revenue');
      expect(measure.description).toBe('Sum of all order amounts');
    });

    it('handles measure as object with name property', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: total_revenue
        agg: sum
        expr: amount
metrics:
  - name: revenue
    label: Revenue (Filtered)
    type: simple
    type_params:
      measure:
        name: total_revenue
        filter:
          - "status = 'completed'"
`,
      );

      const measure = result.semanticModels[0].measures[0];
      expect(measure.label).toBe('Revenue (Filtered)');
    });

    it('applies metric-level filter to measure with Jinja translation', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: order_count
        agg: count
        expr: '1'
metrics:
  - name: completed_orders
    type: simple
    type_params:
      measure: order_count
    filter:
      - "{{ Dimension('orders__status') }} = 'completed'"
`,
      );

      // Filtered metric creates a new measure; base measure stays clean
      expect(result.semanticModels[0].measures).toHaveLength(2);
      const baseMeasure = result.semanticModels[0].measures[0] as { filter?: string };
      expect(baseMeasure.filter).toBeUndefined();
      const filteredMeasure = result.semanticModels[0].measures[1] as { name: string; filter?: string };
      expect(filteredMeasure.name).toBe('completed_orders');
      expect(filteredMeasure.filter).toBe("status = 'completed'");
    });

    it('marks cumulative metrics on the measure', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: total_revenue
        agg: sum
        expr: amount
metrics:
  - name: cumulative_revenue
    type: cumulative
    type_params:
      measure: total_revenue
`,
      );

      const measure = result.semanticModels[0].measures[0] as { cumulative?: boolean };
      expect(measure.cumulative).toBe(true);
    });

    it('creates derived measure for single-model derived metric', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: total_revenue
        agg: sum
        expr: amount
      - name: order_count
        agg: count
        expr: '1'
metrics:
  - name: metric_revenue
    type: simple
    type_params:
      measure: total_revenue
  - name: metric_count
    type: simple
    type_params:
      measure: order_count
  - name: avg_order_value
    label: Average Order Value
    type: derived
    type_params:
      expr: SAFE_DIVIDE(rev, cnt)
      metrics:
        - name: metric_revenue
          alias: rev
        - name: metric_count
          alias: cnt
`,
      );

      const measures = result.semanticModels[0].measures;
      expect(measures).toHaveLength(3);
      const derived = measures[2];
      expect(derived.type).toBe('derived');
      if (derived.type === 'derived') {
        expect(derived.name).toBe('avg_order_value');
        expect(derived.label).toBe('Average Order Value');
        expect(derived.expr).toBe('SAFE_DIVIDE(total_revenue, order_count)');
        expect(derived.dependsOn).toEqual(['total_revenue', 'order_count']);
      }
    });

    it('auto-generates ratio metric expression from numerator/denominator', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: completed_count
        agg: count
        expr: '1'
      - name: total_count
        agg: count
        expr: '1'
metrics:
  - name: metric_completed
    type: simple
    type_params:
      measure: completed_count
  - name: metric_total
    type: simple
    type_params:
      measure: total_count
  - name: completion_rate
    type: ratio
    type_params:
      numerator:
        name: metric_completed
      denominator:
        name: metric_total
`,
      );

      const measures = result.semanticModels[0].measures;
      const ratio = measures[2];
      expect(ratio.type).toBe('derived');
      if (ratio.type === 'derived') {
        expect(ratio.name).toBe('completion_rate');
        expect(ratio.expr).toBe('completed_count / NULLIF(total_count, 0)');
        expect(ratio.dependsOn).toEqual(['completed_count', 'total_count']);
      }
    });

    it('skips conversion metrics gracefully', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: events
    model: ref('events')
    dimensions: []
    measures:
      - name: event_count
        agg: count
        expr: '1'
metrics:
  - name: signup_conversion
    type: conversion
    type_params:
      conversion_type_params:
        entity: user_id
        base_measure: page_views
        conversion_measure: signups
  - name: simple_metric
    type: simple
    type_params:
      measure: event_count
`,
      );

      // Conversion metric skipped, simple metric processed
      expect(result.crossModelMetrics).toHaveLength(0);
      const measures = result.semanticModels[0].measures;
      expect(measures).toHaveLength(1);
    });

    it('creates cross-model derived metric when references span models', () => {
      const result = parseMetricflowFiles([
        {
          content: yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: total_revenue
        agg: sum
        expr: amount
`,
          path: 'orders.yml',
        },
        {
          content: yaml`
semantic_models:
  - name: campaigns
    model: ref('campaigns')
    dimensions: []
    measures:
      - name: total_spend
        agg: sum
        expr: spend
`,
          path: 'campaigns.yml',
        },
        {
          content: yaml`
metrics:
  - name: metric_revenue
    type: simple
    type_params:
      measure: total_revenue
  - name: metric_spend
    type: simple
    type_params:
      measure: total_spend
  - name: roas
    label: Return on Ad Spend
    description: Revenue per dollar spent
    type: derived
    type_params:
      expr: SAFE_DIVIDE(revenue, spend)
      metrics:
        - name: metric_revenue
          alias: revenue
        - name: metric_spend
          alias: spend
`,
          path: 'metrics.yml',
        },
      ]);

      expect(result.crossModelMetrics).toHaveLength(1);
      const cm = result.crossModelMetrics[0];
      expect(cm.name).toBe('roas');
      expect(cm.label).toBe('Return on Ad Spend');
      expect(cm.expr).toBe('SAFE_DIVIDE(revenue, spend)');
      expect(cm.dependsOn).toHaveLength(2);
      expect(cm.dependsOn[0].metricName).toBe('orders');
      expect(cm.dependsOn[1].metricName).toBe('campaigns');
    });

    it('resolves derived-of-derived metrics within the same model', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: financials
    model: ref('financials')
    dimensions: []
    measures:
      - name: gross_revenue
        agg: sum
        expr: revenue
      - name: cost_of_goods
        agg: sum
        expr: cogs
      - name: operating_expenses
        agg: sum
        expr: opex
metrics:
  - name: metric_gross_revenue
    type: simple
    type_params:
      measure: gross_revenue
  - name: metric_cogs
    type: simple
    type_params:
      measure: cost_of_goods
  - name: metric_opex
    type: simple
    type_params:
      measure: operating_expenses
  - name: gross_profit
    type: derived
    type_params:
      expr: rev - cogs
      metrics:
        - name: metric_gross_revenue
          alias: rev
        - name: metric_cogs
          alias: cogs
  - name: net_profit_margin
    type: derived
    type_params:
      expr: SAFE_DIVIDE(gp - opex, gp)
      metrics:
        - name: gross_profit
          alias: gp
        - name: metric_opex
          alias: opex
`,
      );

      const measures = result.semanticModels[0].measures;
      // 3 original + gross_profit derived + net_profit_margin derived-of-derived
      expect(measures).toHaveLength(5);

      const netProfit = measures.find((m) => m.name === 'net_profit_margin');
      expect(netProfit).toBeDefined();
      expect(netProfit!.type).toBe('derived');
      if (netProfit!.type === 'derived') {
        expect(netProfit!.dependsOn).toContain('gross_profit');
      }
    });
  });

  // ============ Edge Cases ============

  describe('parseFiles — edge cases', () => {
    it('handles empty YAML gracefully', () => {
      const result = parseOne('');
      expect(result.semanticModels).toHaveLength(0);
      expect(result.crossModelMetrics).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
    });

    it('handles invalid YAML gracefully', () => {
      const result = parseOne('{{{{invalid yaml!!!!');
      expect(result.semanticModels).toHaveLength(0);
    });

    it('handles file with only metrics and no semantic models', () => {
      const result = parseOne(yaml`
metrics:
  - name: orphan_metric
    type: simple
    type_params:
      measure: nonexistent
`,
      );

      expect(result.semanticModels).toHaveLength(0);
      // Orphan metric referencing non-existent measure is silently skipped
      expect(result.crossModelMetrics).toHaveLength(0);
    });

    it('handles multiple files', () => {
      const result = parseMetricflowFiles([
        {
          content: yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions:
      - name: status
        type: categorical
    measures:
      - name: order_count
        agg: count
        expr: '1'
`,
          path: 'orders.yml',
        },
        {
          content: yaml`
semantic_models:
  - name: products
    model: ref('products')
    dimensions:
      - name: category
        type: categorical
    measures:
      - name: product_count
        agg: count
        expr: '1'
`,
          path: 'products.yml',
        },
      ]);

      expect(result.semanticModels).toHaveLength(2);
      expect(result.semanticModels[0].name).toBe('orders');
      expect(result.semanticModels[1].name).toBe('products');
    });

    it('returns empty warnings for valid files', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: total
        agg: sum
        expr: amount
`,
      );

      expect(result.warnings).toHaveLength(0);
    });

    it('handles filter as object with where_filters', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: order_count
        agg: count
        expr: '1'
metrics:
  - name: active_orders
    type: simple
    type_params:
      measure: order_count
    filter:
      where_filters:
        - where_sql_template: "status = 'active'"
        - where_sql_template: "amount > 0"
`,
      );

      // Filtered metric creates a new measure
      expect(result.semanticModels[0].measures).toHaveLength(2);
      const filteredMeasure = result.semanticModels[0].measures[1] as { name: string; filter?: string };
      expect(filteredMeasure.name).toBe('active_orders');
      expect(filteredMeasure.filter).toBe("status = 'active' AND amount > 0");
    });

    it('creates separate measures for multiple filtered metrics on the same base', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: intakes
    model: ref('intakes')
    dimensions: []
    measures:
      - name: count_intakes
        agg: count
        expr: '1'
metrics:
  - name: count_first_intakes
    label: First Intakes
    type: simple
    type_params:
      measure: count_intakes
    filter:
      - "is_first_intake = TRUE"
  - name: count_new_intakes
    label: New Intakes
    type: simple
    type_params:
      measure: count_intakes
    filter:
      - "new_refill = 'New'"
  - name: count_refill_intakes
    label: Refill Intakes
    type: simple
    type_params:
      measure: count_intakes
    filter:
      - "new_refill = 'Refill'"
`,
      );

      const measures = result.semanticModels[0].measures;
      // 1 base + 3 filtered
      expect(measures).toHaveLength(4);

      // Base measure stays clean
      expect(measures[0].name).toBe('count_intakes');
      expect((measures[0] as { filter?: string }).filter).toBeUndefined();

      // Each filtered metric creates its own measure
      expect(measures[1].name).toBe('count_first_intakes');
      expect((measures[1] as { filter?: string }).filter).toBe('is_first_intake = TRUE');
      expect(measures[1].label).toBe('First Intakes');

      expect(measures[2].name).toBe('count_new_intakes');
      expect((measures[2] as { filter?: string }).filter).toBe("new_refill = 'New'");

      expect(measures[3].name).toBe('count_refill_intakes');
      expect((measures[3] as { filter?: string }).filter).toBe("new_refill = 'Refill'");
    });

    it('mixed filtered and unfiltered metrics work together', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: order_count
        agg: count
        expr: '1'
metrics:
  - name: order_count
    label: All Orders
    type: simple
    type_params:
      measure: order_count
  - name: completed_orders
    label: Completed Orders
    type: simple
    type_params:
      measure: order_count
    filter:
      - "status = 'completed'"
`,
      );

      const measures = result.semanticModels[0].measures;
      expect(measures).toHaveLength(2);

      // Unfiltered metric updates base measure label
      expect(measures[0].name).toBe('order_count');
      expect(measures[0].label).toBe('All Orders');
      expect((measures[0] as { filter?: string }).filter).toBeUndefined();

      // Filtered metric creates new measure
      expect(measures[1].name).toBe('completed_orders');
      expect(measures[1].label).toBe('Completed Orders');
      expect((measures[1] as { filter?: string }).filter).toBe("status = 'completed'");
    });

    it('derived metric referencing a filtered metric resolves to the new measure name', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: order_count
        agg: count
        expr: '1'
      - name: order_total
        agg: sum
        expr: amount
metrics:
  - name: all_orders
    type: simple
    type_params:
      measure: order_count
  - name: large_orders
    type: simple
    type_params:
      measure: order_count
    filter:
      - "amount > 100"
  - name: pct_large_orders
    type: derived
    label: "% Large Orders"
    type_params:
      expr: large_orders / all_orders
      metrics:
        - name: large_orders
        - name: all_orders
`,
      );

      const measures = result.semanticModels[0].measures;
      // order_count (base) + order_total (base) + large_orders (filtered) + pct_large_orders (derived)
      expect(measures).toHaveLength(4);

      const derived = measures[3] as { name: string; dependsOn: string[]; expr: string };
      expect(derived.name).toBe('pct_large_orders');
      // large_orders resolves to its own name (the new filtered measure)
      // all_orders resolves to order_count (unfiltered metric → base measure)
      expect(derived.dependsOn).toEqual(['large_orders', 'order_count']);
      expect(derived.expr).toBe('large_orders / order_count');
    });
  });

  // ============ Warnings Collection ============

  describe('parseFiles — warnings', () => {
    it('collects warning for unsupported aggregation type', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: weird_measure
        agg: hyperloglog
        expr: user_id
`,
      );

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("unsupported aggregation 'hyperloglog'");
      expect(result.warnings[0]).toContain('weird_measure');
    });

    it('collects warning for skipped conversion metrics', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: events
    model: ref('events')
    dimensions: []
    measures:
      - name: event_count
        agg: count
        expr: '1'
metrics:
  - name: signup_conversion
    type: conversion
    type_params:
      conversion_type_params:
        entity: user_id
        base_measure: page_views
        conversion_measure: signups
`,
      );

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('conversion metrics are not yet supported');
      expect(result.warnings[0]).toContain('signup_conversion');
    });

    it('collects warning for non-median percentile', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: p95_time
        agg: percentile
        expr: delivery_hours
        agg_params:
          percentile: 0.95
`,
      );

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("aggregation 'none'");
      expect(result.warnings[0]).toContain('p95');
    });

    it('collects warning for unparseable YAML', () => {
      const result = parseOne('{{{{invalid yaml!!!!');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Failed to parse YAML');
    });

    it('collects multiple warnings from different sources', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: orders
    model: ref('orders')
    dimensions: []
    measures:
      - name: weird_one
        agg: hyperloglog
        expr: x
      - name: weird_two
        agg: custom_agg
        expr: y
metrics:
  - name: funnel
    type: conversion
    type_params:
      conversion_type_params:
        entity: user_id
        base_measure: a
        conversion_measure: b
`,
      );

      expect(result.warnings).toHaveLength(3);
    });
  });

  // ============ Entity Description Passthrough ============

  describe('parseFiles — entity description on relationships', () => {
    it('passes entity description to relationship', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: customers
    model: ref('dim_customers')
    entities:
      - name: customer_id
        type: primary
        expr: id
    dimensions: []
    measures: []
  - name: orders
    model: ref('fct_orders')
    entities:
      - name: order_id
        type: primary
      - name: customer_id
        type: foreign
        description: Links order to the purchasing customer
    dimensions: []
    measures: []
`,
      );

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0].description).toBe('Links order to the purchasing customer');
    });

    it('omits description when entity has no description', () => {
      const result = parseOne(yaml`
semantic_models:
  - name: customers
    model: ref('dim_customers')
    entities:
      - name: customer_id
        type: primary
        expr: id
    dimensions: []
    measures: []
  - name: orders
    model: ref('fct_orders')
    entities:
      - name: order_id
        type: primary
      - name: customer_id
        type: foreign
    dimensions: []
    measures: []
`,
      );

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0].description).toBeUndefined();
    });
  });
});
