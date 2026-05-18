import { assertSupportedDuckDbPlatform, formatDuckDbNativeLoadError } from './platform.js';

export type DuckDbNodeApi = typeof import('@duckdb/node-api');

export interface DuckDbNativeLoader {
  load(): Promise<DuckDbNodeApi>;
}

export async function loadDuckDbNodeApi(): Promise<DuckDbNodeApi> {
  assertSupportedDuckDbPlatform();
  try {
    return await import('@duckdb/node-api');
  } catch (error) {
    throw formatDuckDbNativeLoadError(error);
  }
}
