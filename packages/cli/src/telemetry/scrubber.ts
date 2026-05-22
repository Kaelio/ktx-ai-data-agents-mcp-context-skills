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
