import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { flushToolCallLogs, wrapToolsWithLogger } from '../../../../src/context/ingest/tools/tool-call-logger.js';

describe('wrapToolsWithLogger + flushToolCallLogs', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  function toolset() {
    return {
      my_tool: {
        name: 'my_tool',
        description: 'test tool',
        inputSchema: z.object({}),
        execute: async (_input: unknown) => ({ markdown: 'ok' }),
      },
    };
  }

  it('makes the fire-and-forget transcript write observable after a flush', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ktx-toollog-'));
    dirs.push(dir);
    const logPath = join(dir, 'wu.jsonl');
    const wrapped = wrapToolsWithLogger(toolset(), logPath, 'cards/users');

    await wrapped.my_tool.execute({});
    // The append is fire-and-forget; flushing must guarantee it has landed.
    await flushToolCallLogs();

    const entry = JSON.parse((await readFile(logPath, 'utf-8')).trim());
    expect(entry.wuKey).toBe('cards/users');
    expect(entry.toolName).toBe('my_tool');
    expect(typeof entry.durationMs).toBe('number');
  });

  it('resolves immediately when there is nothing to flush', async () => {
    await expect(flushToolCallLogs()).resolves.toBeUndefined();
  });

  it('is bounded by its timeout and never rejects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ktx-toollog-'));
    dirs.push(dir);
    const wrapped = wrapToolsWithLogger(toolset(), join(dir, 'wu.jsonl'), 'wu/1');
    await wrapped.my_tool.execute({});
    await expect(flushToolCallLogs(0)).resolves.toBeUndefined();
  });
});
