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
    'test/setup-databases.test.ts',
    'test/scan.test.ts',
    'test/commands/connection-metabase-setup.test.ts',
    'test/setup-models.test.ts',
    'test/setup-sources.test.ts',
    'test/setup.test.ts',
    'test/connection.test.ts',
    'test/setup-embeddings.test.ts',
    'test/ingest.test.ts',
    'test/commands/connection-mapping.test.ts',
    'test/ingest-viz.test.ts',
    'test/demo.test.ts',
    'test/setup-project.test.ts',
    'test/sl.test.ts',
    'test/local-scan-connectors.test.ts',
    'test/commands/connection-notion.test.ts',
  ];

  const contextSlowTests = [
    'test/context/scan/local-scan.test.ts',
    'test/context/mcp/local-project-ports.test.ts',
    'test/context/ingest/local-stage-ingest.test.ts',
    'test/context/sl/pglite-sl-search-prototype.test.ts',
    'test/context/core/git.service.test.ts',
    'test/context/ingest/local-adapters.test.ts',
    'test/context/ingest/local-bundle-ingest.test.ts',
    'test/context/ingest/local-metabase-ingest.test.ts',
    'test/context/sl/local-sl.test.ts',
    'test/context/search/pglite-owner-process.test.ts',
    'test/context/scan/local-enrichment-artifacts.test.ts',
    'test/context/search/pglite-spike.test.ts',
    'test/context/wiki/local-knowledge.test.ts',
    'test/context/sl/local-query.test.ts',
    'test/context/scan/relationship-review-decisions.test.ts',
    'test/context/scan/relationship-profiling.test.ts',
  ];

  it('keeps slow package tests out of default local package test scripts', async () => {
    const cliPackage = await readJson('../packages/cli/package.json');
    assertScriptContainsAll(cliPackage.scripts.test, cliSlowTests.map((file) => `--exclude ${file}`));
    assertScriptContainsAll(cliPackage.scripts.test, contextSlowTests.map((file) => `--exclude ${file}`));
  });

  it('provides explicit slow package test scripts for CI', async () => {
    const rootPackage = await readJson('../package.json');
    const cliPackage = await readJson('../packages/cli/package.json');
    assert.equal(rootPackage.scripts['test:slow'], 'pnpm --filter @kaelio/ktx run test:slow');
    assertScriptContainsAll(cliPackage.scripts['test:slow'], cliSlowTests);
    assertScriptContainsAll(cliPackage.scripts['test:slow'], contextSlowTests);
    assert.doesNotMatch(cliPackage.scripts['test:slow'], /relationship-benchmarks\.test\.ts/);
  });
});
