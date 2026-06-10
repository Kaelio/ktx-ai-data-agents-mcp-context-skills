import { describe, expect, it } from 'vitest';
import {
  buildDefaultKtxProjectConfig,
  generateKtxProjectConfigJsonSchema,
  parseKtxProjectConfig,
  serializeKtxProjectConfig,
  validateKtxProjectConfig,
} from '../../../src/context/project/config.js';

describe('ktx project config', () => {
  it.each(['status', 'replay', 'run', 'watch'])('accepts former ingest subcommand name "%s" as a connection id', (connectionId) => {
    expect(
      parseKtxProjectConfig(`
connections:
  ${connectionId}:
    driver: postgres
`),
    ).toMatchObject({
      connections: {
        [connectionId]: { driver: 'postgres' },
      },
    });
  });

  it('builds the default standalone project config', () => {
    expect(buildDefaultKtxProjectConfig()).toEqual({
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
        adapters: [],
        embeddings: {
          backend: 'none',
          dimensions: 8,
        },
        workUnits: {
          stepBudget: 40,
          maxConcurrency: 1,
          failureMode: 'continue',
        },
        rateLimit: {
          enabled: true,
          throttleThreshold: 0.8,
          minConcurrencyUnderPressure: 1,
          retry: {
            maxAttempts: 6,
            baseDelayMs: 1_000,
            maxDelayMs: 60_000,
            jitter: true,
          },
        },
        profile: false,
      },
      agent: {
        run_research: {
          enabled: false,
          max_iterations: 20,
          default_toolset: ['sl_query', 'wiki_search', 'sl_read_source'],
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
          profileConcurrency: 4,
          validationConcurrency: 4,
        },
      },
    });
  });

  it('round-trips through YAML with stable defaults', () => {
    const serialized = serializeKtxProjectConfig(buildDefaultKtxProjectConfig());
    const parsed = parseKtxProjectConfig(serialized);

    expect(serialized).not.toContain('project:');
    expect(serialized).not.toContain('live-database');
    expect(serialized).toContain('  embeddings:\n    backend: none\n    dimensions: 8');
    expect(parsed.ingest.adapters).toEqual([]);
    expect(parsed.ingest.embeddings).toEqual({
      backend: 'none',
      dimensions: 8,
    });
  });

  it('parses and serializes setup warehouse metadata without setup progress', () => {
    const config = parseKtxProjectConfig(`
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

  it('parses the ingest.profile flag (false default, true, or "json")', () => {
    expect(parseKtxProjectConfig('ingest:\n  adapters: []\n').ingest.profile).toBe(false);
    expect(parseKtxProjectConfig('ingest:\n  profile: true\n').ingest.profile).toBe(true);
    expect(parseKtxProjectConfig('ingest:\n  profile: json\n').ingest.profile).toBe('json');
  });

  it('defaults ingest rate-limit settings', () => {
    const config = buildDefaultKtxProjectConfig();
    expect(config.ingest.rateLimit).toEqual({
      enabled: true,
      throttleThreshold: 0.8,
      minConcurrencyUnderPressure: 1,
      retry: {
        maxAttempts: 6,
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        jitter: true,
      },
    });
  });

  it('validates ingest rate-limit retry settings', () => {
    const config = parseKtxProjectConfig(`
llm:
  provider:
    backend: none
ingest:
  rateLimit:
    enabled: true
    throttleThreshold: 0.7
    minConcurrencyUnderPressure: 2
    maxWaitMs: 300000
    retry:
      maxAttempts: 4
      baseDelayMs: 500
      maxDelayMs: 30000
      jitter: false
`);
    expect(config.ingest.rateLimit).toEqual({
      enabled: true,
      throttleThreshold: 0.7,
      minConcurrencyUnderPressure: 2,
      maxWaitMs: 300_000,
      retry: {
        maxAttempts: 4,
        baseDelayMs: 500,
        maxDelayMs: 30_000,
        jitter: false,
      },
    });
  });

  it('parses global Vertex LLM config', () => {
    const config = parseKtxProjectConfig(`
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

  it('requires a non-empty Vertex location when the Vertex provider block is present', () => {
    const yaml = `
llm:
  provider:
    backend: vertex
    vertex:
      project: local-gcp-project
`;

    expect(() => parseKtxProjectConfig(yaml)).toThrow(/llm\.provider\.vertex\.location/);

    const validation = validateKtxProjectConfig(yaml);
    expect(validation.ok).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'llm.provider.vertex.location',
        }),
      ]),
    );
  });

  it('parses Claude Code as a first-class LLM backend', () => {
    const config = parseKtxProjectConfig(`
llm:
  provider:
    backend: claude-code
  models:
    default: sonnet
    triage: haiku
    candidateExtraction: sonnet
    curator: sonnet
    reconcile: sonnet
    repair: opus
`);

    expect(config.llm.provider.backend).toBe('claude-code');
    expect(config.llm.models).toEqual({
      default: 'sonnet',
      triage: 'haiku',
      candidateExtraction: 'sonnet',
      curator: 'sonnet',
      reconcile: 'sonnet',
      repair: 'opus',
    });
  });

  it('parses Codex as a first-class LLM backend', () => {
    const config = parseKtxProjectConfig(`
llm:
  provider:
    backend: codex
  models:
    default: gpt-5.3-codex
    triage: gpt-5.3-codex
    candidateExtraction: gpt-5.3-codex
    curator: gpt-5.3-codex
    reconcile: gpt-5.3-codex
    repair: gpt-5.3-codex
`);

    expect(config.llm.provider.backend).toBe('codex');
    expect(config.llm.models).toEqual({
      default: 'gpt-5.3-codex',
      triage: 'gpt-5.3-codex',
      candidateExtraction: 'gpt-5.3-codex',
      curator: 'gpt-5.3-codex',
      reconcile: 'gpt-5.3-codex',
      repair: 'gpt-5.3-codex',
    });
  });

  it('parses gateway LLM, OpenAI scan embeddings, and sentence-transformers ingest embeddings', () => {
    const config = parseKtxProjectConfig(`
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
scan:
  relationships:
    enabled: false
    llmProposals: false
    validationRequiredForManifest: true
    acceptThreshold: 0.91
    reviewThreshold: 0.61
    maxLlmTablesPerBatch: 12
    maxCandidatesPerColumn: 7
    profileSampleRows: 500
    profileConcurrency: 3
    validationConcurrency: 2
    validationBudget: 0
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
      profileConcurrency: 3,
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
    expect(serializeKtxProjectConfig(config)).toContain('profileConcurrency: 3');
    expect(serializeKtxProjectConfig(config)).toContain('validationConcurrency: 2');
    expect(serializeKtxProjectConfig(config)).toContain('validationBudget: 0');
  });

  it('parses the scan relationship validation budget sentinel', () => {
    const config = parseKtxProjectConfig(`
scan:
  relationships:
    validationBudget: all
`);

    expect(config.scan.relationships.validationBudget).toBe('all');
    expect(serializeKtxProjectConfig(config)).toContain('validationBudget: all');
  });

  it('rejects out-of-range scan relationship numeric settings', () => {
    const yaml = `
scan:
  relationships:
    acceptThreshold: 2
    reviewThreshold: -1
    maxLlmTablesPerBatch: 0
    maxCandidatesPerColumn: -4
    profileSampleRows: 0
    profileConcurrency: 0
    validationConcurrency: 0
    validationBudget: 1.5
`;
    expect(() => parseKtxProjectConfig(yaml)).toThrow(/scan\.relationships\.acceptThreshold/);

    const validation = validateKtxProjectConfig(yaml);
    expect(validation.ok).toBe(false);
    const paths = validation.issues.map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'scan.relationships.acceptThreshold',
        'scan.relationships.reviewThreshold',
        'scan.relationships.maxLlmTablesPerBatch',
        'scan.relationships.maxCandidatesPerColumn',
        'scan.relationships.profileSampleRows',
        'scan.relationships.profileConcurrency',
        'scan.relationships.validationConcurrency',
        'scan.relationships.validationBudget',
      ]),
    );
  });

  it('rejects invalid scan relationship validation budget strings', () => {
    const yaml = `
scan:
  relationships:
    validationBudget: infinite
`;
    expect(() => parseKtxProjectConfig(yaml)).toThrow(/scan\.relationships\.validationBudget/);
  });

  it('rejects unsupported local LLM and embedding fields', () => {
    expect(() =>
      parseKtxProjectConfig(`
ingest:
  llm:
    backend: anthropic
`),
    ).toThrow('Unsupported ingest.llm: unknown field');

    expect(() =>
      parseKtxProjectConfig(`
scan:
  enrichment:
    backend: gateway
`),
    ).toThrow('Unsupported scan.enrichment.backend: unknown field');

    expect(() =>
      parseKtxProjectConfig(`
scan:
  enrichment:
    mode: llm
    llm:
      backend: gateway
`),
    ).toThrow('Unsupported scan.enrichment.llm: unknown field');

    expect(() =>
      parseKtxProjectConfig(`
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
ingest:
  embeddings:
    backend: gateway
    model: provider/text-embedding
    dimensions: 1536
`),
    ).toThrow('Unsupported ingest.embeddings.backend: gateway');

    expect(() =>
      parseKtxProjectConfig(`
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
    const config = parseKtxProjectConfig('{}\n');

    expect(config).toEqual(buildDefaultKtxProjectConfig());
    expect(config.ingest.embeddings).toEqual({
      backend: 'none',
      dimensions: 8,
    });
  });

  it('rejects configs without an object root', () => {
    expect(() => parseKtxProjectConfig('- nope\n')).toThrow('ktx.yaml must contain a YAML object');
  });

  it('accepts configs without a project name', () => {
    expect(parseKtxProjectConfig('connections: {}\n')).toMatchObject({
      connections: {},
    });
  });

  it('rejects unknown top-level fields under strict mode', () => {
    expect(() =>
      parseKtxProjectConfig(`
storrage:
  state: sqlite
`),
    ).toThrow(/Unsupported storrage/);
  });
});

describe('validateKtxProjectConfig', () => {
  it('returns ok: true with no issues for a valid config', () => {
    const result = validateKtxProjectConfig('connections: {}\n');
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it('collects every schema issue without throwing', () => {
    const result = validateKtxProjectConfig(`
storage:
  search: not-a-real-backend
scan:
  relationships:
    acceptThreshold: 1.7
`);

    expect(result.ok).toBe(false);
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'storage.search',
        'scan.relationships.acceptThreshold',
      ]),
    );
  });

  it('reports YAML parse errors as a root-level issue', () => {
    const result = validateKtxProjectConfig(': not valid yaml :\n');
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.path).toBe('');
    expect(result.issues[0]?.message).toMatch(/ktx\.yaml parse error/);
  });

  it('reports a YAML scalar root as a single issue', () => {
    const result = validateKtxProjectConfig('- nope\n');
    expect(result).toEqual({
      ok: false,
      issues: [{ path: '', message: 'ktx.yaml must contain a YAML object' }],
    });
  });
});

describe('generateKtxProjectConfigJsonSchema', () => {
  const schema = generateKtxProjectConfigJsonSchema();

  it('emits draft-07 metadata', () => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.$id).toBe('https://ktx.dev/schemas/ktx-project-config.json');
    expect(schema.title).toBe('ktx.yaml');
    expect(schema.type).toBe('object');
  });

  it('exposes every top-level ktx.yaml section under properties', () => {
    const properties = schema.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(['agent', 'connections', 'ingest', 'llm', 'memory', 'scan', 'setup', 'storage'].sort());
  });

  it('does not require any top-level fields', () => {
    expect(schema.required).toBeUndefined();
  });

  it('carries .describe() text on top-level fields', () => {
    const properties = schema.properties as Record<string, { description?: string }>;
    expect(properties.llm?.description).toMatch(/LLM/);
    expect(properties.scan?.description).toMatch(/Schema-scan/);
  });

  it('propagates enum values through to nested fields', () => {
    const llm = (schema.properties as Record<string, { properties?: Record<string, unknown> }>).llm;
    const provider = llm?.properties?.provider as { properties?: Record<string, unknown> };
    const backend = provider?.properties?.backend as { enum?: readonly string[] };
    expect(backend?.enum).toEqual(['none', 'anthropic', 'vertex', 'gateway', 'claude-code', 'codex']);

    const storage = (schema.properties as Record<string, { properties?: Record<string, unknown> }>).storage;
    const state = storage?.properties?.state as { enum?: readonly string[] };
    expect(state?.enum).toEqual(['sqlite', 'postgres']);
  });

  it('carries descriptions on deeply nested leaves', () => {
    const scan = (schema.properties as Record<string, { properties?: Record<string, unknown> }>).scan;
    const relationships = scan?.properties?.relationships as { properties?: Record<string, { description?: string }> };
    expect(relationships?.properties?.acceptThreshold?.description).toMatch(/auto-accepted/);
  });

  it('emits the mappings shapes under connections', () => {
    const serialized = JSON.stringify(schema);
    expect(serialized).toContain('databaseMappings');
    expect(serialized).toContain('connectionMappings');
    expect(serialized).toContain('expectedLookerConnectionName');
  });
});
