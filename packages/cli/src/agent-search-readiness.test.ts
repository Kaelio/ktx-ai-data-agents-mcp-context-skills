import { describe, expect, it } from 'vitest';
import {
  isMissingProjectConfigError,
  missingConnectionSlSearchReadiness,
  missingProjectSlSearchReadiness,
  noConnectionsSlSearchReadiness,
  noIndexedSourcesSlSearchReadiness,
} from './agent-search-readiness.js';

describe('agent semantic-layer search readiness guidance', () => {
  it('formats missing project guidance with exact recovery commands', () => {
    expect(missingProjectSlSearchReadiness('/tmp/ktx-search', 'gross revenue')).toEqual({
      code: 'agent_sl_search_missing_project',
      message: 'Semantic-layer search needs an initialized KTX project at /tmp/ktx-search.',
      nextSteps: [
        'ktx setup --project-dir /tmp/ktx-search',
        'ktx status --project-dir /tmp/ktx-search',
        'ktx ingest <connection>',
        'ktx agent sl list --json --query "gross revenue" --project-dir /tmp/ktx-search',
      ],
    });
  });

  it('formats no-connection and no-index guidance without hiding the project path', () => {
    expect(noConnectionsSlSearchReadiness('/tmp/ktx-search', 'revenue')).toMatchObject({
      code: 'agent_sl_search_no_connections',
      message: 'Semantic-layer search found no configured connections in /tmp/ktx-search.',
    });
    expect(noIndexedSourcesSlSearchReadiness('/tmp/ktx-search', 'orders')).toMatchObject({
      code: 'agent_sl_search_no_indexed_sources',
      message: 'Semantic-layer search found no indexed semantic-layer sources in /tmp/ktx-search.',
    });
  });

  it('formats unknown connection guidance', () => {
    expect(missingConnectionSlSearchReadiness('/tmp/ktx-search', 'warehouse', 'revenue')).toMatchObject({
      code: 'agent_sl_search_unknown_connection',
      message: 'Semantic-layer search connection "warehouse" is not configured in /tmp/ktx-search.',
    });
  });

  it('detects missing ktx.yaml read errors', () => {
    const error = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
      path: '/tmp/ktx-search/ktx.yaml',
    });

    expect(isMissingProjectConfigError(error)).toBe(true);
    expect(isMissingProjectConfigError(new Error('other'))).toBe(false);
  });
});
