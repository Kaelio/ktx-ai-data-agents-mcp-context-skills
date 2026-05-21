import { parse as parseYaml } from 'yaml';
import { noopLogger, type KtxLogger } from '../../../core/index.js';

export interface DimensionDefinition {
  name: string;
  column: string;
  type: string;
  label?: string;
  description?: string;
}

export interface SimpleMeasureDefinition {
  type: 'simple';
  name: string;
  column: string;
  aggregation: 'sum' | 'count' | 'count_distinct' | 'avg' | 'min' | 'max' | 'median' | 'none';
  label?: string;
  description?: string;
  filter?: string;
  cumulative?: boolean;
}

export type MeasureDefinition =
  | SimpleMeasureDefinition
  | {
      type: 'derived';
      name: string;
      expr: string;
      dependsOn?: string[];
      label?: string;
      description?: string;
    };

export interface ParsedMetricflowRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  fromSchema?: string;
  toSchema?: string;
  description?: string;
}

export interface MetricflowParseOptions {
  logger?: KtxLogger;
}

// ============ MetricFlow YAML Interfaces ============

interface MetricFlowYaml {
  semantic_models?: MetricFlowSemanticModel[];
  metrics?: MetricFlowMetric[];
}

interface MetricFlowSemanticModel {
  name: string;
  description?: string;
  model: string;
  primary_entity?: string;
  entities?: MetricFlowEntity[];
  dimensions?: MetricFlowDimension[];
  measures?: MetricFlowMeasure[];
  defaults?: { agg_time_dimension?: string };
  config?: Record<string, unknown>;
}

interface MetricFlowEntity {
  name: string;
  type: 'primary' | 'foreign' | 'unique' | 'natural';
  expr?: string;
  description?: string;
}

interface MetricFlowDimension {
  name: string;
  type: 'categorical' | 'time';
  description?: string;
  expr?: string;
  label?: string;
  type_params?: {
    time_granularity?: string;
  };
}

interface MetricFlowMeasure {
  name: string;
  agg: string;
  expr?: string;
  description?: string;
  label?: string;
  create_metric?: boolean;
  non_additive_dimension?: Record<string, unknown>;
  agg_params?: {
    percentile?: number;
    use_discrete_percentile?: boolean;
    use_approximate_percentile?: boolean;
  };
}

interface MetricFlowMetricInput {
  name: string;
  alias?: string;
  offset_window?: string;
  filter?: string | string[];
}

type MetricFlowFilter = string | string[] | { where_filters: Array<{ where_sql_template: string }> };

interface MetricFlowMetric {
  name: string;
  label?: string;
  description?: string;
  type: 'simple' | 'derived' | 'cumulative' | 'ratio' | 'conversion';
  type_params: {
    measure?: string | { name: string; filter?: unknown; alias?: string };
    expr?: string;
    metrics?: MetricFlowMetricInput[];
    numerator?: MetricFlowMetricInput;
    denominator?: MetricFlowMetricInput;
    window?: string;
    grain_to_date?: string;
    cumulative_type_params?: {
      window?: string;
      grain_to_date?: string;
      period_agg?: string;
    };
    conversion_type_params?: {
      entity: string;
      calculation?: string;
      base_measure?: string | { name: string };
      conversion_measure?: string | { name: string };
      window?: string;
    };
  };
  filter?: MetricFlowFilter;
}

// ============ Parse Result Types ============

export interface ParsedSemanticModel {
  name: string;
  description: string | null;
  modelRef: string;
  dimensions: DimensionDefinition[];
  measures: MeasureDefinition[];
  entities: MetricFlowEntity[];
  defaultTimeDimension: string | null;
}

export interface ParsedCrossModelMetric {
  name: string;
  label: string | null;
  description: string | null;
  type: 'derived';
  expr: string;
  dependsOn: Array<{ metricName: string; alias?: string }>;
  filter: string | null;
}

export interface MetricFlowParseResult {
  semanticModels: ParsedSemanticModel[];
  crossModelMetrics: ParsedCrossModelMetric[];
  relationships: ParsedMetricflowRelationship[];
  warnings: string[];
}

// ============ Aggregation Mapping ============

const AGG_MAP: Record<string, SimpleMeasureDefinition['aggregation'] | undefined> = {
  sum: 'sum',
  sum_boolean: 'sum',
  count: 'count',
  count_distinct: 'count_distinct',
  average: 'avg',
  avg: 'avg',
  min: 'min',
  max: 'max',
  median: 'median',
};

export function parseMetricflowFiles(
  files: Array<{ content: string; path: string }>,
  options: MetricflowParseOptions = {},
): MetricFlowParseResult {
  const parser = new MetricflowDeepParser(options.logger ?? noopLogger);
  return parser.parseFiles(files);
}

export function translateMetricflowJinjaFilter(filter: string): string {
  return new MetricflowDeepParser(noopLogger).translateJinjaFilter(filter);
}

class MetricflowDeepParser {
  constructor(private readonly logger: KtxLogger) {}

  parseFiles(files: Array<{ content: string; path: string }>): MetricFlowParseResult {
    this.logger.log(`Parsing ${files.length} files for MetricFlow definitions`);

    const allSemanticModels: ParsedSemanticModel[] = [];
    const allMetrics: MetricFlowMetric[] = [];
    const allRelationshipModels: MetricFlowSemanticModel[] = [];
    const warnings: string[] = [];

    for (const file of files) {
      const result = this.parseFile(file.content, file.path, warnings);
      allSemanticModels.push(...result.semanticModels);
      allMetrics.push(...result.metrics);
      allRelationshipModels.push(...result.relationshipModels);
    }

    // Build measure→model index for cross-model metric resolution
    const measureToModel = this.buildMeasureIndex(allSemanticModels);

    // Absorb simple metrics as labels on existing measures, identify cross-model derived metrics
    const crossModelMetrics = this.resolveMetrics(allMetrics, measureToModel, allSemanticModels, warnings);
    const relationships = this.deduplicateRelationships(this.extractRelationships(allRelationshipModels));

    this.logger.log(
      `Total: ${allSemanticModels.length} semantic models, ${crossModelMetrics.length} cross-model metrics, ${relationships.length} relationships`,
    );

    return {
      semanticModels: allSemanticModels,
      crossModelMetrics,
      relationships,
      warnings,
    };
  }

  private parseFile(
    yamlContent: string,
    filePath: string | undefined,
    warnings: string[],
  ): {
    semanticModels: ParsedSemanticModel[];
    metrics: MetricFlowMetric[];
    relationshipModels: MetricFlowSemanticModel[];
  } {
    let yaml: MetricFlowYaml;
    try {
      yaml = parseYaml(yamlContent) as MetricFlowYaml;
    } catch (error) {
      const msg = `Failed to parse YAML${filePath ? ` at ${filePath}` : ''}: ${error}`;
      this.logger.warn(msg);
      warnings.push(msg);
      return { semanticModels: [], metrics: [], relationshipModels: [] };
    }

    if (!yaml || typeof yaml !== 'object') {
      return { semanticModels: [], metrics: [], relationshipModels: [] };
    }

    const semanticModels = (yaml.semantic_models ?? []).map((sm) => this.parseSemanticModel(sm, warnings));
    const metrics = yaml.metrics ?? [];

    return { semanticModels, metrics, relationshipModels: yaml.semantic_models ?? [] };
  }

  private parseSemanticModel(sm: MetricFlowSemanticModel, warnings: string[]): ParsedSemanticModel {
    const dimensions = (sm.dimensions ?? []).map((d) => this.convertDimension(d));
    const measures = (sm.measures ?? [])
      .map((m) => this.convertMeasure(m, warnings))
      .filter(Boolean) as MeasureDefinition[];

    this.logger.debug(
      `Parsed semantic model '${sm.name}': ${dimensions.length} dimensions, ${measures.length} measures`,
    );

    return {
      name: sm.name,
      description: sm.description?.trim() || null,
      modelRef: this.extractModelRef(sm.model),
      dimensions,
      measures,
      entities: sm.entities ?? [],
      defaultTimeDimension: sm.defaults?.agg_time_dimension ?? null,
    };
  }

  private convertDimension(dim: MetricFlowDimension): DimensionDefinition {
    const type = dim.type === 'time' ? 'time' : 'string';
    const column = dim.expr ?? dim.name;

    return {
      name: dim.name,
      column,
      type,
      label: dim.label ?? this.toTitleCase(dim.name),
      description: dim.description?.trim() || undefined,
    };
  }

  private convertMeasure(m: MetricFlowMeasure, warnings: string[]): MeasureDefinition | null {
    const column = m.expr ?? m.name;

    // Handle percentile: map p50 to median, others to none with inline SQL
    if (m.agg === 'percentile') {
      const pct = m.agg_params?.percentile ?? 0.5;
      if (pct === 0.5) {
        return {
          type: 'simple' as const,
          name: m.name,
          column,
          aggregation: 'median',
          label: m.label ?? this.toTitleCase(m.name),
          description: m.description?.trim() || undefined,
        };
      }
      // Non-median percentile: store as 'none' with the percentile value in description
      const pctLabel = `p${Math.round(pct * 100)}`;
      warnings.push(`Measure '${m.name}': non-median percentile (${pctLabel}) stored with aggregation 'none'`);
      return {
        type: 'simple' as const,
        name: m.name,
        column,
        aggregation: 'none',
        label: m.label ?? `${this.toTitleCase(m.name)} (${pctLabel})`,
        description: m.description?.trim() || `${pctLabel} of ${column}`,
      };
    }

    const aggregation = AGG_MAP[m.agg];
    if (!aggregation) {
      const msg = `Measure '${m.name}': unsupported aggregation '${m.agg}', skipped`;
      this.logger.warn(msg);
      warnings.push(msg);
      return null;
    }

    return {
      type: 'simple' as const,
      name: m.name,
      column,
      aggregation,
      label: m.label ?? this.toTitleCase(m.name),
      description: m.description?.trim() || undefined,
    };
  }

  private extractRelationships(semanticModels: MetricFlowSemanticModel[]): ParsedMetricflowRelationship[] {
    const relationships: ParsedMetricflowRelationship[] = [];

    // Build a map of primary entity names → (model, column)
    const primaryEntities = new Map<string, { model: string; column: string }>();
    for (const sm of semanticModels) {
      // Handle primary_entity shorthand (top-level field)
      if (sm.primary_entity) {
        primaryEntities.set(sm.primary_entity, {
          model: this.extractModelRef(sm.model),
          column: sm.primary_entity,
        });
      }
      for (const entity of sm.entities ?? []) {
        if (entity.type === 'primary' || entity.type === 'unique') {
          primaryEntities.set(entity.name, {
            model: this.extractModelRef(sm.model),
            column: entity.expr ?? entity.name,
          });
        }
      }
    }

    // Match foreign entities to primary entities by name
    for (const sm of semanticModels) {
      const fromTable = this.extractModelRef(sm.model);
      for (const entity of sm.entities ?? []) {
        if (entity.type !== 'foreign') {
          continue;
        }

        const primary = primaryEntities.get(entity.name);
        if (!primary || primary.model === fromTable) {
          continue;
        }

        relationships.push({
          fromTable,
          fromColumn: entity.expr ?? entity.name,
          toTable: primary.model,
          toColumn: primary.column,
          description: entity.description?.trim() || undefined,
        });
      }
    }

    return relationships;
  }

  private buildMeasureIndex(models: ParsedSemanticModel[]): Map<string, string> {
    const index = new Map<string, string>();
    for (const model of models) {
      for (const measure of model.measures) {
        index.set(measure.name, model.name);
      }
    }
    return index;
  }

  /**
   * Extract measure name from type_params.measure which can be a string or { name: string }.
   */
  private extractMeasureName(measure: string | { name: string } | undefined): string | undefined {
    if (!measure) {
      return undefined;
    }
    if (typeof measure === 'string') {
      return measure;
    }
    return measure.name;
  }

  /**
   * Normalize metric filter to an array of strings.
   * MetricFlow filters can be a string, array of strings, or { where_filters: [{ where_sql_template }] }.
   */
  private normalizeFilter(filter: MetricFlowFilter | undefined): string[] {
    if (!filter) {
      return [];
    }
    if (typeof filter === 'string') {
      return [filter];
    }
    if (Array.isArray(filter)) {
      return filter;
    }
    if (filter.where_filters) {
      return filter.where_filters.map((f) => f.where_sql_template);
    }
    return [];
  }

  /**
   * For ratio metrics, build the referenced metrics list from numerator/denominator.
   * For derived metrics, use type_params.metrics directly.
   */
  private getReferencedMetrics(metric: MetricFlowMetric): MetricFlowMetricInput[] {
    if (metric.type === 'derived') {
      return metric.type_params.metrics ?? [];
    }
    if (metric.type === 'ratio') {
      const refs: MetricFlowMetricInput[] = [];
      if (metric.type_params.numerator) {
        refs.push(metric.type_params.numerator);
      }
      if (metric.type_params.denominator) {
        refs.push(metric.type_params.denominator);
      }
      return refs;
    }
    return [];
  }

  private resolveMetrics(
    metrics: MetricFlowMetric[],
    measureToModel: Map<string, string>,
    models: ParsedSemanticModel[],
    warnings: string[],
  ): ParsedCrossModelMetric[] {
    const crossModelMetrics: ParsedCrossModelMetric[] = [];

    // Build metric→model index from simple/cumulative metrics (needed for derived-of-derived resolution)
    const metricToModel = new Map<string, string>();
    for (const metric of metrics) {
      if (metric.type === 'simple' || metric.type === 'cumulative') {
        const measureName = this.extractMeasureName(metric.type_params.measure);
        if (measureName) {
          const owner = measureToModel.get(measureName);
          if (owner) {
            metricToModel.set(metric.name, owner);
          }
        }
      }
    }

    // Build metric→measure name index for resolving dependsOn
    // For filtered metrics, the new measure will use the metric's name
    const metricToMeasureName = new Map<string, string>();
    for (const metric of metrics) {
      if (metric.type === 'simple' || metric.type === 'cumulative') {
        const measureName = this.extractMeasureName(metric.type_params.measure);
        if (measureName) {
          const filterClauses = this.normalizeFilter(metric.filter);
          if (filterClauses.length > 0) {
            metricToMeasureName.set(metric.name, metric.name);
          } else {
            metricToMeasureName.set(metric.name, measureName);
          }
        }
      }
    }

    for (const metric of metrics) {
      if (metric.type === 'conversion') {
        this.logger.debug(`Skipping conversion metric '${metric.name}' (not supported)`);
        warnings.push(`Metric '${metric.name}': conversion metrics are not yet supported, skipped`);
        continue;
      }

      if (metric.type === 'simple' || metric.type === 'cumulative') {
        const measureName = this.extractMeasureName(metric.type_params.measure);
        if (!measureName) {
          continue;
        }

        const ownerModelName = measureToModel.get(measureName);
        if (!ownerModelName) {
          continue;
        }

        const model = models.find((m) => m.name === ownerModelName);
        if (!model) {
          continue;
        }

        const baseMeasure = model.measures.find((m) => m.name === measureName);
        if (!baseMeasure) {
          continue;
        }

        const filterClauses = this.normalizeFilter(metric.filter);

        if (filterClauses.length > 0 && baseMeasure.type === 'simple') {
          // Filtered metric: create a NEW measure (copy of base with metric's identity + filter)
          const translatedFilter = filterClauses.map((f) => this.translateJinjaFilter(f)).join(' AND ');
          const newMeasure: MeasureDefinition = {
            type: 'simple' as const,
            name: metric.name,
            column: baseMeasure.column,
            aggregation: baseMeasure.aggregation,
            label: metric.label ?? this.toTitleCase(metric.name),
            description: metric.description?.trim() || baseMeasure.description,
            filter: translatedFilter,
          };

          if (metric.type === 'cumulative') {
            (newMeasure as { cumulative?: boolean }).cumulative = true;
          }

          if (metric.name === baseMeasure.name) {
            // Same name as base measure: replace in-place to avoid duplicates
            const idx = model.measures.indexOf(baseMeasure);
            model.measures[idx] = newMeasure;
          } else {
            model.measures.push(newMeasure);
          }
          measureToModel.set(metric.name, ownerModelName);
        } else {
          // Unfiltered metric: update base measure's label/description in-place
          if (metric.label) {
            (baseMeasure as { label?: string }).label = metric.label;
          }
          if (metric.description) {
            (baseMeasure as { description?: string }).description = metric.description;
          }
          if (metric.type === 'cumulative' && baseMeasure.type === 'simple') {
            (baseMeasure as { cumulative?: boolean }).cumulative = true;
          }
        }
      } else if (metric.type === 'derived' || metric.type === 'ratio') {
        const referencedMetrics = this.getReferencedMetrics(metric);
        if (referencedMetrics.length === 0) {
          continue;
        }

        // Find which models own the referenced metrics using metricToModel index
        const ownerModels = new Set<string>();
        for (const ref of referencedMetrics) {
          const owner = metricToModel.get(ref.name);
          if (owner) {
            ownerModels.add(owner);
          }
        }

        if (ownerModels.size <= 1 && ownerModels.size > 0) {
          // Single-model derived/ratio metric — add as derived measure to that model
          const ownerModelName = [...ownerModels][0];
          const model = models.find((m) => m.name === ownerModelName);
          if (!model) {
            continue;
          }

          const dependsOn = referencedMetrics.map((ref) => metricToMeasureName.get(ref.name) ?? ref.name);

          let expr = metric.type_params.expr ?? '';

          // For ratio metrics without an explicit expr, generate "numerator / denominator"
          if (metric.type === 'ratio' && !metric.type_params.expr) {
            const [numName, denName] = dependsOn;
            expr = numName && denName ? `${numName} / NULLIF(${denName}, 0)` : dependsOn.join(' / ');
          }

          // Replace metric name aliases with actual measure names in expression
          for (const ref of referencedMetrics) {
            const actualName = metricToMeasureName.get(ref.name) ?? ref.name;
            const aliasOrName = ref.alias ?? ref.name;
            if (aliasOrName !== actualName) {
              expr = expr.replace(new RegExp(`\\b${aliasOrName}\\b`, 'g'), actualName);
            }
          }

          const derivedMeasure: MeasureDefinition = {
            type: 'derived' as const,
            name: metric.name,
            expr,
            dependsOn,
            label: metric.label ?? this.toTitleCase(metric.name),
            description: metric.description?.trim() || undefined,
          };

          model.measures.push(derivedMeasure);

          // Register this derived metric in metricToModel so derived-of-derived can find it
          metricToModel.set(metric.name, ownerModelName);
        } else {
          // Cross-model or unresolved derived metric
          const dependsOn = referencedMetrics.map((ref) => {
            const ownerModel = metricToModel.get(ref.name);
            return { metricName: ownerModel ?? ref.name, alias: ref.alias };
          });

          const filterClauses = this.normalizeFilter(metric.filter);
          const filter =
            filterClauses.length > 0 ? filterClauses.map((f) => this.translateJinjaFilter(f)).join(' AND ') : null;

          crossModelMetrics.push({
            name: metric.name,
            label: metric.label ?? null,
            description: metric.description?.trim() || null,
            type: 'derived',
            expr: metric.type_params.expr ?? '',
            dependsOn,
            filter,
          });
        }
      }
    }

    return crossModelMetrics;
  }

  /**
   * Translate MetricFlow Jinja filter syntax to raw SQL.
   * {{ Dimension('model__column') }} → column
   * {{ TimeDimension('model__column', 'day') }} → column
   */
  translateJinjaFilter(filter: string): string {
    return filter
      .replace(/\{\{\s*Dimension\s*\(\s*'([^']+)'\s*\)\s*\}\}/g, (_match, ref: string) => {
        const parts = ref.split('__');
        return parts[parts.length - 1];
      })
      .replace(/\{\{\s*TimeDimension\s*\(\s*'([^']+)'\s*(?:,\s*'[^']*'\s*)?\)\s*\}\}/g, (_match, ref: string) => {
        const parts = ref.split('__');
        return parts[parts.length - 1];
      })
      .replace(/\{\{\s*Entity\s*\(\s*'([^']+)'\s*\)\s*\}\}/g, (_match, ref: string) => {
        const parts = ref.split('__');
        return parts[parts.length - 1];
      })
      .replace(/\{\{\s*Metric\s*\(\s*'([^']+)'\s*(?:,\s*[^)]+)?\)\s*\}\}/g, (_match, metricName: string) => metricName)
      .trim();
  }

  /**
   * Extract model name from ref('model_name') or source('source', 'table').
   */
  private extractModelRef(modelStr: string): string {
    const refMatch = modelStr.match(/ref\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (refMatch) {
      return refMatch[1];
    }

    const sourceMatch = modelStr.match(/source\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
    if (sourceMatch) {
      return sourceMatch[1];
    }

    return modelStr;
  }

  private toTitleCase(snakeCase: string): string {
    return snakeCase
      .split('_')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  private deduplicateRelationships(relationships: ParsedMetricflowRelationship[]): ParsedMetricflowRelationship[] {
    const seen = new Set<string>();
    return relationships.filter((rel) => {
      const key = `${rel.fromTable}.${rel.fromColumn}->${rel.toTable}.${rel.toColumn}`.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}
