import { readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { z } from 'zod';
import { createAgentTool } from '../../agent/index.js';

interface ReadRawFileDeps {
  stagedDir: string;
  allowedPaths: Set<string>;
}

const MAX_READ_RAW_FILE_BYTES = 120_000;

export function createReadRawFileTool(deps: ReadRawFileDeps) {
  const stagedRoot = resolve(deps.stagedDir);
  return createAgentTool({
    name: 'read_raw_file',
    description:
      "Read the full text content of a raw source file inside this WorkUnit. `path` must be relative to the staged bundle root (no leading slash, no `..`) and must appear in the WorkUnit's rawFiles or dependencyPaths list.",
    inputSchema: z.object({
      path: z.string().describe('Path relative to the staged bundle root. Example: "views/customers/customer.lkml".'),
    }),
    execute: async ({ path }) => {
      const normalized = normalize(path).replace(/^[/\\]+/, '');
      if (normalized.startsWith('..') || !deps.allowedPaths.has(normalized)) {
        return `Error: path "${path}" is not accessible from this WorkUnit. Allowed paths: ${[...deps.allowedPaths].sort().join(', ')}`;
      }
      const absolute = resolve(join(stagedRoot, normalized));
      if (!absolute.startsWith(`${stagedRoot}/`) && absolute !== stagedRoot) {
        return `Error: path "${path}" is not accessible from this WorkUnit.`;
      }
      try {
        const fileStat = await stat(absolute);
        if (fileStat.size > MAX_READ_RAW_FILE_BYTES) {
          return `Error: file "${path}" is too large to return in full (${fileStat.size} bytes). Use read_raw_span with targeted line ranges instead.`;
        }
        return await readFile(absolute, 'utf-8');
      } catch (err) {
        return `Error: file "${path}" not found. (${err instanceof Error ? err.message : String(err)})`;
      }
    },
  });
}
