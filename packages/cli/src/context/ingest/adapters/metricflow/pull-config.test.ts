import { describe, expect, it } from 'vitest';
import { parseMetricflowPullConfig, pullConfigFromMetricflowIntegration } from './pull-config.js';

describe('metricflow pull config', () => {
  it('applies defaults for optional git fields', () => {
    const parsed = parseMetricflowPullConfig({
      repoUrl: 'https://github.com/acme/analytics.git',
    });

    expect(parsed).toEqual({
      repoUrl: 'https://github.com/acme/analytics.git',
      branch: 'main',
      path: null,
      authToken: null,
      parsedTargetTables: {},
    });
  });

  it('preserves provided branch, path, token, and parsed target tables', () => {
    const parsed = parseMetricflowPullConfig({
      repoUrl: 'https://github.com/acme/analytics.git',
      branch: 'release',
      path: 'dbt',
      authToken: 'secret-token',
      parsedTargetTables: {
        orders: {
          catalog: 'warehouse',
          schema: 'marts',
          name: 'orders',
          ok: true,
          canonicalTable: 'analytics.marts.orders',
        },
      },
    });

    expect(parsed.branch).toBe('release');
    expect(parsed.path).toBe('dbt');
    expect(parsed.authToken).toBe('secret-token');
    expect(parsed.parsedTargetTables.orders).toMatchObject({ ok: true, name: 'orders' });
  });

  it('rejects missing repoUrl', () => {
    expect(() => parseMetricflowPullConfig({})).toThrow();
  });

  it('builds pull config from a local metricflow integration block', () => {
    expect(
      pullConfigFromMetricflowIntegration({
        repoUrl: 'https://github.com/acme/analytics.git',
        branch: null,
        path: null,
        authToken: null,
      }),
    ).toEqual({
      repoUrl: 'https://github.com/acme/analytics.git',
      branch: 'main',
      path: null,
      authToken: null,
      parsedTargetTables: {},
    });
  });

  it('throws a clear error when the integration block has no repo URL', () => {
    expect(() => pullConfigFromMetricflowIntegration({ repoUrl: null })).toThrow(
      'metricflow integration config missing repoUrl',
    );
  });
});
