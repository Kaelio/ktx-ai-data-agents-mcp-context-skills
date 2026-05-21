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
    'src/context/scan/local-scan.test.ts',
    'src/context/mcp/local-project-ports.test.ts',
    'src/context/ingest/local-stage-ingest.test.ts',
    'src/context/sl/pglite-sl-search-prototype.test.ts',
    'src/context/core/git.service.test.ts',
    'src/context/ingest/local-adapters.test.ts',
    'src/context/ingest/local-bundle-ingest.test.ts',
    'src/context/ingest/local-metabase-ingest.test.ts',
    'src/context/sl/local-sl.test.ts',
    'src/context/search/pglite-owner-process.test.ts',
    'src/context/scan/local-enrichment-artifacts.test.ts',
    'src/context/search/pglite-spike.test.ts',
    'src/context/wiki/local-knowledge.test.ts',
    'src/context/sl/local-query.test.ts',
    'src/context/scan/relationship-review-decisions.test.ts',
    'src/context/scan/relationship-profiling.test.ts',
  ];

  it('keeps slow package tests out of default local package test scripts', async () => {
    const cliPackage = await readJson('../packages/cli/package.json');
    assertScriptContainsAll(cliPackage.scripts.test, cliSlowTests.map((file) => `--exclude ${file}`));
    assertScriptContainsAll(cliPackage.scripts.test, contextSlowTests.map((file) => `--exclude ${file}`));
  });

  it('provides explicit slow package test scripts for CI', async () => {
    const rootPackage = await readJson('../package.json');
    const cliPackage = await readJson('../packages/cli/package.json');
    assert.equal(rootPackage.scripts['test:slow'], 'pnpm --filter @ktx/cli run test:slow');
    assertScriptContainsAll(cliPackage.scripts['test:slow'], cliSlowTests);
    assertScriptContainsAll(cliPackage.scripts['test:slow'], contextSlowTests);
    assert.doesNotMatch(cliPackage.scripts['test:slow'], /relationship-benchmarks\.test\.ts/);
  });
});
