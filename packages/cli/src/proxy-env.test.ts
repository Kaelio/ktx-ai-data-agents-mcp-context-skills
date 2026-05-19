import { describe, expect, it } from 'vitest';
import { sanitizeChildProxyEnv } from './proxy-env.js';

describe('sanitizeChildProxyEnv', () => {
  it('drops IPv6 CIDR no-proxy entries and normalizes both env keys', () => {
    const env = sanitizeChildProxyEnv({
      NO_PROXY: 'localhost,127.0.0.1,127.0.0.0/8,fd07:b51a:cc66:f0::/64,*.orb.local',
      no_proxy: '::1,0.250.250.0/24,fd00::/8,*.orb.internal',
    });

    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,127.0.0.0/8,*.orb.local,::1,0.250.250.0/24,*.orb.internal');
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it('preserves the input object and leaves missing proxy env unset', () => {
    const input = { PATH: '/usr/bin' };

    expect(sanitizeChildProxyEnv(input)).toEqual({ PATH: '/usr/bin' });
    expect(input).toEqual({ PATH: '/usr/bin' });
  });
});
