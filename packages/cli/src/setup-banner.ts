/**
 * The `ktx setup` intro banner: a lowercase ktx wordmark drawn with
 * half-block glyphs over the brand-orange gradient, followed by the product
 * tagline. Rendering is a pure function of the options so output stays
 * deterministic in tests.
 */

interface KtxBannerRow {
  art: string;
  /** Truecolor gradient stop; the middle row is ktx orange #f97316. */
  rgb: readonly [number, number, number];
  /** Closest xterm-256 color to {@link KtxBannerRow.rgb}. */
  ansi256: number;
}

const WORDMARK: readonly KtxBannerRow[] = [
  { art: '███         ███', rgb: [253, 186, 116], ansi256: 215 },
  { art: '███  ▄██▀ ▀▀███▀▀ ▀██▄  ▄██▀', rgb: [251, 146, 60], ansi256: 214 },
  { art: '███▄██▀     ███     ▀████▀', rgb: [249, 115, 22], ansi256: 208 },
  { art: '███▀██▄     ███     ▄████▄', rgb: [234, 88, 12], ansi256: 202 },
  { art: '███  ▀██▄   ███   ▄██▀  ▀██▄', rgb: [194, 65, 12], ansi256: 166 },
];

const TAGLINE = 'context layer for data agents';
const INDENT = '  ';

const BANNER_WIDTH = Math.max(...WORDMARK.map((row) => row.art.length), TAGLINE.length) + INDENT.length;

export interface KtxSetupBannerOptions {
  /** Terminal width in columns. */
  columns: number;
  /** Color depth in bits, as reported by `tty.WriteStream#getColorDepth`; 1 disables color. */
  colorDepth: number;
  /** Whether the terminal renders Unicode block glyphs. */
  unicode: boolean;
}

/**
 * Returns the banner block ending right above the clack intro line, or an
 * empty string when the terminal cannot display it (no Unicode support or
 * too narrow).
 */
export function renderKtxSetupBanner(options: KtxSetupBannerOptions): string {
  if (!options.unicode || options.columns < BANNER_WIDTH) {
    return '';
  }
  const art = WORDMARK.map((row) => INDENT + colorizeBannerRow(row, options.colorDepth));
  const tagline = INDENT + (options.colorDepth > 1 ? `\u001b[2m${TAGLINE}\u001b[22m` : TAGLINE);
  return `\n${art.join('\n')}\n\n${tagline}\n\n`;
}

function colorizeBannerRow(row: KtxBannerRow, colorDepth: number): string {
  if (colorDepth >= 24) {
    const [r, g, b] = row.rgb;
    return `\u001b[38;2;${r};${g};${b}m${row.art}\u001b[39m`;
  }
  if (colorDepth >= 8) {
    return `\u001b[38;5;${row.ansi256}m${row.art}\u001b[39m`;
  }
  return row.art;
}
