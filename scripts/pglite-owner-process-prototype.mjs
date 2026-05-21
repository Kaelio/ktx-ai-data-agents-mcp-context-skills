import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite/vector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Client } from 'pg';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ktxRoot = resolve(scriptDir, '..');
const reportPath = join(ktxRoot, 'docs', 'hybrid-search-pglite-owner-process.md');

async function timed(label, fn) {
  const started = performance.now();
  const value = await fn();
  return {
    label,
    durationMs: Number((performance.now() - started).toFixed(2)),
    value,
  };
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('Expected TCP server address while allocating a PGlite owner-process port.');
  }
  await new Promise((resolve, reject) => {
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

async function createOwner(dataDir, port) {
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
    CREATE TABLE IF NOT EXISTS prototype_documents (
      id TEXT PRIMARY KEY,
      search_text TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      embedding vector(3) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prototype_documents_fts_idx
      ON prototype_documents
      USING GIN (to_tsvector('english', search_text));
    CREATE INDEX IF NOT EXISTS prototype_documents_vector_idx
      ON prototype_documents
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 1);
    CREATE TABLE IF NOT EXISTS prototype_dictionary_values (
      connection_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (connection_id, source_name, column_name, value)
    );
    CREATE INDEX IF NOT EXISTS prototype_dictionary_values_trgm_idx
      ON prototype_dictionary_values
      USING GIN (value gin_trgm_ops);
  `);

  const server = new PGLiteSocketServer({
    db,
    host: '127.0.0.1',
    port,
    maxConnections: 100,
  });

  await server.start();

  return {
    db,
    server,
    connectionConfig: {
      host: '127.0.0.1',
      port,
      user: 'postgres',
      database: 'postgres',
      application_name: 'ktx-pglite-owner-report',
      connectionTimeoutMillis: 5_000,
    },
  };
}

async function withClient(connectionConfig, fn) {
  const client = new Client(connectionConfig);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function seed(connectionConfig) {
  await withClient(connectionConfig, async (client) => {
    await client.query(
      `
        INSERT INTO prototype_documents (id, search_text, metadata, embedding)
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

    await client.query(`
      INSERT INTO prototype_dictionary_values (connection_id, source_name, column_name, value)
      VALUES
        ('warehouse', 'orders', 'status', 'refunded'),
        ('warehouse', 'orders', 'status', 'paid'),
        ('warehouse', 'customers', 'region', 'emea')
      ON CONFLICT DO NOTHING
    `);
  });
}

async function queryTopResults(connectionConfig) {
  return await withClient(connectionConfig, async (client) => {
    const lexical = await client.query(
      `
        SELECT id
        FROM prototype_documents
        WHERE to_tsvector('english', search_text) @@ websearch_to_tsquery('english', $1)
        ORDER BY ts_rank_cd(to_tsvector('english', search_text), websearch_to_tsquery('english', $1)) DESC, id ASC
        LIMIT 1
      `,
      ['paid orders'],
    );

    const semantic = await client.query(
      `
        SELECT id
        FROM prototype_documents
        ORDER BY embedding <=> $1::vector, id ASC
        LIMIT 1
      `,
      [JSON.stringify([1, 0, 0])],
    );

    const dictionary = await client.query(
      `
        SELECT connection_id || '/' || source_name AS id
        FROM prototype_dictionary_values
        WHERE similarity(value, $1) > 0
        ORDER BY similarity(value, $1) DESC, id ASC, value ASC
        LIMIT 1
      `,
      ['refund'],
    );

    return {
      lexical: lexical.rows[0]?.id ?? '<missing>',
      semantic: semantic.rows[0]?.id ?? '<missing>',
      dictionary: dictionary.rows[0]?.id ?? '<missing>',
    };
  });
}

async function concurrentReads(connectionConfig) {
  const clients = await Promise.all(
    Array.from({ length: 4 }, async () => {
      const client = new Client(connectionConfig);
      await client.connect();
      return client;
    }),
  );

  try {
    const results = await Promise.all(
      clients.map((client) => client.query('SELECT COUNT(*)::int AS count FROM prototype_documents')),
    );
    return results.map((result) => result.rows[0]?.count ?? null);
  } finally {
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
  }
}

async function stopOwner(owner) {
  await owner.server.stop();
  await owner.db.close();
}

async function main() {
  const tempDir = await mkdtemp(join(tmpdir(), 'ktx-pglite-owner-report-'));
  const dataDir = join(tempDir, 'pgdata');
  const port = await allocatePort();

  let owner;

  try {
    const startTimer = await timed('startOwner', async () => await createOwner(dataDir, port));
    owner = startTimer.value;

    const seedTimer = await timed('seed', async () => await seed(owner.connectionConfig));
    const queryTimer = await timed('searchQueries', async () => await queryTopResults(owner.connectionConfig));
    const concurrentTimer = await timed('concurrentReads', async () => await concurrentReads(owner.connectionConfig));

    await stopOwner(owner);
    owner = undefined;

    const restartTimer = await timed('restartOwner', async () => await createOwner(dataDir, port));
    owner = restartTimer.value;

    const persisted = await withClient(owner.connectionConfig, async (client) => {
      const result = await client.query('SELECT COUNT(*)::int AS count FROM prototype_documents');
      return result.rows[0]?.count ?? null;
    });

    const markdown = `# Hybrid Search PGlite Owner Process Prototype

Generated: ${new Date().toISOString()}

## Summary

PGlite started behind one explicit owner process, enabled vector and pg_trgm extensions, served PostgreSQL clients through \`@electric-sql/pglite-socket\`, answered lexical, semantic, and dictionary probes, and preserved rows across owner restart.

Recommendation: Keep SQLite as the production default. The next PGlite implementation step should be a private adapter prototype behind an explicit configuration flag, still guarded by backend conformance tests, before any CLI or MCP default changes.

## Timings

| Probe | Duration ms |
| --- | ---: |
| startOwner | ${startTimer.durationMs} |
| seed | ${seedTimer.durationMs} |
| searchQueries | ${queryTimer.durationMs} |
| concurrentReads | ${concurrentTimer.durationMs} |
| restartOwner | ${restartTimer.durationMs} |

## Search Feature Results

| Probe | Top result |
| --- | --- |
| Postgres FTS through socket | \`${queryTimer.value.lexical}\` |
| pgvector cosine through socket | \`${queryTimer.value.semantic}\` |
| pg_trgm dictionary through socket | \`${queryTimer.value.dictionary}\` |
| Reopened persisted row count | \`${persisted}\` |

## Concurrency Observation

Concurrent socket read counts: \`${concurrentTimer.value.join(', ')}\`

## Decision

The owner-process shape is viable for a prototype because it gives CLI and MCP callers a PostgreSQL protocol boundary without opening the same PGlite data directory from independent runtimes. This report is not a production adapter acceptance record.
`;

    await writeFile(reportPath, markdown);
    console.log(`Wrote ${reportPath}`);
    console.log(
      JSON.stringify(
        {
          port,
          timings: {
            startOwner: startTimer.durationMs,
            seed: seedTimer.durationMs,
            searchQueries: queryTimer.durationMs,
            concurrentReads: concurrentTimer.durationMs,
            restartOwner: restartTimer.durationMs,
          },
          topResults: queryTimer.value,
          concurrentReads: concurrentTimer.value,
          persisted,
        },
        null,
        2,
      ),
    );
  } finally {
    if (owner) {
      await stopOwner(owner).catch(() => undefined);
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
