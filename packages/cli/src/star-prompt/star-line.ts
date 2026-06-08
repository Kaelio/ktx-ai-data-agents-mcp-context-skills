import { SYMBOLS } from '../io/symbols.js';

const STAR_PROMPT_URL = 'github.com/Kaelio/ktx';
const STAR_PROMPT_TEXT = 'This takes a few minutes - mind giving ktx a star while you wait?';

interface StarPromptSymbols {
  star: string;
  middot: string;
  rightArrow: string;
}

export interface RenderStarPromptLineOptions {
  columns: number;
  count?: number | null;
  symbols?: StarPromptSymbols;
}

function usableColumns(columns: number): number {
  return Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
}

function starCountSegment(count: number | null | undefined, symbols: StarPromptSymbols): string {
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    return '';
  }
  const formatted = new Intl.NumberFormat('en-US').format(count);
  return ` ${symbols.middot} ${formatted} ${symbols.star}`;
}

export function renderStarPromptLine(options: RenderStarPromptLineOptions): string {
  const symbols = options.symbols ?? SYMBOLS;
  const columns = usableColumns(options.columns);
  const base = `  ${symbols.star}  ${STAR_PROMPT_TEXT}  ${STAR_PROMPT_URL}`;
  const withCount = `${base}${starCountSegment(options.count, symbols)}`;
  if (withCount.length <= columns) {
    return withCount;
  }
  if (base.length <= columns) {
    return base;
  }
  return `  ${symbols.star} Star ktx ${symbols.rightArrow} ${STAR_PROMPT_URL}`;
}
