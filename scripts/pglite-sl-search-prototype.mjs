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
const reportPath = join(ktxRoot, 'docs', 'hybrid-search-pglite-sl-adapter-prototype.md');

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
    throw new Error('Expected TCP server address while allocating a PGlite SL prototype port.');
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
    extensions: { vector, pg_trgm },
  });

  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE TABLE prototype_sl_sources (
      connection_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      search_text TEXT NOT NULL,
      embedding vector(3),
      PRIMARY KEY (connection_id, source_name)
    );
    CREATE INDEX prototype_sl_sources_fts_idx
      ON prototype_sl_sources
      USING GIN (to_tsvector('english', search_text));
    CREATE INDEX prototype_sl_sources_vector_idx
      ON prototype_sl_sources
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 1);
    CREATE TABLE prototype_sl_dictionary_values (
      connection_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      value TEXT NOT NULL,
      value_lower TEXT NOT NULL,
      PRIMARY KEY (connection_id, source_name, column_name, value)
    );
    CREATE INDEX prototype_sl_dictionary_values_trgm_idx
      ON prototype_sl_dictionary_values
      USING GIN (value gin_trgm_ops);
  `);

  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port, maxConnections: 100 });
  await server.start();

  return {
    db,
    server,
    connectionConfig: {
      host: '127.0.0.1',
      port,
      user: 'postgres',
      database: 'postgres',
      application_name: 'ktx-pglite-sl-prototype-report',
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
        INSERT INTO prototype_sl_sources (connection_id, source_name, search_text, embedding)
        VALUES
          ($1, $2, $3, $4::vector),
          ($5, $6, $7, $8::vector),
          ($9, $10, $11, $12::vector)
      `,
      [
        'warehouse',
        'orders',
        'orders paid revenue refund status customer',
        JSON.stringify([1, 0, 0]),
        'finance',
        'orders',
        'orders finance bookings gross margin',
        JSON.stringify([0.72, 0.28, 0]),
        'warehouse',
        'customers',
        'customers accounts lifecycle region',
        JSON.stringify([0, 1, 0]),
      ],
    );

    await client.query(`
      INSERT INTO prototype_sl_dictionary_values (connection_id, source_name, column_name, value, value_lower)
      VALUES
        ('warehouse', 'orders', 'status', 'refunded', 'refunded'),
        ('warehouse', 'orders', 'status', 'paid', 'paid'),
        ('warehouse', 'customers', 'region', 'emea', 'emea')
    `);
  });
}

async function queryTopResults(connectionConfig) {
  return withClient(connectionConfig, async (client) => {
    const lexical = await client.query(
      `
        SELECT connection_id || '/' || source_name AS id
        FROM prototype_sl_sources
        WHERE to_tsvector('english', search_text) @@ websearch_to_tsquery('english', $1)
        ORDER BY ts_rank_cd(to_tsvector('english', search_text), websearch_to_tsquery('english', $1)) DESC, id ASC
        LIMIT 1
      `,
      ['paid revenue'],
    );

    const semantic = await client.query(
      `
        SELECT connection_id || '/' || source_name AS id
        FROM prototype_sl_sources
        ORDER BY embedding <=> $1::vector, id ASC
        LIMIT 1
      `,
      [JSON.stringify([1, 0, 0])],
    );

    const dictionary = await client.query(
      `
        SELECT connection_id || '/' || source_name AS id
        FROM prototype_sl_dictionary_values
        WHERE similarity(value, $1) > 0 OR value_lower LIKE '%' || lower($1) || '%'
        ORDER BY GREATEST(similarity(value, $1), CASE WHEN value_lower LIKE '%' || lower($1) || '%' THEN 0.75 ELSE 0 END) DESC,
                 id ASC,
                 value ASC
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

async function stopOwner(owner) {
  await owner.server.stop();
  await owner.db.close();
}

async function main() {
  const tempDir = await mkdtemp(join(tmpdir(), 'ktx-pglite-sl-prototype-report-'));
  const dataDir = join(tempDir, 'pgdata');
  const port = await allocatePort();
  let owner;

  try {
    const startTimer = await timed('startOwner', async () => createOwner(dataDir, port));
    owner = startTimer.value;
    const seedTimer = await timed('seedSemanticLayerIndex', async () => seed(owner.connectionConfig));
    const searchTimer = await timed('searchQueries', async () => queryTopResults(owner.connectionConfig));

    const markdown = `# Hybrid Search PGlite Semantic-Layer Adapter Prototype

Generated: ${new Date().toISOString()}

## Summary

PGlite served a semantic-layer-style search index through one owner process and PostgreSQL clients. The probe returned lexical, semantic, and dictionary top results through Postgres FTS, pgvector ordering, and pg_trgm matching.

Recommendation: Keep SQLite as the production default. The PGlite semantic-layer adapter remains private and explicitly opt-in until a separate plan decides runtime dependencies, long-lived owner lifecycle, and CLI/MCP routing.

## Timings

| Probe | Duration ms |
| --- | ---: |
| startOwner | ${startTimer.durationMs} |
| seedSemanticLayerIndex | ${seedTimer.durationMs} |
| searchQueries | ${searchTimer.durationMs} |

## Search Feature Results

| Probe | Top result |
| --- | --- |
| Postgres FTS through socket | \`${searchTimer.value.lexical}\` |
| pgvector cosine through socket | \`${searchTimer.value.semantic}\` |
| pg_trgm dictionary through socket | \`${searchTimer.value.dictionary}\` |

## Decision

The private adapter shape is viable for semantic-layer search prototypes. It is not a production backend acceptance record and does not change the default SQLite search path.
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
            searchQueries: searchTimer.durationMs,
          },
          topResults: searchTimer.value,
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
