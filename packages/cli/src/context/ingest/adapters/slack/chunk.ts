import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ChunkResult, DiffSet, ScopeDescriptor, WorkUnit } from '../../types.js';
import { slackManifestSchema } from './types.js';

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
    .sort();
}

function safeUnitKey(path: string): string {
  return `slack-${path
    .replace(/^wiki\/global\//, '')
    .replace(/\.md$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}`;
}

async function readManifest(stagedDir: string) {
  try {
    return slackManifestSchema.parse(JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8')));
  } catch (error) {
    throw new Error(`Invalid Slack manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function chunkSlackStagedDir(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
  const files = await walk(stagedDir);
  const manifest = await readManifest(stagedDir);
  const touched = diffSet ? new Set([...diffSet.added, ...diffSet.modified]) : null;
  const markdownFiles = files.filter((path) => path.startsWith('wiki/global/') && path.endsWith('.md'));
  const workUnits: WorkUnit[] = [];

  for (const markdownPath of markdownFiles) {
    if (touched && !touched.has(markdownPath)) {
      continue;
    }
    const dependencyPaths = ['manifest.json'].filter((path) => path !== markdownPath);
    workUnits.push({
      unitKey: safeUnitKey(markdownPath),
      displayLabel: markdownPath.replace(/^wiki\/global\//, ''),
      rawFiles: [markdownPath],
      dependencyPaths,
      peerFileIndex: markdownFiles.filter((path) => path !== markdownPath).sort(),
      notes:
        'Synthesize durable wiki knowledge from this allowlisted Slack source. Treat Slack as wiki-only context unless another mapped source is confirmed with discover_data.',
    });
  }

  return {
    workUnits,
    eviction: diffSet && diffSet.deleted.length > 0 ? { deletedRawPaths: [...diffSet.deleted].sort() } : undefined,
    reconcileNotes: [
      `Slack channels fetched: ${manifest.channelIds.join(', ')}`,
      `Slack maxMessagesPerChannel=${manifest.maxMessagesPerChannel}`,
      'Slack ingest reads only configured allowlisted channels.',
    ],
    contextReport: {
      warnings: manifest.warnings,
    },
  };
}

export async function describeSlackScope(stagedDir: string): Promise<ScopeDescriptor> {
  const manifest = await readManifest(stagedDir);
  const scopeKey = JSON.stringify({
    channelIds: [...manifest.channelIds].sort(),
    maxMessagesPerChannel: manifest.maxMessagesPerChannel,
  });
  const fingerprint = createHash('sha256').update(scopeKey).digest('hex');
  return {
    fingerprint,
    isPathInScope: (rawPath) =>
      rawPath === 'manifest.json' || rawPath.startsWith('wiki/global/slack/'),
  };
}
