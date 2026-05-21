import type { SlValidationDeps, SlValidatorPort } from '../../sl/index.js';
import type { TouchedSlSource } from '../../tools/index.js';

export interface WuValidationResult {
  validSources: string[];
  invalidSources: string[];
}

export async function validateWuTouchedSources(
  deps: SlValidationDeps & { slValidator: SlValidatorPort<SlValidationDeps> },
  touched: TouchedSlSource[],
): Promise<WuValidationResult> {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const source of touched) {
    const result = await deps.slValidator.validateSingleSource(deps, source.connectionId, source.sourceName);
    if (result.errors.length === 0) {
      valid.push(`${source.connectionId}:${source.sourceName}`);
    } else {
      invalid.push(`${source.connectionId}:${source.sourceName}`);
    }
  }
  return { validSources: valid, invalidSources: invalid };
}
