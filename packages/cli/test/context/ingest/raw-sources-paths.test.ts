import { describe, expect, it } from 'vitest';
import { buildSyncId, provenanceMarker, rawSourcesDirForSync, rawSourcesRoot } from '../../../src/context/ingest/raw-sources-paths.js';

describe('raw-sources paths', () => {
  it('buildSyncId uses timestamp + jobId', () => {
    const id = buildSyncId(new Date('2026-04-22T14:30:00Z'), 'job-abc');
    expect(id).toBe('2026-04-22-143000-job-abc');
  });

  it('rawSourcesDirForSync composes the canonical path', () => {
    const path = rawSourcesDirForSync('c1', 'fake', 's1');
    expect(path).toBe('raw-sources/c1/fake/s1');
  });

  it('rawSourcesRoot is stable', () => {
    expect(rawSourcesRoot).toBe('raw-sources');
  });

  it('provenanceMarker produces the documented HTML-comment shape', () => {
    expect(provenanceMarker('raw-sources/c1/fake/s1/a.yml', 15, 28)).toBe(
      '<!-- from: raw-sources/c1/fake/s1/a.yml#L15-28 -->',
    );
  });
});
