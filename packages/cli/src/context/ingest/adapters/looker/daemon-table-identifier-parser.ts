import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import type {
  LookerParsedIdentifier,
  LookerTableIdentifierParseItem,
  LookerTableIdentifierParser,
} from './mapping.js';

export type KtxDaemonTableIdentifierHttpJsonRunner = (
  path: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface DaemonLookerTableIdentifierParserOptions {
  baseUrl: string;
  requestJson?: KtxDaemonTableIdentifierHttpJsonRunner;
}

export function createDaemonLookerTableIdentifierParser(
  options: DaemonLookerTableIdentifierParserOptions,
): LookerTableIdentifierParser {
  const requestJson = options.requestJson ?? postJson(options.baseUrl);
  return {
    async parse(items: LookerTableIdentifierParseItem[]): Promise<Record<string, LookerParsedIdentifier>> {
      const raw = await requestJson('/sql/parse-table-identifier', { items });
      if (!raw.results || typeof raw.results !== 'object' || Array.isArray(raw.results)) {
        throw new Error('ktx-daemon table identifier parser returned invalid results');
      }
      return raw.results as Record<string, LookerParsedIdentifier>;
    },
  };
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function postJson(baseUrl: string): KtxDaemonTableIdentifierHttpJsonRunner {
  return async (path, payload) =>
    new Promise((resolve, reject) => {
      const target = new URL(path.replace(/^\//, ''), normalizedBaseUrl(baseUrl));
      const body = JSON.stringify(payload);
      const client = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = client(
        target,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`ktx-daemon HTTP ${path} failed with ${statusCode}: ${text}`));
              return;
            }
            try {
              const parsed = JSON.parse(text) as unknown;
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                reject(new Error(`ktx-daemon HTTP ${path} returned non-object JSON`));
                return;
              }
              resolve(parsed as Record<string, unknown>);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
      request.end(body);
    });
}
