import { describe, expect, it } from 'vitest';

import { renderStarPromptLine } from '../../src/star-prompt/star-line.js';

const unicodeSymbols = {
  star: '★',
  middot: '·',
  rightArrow: '→',
};

const asciiSymbols = {
  star: '*',
  middot: '-',
  rightArrow: '->',
};

describe('renderStarPromptLine', () => {
  it('renders the full prompt with a formatted count when it fits', () => {
    expect(renderStarPromptLine({ count: 1234, columns: 120, symbols: unicodeSymbols })).toBe(
      '  ★  This takes a few minutes - mind giving ktx a star while you wait?  github.com/Kaelio/ktx · 1,234 ★',
    );
  });

  it('renders the full prompt without a count when the count is unavailable', () => {
    expect(renderStarPromptLine({ count: null, columns: 120, symbols: unicodeSymbols })).toBe(
      '  ★  This takes a few minutes - mind giving ktx a star while you wait?  github.com/Kaelio/ktx',
    );
  });

  it('drops the count segment before shortening the sentence', () => {
    expect(renderStarPromptLine({ count: 1234, columns: 102, symbols: unicodeSymbols })).toBe(
      '  ★  This takes a few minutes - mind giving ktx a star while you wait?  github.com/Kaelio/ktx',
    );
  });

  it('uses the narrow fallback on compact terminals', () => {
    expect(renderStarPromptLine({ count: 1234, columns: 92, symbols: unicodeSymbols })).toBe(
      '  ★ Star ktx → github.com/Kaelio/ktx',
    );
  });

  it('supports ASCII fallback symbols', () => {
    expect(renderStarPromptLine({ count: 1234, columns: 120, symbols: asciiSymbols })).toBe(
      '  *  This takes a few minutes - mind giving ktx a star while you wait?  github.com/Kaelio/ktx - 1,234 *',
    );
  });
});
