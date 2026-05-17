import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitService } from '../../core/index.js';
import { FileIngestTraceWriter } from '../ingest-trace.js';
import { integrateWorkUnitPatch } from './patch-integrator.js';

async function makeRepo() {
  const homeDir = await mkdtemp(join(tmpdir(), 'ktx-integrate-'));
  const configDir = join(homeDir, 'config');
  const git = new GitService({
    storage: { configDir, homeDir },
    git: {
      userName: 'System User',
      userEmail: 'system@example.com',
      bootstrapMessage: 'init',
      bootstrapAuthor: 'system',
      bootstrapAuthorEmail: 'system@example.com',
    },
  });
  await git.onModuleInit();
  await mkdir(join(configDir, 'wiki/global'), { recursive: true });
  await writeFile(join(configDir, 'wiki/global/a.md'), 'old\n');
  await git.commitFiles(['wiki/global/a.md'], 'base', 'System User', 'system@example.com');
  return { homeDir, configDir, git, baseSha: await git.revParseHead() };
}

describe('integrateWorkUnitPatch', () => {
  it('applies a clean patch, runs semantic gates, and commits accepted changes', async () => {
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    const childDir = join(homeDir, 'child');
    await git.addWorktree(childDir, 'child', baseSha);
    const childGit = git.forWorktree(childDir);
    await writeFile(join(childDir, 'wiki/global/a.md'), 'new\n');
    await childGit.commitFiles(['wiki/global/a.md'], 'edit', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/wu.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-1/trace.jsonl'),
      jobId: 'job-1',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-1',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'KTX Test', email: 'system@ktx.local' },
      validateAppliedTree: vi.fn().mockResolvedValue(undefined),
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['c1']),
    });

    expect(result.status).toBe('accepted');
    await expect(readFile(join(configDir, 'wiki/global/a.md'), 'utf-8')).resolves.toBe('new\n');
    await expect(readFile(trace.tracePath, 'utf-8')).resolves.toContain('patch_apply_finished');
  });

  it('rolls back and classifies semantic conflicts', async () => {
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    const childDir = join(homeDir, 'child-semantic');
    await git.addWorktree(childDir, 'child-semantic', baseSha);
    const childGit = git.forWorktree(childDir);
    await writeFile(join(childDir, 'wiki/global/a.md'), 'bad\n');
    await childGit.commitFiles(['wiki/global/a.md'], 'bad edit', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/bad.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-2/trace.jsonl'),
      jobId: 'job-2',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-bad',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'KTX Test', email: 'system@ktx.local' },
      validateAppliedTree: vi.fn().mockRejectedValue(new Error('final artifact gates failed')),
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['c1']),
    });

    expect(result.status).toBe('semantic_conflict');
    await expect(readFile(join(configDir, 'wiki/global/a.md'), 'utf-8')).resolves.toBe('old\n');
  });

  it('classifies slDisallowed patch policy failures as traced textual conflicts', async () => {
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    await mkdir(join(configDir, 'semantic-layer/c1'), { recursive: true });
    await git.commitFiles(['semantic-layer/c1'], 'empty sl dir', 'System User', 'system@example.com');
    const childDir = join(homeDir, 'child-policy');
    await git.addWorktree(childDir, 'child-policy', baseSha);
    const childGit = git.forWorktree(childDir);
    await mkdir(join(childDir, 'semantic-layer/c1'), { recursive: true });
    await writeFile(join(childDir, 'semantic-layer/c1/orders.yaml'), 'name: orders\ncolumns: []\njoins: []\nmeasures: []\n');
    await childGit.commitFiles(['semantic-layer/c1/orders.yaml'], 'forbidden sl', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/forbidden.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-policy/trace.jsonl'),
      jobId: 'job-policy',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'lookml-mismatch',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'KTX Test', email: 'system@ktx.local' },
      validateAppliedTree: vi.fn().mockResolvedValue(undefined),
      slDisallowed: true,
      allowedTargetConnectionIds: new Set(['c1']),
    });

    expect(result).toMatchObject({
      status: 'textual_conflict',
      touchedPaths: ['semantic-layer/c1/orders.yaml'],
    });
    const rawTrace = await readFile(trace.tracePath, 'utf-8');
    expect(rawTrace).toContain('patch_policy_rejected');
    expect(rawTrace).toContain('slDisallowed WorkUnit lookml-mismatch touched semantic-layer/c1/orders.yaml');
  });

  it('classifies unauthorized semantic-layer targets as traced textual conflicts', async () => {
    const { homeDir, git, baseSha } = await makeRepo();
    const childDir = join(homeDir, 'child-target-policy');
    await git.addWorktree(childDir, 'child-target-policy', baseSha);
    const childGit = git.forWorktree(childDir);
    await mkdir(join(childDir, 'semantic-layer/finance'), { recursive: true });
    await writeFile(
      join(childDir, 'semantic-layer/finance/orders.yaml'),
      'name: orders\ncolumns: []\njoins: []\nmeasures: []\n',
    );
    await childGit.commitFiles(['semantic-layer/finance/orders.yaml'], 'unauthorized sl', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/unauthorized.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-target-policy/trace.jsonl'),
      jobId: 'job-target-policy',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-finance',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'KTX Test', email: 'system@ktx.local' },
      validateAppliedTree: vi.fn().mockResolvedValue(undefined),
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['warehouse']),
    });

    expect(result).toMatchObject({
      status: 'textual_conflict',
      touchedPaths: ['semantic-layer/finance/orders.yaml'],
    });
    const rawTrace = await readFile(trace.tracePath, 'utf-8');
    expect(rawTrace).toContain('patch_policy_rejected');
    expect(rawTrace).toContain('semantic-layer target connection not allowed');
    expect(rawTrace).toContain('allowedTargetConnectionIds');
  });
});
