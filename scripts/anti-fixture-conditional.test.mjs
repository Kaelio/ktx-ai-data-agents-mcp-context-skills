import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const KTX_ROOT = new URL('../', import.meta.url);

const RELATIONSHIP_RUNTIME_SOURCES = Object.freeze([
  'packages/cli/src/context/scan/relationship-benchmarks.ts',
  'packages/cli/src/context/scan/relationship-budget.ts',
  'packages/cli/src/context/scan/relationship-candidates.ts',
  'packages/cli/src/context/scan/relationship-composite-candidates.ts',
  'packages/cli/src/context/scan/relationship-graph-resolver.ts',
  'packages/cli/src/context/scan/relationship-locality.ts',
  'packages/cli/src/context/scan/relationship-name-similarity.ts',
  'packages/cli/src/context/scan/relationship-discovery.ts',
  'packages/cli/src/context/scan/relationship-profiling.ts',
  'packages/cli/src/context/scan/relationship-scoring.ts',
  'packages/cli/src/context/scan/relationship-validation.ts',
]);

async function checkedInFixtureIds() {
  const fixtureRoot = new URL('packages/cli/src/test/fixtures/relationship-benchmarks/', KTX_ROOT);
  const entries = await readdir(fixtureRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function readRuntimeSources() {
  return Promise.all(
    RELATIONSHIP_RUNTIME_SOURCES.map(async (relativePath) => ({
      relativePath,
      source: await readFile(new URL(relativePath, KTX_ROOT), 'utf8'),
    })),
  );
}

describe('relationship evidence-fusion source guardrails', () => {
  it('keeps runtime relationship modules free of fixture-id conditionals', async () => {
    const fixtureIds = await checkedInFixtureIds();
    const sources = await readRuntimeSources();
    const hits = [];

    for (const { relativePath, source } of sources) {
      for (const fixtureId of fixtureIds) {
        if (source.includes(fixtureId)) {
          hits.push(`${relativePath}: ${fixtureId}`);
        }
      }
    }

    assert.deepEqual(hits, []);
  });

  it('keeps runtime relationship modules free of length-threshold drop-all cliffs', async () => {
    const sources = await readRuntimeSources();
    const dropAllPattern = /if\s*\([^)]*\.length\s*>\s*\d+[^)]*\)\s*(?:\{\s*)?return\s*\[\];/gs;
    const hits = sources.flatMap(({ relativePath, source }) => {
      const matches = Array.from(source.matchAll(dropAllPattern));
      return matches.map((match) => `${relativePath}: ${match[0].replace(/\s+/g, ' ').trim()}`);
    });

    assert.deepEqual(hits, []);
  });
});
