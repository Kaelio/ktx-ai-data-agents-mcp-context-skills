import { sqliteDatabasePathFromConfig, type KtxSqliteConnectionConfig } from '../sqlite/connector.js';
import { postgresPoolConfigFromConfig, type KtxPostgresConnectionConfig } from '../postgres/connector.js';
import {
  mysqlConnectionPoolConfigFromConfig,
  type KtxMysqlConnectionConfig,
} from '../mysql/connector.js';
import { attachTypeForDriver, type FederatedMember } from '../../context/connections/federation.js';

function pgKeyword(value: string): string {
  // libpq keyword values quote with single quotes and backslash-escape.
  return /[\s'\\]/.test(value) ? `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'` : value;
}

function postgresAttachString(member: FederatedMember, env: NodeJS.ProcessEnv): string {
  const cfg = postgresPoolConfigFromConfig({
    connectionId: member.connectionId,
    connection: member.connection as KtxPostgresConnectionConfig,
    env,
  });
  if (cfg.connectionString) {
    return cfg.connectionString;
  }
  const parts: string[] = [];
  if (cfg.host) parts.push(`host=${pgKeyword(cfg.host)}`);
  if (cfg.port) parts.push(`port=${cfg.port}`);
  if (cfg.database) parts.push(`dbname=${pgKeyword(cfg.database)}`);
  if (cfg.user) parts.push(`user=${pgKeyword(cfg.user)}`);
  if (cfg.password) parts.push(`password=${pgKeyword(cfg.password)}`);
  return parts.join(' ');
}

function mysqlAttachString(member: FederatedMember, env: NodeJS.ProcessEnv): string {
  const cfg = mysqlConnectionPoolConfigFromConfig({
    connectionId: member.connectionId,
    connection: member.connection as KtxMysqlConnectionConfig,
    env,
  });
  const parts: string[] = [
    `host=${cfg.host}`,
    `port=${cfg.port}`,
    `database=${cfg.database}`,
    `user=${cfg.user}`,
  ];
  if (cfg.password) {
    parts.push(`password=${cfg.password}`);
  }
  return parts.join(' ');
}

/**
 * Resolves a federated member's ktx.yaml config into the connection target
 * DuckDB's ATTACH wants for that driver, reusing each connector's canonical
 * resolver so federation and standalone scans agree on config interpretation.
 */
export function federatedAttachTarget(member: FederatedMember, env: NodeJS.ProcessEnv): string {
  const type = attachTypeForDriver(member.driver);
  switch (type) {
    case 'sqlite':
      return sqliteDatabasePathFromConfig({
        connectionId: member.connectionId,
        projectDir: member.projectDir,
        connection: member.connection as KtxSqliteConnectionConfig,
      });
    case 'postgres':
      return postgresAttachString(member, env);
    case 'mysql':
      return mysqlAttachString(member, env);
    default:
      throw new Error(`Driver "${member.driver}" cannot be attached by DuckDB federation.`);
  }
}
