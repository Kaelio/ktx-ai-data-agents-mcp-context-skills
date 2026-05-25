import { describe, expect, it } from 'vitest';
import {
  publicDatabaseIngestMessage,
  publicIngestOutputLine,
  publicQueryHistoryMessage,
} from '../src/public-ingest-copy.js';

describe('public ingest copy sanitizers', () => {
  it('maps database scan progress into schema-context wording', () => {
    expect(publicDatabaseIngestMessage('Preparing scan')).toBe('Preparing database ingest');
    expect(publicDatabaseIngestMessage('Inspecting database schema')).toBe('Reading database schema');
    expect(publicDatabaseIngestMessage('Writing schema artifacts')).toBe('Writing schema context');
    expect(publicDatabaseIngestMessage('Enriching schema metadata')).toBe('Building enriched schema context');
  });

  it('maps database scan failure text into public database ingest wording', () => {
    expect(
      publicDatabaseIngestMessage(
        'KTX scan enrichment failed after structural scan completed: embedding service timed out',
      ),
    ).toBe('Database enrichment failed after schema context completed: embedding service timed out');
    expect(publicDatabaseIngestMessage('structural scan wrote partial artifacts')).toBe(
      'schema context wrote partial artifacts',
    );
    expect(publicDatabaseIngestMessage('scan results may be less complete')).toBe(
      'database context may be less complete',
    );
  });

  it('maps query-history adapter progress into public wording', () => {
    expect(publicQueryHistoryMessage('Fetching source files for warehouse/historic-sql', 'warehouse')).toBe(
      'Fetching query history for warehouse',
    );
    expect(publicQueryHistoryMessage('Curating warehouse/historic-sql tasks', 'warehouse')).toBe(
      'Curating warehouse query history tasks',
    );
    expect(publicQueryHistoryMessage('historic SQL local ingest failed', 'warehouse')).toBe(
      'query history local ingest failed',
    );
  });

  it('sanitizes captured public output lines across database and query-history internals', () => {
    expect(
      publicIngestOutputLine(
        'KTX scan enrichment failed after structural scan completed in raw-sources/warehouse/live-database/sync-1',
      ),
    ).toBe('Database enrichment failed after schema context completed in raw-sources/warehouse/database schema/sync-1');
    expect(publicIngestOutputLine('Historic SQL local ingest requires a configured reader')).toBe(
      'query history local ingest requires a configured reader',
    );
  });
});
