function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DATABASE_INGEST_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bPreparing scan\b/gi, 'Preparing database ingest'],
  [/\bInspecting database schema\b/gi, 'Reading database schema'],
  [/\bWriting schema artifacts\b/gi, 'Writing schema context'],
  [/\bEnriching schema metadata\b/gi, 'Building enriched schema context'],
  [
    /\bKTX scan enrichment failed after structural scan completed\b/gi,
    'Database enrichment failed after schema context completed',
  ],
  [/\bstructural scan\b/gi, 'schema context'],
  [/\benriched scan\b/gi, 'deep database ingest'],
  [/\bscan results\b/gi, 'database context'],
];

export function publicDatabaseIngestMessage(message: string): string {
  return DATABASE_INGEST_REPLACEMENTS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    message,
  );
}

export function publicQueryHistoryMessage(message: string, connectionId?: string): string {
  let current = message;
  if (connectionId && connectionId.length > 0) {
    const escapedConnectionId = escapeRegExp(connectionId);
    current = current
      .replace(
        new RegExp(`Fetching source files for ${escapedConnectionId}/historic-sql`, 'i'),
        `Fetching query history for ${connectionId}`,
      )
      .replace(`${connectionId}/historic-sql`, `${connectionId} query history`);
  }
  return current.replace(/\bhistoric-sql\b/g, 'query history').replace(/\bhistoric SQL\b/gi, 'query history');
}

export function publicIngestOutputLine(line: string): string {
  return publicQueryHistoryMessage(publicDatabaseIngestMessage(line)).replace(/\blive-database\b/g, 'database schema');
}
