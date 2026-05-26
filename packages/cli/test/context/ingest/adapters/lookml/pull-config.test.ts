import { describe, expect, it } from 'vitest';
import { parseLookmlPullConfig, pullConfigFromIntegrationConfig } from '../../../../../src/context/ingest/adapters/lookml/pull-config.js';

describe('lookml pull config', () => {
  it('parses a minimal valid config with defaulted branch', () => {
    const config = parseLookmlPullConfig({ repoUrl: 'https://github.com/acme/r.git' });
    expect(config.repoUrl).toBe('https://github.com/acme/r.git');
    expect(config.branch).toBe('main');
    expect(config.path).toBeNull();
    expect(config.authToken).toBeNull();
    expect(config.expectedLookerConnectionName).toBeNull();
    expect(config.parsedTargetTables).toEqual({});
  });

  it('defaults expectedLookerConnectionName and parsedTargetTables for LookML pulls', () => {
    const config = parseLookmlPullConfig({ repoUrl: 'https://github.com/acme/r.git' });

    expect(config.expectedLookerConnectionName).toBeNull();
    expect(config.parsedTargetTables).toEqual({});
  });

  it('parses a fully specified config', () => {
    const config = parseLookmlPullConfig({
      repoUrl: 'https://gitlab.com/team/proj.git',
      branch: 'develop',
      path: 'views',
      authToken: 'glpat-xyz',
    });
    expect(config).toEqual({
      repoUrl: 'https://gitlab.com/team/proj.git',
      branch: 'develop',
      path: 'views',
      authToken: 'glpat-xyz',
      expectedLookerConnectionName: null,
      parsedTargetTables: {},
    });
  });

  it('parses the validation-only expected connection and parsed target table map', () => {
    const config = parseLookmlPullConfig({
      repoUrl: 'https://github.com/acme/r.git',
      expectedLookerConnectionName: 'b2b_sandbox_bq',
      parsedTargetTables: {
        'b2b.orders': {
          ok: true,
          catalog: 'proj',
          schema: 'analytics',
          name: 'orders',
          canonicalTable: 'proj.analytics.orders',
        },
        'b2b.derived': {
          ok: false,
          reason: 'derived_table_not_supported',
        },
      },
    });

    expect(config.expectedLookerConnectionName).toBe('b2b_sandbox_bq');
    expect(config.parsedTargetTables['b2b.orders']).toEqual({
      ok: true,
      catalog: 'proj',
      schema: 'analytics',
      name: 'orders',
      canonicalTable: 'proj.analytics.orders',
    });
    expect(config.parsedTargetTables['b2b.derived']).toEqual({
      ok: false,
      reason: 'derived_table_not_supported',
    });
  });

  it('rejects a non-URL repoUrl', () => {
    expect(() => parseLookmlPullConfig({ repoUrl: 'not-a-url' })).toThrow();
  });

  it('rejects a missing repoUrl', () => {
    expect(() => parseLookmlPullConfig({ branch: 'main' })).toThrow();
  });

  it('pullConfigFromIntegrationConfig extracts the adapter-visible fields', () => {
    const integration = {
      pullEnabled: true,
      repoUrl: 'https://github.com/acme/r.git',
      branch: 'main',
      path: 'models',
      authToken: 'ghp_x',
      pullSchedule: 'daily' as const,
      nextPullAt: '2026-05-01T00:00:00.000Z',
      lastPulledAt: null,
      lastCommitHash: null,
    };
    expect(pullConfigFromIntegrationConfig(integration)).toEqual({
      repoUrl: 'https://github.com/acme/r.git',
      branch: 'main',
      path: 'models',
      authToken: 'ghp_x',
      expectedLookerConnectionName: null,
      parsedTargetTables: {},
    });
  });

  it('pullConfigFromIntegrationConfig forwards the expected connection name', () => {
    const integration = {
      pullEnabled: true,
      repoUrl: 'https://github.com/acme/r.git',
      branch: 'main',
      path: 'models',
      authToken: 'ghp_x',
      pullSchedule: 'daily' as const,
      nextPullAt: '2026-05-01T00:00:00.000Z',
      lastPulledAt: null,
      lastCommitHash: null,
      expectedLookerConnectionName: 'warehouse_bq',
    };

    expect(pullConfigFromIntegrationConfig(integration)).toEqual({
      repoUrl: 'https://github.com/acme/r.git',
      branch: 'main',
      path: 'models',
      authToken: 'ghp_x',
      expectedLookerConnectionName: 'warehouse_bq',
      parsedTargetTables: {},
    });
  });

  it('pullConfigFromIntegrationConfig throws when repoUrl is null', () => {
    const integration = {
      pullEnabled: false,
      repoUrl: null,
      branch: null,
      path: null,
      authToken: null,
      pullSchedule: null,
      nextPullAt: null,
      lastPulledAt: null,
      lastCommitHash: null,
    };
    expect(() => pullConfigFromIntegrationConfig(integration)).toThrow(/repoUrl/);
  });
});
