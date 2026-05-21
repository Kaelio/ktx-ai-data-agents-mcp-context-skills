import type { SemanticLayerService } from '../../../../context/sl/semantic-layer.service.js';
import type { SemanticLayerSource } from '../../../../context/sl/types.js';
import { addTouchedSlSource, createTouchedSlSources, listTouchedSlSources, type TouchedSlSource } from '../../../../context/tools/touched-sl-sources.js';
import type { MetricFlowParseResult } from './deep-parse.js';
import {
  buildMetricflowJoinsForModel,
  buildMetricflowSemanticModelSource,
  filterValidMetricflowRelationships,
  findMatchingMetricflowTable,
  getMetricflowAvailableColumnNames,
  mapCrossModelMetricToSource,
  resolveMetricflowSemanticModelSourceName,
  type MetricflowHostTable,
  type MetricflowSemanticModelImportContext,
} from './semantic-models.js';

export interface MetricFlowImportResult {
  sourcesCreated: number;
  sourcesUpdated: number;
  sourcesSkipped: number;
  crossModelSourcesCreated: number;
  relationshipsImported: number;
  warnings: string[];
  errors: string[];
  touchedSources: TouchedSlSource[];
}

type MetricflowSemanticLayerWriter = Pick<
  SemanticLayerService,
  'getManifestEntry' | 'isManifestBacked' | 'loadAllSources' | 'loadSource' | 'writeSource'
>;

type MetricflowSemanticLayerService = MetricflowSemanticLayerWriter & {
  forWorktree(workdir: string): MetricflowSemanticLayerWriter;
};

export interface ImportMetricflowSemanticModelsDeps {
  semanticLayerService: MetricflowSemanticLayerService;
}

const DBT_METRICFLOW_AUTHOR = {
  name: 'dbt MetricFlow',
  email: ['system@kae', 'lio.dev'].join(''),
} as const;

export interface ImportMetricflowSemanticModelsInput {
  connectionId: string;
  parseResult: MetricFlowParseResult;
  targetSchema?: string | null;
  hostTables: MetricflowHostTable[];
  workdir?: string;
}

export async function importMetricflowSemanticModels(
  deps: ImportMetricflowSemanticModelsDeps,
  input: ImportMetricflowSemanticModelsInput,
): Promise<MetricFlowImportResult> {
  const semanticLayerService = input.workdir
    ? deps.semanticLayerService.forWorktree(input.workdir)
    : deps.semanticLayerService;
  const warnings = [...input.parseResult.warnings];
  const errors: string[] = [];
  const touched = createTouchedSlSources();
  let sourcesCreated = 0;
  let sourcesUpdated = 0;
  let sourcesSkipped = 0;
  let crossModelSourcesCreated = 0;

  const preexistingSourceNames = new Set(
    (await semanticLayerService.loadAllSources(input.connectionId)).sources.map((source) => source.name),
  );
  const modelContexts: MetricflowSemanticModelImportContext[] = [];
  const sourceNameByModelRef = new Map<string, string>();
  const sourceNameByManifestName = new Map<string, string>();
  const availableColumnNamesByModelRef = new Map<string, Set<string>>();

  for (const semanticModel of input.parseResult.semanticModels) {
    const matchedTable = findMatchingMetricflowTable(semanticModel.modelRef, input.hostTables, input.targetSchema);
    const sourceName = resolveMetricflowSemanticModelSourceName(semanticModel, matchedTable);
    sourceNameByModelRef.set(semanticModel.modelRef, sourceName);
    if (matchedTable) {
      sourceNameByManifestName.set(matchedTable.name, sourceName);
    }
    const manifestSource = await resolveManifestSource(semanticLayerService, input.connectionId, sourceName, matchedTable);
    const context = {
      model: semanticModel,
      matchedTable,
      sourceName,
      manifestSource,
    };
    availableColumnNamesByModelRef.set(semanticModel.modelRef, getMetricflowAvailableColumnNames(context));
    modelContexts.push(context);
  }

  const validRelationships = filterValidMetricflowRelationships(
    input.parseResult.relationships,
    availableColumnNamesByModelRef,
  );
  const availableTargetModelRefs = new Set(
    modelContexts
      .filter(
        (context) =>
          preexistingSourceNames.has(context.sourceName) || context.manifestSource?.name === context.sourceName,
      )
      .map((context) => context.model.modelRef),
  );
  const successfulModelContexts: MetricflowSemanticModelImportContext[] = [];

  for (const context of modelContexts) {
    try {
      const joins = buildMetricflowJoinsForModel(context.model, validRelationships, sourceNameByModelRef);
      const source = buildMetricflowSemanticModelSource(context, joins, sourceNameByManifestName);
      const existing =
        preexistingSourceNames.has(context.sourceName) ||
        context.manifestSource?.name === context.sourceName ||
        Boolean(await semanticLayerService.loadSource(input.connectionId, context.sourceName));

      await semanticLayerService.writeSource(
        input.connectionId,
        source as SemanticLayerSource,
        DBT_METRICFLOW_AUTHOR.name,
        DBT_METRICFLOW_AUTHOR.email,
        `dbt MetricFlow sync: ${existing ? 'update' : 'create'} source ${context.sourceName}`,
        { skipValidation: true },
      );

      if (existing) {
        sourcesUpdated++;
      } else {
        sourcesCreated++;
      }
      availableTargetModelRefs.add(context.model.modelRef);
      successfulModelContexts.push(context);
      addTouchedSlSource(touched, input.connectionId, context.sourceName);
    } catch (error) {
      errors.push(
        `Failed to import semantic model '${context.model.name}': ${error instanceof Error ? error.message : String(error)}`,
      );
      sourcesSkipped++;
    }
  }

  if (successfulModelContexts.length > 0) {
    try {
      await repairSourcesAfterPartialImportFailures({
        semanticLayerService,
        connectionId: input.connectionId,
        contexts: successfulModelContexts,
        relationships: validRelationships,
        sourceNameByModelRef,
        sourceNameByManifestName,
        availableTargetModelRefs,
        touched,
      });
    } catch (error) {
      errors.push(
        `Failed to repair semantic-model joins after partial import: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const relationshipsImported = successfulModelContexts.reduce((count, context) => {
    return (
      count +
      buildMetricflowJoinsForModel(context.model, validRelationships, sourceNameByModelRef, availableTargetModelRefs)
        .length
    );
  }, 0);

  for (const metric of input.parseResult.crossModelMetrics) {
    try {
      const source = mapCrossModelMetricToSource(metric);
      await semanticLayerService.writeSource(
        input.connectionId,
        source,
        DBT_METRICFLOW_AUTHOR.name,
        DBT_METRICFLOW_AUTHOR.email,
        `dbt MetricFlow sync: create cross-model source ${source.name}`,
        { skipValidation: true },
      );
      crossModelSourcesCreated++;
      addTouchedSlSource(touched, input.connectionId, source.name);
    } catch (error) {
      errors.push(
        `Failed to import cross-model metric '${metric.name}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    sourcesCreated,
    sourcesUpdated,
    sourcesSkipped,
    crossModelSourcesCreated,
    relationshipsImported,
    warnings,
    errors,
    touchedSources: listTouchedSlSources(touched),
  };
}

async function resolveManifestSource(
  semanticLayerService: MetricflowSemanticLayerWriter,
  connectionId: string,
  sourceName: string,
  matchedTable: MetricflowHostTable | undefined,
) {
  if (await semanticLayerService.isManifestBacked(connectionId, sourceName)) {
    return semanticLayerService.getManifestEntry(connectionId, sourceName);
  }

  const matchedTableName = matchedTable?.name;
  if (!matchedTableName || matchedTableName === sourceName) {
    return null;
  }
  if (await semanticLayerService.isManifestBacked(connectionId, matchedTableName)) {
    return semanticLayerService.getManifestEntry(connectionId, matchedTableName);
  }
  return null;
}

async function repairSourcesAfterPartialImportFailures(input: {
  semanticLayerService: MetricflowSemanticLayerWriter;
  connectionId: string;
  contexts: MetricflowSemanticModelImportContext[];
  relationships: Parameters<typeof buildMetricflowJoinsForModel>[1];
  sourceNameByModelRef: Map<string, string>;
  sourceNameByManifestName: Map<string, string>;
  availableTargetModelRefs: Set<string>;
  touched: ReturnType<typeof createTouchedSlSources>;
}): Promise<void> {
  for (const context of input.contexts) {
    const fullJoins = buildMetricflowJoinsForModel(context.model, input.relationships, input.sourceNameByModelRef);
    const repairedJoins = buildMetricflowJoinsForModel(
      context.model,
      input.relationships,
      input.sourceNameByModelRef,
      input.availableTargetModelRefs,
    );
    if (fullJoins.length === repairedJoins.length) {
      continue;
    }
    const repairedSource = buildMetricflowSemanticModelSource(
      context,
      repairedJoins,
      input.sourceNameByManifestName,
    );
    await input.semanticLayerService.writeSource(
      input.connectionId,
      repairedSource as SemanticLayerSource,
      DBT_METRICFLOW_AUTHOR.name,
      DBT_METRICFLOW_AUTHOR.email,
      `dbt MetricFlow sync: repair source ${context.sourceName} after partial import`,
      { skipValidation: true },
    );
    addTouchedSlSource(input.touched, input.connectionId, context.sourceName);
  }
}
