import type { ToolSession } from './tool-session.js';

type ActionRawPathValidation =
  | { ok: true; rawPaths?: string[] }
  | { ok: false; error: string };

export function validateActionRawPaths(
  session: ToolSession | undefined,
  rawPaths: readonly string[] | undefined,
): ActionRawPathValidation {
  if (!rawPaths || rawPaths.length === 0) {
    return { ok: true };
  }

  const uniqueRawPaths = [...new Set(rawPaths)];
  const allowedRawPaths = session?.allowedRawPaths;
  if (!allowedRawPaths) {
    return { ok: true, rawPaths: uniqueRawPaths };
  }

  const unavailable = uniqueRawPaths.filter((rawPath) => !allowedRawPaths.has(rawPath));
  if (unavailable.length > 0) {
    return {
      ok: false,
      error: `rawPaths include unavailable ingest file(s): ${unavailable.join(', ')}`,
    };
  }

  return { ok: true, rawPaths: uniqueRawPaths };
}
