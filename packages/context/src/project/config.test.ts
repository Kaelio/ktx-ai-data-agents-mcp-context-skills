import { describe, expect, it } from 'vitest';
import { buildDefaultKtxProjectConfig, parseKtxProjectConfig, serializeKtxProjectConfig } from './config.js';

describe('KTX project config', () => {
  it('builds the default standalone project config', () => {
    expect(buildDefaultKtxProjectConfig('warehouse')).toEqual({
      project: 'warehouse',
      connections: {},
      storage: {
        state: 'sqlite',
        search: 'sqlite-fts5',
        git: {
          auto_commit: true,
          author: 'ktx <ktx@example.com>',
        },
      },
      llm: {
        provider: {
          backend: 'none',
        },
        models: {},
      },
      ingest: {
        adapters: ['live-database', 'lookml', 'metabase', 'metricflow', 'notion'],
        embeddings: {
          backend: 'deterministic',
          model: 'deterministic',
          dimensions: 8,
        },
        workUnits: {
          stepBudget: 40,
          maxConcurrency: 1,
          failureMode: 'continue',
        },
      },
      agent: {
        run_research: {
          enabled: false,
          max_iterations: 20,
          default_toolset: ['sl_query', 'knowledge_search', 'sl_read_source'],
        },
      },
      memory: {
        auto_commit: true,
      },
      scan: {
        enrichment: {
          mode: 'none',
        },
        relationships: {
          enabled: true,
          llmProposals: true,
          validationRequiredForManifest: true,
          acceptThreshold: 0.85,
          reviewThreshold: 0.55,
          maxLlmTablesPerBatch: 40,
          maxCandidatesPerColumn: 25,
          profileSampleRows: 10000,
          validationConcurrency: 4,
        },
      },
    });
  });

  it('round-trips through YAML with stable defaults', () => {
    const serialized = serializeKtxProjectConfig(buildDefaultKtxProjectConfig('warehouse'));
    const parsed = parseKtxProjectConfig(serialized);

    expect(serialized).toContain('project: warehouse');
    expect(serialized).toContain('live-database');
    expect(serialized).toContain('notion');
    expect(serialized).toContain(
      '  embeddings:\n    backend: deterministic\n    model: deterministic\n    dimensions: 8',
    );
    expect(parsed.project).toBe('warehouse');
    expect(parsed.ingest.adapters).toEqual(['live-database', 'lookml', 'metabase', 'metricflow', 'notion']);
    expect(parsed.ingest.embeddings).toEqual({
      backend: 'deterministic',
      model: 'deterministic',
      dimensions: 8,
    });
  });

  it('parses and serializes setup warehouse metadata without setup progress', () => {
    const config = parseKtxProjectConfig(`
project: revenue
setup:
  database_connection_ids:
    - warehouse
    - analytics
connections:
  warehouse:
    driver: postgres
    url: env:WAREHOUSE_URL
`);

    expect(config.setup).toEqual({
      database_connection_ids: ['warehouse', 'analytics'],
    });

    const serialized = serializeKtxProjectConfig(config);
    expect(serialized).toContain('setup:');
    expect(serialized).toContain('database_connection_ids:');
    expect(serialized).not.toContain('completed_steps:');
  });

  it('parses global direct Anthropic LLM config', () => {
    const config = parseKtxProjectConfig(`
project: demo
llm:
  provider:
    backend: anthropic
    anthropic:
      api_key: env:ANTHROPIC_API_KEY
  models:
    default: claude-sonnet-4-6
    triage: claude-haiku-4-5
    repair: claude-opus-4-7
  promptCaching:
    enabled: false
ingest:
  workUnits:
    stepBudget: 30
    maxConcurrency: 2
    failureMode: abort
`);

    expect(config.llm).toMatchObject({
      provider: {
        backend: 'anthropic',
        anthropic: { api_key: 'env:ANTHROPIC_API_KEY' }, // pragma: allowlist secret
      },
      models: {
        default: 'claude-sonnet-4-6',
        triage: 'claude-haiku-4-5',
        repair: 'claude-opus-4-7',
      },
      promptCaching: { enabled: false },
    });
    expect(config.ingest.workUnits).toEqual({
      stepBudget: 30,
      maxConcurrency: 2,
      failureMode: 'abort',
    });
  });

  it('parses global Vertex LLM config', () => {
    const config = parseKtxProjectConfig(`
project: demo
llm:
  provider:
    backend: vertex
    vertex:
      project: local-gcp-project
      location: us-east5
  models:
    default: claude-sonnet-4-6
    triage: claude-haiku-4-5
`);

    expect(config.llm.provider.backend).toBe('vertex');
    expect(config.llm.provider.vertex).toEqual({ project: 'local-gcp-project', location: 'us-east5' });
    expect(config.llm.models).toEqual({
      default: 'claude-sonnet-4-6',
      triage: 'claude-haiku-4-5',
    });
  });

  it('parses gateway LLM, OpenAI scan embeddings, and sentence-transformers ingest embeddings', () => {
    const config = parseKtxProjectConfig(`
project: demo
llm:
  provider:
    backend: gateway
    gateway:
      api_key: env:AI_GATEWAY_API_KEY
      base_url: https://gateway.example/v1
  models:
    default: anthropic/claude-sonnet-4-6
ingest:
  embeddings:
    backend: sentence-transformers
    model: all-MiniLM-L6-v2
    dimensions: 384
    sentenceTransformers:
      base_url: http://127.0.0.1:18081
      pathPrefix: ""
    batchSize: 16
scan:
  enrichment:
    mode: llm
    embeddings:
      backend: openai
      model: text-embedding-3-small
      dimensions: 1536
      openai:
        api_key: env:OPENAI_API_KEY
      batchSize: 32
`);

    expect(config.ingest.embeddings).toMatchObject({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { base_url: 'http://127.0.0.1:18081', pathPrefix: '' },
      batchSize: 16,
    });
    expect(config.llm.models.default).toBe('anthropic/claude-sonnet-4-6');
    expect(config.scan.enrichment.mode).toBe('llm');
    expect(config.scan.enrichment.embeddings?.dimensions).toBe(1536);
  });

  it('parses scan relationship settings', () => {
    const config = parseKtxProjectConfig(`
project: demo
scan:
  relationships:
    enabled: false
    llm_proposals: false
    validation_required_for_manifest: true
    accept_threshold: 0.91
    review_threshold: 0.61
    max_llm_tables_per_batch: 12
    max_candidates_per_column: 7
    profile_sample_rows: 500
    validation_concurrency: 2
    validation_budget: 0
`);

    expect(config.scan.relationships).toEqual({
      enabled: false,
      llmProposals: false,
      validationRequiredForManifest: true,
      acceptThreshold: 0.91,
      reviewThreshold: 0.61,
      maxLlmTablesPerBatch: 12,
      maxCandidatesPerColumn: 7,
      profileSampleRows: 500,
      validationConcurrency: 2,
      validationBudget: 0,
    });
    expect(serializeKtxProjectConfig(config)).toContain('enabled: false');
    expect(serializeKtxProjectConfig(config)).toContain('llmProposals: false');
    expect(serializeKtxProjectConfig(config)).toContain('validationRequiredForManifest: true');
    expect(serializeKtxProjectConfig(config)).toContain('acceptThreshold: 0.91');
    expect(serializeKtxProjectConfig(config)).toContain('reviewThreshold: 0.61');
    expect(serializeKtxProjectConfig(config)).toContain('maxLlmTablesPerBatch: 12');
    expect(serializeKtxProjectConfig(config)).toContain('maxCandidatesPerColumn: 7');
    expect(serializeKtxProjectConfig(config)).toContain('profileSampleRows: 500');
    expect(serializeKtxProjectConfig(config)).toContain('validationConcurrency: 2');
    expect(serializeKtxProjectConfig(config)).toContain('validationBudget: 0');
  });

  it('parses the scan relationship validation budget sentinel', () => {
    const config = parseKtxProjectConfig(`
project: demo
scan:
  relationships:
    validation_budget: all
`);

    expect(config.scan.relationships.validationBudget).toBe('all');
    expect(serializeKtxProjectConfig(config)).toContain('validationBudget: all');
  });

  it('falls back to safe scan relationship defaults for invalid numeric settings', () => {
    const config = parseKtxProjectConfig(`
project: demo
scan:
  relationships:
    accept_threshold: 2
    review_threshold: -1
    max_llm_tables_per_batch: 0
    max_candidates_per_column: -4
    profile_sample_rows: 0
    validation_concurrency: 0
    validation_budget: 1.5
`);

    expect(config.scan.relationships).toMatchObject({
      acceptThreshold: 0.85,
      reviewThreshold: 0.55,
      maxLlmTablesPerBatch: 40,
      maxCandidatesPerColumn: 25,
      profileSampleRows: 10000,
      validationConcurrency: 4,
    });
    expect(config.scan.relationships).not.toHaveProperty('validationBudget');
  });

  it('falls back for invalid scan relationship validation budget strings', () => {
    const config = parseKtxProjectConfig(`
project: demo
scan:
  relationships:
    validation_budget: infinite
`);

    expect(config.scan.relationships).not.toHaveProperty('validationBudget');
  });

  it('rejects legacy local LLM and embedding fields', () => {
    expect(() =>
      parseKtxProjectConfig(`
project: demo
ingest:
  llm:
    backend: anthropic
`),
    ).toThrow('Unsupported ingest.llm: use top-level llm.provider, llm.models, and ingest.workUnits');

    expect(() =>
      parseKtxProjectConfig(`
project: demo
scan:
  enrichment:
    backend: gateway
`),
    ).toThrow('Unsupported scan.enrichment.backend: use scan.enrichment.mode');

    expect(() =>
      parseKtxProjectConfig(`
project: demo
scan:
  enrichment:
    mode: llm
    llm:
      backend: gateway
`),
    ).toThrow('Unsupported scan.enrichment.llm: use top-level llm.provider and llm.models');

    expect(() =>
      parseKtxProjectConfig(`
project: demo
ingest:
  embeddings:
    provider: gateway
    max_batch_size: 32
`),
    ).toThrow('Unsupported ingest.embeddings.provider');
  });

  it('rejects gateway embedding configs', () => {
    expect(() =>
      parseKtxProjectConfig(`
project: demo
ingest:
  embeddings:
    backend: gateway
    model: provider/text-embedding
    dimensions: 1536
`),
    ).toThrow('Unsupported ingest.embeddings.backend: gateway');

    expect(() =>
      parseKtxProjectConfig(`
project: demo
scan:
  enrichment:
    mode: llm
    embeddings:
      backend: gateway
      model: provider/text-embedding
      dimensions: 1536
`),
    ).toThrow('Unsupported scan.enrichment.embeddings.backend: gateway');
  });

  it('fills optional sections when a minimal config is loaded', () => {
    const config = parseKtxProjectConfig('project: local\n');

    expect(config).toEqual(buildDefaultKtxProjectConfig('local'));
    expect(config.ingest.embeddings).toEqual({
      backend: 'deterministic',
      model: 'deterministic',
      dimensions: 8,
    });
  });

  it('rejects configs without an object root', () => {
    expect(() => parseKtxProjectConfig('- nope\n')).toThrow('ktx.yaml must contain a YAML object');
  });

  it('rejects configs with a missing project name', () => {
    expect(() => parseKtxProjectConfig('connections: {}\n')).toThrow('ktx.yaml field "project" is required');
  });
});
