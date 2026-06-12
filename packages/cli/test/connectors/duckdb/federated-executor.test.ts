import { describe, expect, it } from 'vitest';
import {
  buildAttachStatements,
  attachTypeForDriver,
} from '../../../src/connectors/duckdb/federated-executor.js';
import type { FederatedMember } from '../../../src/context/connections/federation.js';

const member = (connectionId: string, driver: string, url: string): FederatedMember =>
  ({ connectionId, driver, config: { driver, url } as never });

describe('attachTypeForDriver', () => {
  it('maps drivers to DuckDB attach extension types', () => {
    expect(attachTypeForDriver('postgres')).toBe('postgres');
    expect(attachTypeForDriver('mysql')).toBe('mysql');
    expect(attachTypeForDriver('sqlite')).toBe('sqlite');
  });

  it('throws for an unsupported driver', () => {
    expect(() => attachTypeForDriver('snowflake')).toThrow(/cannot be attached/i);
  });
});

describe('buildAttachStatements', () => {
  it('emits READ_ONLY ATTACH aliased by connectionId, resolving env refs', () => {
    const stmts = buildAttachStatements(
      [
        member('pg_books', 'postgres', 'env:PG_URL'),
        member('sqlite_reviews', 'sqlite', '/data/reviews.db'),
      ],
      { PG_URL: 'postgresql://localhost/books' },
    );
    expect(stmts).toEqual([
      "INSTALL postgres; LOAD postgres;",
      "ATTACH 'postgresql://localhost/books' AS pg_books (TYPE postgres, READ_ONLY);",
      "INSTALL sqlite; LOAD sqlite;",
      "ATTACH '/data/reviews.db' AS sqlite_reviews (TYPE sqlite, READ_ONLY);",
    ]);
  });

  it('throws if a member url is missing', () => {
    expect(() =>
      buildAttachStatements([{ connectionId: 'pg', driver: 'postgres', config: { driver: 'postgres' } as never }], {}),
    ).toThrow(/no url/i);
  });

  it('escapes single quotes in a member url', () => {
    const stmts = buildAttachStatements(
      [member('pg', 'postgres', "postgresql://u:it's@h/db")],
      {},
    );
    expect(stmts[1]).toBe("ATTACH 'postgresql://u:it''s@h/db' AS pg (TYPE postgres, READ_ONLY);");
  });
});
