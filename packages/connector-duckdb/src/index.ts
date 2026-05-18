export {
  assertDuckDbDatabaseFile,
  duckDbDatabasePathFromConfig,
  isKtxDuckDbConnectionConfig,
  KtxDuckDbScanConnector,
  type DuckDbDatabasePathInput,
  type KtxDuckDbConnectionConfig,
  type KtxDuckDbScanConnectorOptions,
} from './connector.js';
export {
  assertSupportedDuckDbPlatform,
  currentDuckDbPlatform,
  detectDuckDbLibc,
  formatDuckDbNativeLoadError,
  type DuckDbLibc,
  type DuckDbPlatformInfo,
} from './platform.js';
