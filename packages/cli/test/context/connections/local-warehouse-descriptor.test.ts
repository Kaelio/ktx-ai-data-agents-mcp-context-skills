import { describe, expect, it } from 'vitest';
import {
  isExecuteOnlyConnection,
  isScanTargetWarehouse,
  localConnectionInfoFromConfig,
  localConnectionToWarehouseDescriptor,
  localConnectionTypeForConfig,
} from '../../../src/context/connections/local-warehouse-descriptor.js';

describe('execute-only warehouse connections', () => {
  it('treats a warehouse without scan_enabled as a scan target', () => {
    const connection = { driver: 'postgres', url: 'postgresql://db/a' } as const;
    expect(isExecuteOnlyConnection(connection)).toBe(false);
    expect(isScanTargetWarehouse('w', connection)).toBe(true);
  });

  it('excludes a warehouse with scan_enabled: false from scan targets but still resolves it as a warehouse', () => {
    const connection = { driver: 'postgres', url: 'postgresql://db/a', scan_enabled: false } as const;
    expect(isExecuteOnlyConnection(connection)).toBe(true);
    expect(isScanTargetWarehouse('w', connection)).toBe(false);
    // Execution paths must still see it as a warehouse so `ktx sql` works.
    expect(localConnectionToWarehouseDescriptor('w', connection)).not.toBeNull();
  });

  it('does not treat non-warehouse connections as scan targets', () => {
    expect(isScanTargetWarehouse('n', { driver: 'notion', auth_token: 'x' } as never)).toBe(false);
  });
});

describe('localConnectionToWarehouseDescriptor', () => {
  it('maps local Postgres URLs to canonical warehouse descriptors', () => {
    expect(
      localConnectionToWarehouseDescriptor('warehouse', {
        driver: 'postgres',
        url: 'postgresql://readonly@db.example.test/analytics',
      }),
    ).toMatchObject({
      id: 'warehouse',
      connection_type: 'POSTGRESQL',
      host: 'db.example.test',
      database: 'analytics',
    });
  });

  it('maps BigQuery project and dataset from explicit fields', () => {
    expect(
      localConnectionToWarehouseDescriptor('bq', {
        driver: 'bigquery',
        project_id: 'acme',
        dataset_id: 'warehouse',
      }),
    ).toMatchObject({
      id: 'bq',
      connection_type: 'BIGQUERY',
      project_id: 'acme',
      dataset_id: 'warehouse',
    });
  });

  it('returns null for non-warehouse adapters', () => {
    expect(
      localConnectionToWarehouseDescriptor('looker', {
        driver: 'looker',
        base_url: 'https://looker.example.com',
        client_id: 'client',
      }),
    ).toBeNull();
  });
});

describe('local connection info helpers', () => {
  it('returns canonical warehouse connection types for local catalogs', () => {
    expect(localConnectionTypeForConfig('warehouse', { driver: 'postgres' })).toBe('POSTGRESQL');
    expect(localConnectionTypeForConfig('bq', { driver: 'bigquery', project_id: 'acme' })).toBe('BIGQUERY');
    expect(localConnectionTypeForConfig('snowflake', { driver: 'snowflake' })).toBe('SNOWFLAKE');
  });

  it('keeps removed driver aliases as display-only labels', () => {
    expect(localConnectionTypeForConfig('warehouse', { driver: 'postgresql' } as never)).toBe('postgresql');
    expect(localConnectionTypeForConfig('warehouse', { driver: 'mssql' } as never)).toBe('mssql');
  });

  it('keeps non-warehouse adapter labels for display-only local connection surfaces', () => {
    expect(localConnectionTypeForConfig('prod-metabase', { driver: 'metabase', api_url: 'https://metabase.example.com' })).toBe(
      'metabase',
    );
    expect(localConnectionTypeForConfig('missing-driver', {} as never)).toBe('unknown');
  });

  it('builds nullable local connection info records', () => {
    expect(localConnectionInfoFromConfig('warehouse', { driver: 'postgres' })).toEqual({
      id: 'warehouse',
      name: 'warehouse',
      connectionType: 'POSTGRESQL',
    });
    expect(localConnectionInfoFromConfig('missing', undefined)).toBeNull();
  });
});
