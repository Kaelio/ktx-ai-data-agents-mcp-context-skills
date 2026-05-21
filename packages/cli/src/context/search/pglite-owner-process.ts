import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite/vector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Client, type ClientConfig, type QueryResult, type QueryResultRow } from 'pg';
import type { SearchBackendCapabilities } from './types.js';

export const PGLITE_OWNER_PROCESS_BACKEND_CAPABILITIES = {
  fts: true,
  vector: true,
  fuzzy: true,
  jsonSearch: true,
  arraySearch: false,
} satisfies SearchBackendCapabilities;

export interface KtxPGliteOwnerProcessOptions {
  dataDir: string;
  host: string;
  port: number;
  inspect?: boolean;
  maxConnections?: number;
}

export class KtxPGliteOwnerProcess {
  readonly dataDir: string;
  readonly host: string;
  readonly port: number;

  #db: PGliteInterface;
  #server: PGLiteSocketServer;
  #stopped = false;

  private constructor(options: KtxPGliteOwnerProcessOptions, db: PGliteInterface, server: PGLiteSocketServer) {
    this.dataDir = options.dataDir;
    this.host = options.host;
    this.port = options.port;
    this.#db = db;
    this.#server = server;
  }

  static async start(options: KtxPGliteOwnerProcessOptions): Promise<KtxPGliteOwnerProcess> {
    const db = await PGlite.create({
      dataDir: options.dataDir,
      extensions: {
        vector,
        pg_trgm,
      },
    });

    let server: PGLiteSocketServer | undefined;

    try {
      await db.exec(`
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
      `);

      server = new PGLiteSocketServer({
        db,
        host: options.host,
        port: options.port,
        inspect: options.inspect ?? false,
        maxConnections: options.maxConnections ?? 100,
      });

      await server.start();

      return new KtxPGliteOwnerProcess(options, db, server);
    } catch (error) {
      await server?.stop().catch(() => undefined);
      await db.close().catch(() => undefined);
      throw error;
    }
  }

  connectionConfig(): ClientConfig {
    return {
      host: this.host,
      port: this.port,
      user: 'postgres',
      database: 'postgres',
      application_name: 'ktx-pglite-owner-prototype',
      connectionTimeoutMillis: 5_000,
    };
  }

  async connect(): Promise<Client> {
    const client = new Client(this.connectionConfig());
    await client.connect();
    return client;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    const client = await this.connect();
    try {
      return await client.query<T>(text, values ? [...values] : undefined);
    } finally {
      await client.end();
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }

    this.#stopped = true;
    await this.#server.stop();
    await this.#db.close();
  }
}
