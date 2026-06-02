const MAX_ERROR_CLASS_LENGTH = 80;
const ERROR_CLASS_PATTERN = /^[A-Z][A-Za-z0-9_]*$/;
const PRIVATE_STRING_MARKERS = ['/', '\\', '@', '://'];

export function scrubErrorClass(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const constructorName = (error as { constructor?: { name?: unknown } }).constructor?.name;
  if (typeof constructorName !== 'string') {
    return undefined;
  }

  if (constructorName.length > MAX_ERROR_CLASS_LENGTH) {
    return undefined;
  }

  if (PRIVATE_STRING_MARKERS.some((marker) => constructorName.includes(marker))) {
    return undefined;
  }

  if (!ERROR_CLASS_PATTERN.test(constructorName)) {
    return undefined;
  }

  return constructorName;
}

const MAX_ERROR_DETAIL_LENGTH = 1000;

/**
 * Human-readable failure detail for telemetry: the error's `.code` (when
 * present) prefixed onto its `message`, collapsed to a single line and
 * length-capped. Captures the message only — never the stack.
 *
 * This intentionally forwards raw error text, which can include identifiers from
 * the user's environment (table/column names, hostnames, usernames), so that
 * funnel failures are diagnosable. Callers must gate it to the failure path.
 */
export function formatErrorDetail(error: unknown): string | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  const prefix = typeof code === 'string' || typeof code === 'number' ? `${code}: ` : '';
  const detail = `${prefix}${message}`.replace(/\s+/g, ' ').trim();

  return detail.length > 0 ? detail.slice(0, MAX_ERROR_DETAIL_LENGTH) : undefined;
}
