import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { executeFederatedQuery } from '../../../src/connectors/duckdb/federated-executor.js';
import type { FederatedMember } from '../../../src/context/connections/federation.js';

describe('federated cross-catalog join (live DuckDB)', () => {
  it('joins two sqlite catalogs and enforces read-only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ktx-fed-'));
    const booksPath = join(dir, 'books.db');
    const reviewsPath = join(dir, 'reviews.db');

    const books = new Database(booksPath);
    books.exec("CREATE TABLE books (id INTEGER, title TEXT); INSERT INTO books VALUES (1, 'Dune'), (2, 'Foundation');");
    books.close();

    const reviews = new Database(reviewsPath);
    reviews.exec('CREATE TABLE reviews (book_id INTEGER, stars INTEGER); INSERT INTO reviews VALUES (1, 5), (1, 4), (2, 2);');
    reviews.close();

    const members: FederatedMember[] = [
      { connectionId: 'books_db', driver: 'sqlite', config: { driver: 'sqlite', url: booksPath } as never },
      { connectionId: 'reviews_db', driver: 'sqlite', config: { driver: 'sqlite', url: reviewsPath } as never },
    ];

    try {
      const result = await executeFederatedQuery(members, {
        connectionId: '_ktx_federated',
        connection: undefined,
        sql: 'SELECT b.title, AVG(r.stars) AS avg_stars FROM books_db.books b JOIN reviews_db.reviews r ON b.id = r.book_id GROUP BY b.title ORDER BY b.title',
      });
      expect(result.headers).toEqual(['title', 'avg_stars']);
      // ORDER BY title: Dune, Foundation
      expect(result.rows.map((row) => row[0])).toEqual(['Dune', 'Foundation']);
      expect(Number(result.rows[0][1])).toBeCloseTo(4.5); // Dune: (5+4)/2
      expect(Number(result.rows[1][1])).toBeCloseTo(2.0); // Foundation: 2/1

      await expect(
        executeFederatedQuery(members, {
          connectionId: '_ktx_federated',
          connection: undefined,
          sql: "INSERT INTO books_db.books VALUES (2, 'Hack')",
        }),
      ).rejects.toThrow(/read-only/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
