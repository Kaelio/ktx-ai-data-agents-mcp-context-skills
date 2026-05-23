import { basename } from 'node:path';
import type { KtxProjectConnectionConfig } from '../context/project/config.js';
import { DEMO_CONNECTION_ID } from '../demo-assets.js';

export function isDemoConnection(
  connectionId: string,
  connection: KtxProjectConnectionConfig | undefined,
): boolean {
  if (!connection) {
    return false;
  }

  const path = typeof connection.path === 'string' ? connection.path : '';
  return connectionId === DEMO_CONNECTION_ID && connection.driver === 'sqlite' && basename(path) === 'demo.db';
}
