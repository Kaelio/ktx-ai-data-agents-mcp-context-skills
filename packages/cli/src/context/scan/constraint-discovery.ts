import type { KtxScanWarning } from './types.js';

export type ConstraintDiscoveryKind = 'primary_key' | 'foreign_key';

export interface ConstraintQueryContext {
  schema: string;
  kind: ConstraintDiscoveryKind;
  isDeniedError: (error: unknown) => boolean;
}

export type ConstraintQueryOutcome<T> = { ok: true; value: T } | { ok: false; warning: KtxScanWarning };

export function constraintDiscoveryWarning(input: {
  schema: string;
  kind: ConstraintDiscoveryKind;
}): KtxScanWarning {
  return {
    code: 'constraint_discovery_unauthorized',
    message:
      `Skipped ${input.kind === 'primary_key' ? 'primary-key' : 'foreign-key'} ` +
      `discovery in ${input.schema} (insufficient grants on system catalogs)`,
    recoverable: true,
    metadata: { schema: input.schema, kind: input.kind },
  };
}

export async function tryConstraintQuery<T>(
  ctx: ConstraintQueryContext,
  fn: () => Promise<T>,
): Promise<ConstraintQueryOutcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (!ctx.isDeniedError(error)) {
      throw error;
    }
    return {
      ok: false,
      warning: constraintDiscoveryWarning({ schema: ctx.schema, kind: ctx.kind }),
    };
  }
}
