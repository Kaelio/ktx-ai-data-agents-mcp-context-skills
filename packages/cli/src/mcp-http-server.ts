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
