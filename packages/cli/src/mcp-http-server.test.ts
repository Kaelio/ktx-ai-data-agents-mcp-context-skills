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
