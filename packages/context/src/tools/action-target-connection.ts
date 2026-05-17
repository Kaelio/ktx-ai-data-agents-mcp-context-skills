import type { ToolSession } from './tool-session.js';

type ActionTargetConnectionValidation = { ok: true } | { ok: false; error: string };

export function validateActionTargetConnection(
  session: ToolSession | undefined,
  connectionId: string,
): ActionTargetConnectionValidation {
  const allowed = session?.allowedConnectionNames;
  if (!allowed) {
    return { ok: true };
  }
  if (allowed.has(connectionId)) {
    return { ok: true };
  }
  const allowedList = [...allowed].sort();
  return {
    ok: false,
    error: `connectionId "${connectionId}" is outside this ingest session's allowed target connections: ${
      allowedList.length > 0 ? allowedList.join(', ') : '(none)'
    }`,
  };
}
