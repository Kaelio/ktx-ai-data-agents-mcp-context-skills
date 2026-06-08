import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { z } from 'zod';

const GITHUB_REPO_URL = new URL('https://api.github.com/repos/Kaelio/ktx');
const DEFAULT_TIMEOUT_MS = 5000;
const githubRepoSchema = z.object({
  stargazers_count: z.number().int().nonnegative(),
});

type HttpsRequest = typeof httpsRequest;

function parseStarCount(raw: string): number {
  return githubRepoSchema.parse(JSON.parse(raw)).stargazers_count;
}

export function fetchGitHubStarCount(options: { request?: HttpsRequest; timeoutMs?: number } = {}): Promise<number | null> {
  const requestImpl = options.request ?? httpsRequest;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (count: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(count);
    };

    try {
      const request = requestImpl(
        GITHUB_REPO_URL,
        {
          method: 'GET',
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'ktx-star-prompt',
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => {
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              finish(null);
              return;
            }
            try {
              finish(parseStarCount(Buffer.concat(chunks).toString('utf8')));
            } catch {
              finish(null);
            }
          });
        },
      );

      request.on('socket', (socket) => {
        socket.unref();
      });
      request.on('error', () => {
        finish(null);
      });
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error('GitHub star count request timed out'));
        finish(null);
      });
      request.end();
    } catch {
      finish(null);
    }
  });
}
