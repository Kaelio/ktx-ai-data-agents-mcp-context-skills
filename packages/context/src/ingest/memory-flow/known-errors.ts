interface MemoryFlowErrorContext {
  adapter: string;
}

export function isNotionAuthorizationExpired(
  context: MemoryFlowErrorContext,
  reason: string | undefined,
): boolean {
  if (context.adapter !== 'notion') {
    return false;
  }
  const normalized = (reason ?? '').toLowerCase();
  return (
    normalized.includes('invalid_grant') &&
    (normalized.includes('invalid_rapt') || normalized.includes('reauth'))
  );
}

export function formatNotionAuthorizationExpiredDetail(unitKey: string): string {
  return `${unitKey} could not read Notion because the saved OAuth grant expired or requires reauthentication (invalid_grant / invalid_rapt).`;
}

export function notionAuthorizationFixSuggestions(connectionId: string): string[] {
  return [
    `Refresh the Notion token referenced by auth_token_ref for ${connectionId}. If it uses env:NAME, export a fresh token in that variable; if it uses file:/path, replace that file.`,
    `Run ktx connection notion pick ${connectionId} to confirm Notion access, then rerun ktx ingest ${connectionId}.`,
  ];
}
