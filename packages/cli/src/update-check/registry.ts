import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { z } from 'zod';

const DIST_TAGS_URL = new URL('https://registry.npmjs.org/-/package/@kaelio/ktx/dist-tags');
const distTagsSchema = z.record(z.string(), z.string());

function parseDistTags(raw: string): Record<string, string> {
  return distTagsSchema.parse(JSON.parse(raw));
}

export function fetchDistTags(): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      DIST_TAGS_URL,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`npm dist-tags request failed with ${statusCode}: ${text}`));
            return;
          }
          try {
            resolve(parseDistTags(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on('socket', (socket) => {
      socket.unref();
    });
    request.on('error', reject);
    request.setTimeout(5000, () => {
      request.destroy(new Error('npm dist-tags request timed out'));
    });
    request.end();
  });
}
