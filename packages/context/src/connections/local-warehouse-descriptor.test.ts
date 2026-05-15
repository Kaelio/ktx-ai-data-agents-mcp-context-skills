import { describe, expect, it } from 'vitest';
import {
  localConnectionInfoFromConfig,
  localConnectionToWarehouseDescriptor,
  localConnectionTypeForConfig,
} from './local-warehouse-descriptor.js';

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
