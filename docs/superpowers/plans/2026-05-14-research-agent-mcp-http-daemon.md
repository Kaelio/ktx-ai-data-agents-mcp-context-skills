# Research Agent MCP HTTP Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the HTTP-only `ktx mcp start|stop|status|logs` daemon so external MCP clients can reach the already implemented KTX research tools.

**Architecture:** Keep the MCP tool contracts in `@ktx/context` and add CLI-owned HTTP hosting/lifecycle code. The public `ktx mcp start` command either runs a foreground HTTP server or spawns a hidden foreground child command, persists daemon state to `.ktx/mcp.json`, and writes logs to `.ktx/logs/mcp.log`; the HTTP server uses stateful `StreamableHTTPServerTransport` sessions with explicit host/origin/token checks.

**Tech Stack:** TypeScript, Node 22 `node:http`, Commander, `@modelcontextprotocol/sdk@1.29.0`, Zod, Vitest, KTX managed Python daemon helpers.

---

## Audit Summary

Original spec: `docs/superpowers/specs/2026-05-14-research-agent-mcp-tools-design.md`

Implemented v1 slices confirmed in current source:

- MCP `sql_execution` is implemented and parser-gated: `python/ktx-daemon/src/ktx_daemon/sql_analysis.py` validates SQL with sqlglot, `python/ktx-daemon/src/ktx_daemon/app.py` exposes `/sql/validate-read-only`, `packages/context/src/mcp/context-tools.ts` registers `sql_execution`, and `packages/context/src/mcp/local-project-ports.ts` only exposes it when both SQL analysis and local scan connector creation are available.
- MCP `entity_details` is implemented: `packages/context/src/scan/entity-details.ts`, `KtxEntityDetailsMcpPort`, context-tool registration, and local project wiring all exist.
- MCP `dictionary_search` is implemented: `packages/context/src/sl/dictionary-search.ts`, `KtxDictionarySearchMcpPort`, context-tool registration, and local project wiring all exist.
- MCP `discover_data` is implemented: `packages/context/src/search/discover.ts`, `KtxDiscoverDataMcpPort`, context-tool registration, and local project wiring all exist.

Remaining v1-blocking gaps:

- `ktx mcp start|stop|status|logs` and the HTTP Streamable MCP daemon are missing. There is no `packages/cli/src/commands/mcp-commands.ts`, no `packages/cli/src/managed-mcp-daemon.ts`, and `packages/cli/src/cli-program.ts` does not register an `mcp` subtree.
- `ktx setup-agents` does not install MCP client config entries or the `ktx-research` skill. `plannedKtxAgentFiles()` still installs only the existing `ktx` skill/rules.
- Ingest-side warehouse verification tools still use `connectionName`, not the spec-required `connectionId`, and `WarehouseCatalogService` still exposes `connectionName` in its service contract.

Non-blocking gaps:

- TLS, audit logging, rate limiting, per-tool authorization, OS-level autostart, stdio MCP transport, and multi-project switching remain explicitly out of scope for v1.

This plan covers only the next dependency-aware blocker: the HTTP Streamable MCP daemon and `ktx mcp` lifecycle command subtree. After this plan lands, the remaining v1 plans are setup-agent/research-skill installation and ingest warehouse-verification contract convergence.

## Documentation Notes

- Context7 was checked for current MCP TypeScript SDK Streamable HTTP examples.
- The local `@modelcontextprotocol/sdk@1.29.0` package metadata was checked with `pnpm view`; its exported import path supports `@modelcontextprotocol/sdk/server/streamableHttp.js`.
- The 1.29.0 tarball types show `StreamableHTTPServerTransport` accepts `sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed`, `allowedHosts`, `allowedOrigins`, and `enableDnsRebindingProtection`, and exposes `handleRequest(req, res, parsedBody?)`.

## File Structure

- Create `packages/cli/src/mcp-http-server.ts`
  - Owns the foreground HTTP server.
  - Validates Host, Origin, and bearer token policy before handing requests to the MCP SDK transport.
  - Hosts `/health` and stateful `/mcp` `POST`/`GET`/`DELETE`.
  - Builds a fresh `McpServer` per session with `createDefaultKtxMcpServer()`.
- Create `packages/cli/src/mcp-http-server.test.ts`
  - Unit tests for host normalization, origin validation, token enforcement, `/health`, initialize session creation, unknown-session rejection, and DELETE cleanup.
- Create `packages/cli/src/managed-mcp-daemon.ts`
  - Owns `.ktx/mcp.json`, `.ktx/logs/mcp.log`, background spawning, status probes, stop, and log reading.
- Create `packages/cli/src/managed-mcp-daemon.test.ts`
  - Unit tests for state paths, start spawn arguments, token redaction from state/argv, status, stale state, stop, and log tailing.
- Create `packages/cli/src/commands/mcp-commands.ts`
  - Registers public `start|stop|status|logs` and hidden `serve-internal`.
- Create `packages/cli/src/commands/mcp-commands.test.ts`
  - Command-level tests for option parsing, non-loopback token requirement, state output, and hidden server command wiring.
- Modify `packages/cli/src/cli-program.ts`
  - Add `mcp` to project-aware root commands.
  - Register the MCP command subtree.
- Modify `packages/cli/package.json`
  - Add `@modelcontextprotocol/sdk` as a direct dependency of `@ktx/cli`, because the CLI package will import the Streamable HTTP transport directly.

## Task 1: Add MCP HTTP Security Helper Tests

**Files:**
- Create: `packages/cli/src/mcp-http-server.test.ts`
- Create later: `packages/cli/src/mcp-http-server.ts`

- [ ] **Step 1: Write the failing security helper tests**

Create `packages/cli/src/mcp-http-server.test.ts` with:

```typescript
import { describe, expect, it } from 'vitest';
import {
  buildMcpSecurityConfig,
  isMcpRequestAuthorized,
  normalizeHostHeader,
} from './mcp-http-server.js';

describe('normalizeHostHeader', () => {
  it('normalizes host headers before allow-list comparison', () => {
    expect(normalizeHostHeader('LOCALHOST:7878')).toBe('localhost');
    expect(normalizeHostHeader('127.0.0.1:7878')).toBe('127.0.0.1');
    expect(normalizeHostHeader('[::1]:7878')).toBe('::1');
    expect(normalizeHostHeader('  Example.COM  ')).toBe('example.com');
  });
});

describe('buildMcpSecurityConfig', () => {
  it('allows loopback hosts without a token', () => {
    const config = buildMcpSecurityConfig({
      host: '127.0.0.1',
      port: 7878,
      token: undefined,
      allowedHosts: [],
      allowedOrigins: [],
    });

    expect(config.token).toBeUndefined();
    expect(config.allowedHosts).toEqual(['localhost', '127.0.0.1', '::1']);
  });

  it('requires a token for non-loopback binding', () => {
    expect(() =>
      buildMcpSecurityConfig({
        host: '0.0.0.0',
        port: 7878,
        token: undefined,
        allowedHosts: [],
        allowedOrigins: [],
      }),
    ).toThrow('Binding KTX MCP to 0.0.0.0 requires --token or KTX_MCP_TOKEN');
  });

  it('validates allowed origins as full origins', () => {
    expect(() =>
      buildMcpSecurityConfig({
        host: '127.0.0.1',
        port: 7878,
        token: undefined,
        allowedHosts: [],
        allowedOrigins: ['localhost:7878'],
      }),
    ).toThrow('Allowed origin must be a full origin URL');
  });
});

describe('isMcpRequestAuthorized', () => {
  const config = buildMcpSecurityConfig({
    host: '0.0.0.0',
    port: 7878,
    token: 'secret-token',
    allowedHosts: ['mcp.example.test'],
    allowedOrigins: ['https://mcp.example.test'],
  });

  it('accepts a valid host, origin, and bearer token', () => {
    expect(
      isMcpRequestAuthorized(
        {
          path: '/mcp',
          headers: {
            host: 'mcp.example.test:7878',
            origin: 'https://mcp.example.test',
            authorization: 'Bearer secret-token',
          },
        },
        config,
      ),
    ).toEqual({ ok: true });
  });

  it('rejects bad host headers before MCP handling', () => {
    expect(
      isMcpRequestAuthorized(
        { path: '/health', headers: { host: 'evil.example.test' } },
        config,
      ),
    ).toEqual({ ok: false, status: 403, message: 'Host header is not allowed for KTX MCP.' });
  });

  it('rejects browser origins unless explicitly allowed', () => {
    expect(
      isMcpRequestAuthorized(
        {
          path: '/health',
          headers: { host: 'mcp.example.test', origin: 'https://evil.example.test' },
        },
        config,
      ),
    ).toEqual({ ok: false, status: 403, message: 'Origin header is not allowed for KTX MCP.' });
  });

  it('requires bearer auth on /mcp when token auth is enabled', () => {
    expect(
      isMcpRequestAuthorized(
        { path: '/mcp', headers: { host: 'mcp.example.test', authorization: 'Bearer wrong' } },
        config,
      ),
    ).toEqual({ ok: false, status: 401, message: 'Missing or invalid KTX MCP bearer token.' });
  });

  it('does not require bearer auth on /health', () => {
    expect(isMcpRequestAuthorized({ path: '/health', headers: { host: 'mcp.example.test' } }, config)).toEqual({
      ok: true,
    });
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/mcp-http-server.test.ts
```

Expected: FAIL because `./mcp-http-server.js` does not exist.

- [ ] **Step 3: Implement the security helpers**

Create `packages/cli/src/mcp-http-server.ts` with the helper surface first:

```typescript
import type { IncomingHttpHeaders } from 'node:http';

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;

export interface McpSecurityConfigInput {
  host: string;
  port: number;
  token?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
}

export interface McpSecurityConfig {
  host: string;
  port: number;
  token?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
}

export type McpAuthorizationResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; message: string };

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHostHeader(host);
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function normalizeHostHeader(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    return close >= 0 ? trimmed.slice(1, close) : trimmed.replace(/^\[/, '');
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon > -1 && trimmed.indexOf(':') === colon) {
    return trimmed.slice(0, colon);
  }
  return trimmed;
}

function fullOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Allowed origin must be a full origin URL: ${value}`);
  }
  if (!parsed.protocol || !parsed.host || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`Allowed origin must be a full origin URL: ${value}`);
  }
  return parsed.origin;
}

export function buildMcpSecurityConfig(input: McpSecurityConfigInput): McpSecurityConfig {
  if (!isLoopbackHost(input.host) && !input.token) {
    throw new Error(`Binding KTX MCP to ${input.host} requires --token or KTX_MCP_TOKEN`);
  }
  const allowedHostSet = new Set<string>(DEFAULT_ALLOWED_HOSTS);
  if (!isLoopbackHost(input.host)) {
    allowedHostSet.add(normalizeHostHeader(input.host));
  }
  for (const host of input.allowedHosts) {
    allowedHostSet.add(normalizeHostHeader(host));
  }
  return {
    host: input.host,
    port: input.port,
    ...(input.token ? { token: input.token } : {}),
    allowedHosts: [...allowedHostSet],
    allowedOrigins: input.allowedOrigins.map(fullOrigin),
  };
}

function headerValue(headers: IncomingHttpHeaders | Record<string, string | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function isMcpRequestAuthorized(
  request: { path: string; headers: IncomingHttpHeaders | Record<string, string | undefined> },
  config: McpSecurityConfig,
): McpAuthorizationResult {
  const host = headerValue(request.headers, 'host');
  if (!host || !config.allowedHosts.includes(normalizeHostHeader(host))) {
    return { ok: false, status: 403, message: 'Host header is not allowed for KTX MCP.' };
  }
  const origin = headerValue(request.headers, 'origin');
  if (origin && !config.allowedOrigins.includes(origin)) {
    return { ok: false, status: 403, message: 'Origin header is not allowed for KTX MCP.' };
  }
  if (request.path === '/mcp' && config.token) {
    const auth = headerValue(request.headers, 'authorization');
    if (auth !== `Bearer ${config.token}`) {
      return { ok: false, status: 401, message: 'Missing or invalid KTX MCP bearer token.' };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run the security helper tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/mcp-http-server.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/mcp-http-server.ts packages/cli/src/mcp-http-server.test.ts
git commit -m "feat(cli): add mcp http security helpers"
```

## Task 2: Add Foreground MCP HTTP Server

**Files:**
- Modify: `packages/cli/src/mcp-http-server.ts`
- Modify: `packages/cli/src/mcp-http-server.test.ts`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Add the direct SDK dependency to the CLI package**

In `packages/cli/package.json`, add this dependency inside `"dependencies"`:

```json
"@modelcontextprotocol/sdk": "^1.29.0"
```

Keep the dependency list alphabetized by package name.

- [ ] **Step 2: Write failing HTTP server behavior tests**

Append these imports to `packages/cli/src/mcp-http-server.test.ts`:

```typescript
import { request } from 'node:http';
import { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { runKtxMcpHttpServer } from './mcp-http-server.js';
```

Append these helpers and tests:

```typescript
function postJson(port: number, path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            host: `127.0.0.1:${port}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(payload);
    },
  );
}

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'GET',
          headers: { host: `127.0.0.1:${port}`, ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

function createTestMcpServer() {
  return () => {
    const server = new McpServer({ name: 'ktx-test', version: '0.0.0-test' });
    server.registerTool('ping', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));
    return server;
  };
}

describe('runKtxMcpHttpServer', () => {
  it('serves /health with project metadata', async () => {
    const handle = await runKtxMcpHttpServer({
      projectDir: '/tmp/ktx-project',
      host: '127.0.0.1',
      port: 0,
      allowedHosts: [],
      allowedOrigins: [],
      createMcpServer: createTestMcpServer(),
    });
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const response = await get(port, '/health');
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        status: 'ok',
        projectDir: '/tmp/ktx-project',
        port,
      });
    } finally {
      await handle.close();
    }
  });

  it('allocates a stateful MCP session on initialize', async () => {
    const handle = await runKtxMcpHttpServer({
      projectDir: '/tmp/ktx-project',
      host: '127.0.0.1',
      port: 0,
      allowedHosts: [],
      allowedOrigins: [],
      createMcpServer: createTestMcpServer(),
    });
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const response = await postJson(port, '/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '0.0.0' },
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers['mcp-session-id']).toBeTruthy();
    } finally {
      await handle.close();
    }
  });

  it('rejects unknown session ids with 404', async () => {
    const handle = await runKtxMcpHttpServer({
      projectDir: '/tmp/ktx-project',
      host: '127.0.0.1',
      port: 0,
      allowedHosts: [],
      allowedOrigins: [],
      createMcpServer: createTestMcpServer(),
    });
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const response = await postJson(
        port,
        '/mcp',
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { 'mcp-session-id': 'missing-session' },
      );

      expect(response.status).toBe(404);
      expect(response.body).toContain('Unknown MCP session');
    } finally {
      await handle.close();
    }
  });
});
```

- [ ] **Step 3: Run the HTTP server tests to verify the new cases fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/mcp-http-server.test.ts
```

Expected: FAIL because `runKtxMcpHttpServer` is not implemented.

- [ ] **Step 4: Implement the foreground server**

Extend `packages/cli/src/mcp-http-server.ts` with:

```typescript
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createDefaultKtxMcpServer } from '@ktx/context/mcp';
import { createLocalProjectMcpContextPorts } from '@ktx/context/mcp';
import { createLocalProjectMemoryCapture } from '@ktx/context/memory';
import { loadKtxProject, type KtxLocalProject } from '@ktx/context/project';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KtxCliIo } from './cli-runtime.js';
import { createKtxCliIngestQueryExecutor } from './ingest-query-executor.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';
import { createManagedPythonSemanticLayerComputePort } from './managed-python-command.js';
import { createManagedDaemonSqlAnalysisPort } from './managed-python-http.js';

export interface KtxMcpHttpServerHandle {
  server: Server;
  close(): Promise<void>;
}

export interface RunKtxMcpHttpServerOptions extends McpSecurityConfigInput {
  projectDir: string;
  cliVersion?: string;
  io?: KtxCliIo;
  createMcpServer?: () => McpServer;
  loadProject?: typeof loadKtxProject;
}

function writeJson(res: ServerResponse, status: number, body: object): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function writeText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function requestPath(req: IncomingMessage): string {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  return url.pathname;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.trim().length === 0 ? undefined : (JSON.parse(raw) as unknown);
}

async function defaultMcpServerFactory(input: {
  project: KtxLocalProject;
  projectDir: string;
  cliVersion: string;
  io?: KtxCliIo;
}): Promise<() => McpServer> {
  const queryExecutor = createKtxCliIngestQueryExecutor(input.project);
  const semanticLayerCompute = await createManagedPythonSemanticLayerComputePort({
    cliVersion: input.cliVersion,
    installPolicy: 'auto',
    io: input.io ?? {
      stdout: { write() {} },
      stderr: { write() {} },
    },
  });
  const sqlAnalysis = createManagedDaemonSqlAnalysisPort({
    cliVersion: input.cliVersion,
    projectDir: input.projectDir,
    installPolicy: 'auto',
    io: input.io ?? {
      stdout: { write() {} },
      stderr: { write() {} },
    },
  });
  const contextTools = createLocalProjectMcpContextPorts(input.project, {
    semanticLayerCompute,
    queryExecutor,
    sqlAnalysis,
    localScan: {
      createConnector: async (connectionId) => createKtxCliScanConnector(input.project, connectionId),
    },
    localIngest: {
      semanticLayerCompute,
      queryExecutor,
    },
  });
  let memoryCapture;
  try {
    memoryCapture = createLocalProjectMemoryCapture(input.project, { semanticLayerCompute, queryExecutor });
  } catch (error) {
    input.io?.stderr.write(`KTX MCP memory_capture disabled: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  return () =>
    createDefaultKtxMcpServer({
      name: 'ktx',
      version: input.cliVersion,
      userContext: { userId: 'local' },
      contextTools,
      memoryCapture,
    });
}

export async function runKtxMcpHttpServer(options: RunKtxMcpHttpServerOptions): Promise<KtxMcpHttpServerHandle> {
  const config = buildMcpSecurityConfig(options);
  const project =
    options.createMcpServer === undefined
      ? await (options.loadProject ?? loadKtxProject)({ projectDir: options.projectDir })
      : undefined;
  const createMcpServer =
    options.createMcpServer ??
    (await defaultMcpServerFactory({
      project: project!,
      projectDir: options.projectDir,
      cliVersion: options.cliVersion ?? '0.0.0-private',
      io: options.io,
    }));
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  async function newTransport(): Promise<StreamableHTTPServerTransport> {
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, transport);
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
      allowedHosts: config.allowedHosts,
      allowedOrigins: config.allowedOrigins,
      enableDnsRebindingProtection: true,
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };
    await createMcpServer().connect(transport);
    return transport;
  }

  const server = createServer(async (req, res) => {
    const path = requestPath(req);
    const auth = isMcpRequestAuthorized({ path, headers: req.headers }, config);
    if (!auth.ok) {
      writeText(res, auth.status, auth.message);
      return;
    }

    if (path === '/health' && req.method === 'GET') {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      writeJson(res, 200, { status: 'ok', projectDir: options.projectDir, port });
      return;
    }

    if (path !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(req.method ?? '')) {
      writeText(res, 404, 'Not found');
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const normalizedSessionId = Array.isArray(sessionId) ? sessionId[0] : sessionId;

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        writeText(res, 400, `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const existing = normalizedSessionId ? sessions.get(normalizedSessionId) : undefined;
      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }
      if (normalizedSessionId) {
        writeText(res, 404, `Unknown MCP session: ${normalizedSessionId}`);
        return;
      }
      if (!isInitializeRequest(body)) {
        writeText(res, 400, 'MCP initialize request is required before session traffic.');
        return;
      }
      await (await newTransport()).handleRequest(req, res, body);
      return;
    }

    if (!normalizedSessionId || !sessions.has(normalizedSessionId)) {
      writeText(res, 404, normalizedSessionId ? `Unknown MCP session: ${normalizedSessionId}` : 'Missing MCP session id.');
      return;
    }
    await sessions.get(normalizedSessionId)!.handleRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    server,
    async close() {
      for (const transport of sessions.values()) {
        await transport.close();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
```

- [ ] **Step 5: Run the HTTP server tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/mcp-http-server.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/package.json packages/cli/src/mcp-http-server.ts packages/cli/src/mcp-http-server.test.ts
git commit -m "feat(cli): host mcp over streamable http"
```

## Task 3: Add Managed MCP Daemon Lifecycle

**Files:**
- Create: `packages/cli/src/managed-mcp-daemon.ts`
- Create: `packages/cli/src/managed-mcp-daemon.test.ts`

- [ ] **Step 1: Write failing daemon lifecycle tests**

Create `packages/cli/src/managed-mcp-daemon.test.ts` with:

```typescript
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mcpDaemonLayout,
  readKtxMcpDaemonStatus,
  startKtxMcpDaemon,
  stopKtxMcpDaemon,
  type KtxMcpDaemonChild,
  type KtxMcpDaemonState,
} from './managed-mcp-daemon.js';

function child(pid = 4242): KtxMcpDaemonChild {
  return { pid, unref: vi.fn() };
}

function state(projectDir: string, overrides: Partial<KtxMcpDaemonState> = {}): KtxMcpDaemonState {
  return {
    schemaVersion: 1,
    pid: 4242,
    host: '127.0.0.1',
    port: 7878,
    tokenAuth: false,
    projectDir,
    startedAt: '2026-05-14T00:00:00.000Z',
    logPath: join(projectDir, '.ktx/logs/mcp.log'),
    ...overrides,
  };
}

describe('managed MCP daemon lifecycle', () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-mcp-daemon-'));
    projectDir = join(tempDir, 'project');
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('uses the spec state and log paths', () => {
    expect(mcpDaemonLayout(projectDir)).toEqual({
      statePath: join(projectDir, '.ktx/mcp.json'),
      logPath: join(projectDir, '.ktx/logs/mcp.log'),
    });
  });

  it('starts a detached child and writes state without the token value', async () => {
    const spawnDaemon = vi.fn(() => child(5555));
    await startKtxMcpDaemon({
      projectDir,
      cliVersion: '0.0.0-test',
      host: '0.0.0.0',
      port: 7879,
      token: 'secret-token',
      allowedHosts: ['mcp.example.test'],
      allowedOrigins: ['https://mcp.example.test'],
      binPath: '/repo/packages/cli/dist/bin.js',
      spawnDaemon,
      processAlive: vi.fn(() => false),
      portAvailable: vi.fn(async () => true),
      now: () => new Date('2026-05-14T00:00:00.000Z'),
    });

    expect(spawnDaemon).toHaveBeenCalledWith(
      process.execPath,
      [
        '/repo/packages/cli/dist/bin.js',
        '--project-dir',
        projectDir,
        'mcp',
        'serve-internal',
        '--host',
        '0.0.0.0',
        '--port',
        '7879',
        '--allowed-host',
        'mcp.example.test',
        '--allowed-origin',
        'https://mcp.example.test',
      ],
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ KTX_MCP_TOKEN: 'secret-token' }),
      }),
    );
    expect(JSON.stringify(JSON.parse(await readFile(join(projectDir, '.ktx/mcp.json'), 'utf8')))).not.toContain(
      'secret-token',
    );
  });

  it('reports running when the process is alive and health passes', async () => {
    await mkdir(join(projectDir, '.ktx'), { recursive: true });
    await writeFile(join(projectDir, '.ktx/mcp.json'), `${JSON.stringify(state(projectDir), null, 2)}\n`);

    const status = await readKtxMcpDaemonStatus({
      projectDir,
      processAlive: vi.fn(() => true),
      fetchHealth: vi.fn(async () => ({ ok: true, body: { status: 'ok', projectDir, port: 7878 } })),
    });

    expect(status.kind).toBe('running');
    expect(status.url).toBe('http://127.0.0.1:7878/mcp');
  });

  it('stops a recorded daemon and removes state', async () => {
    await mkdir(join(projectDir, '.ktx'), { recursive: true });
    await writeFile(join(projectDir, '.ktx/mcp.json'), `${JSON.stringify(state(projectDir), null, 2)}\n`);
    const alive = new Set([4242]);
    const killProcess = vi.fn((pid: number) => alive.delete(pid));

    await expect(
      stopKtxMcpDaemon({
        projectDir,
        processAlive: vi.fn((pid) => alive.has(pid)),
        killProcess,
        stopGraceMs: 1,
        pollIntervalMs: 1,
      }),
    ).resolves.toEqual({ status: 'stopped' });

    expect(killProcess).toHaveBeenCalledWith(4242, 'SIGTERM');
    await expect(readFile(join(projectDir, '.ktx/mcp.json'), 'utf8')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the lifecycle tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/managed-mcp-daemon.test.ts
```

Expected: FAIL because `./managed-mcp-daemon.js` does not exist.

- [ ] **Step 3: Implement lifecycle state, start, status, and stop**

Create `packages/cli/src/managed-mcp-daemon.ts` with:

```typescript
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

export interface KtxMcpDaemonState {
  schemaVersion: 1;
  pid: number;
  host: string;
  port: number;
  tokenAuth: boolean;
  projectDir: string;
  startedAt: string;
  logPath: string;
}

export interface KtxMcpDaemonChild {
  pid?: number;
  unref(): void;
}

export type KtxMcpDaemonStatus =
  | { kind: 'stopped'; detail: string }
  | { kind: 'running'; detail: string; state: KtxMcpDaemonState; url: string }
  | { kind: 'stale'; detail: string; state?: KtxMcpDaemonState };

const stateSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  tokenAuth: z.boolean(),
  projectDir: z.string().min(1),
  startedAt: z.string().min(1),
  logPath: z.string().min(1),
});

export function mcpDaemonLayout(projectDir: string): { statePath: string; logPath: string } {
  return {
    statePath: join(projectDir, '.ktx/mcp.json'),
    logPath: join(projectDir, '.ktx/logs/mcp.log'),
  };
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKillProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ESRCH') {
      throw error;
    }
  }
}

async function readState(projectDir: string): Promise<KtxMcpDaemonState | undefined> {
  try {
    return stateSchema.parse(JSON.parse(await readFile(mcpDaemonLayout(projectDir).statePath, 'utf8')) as unknown);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function writeState(projectDir: string, state: KtxMcpDaemonState): Promise<void> {
  const { statePath } = mcpDaemonLayout(projectDir);
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function defaultPortAvailable(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function defaultSpawnDaemon(
  command: string,
  args: string[],
  options: { detached: boolean; stdio: ['ignore', number, number]; env: NodeJS.ProcessEnv },
): KtxMcpDaemonChild {
  return spawn(command, args, options);
}

async function defaultFetchHealth(state: KtxMcpDaemonState): Promise<{ ok: boolean; body: unknown; detail?: string }> {
  try {
    const response = await fetch(`http://${state.host}:${state.port}/health`, {
      headers: { host: `${state.host}:${state.port}` },
    });
    const body = await response.json();
    return { ok: response.ok, body, detail: response.ok ? undefined : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, body: null, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function startKtxMcpDaemon(options: {
  projectDir: string;
  cliVersion: string;
  host: string;
  port: number;
  token?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  binPath: string;
  processAlive?: (pid: number) => boolean;
  portAvailable?: (host: string, port: number) => Promise<boolean>;
  spawnDaemon?: typeof defaultSpawnDaemon;
  now?: () => Date;
}): Promise<{ status: 'started'; state: KtxMcpDaemonState; url: string }> {
  const existing = await readState(options.projectDir).catch(() => undefined);
  const processAlive = options.processAlive ?? defaultProcessAlive;
  if (existing && processAlive(existing.pid)) {
    throw new Error(`KTX MCP daemon is already recorded at http://${existing.host}:${existing.port}/mcp`);
  }
  const portAvailable = options.portAvailable ?? defaultPortAvailable;
  if (!(await portAvailable(options.host, options.port))) {
    throw new Error(`Port ${options.port} is already in use. Choose another port with --port <n>.`);
  }

  const { logPath } = mcpDaemonLayout(options.projectDir);
  await mkdir(dirname(logPath), { recursive: true });
  const log = await open(logPath, 'a');
  const args = [
    options.binPath,
    '--project-dir',
    options.projectDir,
    'mcp',
    'serve-internal',
    '--host',
    options.host,
    '--port',
    String(options.port),
    ...options.allowedHosts.flatMap((host) => ['--allowed-host', host]),
    ...options.allowedOrigins.flatMap((origin) => ['--allowed-origin', origin]),
  ];
  const child = (options.spawnDaemon ?? defaultSpawnDaemon)(process.execPath, args, {
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
    env: {
      ...process.env,
      KTX_CLI_VERSION: options.cliVersion,
      ...(options.token ? { KTX_MCP_TOKEN: options.token } : {}),
    },
  });
  if (!child.pid) {
    throw new Error('Failed to start KTX MCP daemon: child process pid was not available.');
  }
  child.unref();
  const state: KtxMcpDaemonState = {
    schemaVersion: 1,
    pid: child.pid,
    host: options.host,
    port: options.port,
    tokenAuth: Boolean(options.token),
    projectDir: options.projectDir,
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    logPath,
  };
  await writeState(options.projectDir, state);
  return { status: 'started', state, url: `http://${state.host}:${state.port}/mcp` };
}

export async function readKtxMcpDaemonStatus(options: {
  projectDir: string;
  processAlive?: (pid: number) => boolean;
  fetchHealth?: (state: KtxMcpDaemonState) => Promise<{ ok: boolean; body: unknown; detail?: string }>;
}): Promise<KtxMcpDaemonStatus> {
  let state: KtxMcpDaemonState | undefined;
  try {
    state = await readState(options.projectDir);
  } catch (error) {
    return { kind: 'stale', detail: `MCP daemon state is invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!state) {
    return { kind: 'stopped', detail: `No MCP daemon state at ${mcpDaemonLayout(options.projectDir).statePath}` };
  }
  const processAlive = options.processAlive ?? defaultProcessAlive;
  if (!processAlive(state.pid)) {
    return { kind: 'stale', detail: `MCP daemon process ${state.pid} is not running`, state };
  }
  const health = await (options.fetchHealth ?? defaultFetchHealth)(state);
  if (!health.ok) {
    return { kind: 'stale', detail: health.detail ?? 'MCP daemon health check failed', state };
  }
  return {
    kind: 'running',
    detail: `KTX MCP daemon running at http://${state.host}:${state.port}/mcp`,
    state,
    url: `http://${state.host}:${state.port}/mcp`,
  };
}

export async function stopKtxMcpDaemon(options: {
  projectDir: string;
  processAlive?: (pid: number) => boolean;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  stopGraceMs?: number;
  pollIntervalMs?: number;
}): Promise<{ status: 'stopped' | 'already-stopped' }> {
  const state = await readState(options.projectDir);
  const { statePath } = mcpDaemonLayout(options.projectDir);
  if (!state) {
    return { status: 'already-stopped' };
  }
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const killProcess = options.killProcess ?? defaultKillProcess;
  if (processAlive(state.pid)) {
    killProcess(state.pid, 'SIGTERM');
    const deadline = Date.now() + (options.stopGraceMs ?? 10_000);
    while (Date.now() <= deadline && processAlive(state.pid)) {
      await delay(options.pollIntervalMs ?? 100);
    }
    if (processAlive(state.pid)) {
      killProcess(state.pid, 'SIGKILL');
    }
  }
  await rm(statePath, { force: true });
  return { status: 'stopped' };
}
```

- [ ] **Step 4: Run the daemon lifecycle tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/managed-mcp-daemon.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/managed-mcp-daemon.ts packages/cli/src/managed-mcp-daemon.test.ts
git commit -m "feat(cli): manage mcp daemon lifecycle"
```

## Task 4: Register `ktx mcp` Commands

**Files:**
- Create: `packages/cli/src/commands/mcp-commands.ts`
- Create: `packages/cli/src/commands/mcp-commands.test.ts`
- Modify: `packages/cli/src/cli-program.ts`

- [ ] **Step 1: Write failing command tests**

Create `packages/cli/src/commands/mcp-commands.test.ts` with:

```typescript
import { Command } from '@commander-js/extra-typings';
import { describe, expect, it, vi } from 'vitest';
import type { KtxCliCommandContext } from '../cli-program.js';
import { registerMcpCommands } from './mcp-commands.js';

function makeContext(overrides: Partial<KtxCliCommandContext> = {}): KtxCliCommandContext {
  let exitCode = 0;
  return {
    io: {
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    },
    deps: {},
    packageInfo: { name: '@ktx/cli', version: '0.0.0-test' },
    setExitCode: (code) => {
      exitCode = code;
    },
    runInit: vi.fn(),
    writeDebug: vi.fn(),
    ...overrides,
    get exitCode() {
      return exitCode;
    },
  } as KtxCliCommandContext;
}

describe('registerMcpCommands', () => {
  it('registers the public mcp lifecycle commands', () => {
    const program = new Command().exitOverride();
    registerMcpCommands(program, makeContext());
    const mcp = program.commands.find((command) => command.name() === 'mcp');

    expect(mcp?.commands.map((command) => command.name()).sort()).toEqual([
      'logs',
      'serve-internal',
      'start',
      'status',
      'stop',
    ]);
    expect(mcp?.commands.find((command) => command.name() === 'serve-internal')?.hidden).toBe(true);
  });

  it('rejects non-loopback start without token before spawning', async () => {
    const program = new Command().exitOverride();
    const startDaemon = vi.fn();
    const context = makeContext({ deps: { mcp: { startDaemon } } } as Partial<KtxCliCommandContext>);
    registerMcpCommands(program, context);

    await expect(program.parseAsync(['mcp', 'start', '--host', '0.0.0.0'], { from: 'user' })).rejects.toThrow(
      'Binding KTX MCP to 0.0.0.0 requires --token or KTX_MCP_TOKEN',
    );
    expect(startDaemon).not.toHaveBeenCalled();
  });
});
```

If `KtxCliDeps` does not yet include `mcp`, add this test helper shape in the test file:

```typescript
type TestDeps = KtxCliCommandContext['deps'] & {
  mcp?: {
    startDaemon?: unknown;
    stopDaemon?: unknown;
    readStatus?: unknown;
    runServer?: unknown;
  };
};
```

Then cast `deps: { mcp: { startDaemon } } as TestDeps`.

- [ ] **Step 2: Run the command tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/commands/mcp-commands.test.ts
```

Expected: FAIL because `./mcp-commands.js` does not exist.

- [ ] **Step 3: Add MCP command dependency hooks**

Find `KtxCliDeps` in `packages/cli/src/cli-runtime.ts` and add:

```typescript
  mcp?: {
    startDaemon?: typeof import('./managed-mcp-daemon.js').startKtxMcpDaemon;
    stopDaemon?: typeof import('./managed-mcp-daemon.js').stopKtxMcpDaemon;
    readStatus?: typeof import('./managed-mcp-daemon.js').readKtxMcpDaemonStatus;
    runServer?: typeof import('./mcp-http-server.js').runKtxMcpHttpServer;
  };
```

- [ ] **Step 4: Implement the MCP command subtree**

Create `packages/cli/src/commands/mcp-commands.ts` with:

```typescript
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Command } from '@commander-js/extra-typings';
import {
  buildMcpSecurityConfig,
  runKtxMcpHttpServer,
} from '../mcp-http-server.js';
import {
  mcpDaemonLayout,
  readKtxMcpDaemonStatus,
  startKtxMcpDaemon,
  stopKtxMcpDaemon,
} from '../managed-mcp-daemon.js';
import {
  collectOption,
  parsePositiveIntegerOption,
  resolveCommandProjectDir,
  type KtxCliCommandContext,
} from '../cli-program.js';

function tokenFromOption(value: string | undefined): string | undefined {
  return value ?? process.env.KTX_MCP_TOKEN;
}

function binPath(): string {
  return fileURLToPath(new URL('../bin.js', import.meta.url));
}

export function registerMcpCommands(program: Command, context: KtxCliCommandContext): void {
  const mcp = program.command('mcp').description('Run the KTX MCP HTTP server');

  mcp
    .command('start')
    .description('Start the KTX MCP HTTP server')
    .option('--host <host>', 'Host to bind', '127.0.0.1')
    .option('--port <n>', 'Port to bind', parsePositiveIntegerOption, 7878)
    .option('--token <token>', 'Bearer token required for non-loopback binding')
    .option('--foreground', 'Run in the foreground', false)
    .option('--allowed-host <host>', 'Additional allowed Host header', collectOption, [])
    .option('--allowed-origin <origin>', 'Allowed browser Origin header', collectOption, [])
    .action(async (options, command) => {
      const projectDir = resolveCommandProjectDir(command);
      const token = tokenFromOption(options.token);
      buildMcpSecurityConfig({
        host: options.host,
        port: options.port,
        token,
        allowedHosts: options.allowedHost,
        allowedOrigins: options.allowedOrigin,
      });
      if (options.foreground) {
        await (context.deps.mcp?.runServer ?? runKtxMcpHttpServer)({
          projectDir,
          cliVersion: context.packageInfo.version,
          host: options.host,
          port: options.port,
          token,
          allowedHosts: options.allowedHost,
          allowedOrigins: options.allowedOrigin,
          io: context.io,
        });
        context.io.stdout.write(`KTX MCP server listening at http://${options.host}:${options.port}/mcp\n`);
        return;
      }
      const result = await (context.deps.mcp?.startDaemon ?? startKtxMcpDaemon)({
        projectDir,
        cliVersion: context.packageInfo.version,
        host: options.host,
        port: options.port,
        token,
        allowedHosts: options.allowedHost,
        allowedOrigins: options.allowedOrigin,
        binPath: binPath(),
      });
      context.io.stdout.write(`KTX MCP daemon started: ${result.url}\n`);
    });

  mcp.command('stop').description('Stop the KTX MCP daemon').action(async (_options, command) => {
    const result = await (context.deps.mcp?.stopDaemon ?? stopKtxMcpDaemon)({
      projectDir: resolveCommandProjectDir(command),
    });
    context.io.stdout.write(result.status === 'stopped' ? 'KTX MCP daemon stopped.\n' : 'KTX MCP daemon is not running.\n');
  });

  mcp.command('status').description('Show KTX MCP daemon status').action(async (_options, command) => {
    const status = await (context.deps.mcp?.readStatus ?? readKtxMcpDaemonStatus)({
      projectDir: resolveCommandProjectDir(command),
    });
    context.io.stdout.write(`${status.detail}\n`);
    if (status.kind === 'running') {
      context.io.stdout.write(`URL: ${status.url}\n`);
      context.io.stdout.write(`PID: ${status.state.pid}\n`);
      context.io.stdout.write(`Token auth: ${status.state.tokenAuth ? 'enabled' : 'disabled'}\n`);
      context.io.stdout.write(`Project: ${status.state.projectDir}\n`);
    }
  });

  mcp.command('logs').description('Print the KTX MCP daemon log').option('--follow', 'Follow log output', false).action(async (options, command) => {
    const logPath = mcpDaemonLayout(resolveCommandProjectDir(command)).logPath;
    if (options.follow) {
      const child = spawn('tail', ['-f', logPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (chunk: Buffer) => context.io.stdout.write(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => context.io.stderr.write(chunk.toString('utf8')));
      await new Promise((resolve) => child.on('close', resolve));
      return;
    }
    context.io.stdout.write(await readFile(logPath, 'utf8'));
  });

  mcp
    .command('serve-internal', { hidden: true })
    .option('--host <host>', 'Host to bind', '127.0.0.1')
    .requiredOption('--port <n>', 'Port to bind', parsePositiveIntegerOption)
    .option('--allowed-host <host>', 'Additional allowed Host header', collectOption, [])
    .option('--allowed-origin <origin>', 'Allowed browser Origin header', collectOption, [])
    .action(async (options, command) => {
      await (context.deps.mcp?.runServer ?? runKtxMcpHttpServer)({
        projectDir: resolveCommandProjectDir(command),
        cliVersion: context.packageInfo.version,
        host: options.host,
        port: options.port,
        token: process.env.KTX_MCP_TOKEN,
        allowedHosts: options.allowedHost,
        allowedOrigins: options.allowedOrigin,
        io: context.io,
      });
    });
}
```

- [ ] **Step 5: Wire the command into the root CLI**

In `packages/cli/src/cli-program.ts`:

Add the import:

```typescript
import { registerMcpCommands } from './commands/mcp-commands.js';
```

Change:

```typescript
const PROJECT_AWARE_ROOT_COMMANDS = new Set(['setup', 'connection', 'ingest', 'wiki', 'sl', 'status']);
```

to:

```typescript
const PROJECT_AWARE_ROOT_COMMANDS = new Set(['setup', 'connection', 'ingest', 'wiki', 'sl', 'status', 'mcp']);
```

Add registration after `registerStatusCommands(program, context);`:

```typescript
  registerMcpCommands(program, context);
```

- [ ] **Step 6: Run command tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/commands/mcp-commands.test.ts src/cli-program.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  packages/cli/src/commands/mcp-commands.ts \
  packages/cli/src/commands/mcp-commands.test.ts \
  packages/cli/src/cli-program.ts \
  packages/cli/src/cli-runtime.ts
git commit -m "feat(cli): add ktx mcp commands"
```

## Task 5: Final Verification And Handoff

**Files:**
- Verify: `packages/cli/src/mcp-http-server.ts`
- Verify: `packages/cli/src/managed-mcp-daemon.ts`
- Verify: `packages/cli/src/commands/mcp-commands.ts`
- Verify: `packages/cli/package.json`

- [ ] **Step 1: Run focused CLI tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run \
  src/mcp-http-server.test.ts \
  src/managed-mcp-daemon.test.ts \
  src/commands/mcp-commands.test.ts \
  src/cli-program.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run CLI type-check**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 3: Run CLI package tests**

Run:

```bash
pnpm --filter @ktx/cli run test
```

Expected: PASS.

- [ ] **Step 4: Run workspace type-check**

Run:

```bash
pnpm run type-check
```

Expected: PASS.

- [ ] **Step 5: Confirm remaining v1 blockers**

Run:

```bash
test -e packages/cli/src/skills/research/SKILL.md; printf 'research-skill:%s\n' "$?"
rg -n "connectionName" packages/context/src/ingest/tools/warehouse-verification
rg -n "mcpServers|mcp_servers|opencode|KTX_MCP_TOKEN" packages/cli/src/setup-agents.ts packages/cli/src/setup-agents.test.ts
```

Expected after this plan is implemented:

```text
research-skill:1
```

Expected `rg "connectionName"`: matches remain under `packages/context/src/ingest/tools/warehouse-verification`, proving ingest contract convergence still needs a later v1 plan.

Expected setup-agent `rg`: no complete MCP client config writer/snippet matrix yet, proving setup-agent/research-skill installation still needs a later v1 plan.

- [ ] **Step 6: Commit final fixes if verification required any**

If verification required changes, commit them:

```bash
git add packages/cli/src packages/cli/package.json pnpm-lock.yaml
git commit -m "fix(cli): stabilize mcp daemon verification"
```

If no verification changes were needed, do not create an empty commit.

## Self-Review

- Spec coverage in this plan: covers `ktx mcp start|stop|status|logs`, foreground/background lifecycle, `.ktx/mcp.json`, `.ktx/logs/mcp.log`, HTTP-only `/mcp`, `/health`, stateful sessions, Host/Origin validation, non-loopback token requirement, and bearer checks on `/mcp`.
- Remaining v1-blocking spec coverage after this plan: setup-agent MCP client config installation, `ktx-research` skill installation, and ingest-side warehouse-verification `connectionName` to `connectionId` contract convergence.
- Placeholder scan: the plan contains no deferred work markers or vague implementation instructions.
- Type consistency: public names are consistent across tasks: `runKtxMcpHttpServer`, `buildMcpSecurityConfig`, `isMcpRequestAuthorized`, `mcpDaemonLayout`, `startKtxMcpDaemon`, `readKtxMcpDaemonStatus`, `stopKtxMcpDaemon`, and `registerMcpCommands`.
