export interface KtxDataDictionarySettings {
  cardinalityThreshold: number;
  maxValuesToStore: number;
  sampleSize: number;
  useDbStatistics: boolean;
  excludePatterns: string[];
}

export const defaultKtxDataDictionarySettings: KtxDataDictionarySettings = {
  cardinalityThreshold: 200,
  maxValuesToStore: 100,
  sampleSize: 10000,
  useDbStatistics: true,
  excludePatterns: [
    '_id$',
    '_uuid$',
    '_key$',
    '_hash$',
    '_token$',
    '^id$',
    '^uuid$',
    '_at$',
    '_date$',
    '_time$',
    'description$',
    'comment$',
    'notes?$',
    'message$',
    'body$',
    'content$',
    '_url$',
    '_path$',
    'email$',
    '^phone',
    'address$',
  ],
};

type KtxDataDictionarySkipReason =
  | 'not_candidate'
  | 'already_populated'
  | 'empty_column'
  | 'high_cardinality';

/** @internal */
export interface KtxDataDictionarySampleDecision {
  sample: boolean;
  reason?: KtxDataDictionarySkipReason;
}

/** @internal */
export interface KtxDataDictionaryColumnState {
  columnType: string;
  columnName: string;
  sampleValues?: readonly string[] | null;
  cardinality?: number | null;
  settings: KtxDataDictionarySettings;
}

const categoricalCandidateTypes = /^(n?varchar|n?char|n?text|string|character|enum|bool(ean)?)/i;

export function isKtxDataDictionaryCandidate(
  columnType: string,
  columnName: string,
  excludePatterns: readonly string[] = defaultKtxDataDictionarySettings.excludePatterns,
): boolean {
  const typeLower = columnType.toLowerCase();
  const nameLower = columnName.toLowerCase();

  if (!categoricalCandidateTypes.test(typeLower)) {
    return false;
  }

  for (const patternText of excludePatterns) {
    try {
      const pattern = new RegExp(patternText, 'i');
      if (pattern.test(nameLower)) {
        return false;
      }
    } catch {
      continue;
    }
  }

  return true;
}

/** @internal */
export function shouldKtxSampleColumnForDictionary(
  input: KtxDataDictionaryColumnState,
): KtxDataDictionarySampleDecision {
  const sampleValues = input.sampleValues ?? null;
  const cardinality = input.cardinality ?? null;

  if (sampleValues && sampleValues.length > 0) {
    return { sample: false, reason: 'already_populated' };
  }

  if (cardinality === 0) {
    return { sample: false, reason: 'empty_column' };
  }

  if (cardinality !== null && cardinality > input.settings.cardinalityThreshold) {
    return { sample: false, reason: 'high_cardinality' };
  }

  if (!isKtxDataDictionaryCandidate(input.columnType, input.columnName, input.settings.excludePatterns)) {
    return { sample: false, reason: 'not_candidate' };
  }

  return { sample: true };
}
