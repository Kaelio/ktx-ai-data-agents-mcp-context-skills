import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite/vector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSearchBackendCapabilities, assertSearchBackendConformanceCase } from './backend-conformance.test-utils.js';
import type { SearchBackendCapabilities } from '../../../src/context/search/types.js';

type PGliteDb = PGliteInterface;

const PGLITE_SPIKE_CAPABILITIES = {
  fts: true,
  vector: true,
  fuzzy: true,
  jsonSearch: true,
  arraySearch: false,
} satisfies SearchBackendCapabilities;

async function createSpikeDb(dataDir: string): Promise<PGliteDb> {
  const db = await PGlite.create({
    dataDir,
    extensions: {
      vector,
      pg_trgm,
    },
  });

  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  `);

  return db;
}

async function createSchema(db: PGliteDb): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS spike_documents (
      id TEXT PRIMARY KEY,
      search_text TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      embedding vector(3) NOT NULL
    );

    CREATE INDEX IF NOT EXISTS spike_documents_fts_idx
      ON spike_documents
      USING GIN (to_tsvector('english', search_text));

    CREATE INDEX IF NOT EXISTS spike_documents_vector_idx
      ON spike_documents
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 1);

    CREATE TABLE IF NOT EXISTS spike_dictionary_values (
      connection_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (connection_id, source_name, column_name, value)
    );

    CREATE INDEX IF NOT EXISTS spike_dictionary_values_trgm_idx
      ON spike_dictionary_values
      USING GIN (value gin_trgm_ops);
  `);
}

async function seedSearchFixture(db: PGliteDb): Promise<void> {
  await db.query(
    `
      INSERT INTO spike_documents (id, search_text, metadata, embedding)
      VALUES
        ($1, $2, $3::jsonb, $4::vector),
        ($5, $6, $7::jsonb, $8::vector),
        ($9, $10, $11::jsonb, $12::vector)
      ON CONFLICT (id) DO UPDATE
      SET search_text = EXCLUDED.search_text,
          metadata = EXCLUDED.metadata,
          embedding = EXCLUDED.embedding
    `,
    [
      'warehouse/orders',
      'orders paid revenue refund status customer',
      JSON.stringify({ connectionId: 'warehouse', sourceName: 'orders' }),
      JSON.stringify([1, 0, 0]),
      'finance/orders',
      'orders finance bookings gross margin',
      JSON.stringify({ connectionId: 'finance', sourceName: 'orders' }),
      JSON.stringify([0.72, 0.28, 0]),
      'warehouse/customers',
      'customers accounts lifecycle region',
      JSON.stringify({ connectionId: 'warehouse', sourceName: 'customers' }),
      JSON.stringify([0, 1, 0]),
    ],
  );

  await db.query(
    `
      INSERT INTO spike_dictionary_values (connection_id, source_name, column_name, value)
      VALUES
        ('warehouse', 'orders', 'status', 'refunded'),
        ('warehouse', 'orders', 'status', 'paid'),
        ('warehouse', 'customers', 'region', 'emea')
      ON CONFLICT DO NOTHING
    `,
  );
}

async function closeDb(db: PGliteDb): Promise<void> {
  await db.close();
}

describe('PGlite hybrid search spike', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-pglite-search-spike-'));
    dataDir = join(tempDir, 'pgdata');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('documents PGlite search backend capabilities', () => {
    assertSearchBackendCapabilities({
      backendName: 'pglite-spike',
      capabilities: PGLITE_SPIKE_CAPABILITIES,
      expected: {
        fts: true,
        vector: true,
        fuzzy: true,
        jsonSearch: true,
        arraySearch: false,
      },
    });
  });

  it('supports FTS, pgvector ordering, and pg_trgm dictionary lookup', async () => {
    const db = await createSpikeDb(dataDir);

    try {
      await createSchema(db);
      await seedSearchFixture(db);

      const lexical = await db.query<{ id: string; score: number }>(
        `
          SELECT
            id,
            ts_rank_cd(to_tsvector('english', search_text), websearch_to_tsquery('english', $1)) AS score
          FROM spike_documents
          WHERE to_tsvector('english', search_text) @@ websearch_to_tsquery('english', $1)
          ORDER BY score DESC, id ASC
          LIMIT 2
        `,
        ['paid orders'],
      );

      assertSearchBackendConformanceCase({
        backendName: 'pglite-spike',
        surface: 'semantic-layer',
        caseName: 'postgres fts lexical ranking',
        results: lexical.rows.map((row) => ({
          id: row.id,
          score: row.score,
          matchReasons: ['lexical'],
        })),
        expectedTopIds: ['warehouse/orders'],
        expectedReasonsById: {
          'warehouse/orders': ['lexical'],
        },
      });

      const semantic = await db.query<{ id: string; similarity: number }>(
        `
          SELECT
            id,
            1 - (embedding <=> $1::vector) AS similarity
          FROM spike_documents
          ORDER BY embedding <=> $1::vector, id ASC
          LIMIT 2
        `,
        [JSON.stringify([1, 0, 0])],
      );

      assertSearchBackendConformanceCase({
        backendName: 'pglite-spike',
        surface: 'semantic-layer',
        caseName: 'pgvector cosine ranking',
        results: semantic.rows.map((row) => ({
          id: row.id,
          score: row.similarity,
          matchReasons: ['semantic'],
        })),
        expectedTopIds: ['warehouse/orders'],
        expectedReasonsById: {
          'warehouse/orders': ['semantic'],
        },
      });

      const dictionary = await db.query<{ id: string; value: string; score: number }>(
        `
          SELECT
            connection_id || '/' || source_name AS id,
            value,
            similarity(value, $1) AS score
          FROM spike_dictionary_values
          WHERE similarity(value, $1) > 0
          ORDER BY score DESC, id ASC, value ASC
          LIMIT 2
        `,
        ['refund'],
      );

      assertSearchBackendConformanceCase({
        backendName: 'pglite-spike',
        surface: 'semantic-layer',
        caseName: 'pg_trgm dictionary ranking',
        results: dictionary.rows.map((row) => ({
          id: row.id,
          score: row.score,
          matchReasons: ['dictionary'],
          dictionaryMatches: [{ column: 'status', values: [row.value] }],
        })),
        expectedTopIds: ['warehouse/orders'],
        expectedReasonsById: {
          'warehouse/orders': ['dictionary'],
        },
        expectedDictionaryMatchesById: {
          'warehouse/orders': [{ column: 'status', values: ['refunded'] }],
        },
      });
    } finally {
      await closeDb(db);
    }
  });

  it('persists indexed rows after reopening the filesystem database', async () => {
    const first = await createSpikeDb(dataDir);

    try {
      await createSchema(first);
      await seedSearchFixture(first);
    } finally {
      await closeDb(first);
    }

    const second = await createSpikeDb(dataDir);

    try {
      const persisted = await second.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM spike_documents WHERE metadata->>'connectionId' = $1",
        ['warehouse'],
      );

      expect(persisted.rows[0]).toEqual({ count: 2 });
    } finally {
      await closeDb(second);
    }
  });

  it('records direct concurrency behavior without assuming Postgres server parity', async () => {
    const db = await createSpikeDb(dataDir);

    try {
      await createSchema(db);
      await seedSearchFixture(db);

      const reads = await Promise.all(
        Array.from({ length: 4 }, () =>
          db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM spike_documents'),
        ),
      );

      expect(reads.map((result) => result.rows[0]?.count)).toEqual([3, 3, 3, 3]);

      let secondOpenStatus: 'opened' | 'blocked' = 'opened';
      let second: PGliteDb | undefined;

      try {
        second = await createSpikeDb(dataDir);
        await second.query('SELECT 1');
      } catch {
        secondOpenStatus = 'blocked';
      } finally {
        if (second) {
          await closeDb(second);
        }
      }

      expect(['opened', 'blocked']).toContain(secondOpenStatus);
    } finally {
      await closeDb(db);
    }
  });
});
