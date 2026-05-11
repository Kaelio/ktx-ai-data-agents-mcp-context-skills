import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
}

function assertScriptContainsAll(script, expected) {
  for (const item of expected) {
    assert.match(script, new RegExp(item.replaceAll('/', '\\/').replaceAll('.', '\\.')));
  }
}

describe('test tiering', () => {
  const cliSlowTests = [
    'src/setup-databases.test.ts',
    'src/scan.test.ts',
    'src/commands/connection-metabase-setup.test.ts',
    'src/setup-models.test.ts',
    'src/setup-sources.test.ts',
    'src/setup.test.ts',
    'src/connection.test.ts',
    'src/setup-embeddings.test.ts',
    'src/ingest.test.ts',
    'src/commands/connection-mapping.test.ts',
    'src/ingest-viz.test.ts',
    'src/demo.test.ts',
    'src/setup-project.test.ts',
    'src/sl.test.ts',
    'src/local-scan-connectors.test.ts',
    'src/commands/connection-notion.test.ts',
  ];

  const contextSlowTests = [
    'src/scan/local-scan.test.ts',
    'src/mcp/local-project-ports.test.ts',
    'src/ingest/local-stage-ingest.test.ts',
    'src/sl/pglite-sl-search-prototype.test.ts',
    'src/core/git.service.test.ts',
    'src/ingest/local-adapters.test.ts',
    'src/ingest/local-bundle-ingest.test.ts',
    'src/ingest/local-metabase-ingest.test.ts',
    'src/sl/local-sl.test.ts',
    'src/search/pglite-owner-process.test.ts',
    'src/scan/local-enrichment-artifacts.test.ts',
    'src/search/pglite-spike.test.ts',
    'src/wiki/local-knowledge.test.ts',
    'src/sl/local-query.test.ts',
    'src/scan/relationship-review-decisions.test.ts',
    'src/scan/relationship-profiling.test.ts',
  ];

  it('keeps slow package tests out of default local package test scripts', async () => {
    const cliPackage = await readJson('../packages/cli/package.json');
    const contextPackage = await readJson('../packages/context/package.json');

    assertScriptContainsAll(cliPackage.scripts.test, cliSlowTests.map((file) => `--exclude ${file}`));
    assertScriptContainsAll(contextPackage.scripts.test, contextSlowTests.map((file) => `--exclude ${file}`));
    assert.match(contextPackage.scripts.test, /--exclude src\/scan\/relationship-benchmarks\.test\.ts/);
  });

  it('provides explicit slow package test scripts for CI', async () => {
    const rootPackage = await readJson('../package.json');
    const cliPackage = await readJson('../packages/cli/package.json');
    const contextPackage = await readJson('../packages/context/package.json');

    assert.equal(rootPackage.scripts['test:slow'], 'pnpm --filter @ktx/context run test:slow && pnpm --filter @ktx/cli run test:slow');
    assertScriptContainsAll(cliPackage.scripts['test:slow'], cliSlowTests);
    assertScriptContainsAll(contextPackage.scripts['test:slow'], contextSlowTests);
    assert.doesNotMatch(contextPackage.scripts['test:slow'], /relationship-benchmarks\.test\.ts/);
  });
});
