import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createJsonlKtxLlmDebugRequestRecorder,
  summarizeKtxLlmDebugRequest,
} from '../../../src/context/llm/debug-request-recorder.js';

describe('summarizeKtxLlmDebugRequest', () => {
  it('records providerOptions positions without message text or tool schemas', () => {
    const summary = summarizeKtxLlmDebugRequest({
      operationName: 'ingest-bundle-wu',
      source: 'metabase',
      jobId: 'job-1',
      unitKey: 'cards/1',
      modelRole: 'candidateExtraction',
      modelId: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'system',
          content: 'SECRET SYSTEM PROMPT',
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'SECRET USER PROMPT',
              providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } } },
            },
          ],
        },
      ],
      tools: {
        emit_candidate: {
          description: 'SECRET TOOL DESCRIPTION',
          inputSchema: { secret: true },
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
        },
      },
    });

    expect(summary).toMatchObject({
      operationName: 'ingest-bundle-wu',
      source: 'metabase',
      jobId: 'job-1',
      unitKey: 'cards/1',
      modelRole: 'candidateExtraction',
      modelId: 'claude-sonnet-4-6',
      messageCount: 2,
      toolNames: ['emit_candidate'],
      providerOptions: [
        {
          target: 'message',
          index: 0,
          role: 'system',
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
        },
        {
          target: 'message-part',
          index: 1,
          role: 'user',
          partIndex: 0,
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } } },
        },
        {
          target: 'tool',
          name: 'emit_candidate',
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
        },
      ],
    });

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('SECRET SYSTEM PROMPT');
    expect(serialized).not.toContain('SECRET USER PROMPT');
    expect(serialized).not.toContain('SECRET TOOL DESCRIPTION');
    expect(serialized).not.toContain('inputSchema');
  });
});

describe('createJsonlKtxLlmDebugRequestRecorder', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('appends one JSON object per recorded request', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-llm-debug-'));
    const filePath = join(tempDir, 'nested', 'llm-debug.jsonl');
    const recorder = createJsonlKtxLlmDebugRequestRecorder(filePath);

    await recorder.record({
      timestamp: '2026-05-04T00:00:00.000Z',
      operationName: 'ingest-bundle-wu',
      modelRole: 'candidateExtraction',
      modelId: 'claude-sonnet-4-6',
      messageCount: 2,
      toolNames: ['emit_candidate'],
      providerOptions: [],
    });
    await recorder.record({
      timestamp: '2026-05-04T00:00:01.000Z',
      operationName: 'ingest-bundle-reconcile',
      modelRole: 'reconcile',
      modelId: 'claude-sonnet-4-6',
      messageCount: 2,
      toolNames: [],
      providerOptions: [],
    });

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ operationName: 'ingest-bundle-wu', modelRole: 'candidateExtraction' });
    expect(lines[1]).toMatchObject({ operationName: 'ingest-bundle-reconcile', modelRole: 'reconcile' });
  });
});
