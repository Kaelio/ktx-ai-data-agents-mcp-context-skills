import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSearchBackendConformanceCase } from '../../context/search/backend-conformance.test-utils.js';
import { KtxPGliteOwnerProcess } from './pglite-owner-process.js';

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('Expected TCP server address while allocating a PGlite owner-process port.');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return address.port;
}

async function createHybridSearchFixture(owner: KtxPGliteOwnerProcess): Promise<void> {
  await owner.query(`
    CREATE TABLE prototype_documents (
      id TEXT PRIMARY KEY,
      search_text TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      embedding vector(3) NOT NULL
    );

    CREATE INDEX prototype_documents_fts_idx
      ON prototype_documents
      USING GIN (to_tsvector('english', search_text));

    CREATE INDEX prototype_documents_vector_idx
      ON prototype_documents
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 1);

    CREATE TABLE prototype_dictionary_values (
      connection_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (connection_id, source_name, column_name, value)
    );

    CREATE INDEX prototype_dictionary_values_trgm_idx
      ON prototype_dictionary_values
      USING GIN (value gin_trgm_ops);
  `);
}

async function seedHybridSearchFixture(owner: KtxPGliteOwnerProcess): Promise<void> {
  await owner.query(
    `
      INSERT INTO prototype_documents (id, search_text, metadata, embedding)
      VALUES
        ($1, $2, $3::jsonb, $4::vector),
        ($5, $6, $7::jsonb, $8::vector),
        ($9, $10, $11::jsonb, $12::vector)
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

  await owner.query(`
    INSERT INTO prototype_dictionary_values (connection_id, source_name, column_name, value)
    VALUES
      ('warehouse', 'orders', 'status', 'refunded'),
      ('warehouse', 'orders', 'status', 'paid'),
      ('warehouse', 'customers', 'region', 'emea')
  `);
}

describe('KtxPGliteOwnerProcess', () => {
  let tempDir: string;
  let dataDir: string;
  let port: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-pglite-owner-process-'));
    dataDir = join(tempDir, 'pgdata');
    port = await allocatePort();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('starts a socket owner process and serves PostgreSQL clients', async () => {
    const owner = await KtxPGliteOwnerProcess.start({
      dataDir,
      host: '127.0.0.1',
      port,
    });

    try {
      await owner.query(`
        CREATE TABLE owner_process_smoke (
          id TEXT PRIMARY KEY,
          search_text TEXT NOT NULL,
          embedding vector(3) NOT NULL
        );

        INSERT INTO owner_process_smoke (id, search_text, embedding)
        VALUES
          ('orders', 'orders paid revenue', '[1,0,0]'::vector),
          ('customers', 'customers region lifecycle', '[0,1,0]'::vector);
      `);

      const client = new Client(owner.connectionConfig());
      await client.connect();

      try {
        const result = await client.query<{ id: string }>(`
          SELECT id
          FROM owner_process_smoke
          ORDER BY embedding <=> '[1,0,0]'::vector, id ASC
          LIMIT 1
        `);

        expect(result.rows).toEqual([{ id: 'orders' }]);
      } finally {
        await client.end();
      }
    } finally {
      await owner.stop();
    }
  });

  it('runs lexical, semantic, and dictionary conformance probes through socket clients', async () => {
    const owner = await KtxPGliteOwnerProcess.start({
      dataDir,
      host: '127.0.0.1',
      port,
    });

    try {
      await createHybridSearchFixture(owner);
      await seedHybridSearchFixture(owner);

      const lexical = await owner.query<{ id: string; score: number }>(
        `
          SELECT
            id,
            ts_rank_cd(to_tsvector('english', search_text), websearch_to_tsquery('english', $1)) AS score
          FROM prototype_documents
          WHERE to_tsvector('english', search_text) @@ websearch_to_tsquery('english', $1)
          ORDER BY score DESC, id ASC
          LIMIT 2
        `,
        ['paid orders'],
      );

      assertSearchBackendConformanceCase({
        backendName: 'pglite-owner-process',
        surface: 'semantic-layer',
        caseName: 'socket postgres fts lexical ranking',
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

      const semantic = await owner.query<{ id: string; similarity: number }>(
        `
          SELECT
            id,
            1 - (embedding <=> $1::vector) AS similarity
          FROM prototype_documents
          ORDER BY embedding <=> $1::vector, id ASC
          LIMIT 2
        `,
        [JSON.stringify([1, 0, 0])],
      );

      assertSearchBackendConformanceCase({
        backendName: 'pglite-owner-process',
        surface: 'semantic-layer',
        caseName: 'socket pgvector semantic ranking',
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

      const dictionary = await owner.query<{ id: string; value: string; score: number }>(
        `
          SELECT
            connection_id || '/' || source_name AS id,
            value,
            similarity(value, $1) AS score
          FROM prototype_dictionary_values
          WHERE similarity(value, $1) > 0
          ORDER BY score DESC, id ASC, value ASC
          LIMIT 2
        `,
        ['refund'],
      );

      assertSearchBackendConformanceCase({
        backendName: 'pglite-owner-process',
        surface: 'semantic-layer',
        caseName: 'socket pg_trgm dictionary ranking',
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
      await owner.stop();
    }
  });

  it('persists indexed rows after stopping and restarting the owner process', async () => {
    const firstOwner = await KtxPGliteOwnerProcess.start({
      dataDir,
      host: '127.0.0.1',
      port,
    });

    try {
      await createHybridSearchFixture(firstOwner);
      await seedHybridSearchFixture(firstOwner);
    } finally {
      await firstOwner.stop();
    }

    const secondOwner = await KtxPGliteOwnerProcess.start({
      dataDir,
      host: '127.0.0.1',
      port,
    });

    try {
      const persisted = await secondOwner.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM prototype_documents WHERE metadata->>'connectionId' = $1",
        ['warehouse'],
      );

      expect(persisted.rows).toEqual([{ count: 2 }]);
    } finally {
      await secondOwner.stop();
    }
  });

  it('serves concurrent PostgreSQL clients through one owner process', async () => {
    const owner = await KtxPGliteOwnerProcess.start({
      dataDir,
      host: '127.0.0.1',
      port,
    });

    const clients: Client[] = [];

    try {
      await createHybridSearchFixture(owner);
      await seedHybridSearchFixture(owner);

      for (let index = 0; index < 4; index += 1) {
        const client = new Client(owner.connectionConfig());
        await client.connect();
        clients.push(client);
      }

      const results = await Promise.all(
        clients.map((client) =>
          client.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM prototype_documents'),
        ),
      );

      expect(results.map((result) => result.rows[0]?.count)).toEqual([3, 3, 3, 3]);
    } finally {
      await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
      await owner.stop();
    }
  });
});
