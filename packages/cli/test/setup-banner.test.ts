import { describe, expect, it } from 'vitest';

import { renderKtxSetupBanner } from '../src/setup-banner.js';

const WIDE = { columns: 120, colorDepth: 1, unicode: true };

describe('renderKtxSetupBanner', () => {
  it('renders the wordmark and tagline without ANSI codes when color is off', () => {
    const banner = renderKtxSetupBanner(WIDE);

    expect(banner).toContain('██');
    expect(banner).toContain('context layer for data agents');
    expect(banner).not.toContain('\u001b[');
    expect(banner.endsWith('\n\n')).toBe(true);
  });

  it('fits within the reported terminal width', () => {
    const banner = renderKtxSetupBanner({ ...WIDE, columns: 40 });

    for (const line of banner.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    expect(banner).not.toBe('');
  });

  it('uses truecolor gradient codes at 24-bit depth', () => {
    const banner = renderKtxSetupBanner({ ...WIDE, colorDepth: 24 });

    expect(banner).toContain('\u001b[38;2;249;115;22m');
    expect(banner).toContain('\u001b[2mcontext layer for data agents\u001b[22m');
  });

  it('falls back to xterm-256 codes at 8-bit depth', () => {
    const banner = renderKtxSetupBanner({ ...WIDE, colorDepth: 8 });

    expect(banner).toContain('\u001b[38;5;208m');
    expect(banner).not.toContain('\u001b[38;2;');
  });

  it('renders monochrome art at 16-color depth', () => {
    const banner = renderKtxSetupBanner({ ...WIDE, colorDepth: 4 });

    expect(banner).toContain('██');
    expect(banner).not.toContain('\u001b[38;');
  });

  it('returns an empty string when the terminal is too narrow', () => {
    expect(renderKtxSetupBanner({ ...WIDE, columns: 24 })).toBe('');
  });

  it('returns an empty string without Unicode support', () => {
    expect(renderKtxSetupBanner({ ...WIDE, unicode: false })).toBe('');
  });
});
