import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject } from '../src/context/project/project.js';
import { type KtxProjectConnectionConfig, parseKtxProjectConfig, serializeKtxProjectConfig } from '../src/context/project/config.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runKtxSetupSourcesStep,
  type KtxSetupSourcesPromptAdapter,
} from '../src/setup-sources.js';

const notionMocks = vi.hoisted(() => ({
  tokens: [] as string[],
  retrieveBotUser: vi.fn(async () => ({ name: 'Docs Bot' })),
  retrievePage: vi.fn(async () => ({ id: 'page-1' })),
}));

vi.mock('../src/context/ingest/adapters/notion/notion-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/context/ingest/adapters/notion/notion-client.js')>();
  return {
    ...actual,
    NotionClient: vi.fn().mockImplementation(function NotionClient(token: string) {
      notionMocks.tokens.push(token);
      return {
        retrieveBotUser: notionMocks.retrieveBotUser,
        retrievePage: notionMocks.retrievePage,
      };
    }),
  };
});

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: true,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function prompts(values: { multiselect?: string[][]; select?: string[] }): KtxSetupSourcesPromptAdapter {
  const multiselectValues = [...(values.multiselect ?? [])];
  const selectValues = [...(values.select ?? [])];
  return {
    multiselect: vi.fn(async () => multiselectValues.shift() ?? []),
    select: vi.fn(async () => selectValues.shift() ?? 'back'),
    autocomplete: vi.fn(async () => selectValues.shift() ?? 'back'),
    text: vi.fn(async () => ''),
    password: vi.fn(async () => undefined),
    cancel: vi.fn(),
    log: vi.fn(),
  };
}

describe('setup sources Notion validation', () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    notionMocks.tokens.length = 0;
    notionMocks.retrieveBotUser.mockClear();
    notionMocks.retrievePage.mockClear();
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-sources-notion-'));
    projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function readConfig() {
    return parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
  }

  async function writeConfigConnection(connectionId: string, connection: KtxProjectConnectionConfig) {
    const config = await readConfig();
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      serializeKtxProjectConfig({
        ...config,
        connections: {
          ...config.connections,
          warehouse: { driver: 'postgres', url: 'env:DATABASE_URL' },
          [connectionId]: connection,
        },
        setup: {
          ...config.setup,
          database_connection_ids: ['warehouse'],
        },
      }),
      'utf-8',
    );
  }

  it('validates an existing Notion source that uses an inline auth token', async () => {
    await writeConfigConnection('notion', {
      driver: 'notion',
      auth_token: 'ntn_inline_token',
      crawl_mode: 'all_accessible',
    });
    const io = makeIo();

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: prompts({
            multiselect: [['notion']],
            select: ['existing:notion'],
          }),
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['notion'] });

    expect(notionMocks.tokens).toEqual(['ntn_inline_token']);
    expect(notionMocks.retrieveBotUser).toHaveBeenCalledOnce();
    expect(io.stderr()).toBe('');
  });
});
