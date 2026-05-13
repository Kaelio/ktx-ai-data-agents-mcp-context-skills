import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scanFileContent } from './check-boundaries.mjs';

function productName() {
  return ['Kae', 'lio'].join('');
}

function lowerProductName() {
  return ['kae', 'lio'].join('');
}

describe('scanFileContent', () => {
  it('rejects source imports from application directories', () => {
    const serverAlias = '@' + 'server/contracts';
    const pythonAppPath = `${['python', 'service'].join('-')}/app/api/endpoints/semantic_layer.py`;

    const violations = [
      ...scanFileContent('packages/context/src/index.ts', `import { orpc } from '${serverAlias}';`),
      ...scanFileContent('packages/context/src/index.ts', `import "${pythonAppPath}";`),
    ];

    assert.deepEqual(
      violations.map((violation) => violation.kind),
      ['app-import', 'app-import'],
    );
  });

  it('rejects forbidden product identifiers in code source files', () => {
    const violations = scanFileContent('packages/context/src/index.ts', `export const owner = '${lowerProductName()}';`);

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.kind, 'identifier');
  });

  it('rejects forbidden product identifiers in shipped runtime prompt assets', () => {
    const violations = scanFileContent(
      'packages/context/prompts/memory_agent_bundle_ingest_work_unit.md',
      `Write output for ${productName()}.`,
    );

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.kind, 'identifier');
    assert.equal(violations[0]?.file, 'packages/context/prompts/memory_agent_bundle_ingest_work_unit.md');
  });

  it('rejects forbidden product identifiers in shipped runtime skill assets', () => {
    const violations = scanFileContent(
      'packages/context/skills/metabase_ingest/SKILL.md',
      `Use ${productName()} project conventions.`,
    );

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.kind, 'identifier');
    assert.equal(violations[0]?.file, 'packages/context/skills/metabase_ingest/SKILL.md');
  });

  it('allows product identifiers in docs, examples, and transition metadata', () => {
    const name = productName();

    assert.equal(scanFileContent('docs/transition.md', name).length, 0);
    assert.equal(scanFileContent('examples/transition.md', name).length, 0);
    assert.equal(scanFileContent('python/ktx-sl/plans/brainstorm.md', name).length, 0);
    assert.equal(scanFileContent('python/ktx-sl/openspec/specs/semantic-layer/spec.md', name).length, 0);
  });

  it('allows product identifiers in test fixtures', () => {
    const name = lowerProductName();

    assert.equal(scanFileContent('packages/cli/src/setup.test.ts', `project: ${name}-dev`).length, 0);
    assert.equal(scanFileContent('packages/context/src/ingest/importer.test.ts', `email: system@${name}.dev`).length, 0);
  });

  it('allows public package identifiers in release packaging and managed runtime source', () => {
    const name = lowerProductName();

    assert.equal(scanFileContent('scripts/local-embeddings-runtime-smoke.mjs', `@${name}/ktx`).length, 0);
    assert.equal(scanFileContent('scripts/package-artifacts.test.mjs', `${name}-ktx`).length, 0);
    assert.equal(scanFileContent('scripts/publish-public-npm-package.test.mjs', `@${name}/ktx`).length, 0);
    assert.equal(scanFileContent('packages/cli/src/managed-python-runtime.ts', `${name}_ktx`).length, 0);
  });

  it('allows clean source files and clean runtime prompt assets', () => {
    assert.deepEqual(
      scanFileContent('packages/context/src/index.ts', "export const packageName = '@ktx/context';"),
      [],
    );
    assert.deepEqual(
      scanFileContent('packages/context/prompts/memory_agent_bundle_ingest_work_unit.md', 'Write output for KTX.'),
      [],
    );
  });

  it('rejects context-owned LLM provider construction outside @ktx/llm', () => {
    const violations = [
      ...scanFileContent(
        'packages/context/src/agent/local-llm-provider.ts',
        "import { createAnthropic } from '@ai-sdk/anthropic';",
      ),
      ...scanFileContent('packages/context/src/scan/local-ai-gateway-enrichment.ts', "import { createGateway } from 'ai';"),
      ...scanFileContent('packages/context/src/core/local-embedding-provider.ts', "import { embedMany } from 'ai';"),
    ];

    assert.deepEqual(
      violations.map((violation) => violation.kind),
      ['llm-boundary', 'llm-boundary', 'llm-boundary'],
    );
  });

  it('rejects old KTX LLM port declarations in context', () => {
    const violations = [
      ...scanFileContent('packages/context/src/agent/agent-runner.service.ts', 'export interface LlmProviderPort {}'),
      ...scanFileContent('packages/context/src/scan/types.ts', 'export interface KtxScanLlmPort {}'),
      ...scanFileContent('packages/context/src/agent/gateway-llm-provider.ts', 'export function createGatewayLlmProvider() {}'),
    ];

    assert.deepEqual(
      violations.map((violation) => violation.kind),
      ['llm-boundary', 'llm-boundary', 'llm-boundary'],
    );
  });

  it('rejects getModelByName calls in context production source', () => {
    const violations = scanFileContent(
      'packages/context/src/ingest/page-triage/page-triage.service.ts',
      "const model = this.deps.llmProvider.getModelByName('claude-sonnet-4-6');",
    );

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.kind, 'llm-boundary');
    assert.equal(
      violations[0]?.message,
      'Forbidden context getModelByName call; use getModel(role) inside @ktx/context',
    );
  });

  it('allows role-driven getModel calls, test calls, and provider shape declarations', () => {
    assert.deepEqual(
      scanFileContent(
        'packages/context/src/ingest/page-triage/page-triage.service.ts',
        "const model = this.deps.llmProvider.getModel('triage');",
      ),
      [],
    );

    assert.deepEqual(
      scanFileContent(
        'packages/context/src/ingest/page-triage/page-triage.service.test.ts',
        "const model = this.deps.llmProvider.getModelByName('test-model');",
      ),
      [],
    );

    assert.deepEqual(
      scanFileContent(
        'packages/context/src/scan/local-enrichment.ts',
        'return { getModel() { return model; }, getModelByName() { return model; } };',
      ),
      [],
    );
  });
});
