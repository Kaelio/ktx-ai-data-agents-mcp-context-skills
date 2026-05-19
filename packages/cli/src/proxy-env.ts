const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy'] as const;

function isIpv6CidrNoProxyEntry(entry: string): boolean {
  return entry.includes('/') && entry.includes(':');
}

function cleanedNoProxyValue(env: NodeJS.ProcessEnv): string | undefined {
  const entries = NO_PROXY_KEYS.flatMap((key) => (env[key] ?? '').split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !isIpv6CidrNoProxyEntry(entry));

  if (!NO_PROXY_KEYS.some((key) => env[key] !== undefined)) {
    return undefined;
  }
  return [...new Set(entries)].join(',');
}

export function sanitizeChildProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  const noProxy = cleanedNoProxyValue(env);
  if (noProxy === undefined) {
    return sanitized;
  }
  sanitized.NO_PROXY = noProxy;
  sanitized.no_proxy = noProxy;
  return sanitized;
}
