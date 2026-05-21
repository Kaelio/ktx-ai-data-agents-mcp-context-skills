import type { KtxFileStorePort } from '../../../core/file-store.js';
import type { SlConnectionCatalogPort } from '../../../sl/ports.js';
import { WarehouseCatalogService } from '../../../scan/warehouse-catalog.js';
import type { BaseTool, ToolContext } from '../../../tools/base-tool.js';
import { DiscoverDataTool } from './discover-data.tool.js';
import { EntityDetailsTool } from './entity-details.tool.js';
import { SqlExecutionTool } from './sql-execution.tool.js';

export function createWarehouseVerificationTools(deps: {
  connections: SlConnectionCatalogPort;
  fallbackFileStore: KtxFileStorePort;
  wikiSearchTool: BaseTool;
  slDiscoverTool: BaseTool;
}): BaseTool[] {
  const catalogFactory = (context: ToolContext) =>
    new WarehouseCatalogService({
      fileStore: context.session?.configService ?? deps.fallbackFileStore,
    });
  return [
    new EntityDetailsTool(catalogFactory),
    new SqlExecutionTool(deps.connections),
    new DiscoverDataTool({
      wikiSearchTool: deps.wikiSearchTool,
      slDiscoverTool: deps.slDiscoverTool,
      catalogFactory,
    }),
  ];
}
