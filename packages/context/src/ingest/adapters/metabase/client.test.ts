import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_METABASE_CLIENT_CONFIG,
  DefaultMetabaseConnectionClientFactory,
  getDummyValueForWidgetType,
  MetabaseClient,
  stripOptionalClauses,
} from './client.js';
import type { MetabaseCard, MetabaseTemplateTag } from './client-port.js';

const runtime = {
  apiUrl: 'https://metabase.example.test/api',
  apiKey: 'test-key-1234', // pragma: allowlist secret
};

const fastRetryConfig = {
  maxRetries: 2,
  baseDelayMs: 1,
  maxDelayMs: 1,
  timeoutMs: 5000,
  jitter: false,
  retryableStatuses: [429, 500, 502, 503, 504],
};

function nativeCard(query: string, templateTags: Record<string, MetabaseTemplateTag> = {}): MetabaseCard {
  return {
    id: 1,
    name: 'Native card',
    type: 'model',
    query_type: 'native',
    database_id: 6,
    dataset_query: {
      type: 'native',
      database: 6,
      stages: [{ 'lib/type': 'mbql.stage/native', native: query, 'template-tags': templateTags }],
    },
  };
}

function legacyNativeCard(query: string, templateTags: Record<string, MetabaseTemplateTag> = {}): MetabaseCard {
  return {
    id: 1,
    name: 'Legacy native card',
    type: 'model',
    query_type: 'native',
    database_id: 6,
    dataset_query: {
      type: 'native',
      database: 6,
      native: { query, 'template-tags': templateTags },
    },
  };
}

describe('DefaultMetabaseConnectionClientFactory', () => {
  it('resolves runtime credentials by the explicit Metabase source connection id and merges overrides', async () => {
    const resolveCredentials = vi.fn().mockResolvedValue(runtime);
    const factory = new DefaultMetabaseConnectionClientFactory(resolveCredentials, {
      ...DEFAULT_METABASE_CLIENT_CONFIG,
      timeoutMs: 60000,
      maxRetries: 4,
    });

    const client = await factory.createClient('metabase-source-1', { timeoutMs: 1000 });

    expect(resolveCredentials).toHaveBeenCalledWith('metabase-source-1');
    expect(client).toBeInstanceOf(MetabaseClient);
    expect(Reflect.get(client, 'baseUrl')).toBe('https://metabase.example.test/api');
    expect(Reflect.get(client, 'runtime').apiKey).toBe('test-key-1234');
    expect(Reflect.get(client, 'config').timeoutMs).toBe(1000);
    expect(Reflect.get(client, 'config').maxRetries).toBe(4);
  });
});

describe('MetabaseClient retry exhaustion', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('does not warn to console when retrying by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const client = new MetabaseClient(
      { apiUrl: 'https://metabase.example.test', apiKey: 'key' }, // pragma: allowlist secret
      {
        ...DEFAULT_METABASE_CLIENT_CONFIG,
        baseDelayMs: 0,
        maxRetries: 1,
      },
    );

    await client.getDatabases();

    expect(warn).not.toHaveBeenCalled();
  });

  it('wraps an exhausted ECONNRESET retry chain with method, path, attempt count, and original cause', async () => {
    const sysErr = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
      errno: -104,
      syscall: 'read',
    });
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(sysErr);
    globalThis.fetch = fetchMock;

    const client = new MetabaseClient(runtime, fastRetryConfig);

    let caught: unknown;
    try {
      await client.getDatabases();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const e = caught as Error & { cause?: unknown; code?: string };
    expect(e.message).toContain('Metabase request failed (3 attempts)');
    expect(e.message).toContain('GET /api/database/');
    expect(e.message).toContain('ECONNRESET');
    expect(e.cause).toBe(sysErr);
    expect(e.code).toBe('ECONNRESET');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('classifies undici mid-TLS-handshake error as TLS-handshake failure', async () => {
    const undiciTlsErr = new Error('Client network socket disconnected before secure TLS connection was established');
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(undiciTlsErr);
    globalThis.fetch = fetchMock;

    const client = new MetabaseClient(runtime, { ...fastRetryConfig, maxRetries: 0 });

    let caught: unknown;
    try {
      await client.getDatabases();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const e = caught as Error & { cause?: unknown };
    expect(e.message).toMatch(/^Metabase request failed:/);
    expect(e.message).not.toContain('attempts');
    expect(e.message).toContain('TLS handshake to metabase.example.test did not complete');
    expect(e.message).toContain('before secure TLS connection was established');
    expect(e.cause).toBeInstanceOf(Error);
    expect(((e.cause as Error & { cause?: unknown }).cause as Error)?.message).toContain(
      'before secure TLS connection was established',
    );
  });

  it('does not wrap when a non-retryable error short-circuits the loop', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{"message":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } }),
      );
    globalThis.fetch = fetchMock;

    const client = new MetabaseClient(runtime, fastRetryConfig);

    let caught: unknown;
    try {
      await client.getDatabases();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const e = caught as Error;
    expect(e.message).not.toContain('after 3 attempts');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('MetabaseClient admin auth helpers', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('creates a session without sending an auth header', async () => {
    const sessionFixture = 'session-fixture';
    const adminCredentialFixture = 'admin-fixture';
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: sessionFixture }), { status: 200 }));
    globalThis.fetch = fetchMock;

    const client = new MetabaseClient({ apiUrl: 'https://metabase.example.test', apiKey: '' }, fastRetryConfig);

    await expect(client.createSession('admin@example.test', adminCredentialFixture)).resolves.toBe(sessionFixture);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://metabase.example.test/api/session',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin@example.test', password: adminCredentialFixture }),
      }),
    );
  });

  it('uses the configured auth header for permission groups and API-key creation', async () => {
    const mintedMetabaseCredential = 'mb_generated';
    const sessionFixture = 'session-fixture';
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2, name: 'Administrators' }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ unmasked_key: mintedMetabaseCredential }), { status: 200 }));
    globalThis.fetch = fetchMock;

    const client = new MetabaseClient(
      { apiUrl: 'https://metabase.example.test', apiKey: sessionFixture, authHeaderName: 'X-Metabase-Session' },
      fastRetryConfig,
    );

    await expect(client.getPermissionGroups()).resolves.toEqual([{ id: 2, name: 'Administrators' }]);
    await expect(client.createApiKey({ name: 'KTX CLI test', groupId: 2 })).resolves.toBe(mintedMetabaseCredential);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://metabase.example.test/api/permissions/group',
      expect.objectContaining({
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Metabase-Session': sessionFixture },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://metabase.example.test/api/api-key',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'KTX CLI test', group_id: 2 }),
      }),
    );
  });
});

describe('stripOptionalClauses', () => {
  it('drops optional blocks that contain Metabase template variables', () => {
    const input = 'SELECT * FROM x WHERE 1=1 [[AND a = {{ a }} ]] [[AND b = {{ b }} ]]';
    expect(stripOptionalClauses(input)).toBe('SELECT * FROM x WHERE 1=1  ');
  });

  it('preserves bracket sequences that contain no template variables', () => {
    const input = "SELECT * FROM x WHERE col LIKE '[[abc]]'";
    expect(stripOptionalClauses(input)).toBe(input);
  });

  it('leaves naked template variables intact', () => {
    const input = 'SELECT * FROM x WHERE id = {{ id }}';
    expect(stripOptionalClauses(input)).toBe(input);
  });
});

describe('getDummyValueForWidgetType', () => {
  it('returns widget-specific date and number values', () => {
    expect(getDummyValueForWidgetType('date/range')).toBe('2020-01-01~2020-12-31');
    expect(getDummyValueForWidgetType('date/all-options')).toBe('2020-01-01~2020-12-31');
    expect(getDummyValueForWidgetType('date/single')).toBe('2020-01-01');
    expect(getDummyValueForWidgetType('date/relative')).toBe('past30days');
    expect(getDummyValueForWidgetType('date/month-year')).toBe('2020-01');
    expect(getDummyValueForWidgetType('date/quarter-year')).toBe('Q1-2020');
    expect(getDummyValueForWidgetType('number/=')).toBe('1');
    expect(getDummyValueForWidgetType('number/between')).toBe('1');
  });

  it('falls back to an array placeholder for string, identifier, and unknown widgets', () => {
    expect(getDummyValueForWidgetType('string/=')).toEqual(['placeholder']);
    expect(getDummyValueForWidgetType('category')).toEqual(['placeholder']);
    expect(getDummyValueForWidgetType(undefined)).toEqual(['placeholder']);
  });
});

describe('MetabaseClient legacy native dataset query support', () => {
  it('reads SQL and template tags from dataset_query.native', async () => {
    const client = new MetabaseClient(runtime, fastRetryConfig);
    const card = legacyNativeCard('SELECT * FROM orders WHERE status = {{ status }}', {
      status: {
        name: 'status',
        type: 'text',
        default: 'paid',
      },
    });

    expect(client.getNativeSql(card)).toBe('SELECT * FROM orders WHERE status = {{ status }}');
    expect(client.getTemplateTags(card)).toEqual({
      status: expect.objectContaining({ name: 'status', type: 'text' }),
    });
    await expect(client.getCardSql(card)).resolves.toBe('SELECT * FROM orders WHERE status = {{ status }}');
  });
});

describe('MetabaseClient.getResolvedSql', () => {
  function makeClient(setup?: (client: MetabaseClient) => void): MetabaseClient {
    const client = new MetabaseClient({ apiUrl: 'http://test', apiKey: 'k' });
    setup?.(client);
    return client;
  }

  it('strips optional clauses locally and skips /api/dataset/native when no naked variables remain', async () => {
    const requestSpy = vi.fn();
    const client = makeClient((client) => {
      Reflect.set(client, 'requestWithCustomRetry', requestSpy);
    });
    const card = nativeCard('SELECT * FROM x WHERE 1=1 [[AND end > {{ auction_end }} ]]', {
      auction_end: {
        id: 'tag-1',
        name: 'auction_end',
        type: 'dimension',
        'widget-type': 'date/all-options',
        'display-name': 'Auction End',
      },
    });

    const result = await client.getResolvedSql(card);

    expect(requestSpy).not.toHaveBeenCalled();
    expect(result?.resolutionStatus).toBe('resolved');
    expect(result?.resolvedSql).toBe('SELECT * FROM x WHERE 1=1 ');
    expect(result?.templateTags[0]).toMatchObject({ name: 'auction_end', type: 'dimension' });
  });

  it('inlines saved-question references locally and skips /api/dataset/native when no other variables remain', async () => {
    const requestSpy = vi.fn();
    const getCardSpy = vi.fn().mockResolvedValue({
      id: 5996,
      name: 'Base card',
      type: 'model',
      query_type: 'native',
      database_id: 6,
      dataset_query: {
        type: 'native',
        database: 6,
        stages: [{ 'lib/type': 'mbql.stage/native', native: 'SELECT a, b FROM base' }],
      },
    });
    const client = makeClient((client) => {
      Reflect.set(client, 'requestWithCustomRetry', requestSpy);
      Reflect.set(client, 'getCard', getCardSpy);
    });
    const card = nativeCard('SELECT * FROM {{#5996-base}} t [[WHERE end > {{ end }}]]', {
      '#5996-base': {
        id: 't1',
        name: '#5996-base',
        type: 'card',
        'card-id': 5996,
      },
      end: {
        id: 't2',
        name: 'end',
        type: 'dimension',
        'widget-type': 'date/range',
      },
    });

    const result = await client.getResolvedSql(card);

    expect(requestSpy).not.toHaveBeenCalled();
    expect(getCardSpy).toHaveBeenCalledWith(5996);
    expect(result?.resolutionStatus).toBe('resolved');
    expect(result?.resolvedSql).toBe('SELECT * FROM (SELECT a, b FROM base) t ');
  });

  it('inlines native-query snippets before checking for remaining variables', async () => {
    const requestSpy = vi.fn().mockResolvedValue([
      {
        id: 1,
        name: 'account_join',
        content: 'LEFT JOIN accounts a ON a.account_id = mart.account_id',
      },
    ]);
    const requestWithCustomRetrySpy = vi.fn();
    const client = makeClient((client) => {
      Reflect.set(client, 'request', requestSpy);
      Reflect.set(client, 'requestWithCustomRetry', requestWithCustomRetrySpy);
    });
    const card = nativeCard('SELECT a.account_name FROM mart {{snippet: account_join}}', {
      'snippet: account_join': {
        id: 'snippet-tag',
        name: 'snippet: account_join',
        type: 'snippet',
        'snippet-name': 'account_join',
        'snippet-id': 1,
      },
    });

    const result = await client.getResolvedSql(card);

    expect(requestSpy).toHaveBeenCalledWith('GET', '/api/native-query-snippet');
    expect(requestWithCustomRetrySpy).not.toHaveBeenCalled();
    expect(result?.resolutionStatus).toBe('resolved');
    expect(result?.resolvedSql).toBe(
      'SELECT a.account_name FROM mart LEFT JOIN accounts a ON a.account_id = mart.account_id',
    );
    expect(result?.resolvedSql).not.toContain('{{snippet:');
  });

  it('uses /api/dataset/native for naked variables and prepends a warning comment', async () => {
    const requestSpy = vi.fn().mockResolvedValue({ query: "SELECT * WHERE id = 'placeholder' AND n = 1" });
    const client = makeClient((client) => {
      Reflect.set(client, 'requestWithCustomRetry', requestSpy);
    });
    const card = nativeCard('SELECT * WHERE id = {{ id }} AND n = {{ n }}', {
      id: { id: 't1', name: 'id', type: 'text' },
      n: { id: 't2', name: 'n', type: 'number' },
    });

    const result = await client.getResolvedSql(card);

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(result?.resolutionStatus).toBe('resolved');
    const sql = result?.resolvedSql ?? '';
    expect(sql.startsWith('--')).toBe(true);
    expect(sql).toMatch(/KTX_PLACEHOLDER_WARNING/);
    expect(sql).toMatch(/\bid\b/);
    expect(sql).toMatch(/\bn\b/);
  });

  it('falls back to raw native SQL with truthful template tags when /api/dataset/native errors', async () => {
    const requestSpy = vi.fn().mockRejectedValue(new Error('Metabase 500'));
    const client = makeClient((client) => {
      Reflect.set(client, 'requestWithCustomRetry', requestSpy);
    });
    const card = nativeCard('SELECT * FROM x WHERE end > {{ auction_end }}', {
      auction_end: {
        id: 'tag-id',
        name: 'auction_end',
        type: 'dimension',
        'widget-type': 'date/range',
        'display-name': 'Auction End',
      },
    });

    const result = await client.getResolvedSql(card);

    expect(result?.resolutionStatus).toBe('fallback');
    expect(result?.resolvedSql).toContain('{{ auction_end }}');
    expect(result?.templateTags).toHaveLength(1);
    expect(result?.templateTags[0]).toMatchObject({
      name: 'auction_end',
      type: 'dimension',
      displayName: 'Auction End',
    });
  });
});
