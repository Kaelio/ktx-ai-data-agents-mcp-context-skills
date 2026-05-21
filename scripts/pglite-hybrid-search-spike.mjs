import { readdir, readFile, realpath, rm, stat, writeFile, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const ktxRoot = resolve(scriptDir, '..');
const docsDir = join(ktxRoot, 'docs');
const reportPath = join(docsDir, 'hybrid-search-pglite-spike.md');

async function timed(label, fn) {
  const started = performance.now();
  const value = await fn();
  const durationMs = Number((performance.now() - started).toFixed(2));
  return { label, durationMs, value };
}

async function directoryBytes(path) {
  const entry = await stat(path);
  if (entry.isFile()) {
    return entry.size;
  }

  if (!entry.isDirectory()) {
    return 0;
  }

  const children = await readdir(path);
  const childSizes = await Promise.all(children.map((child) => directoryBytes(join(path, child))));
  return childSizes.reduce((sum, size) => sum + size, 0);
}

async function resolvePackageJson(packageName) {
  let currentDir = dirname(require.resolve(packageName));

  while (currentDir !== dirname(currentDir)) {
    const packageJsonPath = join(currentDir, 'package.json');

    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
      if (packageJson.name === packageName) {
        return { packageJsonPath, packageJson };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    currentDir = dirname(currentDir);
  }

  throw new Error(`Could not resolve package.json for ${packageName}`);
}

async function packageInfo(packageName) {
  const { packageJsonPath, packageJson } = await resolvePackageJson(packageName);
  const packageDir = await realpath(dirname(packageJsonPath));
  return {
    name: packageName,
    version: packageJson.version,
    path: relative(ktxRoot, packageDir),
    bytes: await directoryBytes(packageDir),
  };
}

async function createDb(PGlite, vector, pg_trgm, dataDir) {
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

  return db;
}

async function seed(db) {
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

  await db.query(`
    INSERT INTO spike_dictionary_values (connection_id, source_name, column_name, value)
    VALUES
      ('warehouse', 'orders', 'status', 'refunded'),
      ('warehouse', 'orders', 'status', 'paid'),
      ('warehouse', 'customers', 'region', 'emea')
    ON CONFLICT DO NOTHING
  `);
}

async function closeDb(db) {
  if (typeof db.close === 'function') {
    await db.close();
  }
}

async function main() {
  const importTimer = await timed('dynamic import @electric-sql/pglite', async () => {
    const [{ PGlite }, { vector }, { pg_trgm }] = await Promise.all([
      import('@electric-sql/pglite'),
      import('@electric-sql/pglite/vector'),
      import('@electric-sql/pglite/contrib/pg_trgm'),
    ]);
    return { PGlite, vector, pg_trgm };
  });

  const { PGlite, vector, pg_trgm } = importTimer.value;
  const tempDir = await mkdtemp(join(tmpdir(), 'ktx-pglite-report-'));
  const dataDir = join(tempDir, 'pgdata');

  let db;
  let reopened;

  try {
    const createTimer = await timed('create persistent PGlite database and load extensions', async () => {
      db = await createDb(PGlite, vector, pg_trgm, dataDir);
      return true;
    });

    const seedTimer = await timed('seed hybrid search fixture', async () => seed(db));

    const ftsTimer = await timed('Postgres FTS query', () =>
      db.query(
        `
          SELECT id
          FROM spike_documents
          WHERE to_tsvector('english', search_text) @@ websearch_to_tsquery('english', $1)
          ORDER BY ts_rank_cd(to_tsvector('english', search_text), websearch_to_tsquery('english', $1)) DESC, id ASC
          LIMIT 1
        `,
        ['paid orders'],
      ),
    );

    const vectorTimer = await timed('pgvector cosine query', () =>
      db.query(
        `
          SELECT id, 1 - (embedding <=> $1::vector) AS similarity
          FROM spike_documents
          ORDER BY embedding <=> $1::vector, id ASC
          LIMIT 1
        `,
        [JSON.stringify([1, 0, 0])],
      ),
    );

    const trigramTimer = await timed('pg_trgm dictionary query', () =>
      db.query(
        `
          SELECT connection_id || '/' || source_name AS id, value, similarity(value, $1) AS score
          FROM spike_dictionary_values
          WHERE similarity(value, $1) > 0
          ORDER BY score DESC, id ASC, value ASC
          LIMIT 1
        `,
        ['refund'],
      ),
    );

    const sameInstanceTimer = await timed('same instance parallel reads', () =>
      Promise.all(Array.from({ length: 4 }, () => db.query('SELECT COUNT(*)::int AS count FROM spike_documents'))),
    );

    let secondOpenStatus = 'opened';
    let secondOpenMessage = 'Second direct opener executed SELECT 1.';
    let second;
    try {
      second = await createDb(PGlite, vector, pg_trgm, dataDir);
      await second.query('SELECT 1');
    } catch (error) {
      secondOpenStatus = 'blocked';
      secondOpenMessage = error instanceof Error ? error.message : String(error);
    } finally {
      if (second) {
        await closeDb(second);
      }
    }

    await closeDb(db);
    db = undefined;

    const reopenTimer = await timed('reopen persistent PGlite database', async () => {
      reopened = await createDb(PGlite, vector, pg_trgm, dataDir);
      return reopened.query('SELECT COUNT(*)::int AS count FROM spike_documents');
    });

    const packages = await Promise.all([
      packageInfo('@electric-sql/pglite'),
      packageInfo('@electric-sql/pglite-socket'),
    ]);

    const result = {
      generatedAt: new Date().toISOString(),
      node: process.version,
      packages,
      timingsMs: {
        import: importTimer.durationMs,
        createAndExtensions: createTimer.durationMs,
        seed: seedTimer.durationMs,
        ftsQuery: ftsTimer.durationMs,
        vectorQuery: vectorTimer.durationMs,
        trigramQuery: trigramTimer.durationMs,
        sameInstanceParallelReads: sameInstanceTimer.durationMs,
        reopen: reopenTimer.durationMs,
      },
      topResults: {
        fts: ftsTimer.value.rows[0]?.id ?? null,
        vector: vectorTimer.value.rows[0]?.id ?? null,
        trigram: trigramTimer.value.rows[0]?.id ?? null,
        persistedRowCount: reopenTimer.value.rows[0]?.count ?? null,
      },
      concurrency: {
        sameInstanceReadCounts: sameInstanceTimer.value.map((queryResult) => queryResult.rows[0]?.count ?? null),
        secondDirectOpenStatus: secondOpenStatus,
        secondDirectOpenMessage: secondOpenMessage,
      },
    };

    const totalPackageBytes = packages.reduce((sum, pkg) => sum + pkg.bytes, 0);
    const recommendation =
      secondOpenStatus === 'opened'
        ? 'Prototype a PGlite backend behind an explicit owner process or socket before exposing CLI plus MCP concurrent access.'
        : 'Use a socket or owner-process architecture for any PGlite backend prototype because direct second opener access was blocked.';

    const markdown = `# Hybrid Search PGlite Spike

Generated: ${result.generatedAt}

## Summary

PGlite loaded in Node ${result.node}, enabled vector and pg_trgm extensions, executed Postgres FTS, pgvector cosine ranking, pg_trgm dictionary ranking, and reopened a persistent filesystem database.

Recommendation: ${recommendation}

## Package Footprint

| Package | Version | Approx bytes | Resolved path |
| --- | --- | ---: | --- |
${packages.map((pkg) => `| \`${pkg.name}\` | \`${pkg.version}\` | ${pkg.bytes} | \`${pkg.path}\` |`).join('\n')}

Total measured package bytes: ${totalPackageBytes}

## Timings

| Probe | Duration ms |
| --- | ---: |
${Object.entries(result.timingsMs)
  .map(([name, ms]) => `| ${name} | ${ms} |`)
  .join('\n')}

## Search Feature Results

| Probe | Top result |
| --- | --- |
| Postgres FTS | \`${result.topResults.fts}\` |
| pgvector cosine | \`${result.topResults.vector}\` |
| pg_trgm dictionary | \`${result.topResults.trigram}\` |
| Reopened persisted row count | \`${result.topResults.persistedRowCount}\` |

## Concurrency Observation

Same-instance parallel read counts: \`${result.concurrency.sameInstanceReadCounts.join(', ')}\`

Second direct opener status: \`${result.concurrency.secondDirectOpenStatus}\`

Second direct opener message:

\`\`\`text
${result.concurrency.secondDirectOpenMessage}
\`\`\`

## Decision

The SQLite backend remains the production default. The next PGlite step, if approved, is an owner-process or socket-backed prototype that reuses the existing \`SearchBackendCapabilities\` and backend conformance helpers without changing the public CLI surface.
`;

    await writeFile(reportPath, markdown);
    process.stdout.write(`Wrote ${relative(process.cwd(), reportPath)}\n`);
    process.stdout.write(JSON.stringify(result, null, 2));
    process.stdout.write('\n');
  } finally {
    if (db) {
      await closeDb(db);
    }
    if (reopened) {
      await closeDb(reopened);
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
