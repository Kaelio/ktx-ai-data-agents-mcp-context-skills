import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { federatedAttachTarget } from '../../../src/connectors/duckdb/federated-attach.js';
import type { FederatedMember } from '../../../src/context/connections/federation.js';

const member = (over: Partial<FederatedMember>): FederatedMember => ({
  connectionId: 'm',
  driver: 'sqlite',
  projectDir: '/proj',
  connection: { driver: 'sqlite' },
  ...over,
});

describe('federatedAttachTarget', () => {
  it('resolves a sqlite path: config to an absolute filesystem path against projectDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ktx-attach-'));
    writeFileSync(join(dir, 'reviews.db'), '');
    try {
      const target = federatedAttachTarget(
        member({ driver: 'sqlite', projectDir: dir, connection: { driver: 'sqlite', path: './reviews.db' } }),
        {},
      );
      expect(target).toBe(join(dir, 'reviews.db'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a sqlite file:// url to a filesystem path', () => {
    const target = federatedAttachTarget(
      member({ driver: 'sqlite', connection: { driver: 'sqlite', url: 'file:///data/reviews.db' } }),
      {},
    );
    expect(target).toBe('/data/reviews.db');
  });

  it('builds a libpq connection string for postgres from host/database/user', () => {
    const target = federatedAttachTarget(
      member({
        driver: 'postgres',
        connection: { driver: 'postgres', host: 'h', port: 5433, database: 'books', username: 'u', password: 'p' },
      }),
      {},
    );
    expect(target).toContain('host=h');
    expect(target).toContain('port=5433');
    expect(target).toContain('dbname=books');
    expect(target).toContain('user=u');
    expect(target).toContain('password=p');
  });

  it('passes a postgres url through as the connection string', () => {
    const target = federatedAttachTarget(
      member({ driver: 'postgres', connection: { driver: 'postgres', url: 'env:PG_URL' } }),
      { PG_URL: 'postgresql://localhost/books' },
    );
    expect(target).toBe('postgresql://localhost/books');
  });

  it('builds a mysql connection string from host/database/user', () => {
    const target = federatedAttachTarget(
      member({
        driver: 'mysql',
        connection: { driver: 'mysql', host: 'h', port: 3307, database: 'app', username: 'u', password: 'p' },
      }),
      {},
    );
    expect(target).toContain('host=h');
    expect(target).toContain('port=3307');
    expect(target).toContain('database=app');
    expect(target).toContain('user=u');
    expect(target).toContain('password=p');
  });

  it('throws for an unsupported driver', () => {
    expect(() => federatedAttachTarget(member({ driver: 'snowflake', connection: { driver: 'snowflake' } }), {})).toThrow(
      /cannot be attached/i,
    );
  });
});
