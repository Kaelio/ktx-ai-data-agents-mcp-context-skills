import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scanFileContent } from './check-boundaries.mjs';

describe('scanFileContent', () => {
  it('rejects source imports from application directories', () => {
    const serverAlias = '@' + 'server/contracts';
    const pythonAppPath = `${['python', 'service'].join('-')}/app/api/endpoints/semantic_layer.py`;

    const violations = [
      ...scanFileContent('packages/cli/src/context/index.ts', `import { orpc } from '${serverAlias}';`),
      ...scanFileContent('packages/cli/src/context/index.ts', `import "${pythonAppPath}";`),
    ];

    assert.deepEqual(
      violations.map((violation) => violation.kind),
      ['app-import', 'app-import'],
    );
  });

  it('allows clean source files and clean runtime prompt assets', () => {
    assert.deepEqual(
      scanFileContent('packages/cli/src/context/index.ts', "export const packageName = 'ktx';"),
      [],
    );
    assert.deepEqual(
      scanFileContent('packages/cli/src/prompts/memory_agent_bundle_ingest_work_unit.md', 'Write output for ktx.'),
      [],
    );
  });

  it('rejects context-owned LLM provider construction outside llm modules', () => {
    const violations = [
      ...scanFileContent(
        'packages/cli/src/context/agent/local-llm-provider.ts',
        "import { createAnthropic } from '@ai-sdk/anthropic';",
      ),
      ...scanFileContent('packages/cli/src/context/scan/local-ai-gateway-enrichment.ts', "import { createGateway } from 'ai';"),
      ...scanFileContent('packages/cli/src/context/core/local-embedding-provider.ts', "import { embedMany } from 'ai';"),
    ];

    assert.deepEqual(
      violations.map((violation) => violation.kind),
      ['llm-boundary', 'llm-boundary', 'llm-boundary'],
    );
  });

  it('rejects concrete connector dialect imports from scan workflow and connector classes', () => {
    const violations = [
      ...scanFileContent(
        'packages/cli/src/context/scan/relationship-profiling.ts',
        "import { KtxPostgresDialect } from '../../connectors/postgres/dialect.js';",
      ),
      ...scanFileContent(
        'packages/cli/src/connectors/postgres/connector.ts',
        "import { KtxPostgresDialect } from './dialect.js';",
      ),
    ];

    assert.deepEqual(
      violations.map((violation) => violation.kind),
      ['dialect-boundary', 'dialect-boundary'],
    );
    assert.equal(
      violations[0]?.message,
      'Forbidden concrete connector dialect import; use getDialectForDriver() from context/connections/dialects.ts',
    );

    assert.deepEqual(
      scanFileContent(
        'packages/cli/src/context/connections/dialects.ts',
        "import { KtxPostgresDialect } from '../../connectors/postgres/dialect.js';",
      ),
      [],
    );
    assert.deepEqual(
      scanFileContent(
        'packages/cli/test/connectors/postgres/dialect.test.ts',
        "import { KtxPostgresDialect } from './dialect.js';",
      ),
      [],
    );
  });

  it('rejects old ktx LLM port declarations in context', () => {
    const violations = [
      ...scanFileContent('packages/cli/src/context/agent/agent-runner.service.ts', 'export interface LlmProviderPort {}'),
      ...scanFileContent('packages/cli/src/context/scan/types.ts', 'export interface KtxScanLlmPort {}'),
      ...scanFileContent('packages/cli/src/context/agent/gateway-llm-provider.ts', 'export function createGatewayLlmProvider() {}'),
    ];

    assert.deepEqual(
      violations.map((violation) => violation.kind),
      ['llm-boundary', 'llm-boundary', 'llm-boundary'],
    );
  });

  it('rejects getModelByName calls in context production source', () => {
    const violations = scanFileContent(
      'packages/cli/src/context/ingest/page-triage/page-triage.service.ts',
      "const model = this.deps.llmProvider.getModelByName('claude-sonnet-4-6');",
    );

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.kind, 'llm-boundary');
    assert.equal(
      violations[0]?.message,
      'Forbidden context getModelByName call; use getModel(role) inside context modules',
    );
  });

  it('allows role-driven getModel calls, test calls, and provider shape declarations', () => {
    assert.deepEqual(
      scanFileContent(
        'packages/cli/src/context/ingest/page-triage/page-triage.service.ts',
        "const model = this.deps.llmProvider.getModel('triage');",
      ),
      [],
    );

    assert.deepEqual(
      scanFileContent(
        'packages/cli/test/context/ingest/page-triage/page-triage.service.test.ts',
        "const model = this.deps.llmProvider.getModelByName('test-model');",
      ),
      [],
    );

    assert.deepEqual(
      scanFileContent(
        'packages/cli/src/context/scan/local-enrichment.ts',
        'return { getModel() { return model; }, getModelByName() { return model; } };',
      ),
      [],
    );
  });
});
