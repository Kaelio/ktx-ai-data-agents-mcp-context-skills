/** @internal */
export function createAbortError(message = 'Aborted'): DOMException {
  return new DOMException(message, 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as { name?: unknown; code?: unknown };
  return record.name === 'AbortError' || record.code === 'ABORT_ERR';
}

/** @internal */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export function linkAbortSignal(parent?: AbortSignal): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  if (!parent) {
    return { controller, dispose: () => undefined };
  }
  if (parent.aborted) {
    controller.abort(createAbortError());
    return { controller, dispose: () => undefined };
  }
  const onAbort = () => controller.abort(createAbortError());
  parent.addEventListener('abort', onAbort, { once: true });
  return {
    controller,
    dispose: () => parent.removeEventListener('abort', onAbort),
  };
}
