export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    const text = String(error);
    return text.length > 0 ? text : 'unknown error';
  }
  const parts: string[] = [];
  if (error.message.length > 0) {
    parts.push(error.message);
  }
  const seen = new Set<unknown>([error]);
  let cause: unknown = error.cause;
  while (cause && !seen.has(cause)) {
    seen.add(cause);
    if (cause instanceof Error) {
      if (cause.message.length > 0) {
        parts.push(cause.message);
      }
      cause = cause.cause;
    } else {
      const text = String(cause);
      if (text.length > 0) {
        parts.push(text);
      }
      break;
    }
  }
  return parts.length > 0 ? parts.join(': ') : 'unknown error';
}
