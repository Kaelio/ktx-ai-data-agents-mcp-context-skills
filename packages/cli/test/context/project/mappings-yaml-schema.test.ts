import { describe, expect, it } from 'vitest';
import {
  lookerMappingsSchema,
  lookmlMappingsSchema,
  metabaseMappingsSchema,
  parseConnectionMappingBootstrap,
  parseLookmlMappingBootstrap,
  parseLookerMappingBootstrap,
  parseMetabaseMappingBootstrap,
} from '../../../src/context/project/mappings-yaml-schema.js';

describe('ktx.yaml mapping bootstrap schema', () => {
  it('parses Metabase mapping intent with CLI syncMode default ALL', () => {
    const bootstrap = parseMetabaseMappingBootstrap('prod-metabase', {
      driver: 'metabase',
      mappings: {
        databaseMappings: { '1': 'prod-warehouse', '2': null },
        syncEnabled: { '1': true, '2': false },
        selections: { collections: [12], items: [345] },
        defaultTagNames: ['ktx', 'prod'],
      },
    });

    expect(bootstrap).toEqual({
      adapter: 'metabase',
      connectionId: 'prod-metabase',
      databaseMappings: { '1': 'prod-warehouse', '2': null },
      syncEnabled: { '1': true, '2': false },
      syncMode: 'ALL',
      selections: { collections: [12], items: [345] },
      defaultTagNames: ['ktx', 'prod'],
    });
  });

  it('rejects Metabase non-integer mapping keys', () => {
    expect(() =>
      parseMetabaseMappingBootstrap('prod-metabase', {
        driver: 'metabase',
        mappings: { databaseMappings: { abc: 'warehouse' } },
      }),
    ).toThrow(/databaseMappings key "abc" must be a positive integer string/);
  });

  it('parses Looker connection mapping intent', () => {
    const bootstrap = parseLookerMappingBootstrap('prod-looker', {
      driver: 'looker',
      mappings: {
        connectionMappings: {
          bigquery_prod: 'prod-warehouse',
          snowflake_dev: null,
        },
      },
    });

    expect(bootstrap).toEqual({
      adapter: 'looker',
      connectionId: 'prod-looker',
      connectionMappings: {
        bigquery_prod: 'prod-warehouse',
        snowflake_dev: null,
      },
    });
  });

  it('parses LookML expected connection from mappings block', () => {
    expect(
      parseLookmlMappingBootstrap('prod-lookml', {
        driver: 'lookml',
        repo_url: 'https://github.com/acme/looker.git',
        mappings: { expectedLookerConnectionName: 'bigquery_prod' },
      }),
    ).toEqual({
      adapter: 'lookml',
      connectionId: 'prod-lookml',
      expectedLookerConnectionName: 'bigquery_prod',
    });
  });

  it('dispatches by flat driver and returns null for connections with no mappings block', () => {
    expect(parseConnectionMappingBootstrap('warehouse', { driver: 'postgres', url: 'env:DATABASE_URL' })).toBeNull();
    expect(
      parseConnectionMappingBootstrap('prod-looker', {
        driver: 'looker',
        mappings: { connectionMappings: { analytics: 'prod-warehouse' } },
      }),
    ).toMatchObject({ adapter: 'looker', connectionId: 'prod-looker' });
  });

  it('exports mapping shapes that parse documented examples', () => {
    expect(metabaseMappingsSchema.parse({ databaseMappings: { '1': 'wh' } })).toMatchObject({
      databaseMappings: { '1': 'wh' },
      syncMode: 'ALL',
    });
    expect(lookerMappingsSchema.parse({ connectionMappings: { x: 'wh' } })).toEqual({
      connectionMappings: { x: 'wh' },
    });
    expect(lookmlMappingsSchema.parse({ expectedLookerConnectionName: 'x' })).toEqual({
      expectedLookerConnectionName: 'x',
    });
  });
});
