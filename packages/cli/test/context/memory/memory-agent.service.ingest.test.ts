import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Module-level mock for 'ai' so generateText is a stub. This file is separate from
// memory-agent.service.spec.ts so the existing pure-helper tests don't load the mock.
vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({ text: '', toolCalls: [] }),
  stepCountIs: (n: number) => n,
  tool: (def: unknown) => def,
}));

// Imported AFTER vi.mock so the mocked module is used.
import { generateText } from 'ai';
import { SYSTEM_GIT_AUTHOR } from '../../../src/context/tools/authors.js';
import { MemoryAgentService } from '../../../src/context/memory/memory-agent.service.js';

interface BuiltMocks {
  appSettings: any;
  prompt: any;
  eventTracker: any;
  telemetry: any;
  skillsRegistry: any;
  wikiService: any;
  indexRepository: any;
  knowledgeSlRefsRepository: any;
  knowledgeRepository: any;
  embeddingService: any;
  semanticLayerService: any;
  slSearchService: any;
  dataSourcesService: any;
  configService: any;
  gitService: any;
  lockingService: any;
  slSourcesRepository: any;
  sessionWorktreeService: any;
  semanticLayerSourceReconciler: any;
  agentRunner: any;
  slValidator: any;
  toolsetFactory: any;
  logger: any;
  autoCommit: boolean;
}

const buildMocks = (overrides: Partial<BuiltMocks> = {}): BuiltMocks => {
  const scopedConfig = { writeFile: vi.fn(), deleteFile: vi.fn() };
  const scopedGit = { revParseHead: vi.fn().mockResolvedValue('basesha') };
  const sessionWorktree = {
    chatId: 'chat-1',
    workdir: '/tmp/wt/session-chat-1',
    branch: 'session/chat-1',
    baseSha: 'basesha',
    createdAt: new Date(),
    git: scopedGit,
    config: scopedConfig,
  };

  const defaults: BuiltMocks = {
    appSettings: {
      settings: {
        ai: {
          knowledge: { userScopedKnowledgeEnabled: false },
          slValidation: { probeRowCount: 1 },
        },
        llm: { memoryIngestionModel: 'test-model' },
      },
    },
    prompt: { loadPrompt: vi.fn().mockResolvedValue('base framing') },
    eventTracker: { trackEvent: vi.fn(), createTelemetryIntegration: vi.fn().mockReturnValue(undefined) },
    telemetry: {
      isEnabled: () => false,
      appSettingsService: { settings: { telemetry: { recordInputs: false, recordOutputs: false } } },
      systemConfigService: { config: { instance: { name: 'test-instance' } } },
    },
    skillsRegistry: {
      listSkills: vi.fn().mockResolvedValue([]),
      buildSkillsPrompt: vi.fn().mockReturnValue(''),
      getSkill: vi.fn(),
      stripFrontmatter: vi.fn(),
    },
    wikiService: {
      forWorktree: vi.fn().mockReturnThis(),
      readPage: vi.fn(),
      syncSinglePage: vi.fn(),
      deleteFromIndex: vi.fn(),
    },
    indexRepository: { listPagesForUser: vi.fn().mockResolvedValue([]) },
    knowledgeSlRefsRepository: { syncFromWiki: vi.fn().mockResolvedValue({ inserted: 0, deleted: 0 }) },
    knowledgeRepository: {},
    embeddingService: { computeEmbedding: vi.fn() },
    semanticLayerService: {
      forWorktree: vi.fn().mockReturnThis(),
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
      readSourceFile: vi.fn(),
    },
    slSearchService: { indexSources: vi.fn(), buildSearchText: vi.fn() },
    dataSourcesService: {
      listEnabledConnections: vi.fn().mockResolvedValue([]),
      getConnectionById: vi.fn().mockResolvedValue({
        id: 'conn-1',
        name: 'Warehouse',
        connectionType: 'POSTGRESQL',
      }),
      executeQuery: vi.fn(),
    },
    configService: {
      enqueueCommitMessageJobForExternalCommit: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
    },
    gitService: {
      revParseHead: vi.fn().mockResolvedValue('basesha'),
      squashMergeIntoMain: vi.fn().mockResolvedValue({ ok: true, squashSha: 'cafebabe', touchedPaths: ['a.yaml'] }),
      stageSquashMergeIntoMain: vi
        .fn()
        .mockResolvedValue({ ok: true, touchedPaths: ['a.yaml'], stagedTree: 'deadbeeftree' }),
    },
    lockingService: {
      withLock: vi.fn().mockImplementation((_key: string, fn: () => Promise<unknown>) => fn()),
    },
    slSourcesRepository: { deleteByConnectionAndName: vi.fn() },
    sessionWorktreeService: {
      create: vi.fn().mockResolvedValue(sessionWorktree),
      cleanup: vi.fn().mockResolvedValue(undefined),
    },
    semanticLayerSourceReconciler: { upsertRow: vi.fn() },
    agentRunner: { runLoop: vi.fn().mockResolvedValue({ stopReason: 'natural' }) },
    slValidator: { validateSingleSource: vi.fn().mockResolvedValue({ errors: [], warnings: [] }) },
    toolsetFactory: {
      createIngestWuToolset: vi.fn().mockReturnValue({
        toRuntimeTools: vi.fn().mockReturnValue({}),
        getAllTools: vi.fn().mockReturnValue([]),
      }),
      createToolset: vi.fn().mockReturnValue({
        toRuntimeTools: vi.fn().mockReturnValue({}),
        getAllTools: vi.fn().mockReturnValue([]),
      }),
    },
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    autoCommit: true,
  };

  return { ...defaults, ...overrides };
};

const buildService = (mocks: BuiltMocks): MemoryAgentService =>
  new MemoryAgentService({
    settings: {
      knowledge: {
        userScopedKnowledgeEnabled: mocks.appSettings.settings.ai.knowledge.userScopedKnowledgeEnabled,
      },
      slValidation: {
        probeRowCount: mocks.appSettings.settings.ai.slValidation.probeRowCount,
      },
      llm: {
        memoryIngestionModel: mocks.appSettings.settings.llm.memoryIngestionModel,
      },
      autoCommit: mocks.autoCommit,
    },
    promptService: mocks.prompt,
    skillsRegistry: mocks.skillsRegistry,
    wikiService: mocks.wikiService,
    knowledgeIndex: mocks.indexRepository,
    knowledgeSlRefs: mocks.knowledgeSlRefsRepository,
    semanticLayerService: mocks.semanticLayerService,
    slSearchService: mocks.slSearchService,
    connections: {
      listEnabledConnections: vi.fn().mockResolvedValue([]),
      getConnectionById:
        mocks.dataSourcesService.getConnectionById ??
        vi.fn().mockResolvedValue({
          id: 'conn-1',
          name: 'Warehouse',
          connectionType: 'POSTGRESQL',
        }),
      executeQuery: mocks.dataSourcesService.executeQuery,
    },
    rootFileStore: mocks.configService,
    gitService: mocks.gitService,
    lockingService: mocks.lockingService,
    slSourcesRepository: mocks.slSourcesRepository,
    sessionWorktreeService: mocks.sessionWorktreeService,
    semanticLayerSourceReconciler: mocks.semanticLayerSourceReconciler,
    agentRunner: mocks.agentRunner,
    slValidator: mocks.slValidator,
    toolsetFactory: mocks.toolsetFactory,
    telemetry: {
      trackMemoryIngestion: mocks.eventTracker.trackEvent,
    },
    logger: mocks.logger,
  });

const baseInput = {
  userId: 'u1',
  chatId: 'chat-1',
  // Long enough + with a definition keyword so the prefilter doesn't skip.
  userMessage: 'going forward exclude cancelled orders from revenue, this is the canonical definition',
};

const generateTextMock = vi.mocked(generateText);

beforeEach(() => {
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({ text: '', toolCalls: [] } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MemoryAgentService.ingest — session-branch orchestration', () => {
  it('happy path: creates worktree, runs LLM loop, squash-merges, enqueues note, cleans up', async () => {
    const mocks = buildMocks();
    const svc = buildService(mocks);

    const result = await svc.ingest(baseInput);

    // Phase 1: session worktree was created from main's HEAD.
    expect(mocks.sessionWorktreeService.create).toHaveBeenCalledWith('chat-1', 'basesha');

    // Phase 2: LLM loop ran with the assembled tools/system/prompt.
    expect(mocks.agentRunner.runLoop).toHaveBeenCalledOnce();

    // Phase 3: squash-merged onto main.
    expect(mocks.gitService.squashMergeIntoMain).toHaveBeenCalledWith(
      'session/chat-1',
      SYSTEM_GIT_AUTHOR.name,
      SYSTEM_GIT_AUTHOR.email,
      expect.stringContaining('[chat=chat-1]'),
    );

    // Note enqueue happened on the ROOT configService, not the scoped one. The single
    // touched path is passed as the diff scope.
    expect(mocks.configService.enqueueCommitMessageJobForExternalCommit).toHaveBeenCalledWith(
      { commitHash: 'cafebabe' },
      expect.stringContaining('[chat=chat-1]'),
      'a.yaml',
    );

    // Cleanup ran with success.
    expect(mocks.sessionWorktreeService.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1' }),
      'success',
      expect.any(Object),
    );

    expect(result.commitHash).toBe('cafebabe');
  });

  it('with auto_commit disabled, stages the session on main without committing or enqueuing a note', async () => {
    const mocks = buildMocks({ autoCommit: false });
    const svc = buildService(mocks);

    const result = await svc.ingest(baseInput);

    // Applied to main via the staging path, never the committing path.
    expect(mocks.gitService.stageSquashMergeIntoMain).toHaveBeenCalledWith('session/chat-1');
    expect(mocks.gitService.squashMergeIntoMain).not.toHaveBeenCalled();
    // No commit means no commit-message enhancement job.
    expect(mocks.configService.enqueueCommitMessageJobForExternalCommit).not.toHaveBeenCalled();
    // The session still applied successfully; there is just no commit hash.
    expect(result.commitHash).toBeNull();
    expect(mocks.sessionWorktreeService.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1' }),
      'success',
      expect.any(Object),
    );
  });

  it('normalizes load_skill output to markdown while preserving structured payload', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-memory-skill-'));
    const skillDir = join(tempDir, 'memory_agent');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: memory_agent\n---\nSkill body', 'utf-8');
    try {
      const agentRunner = {
        runLoop: vi.fn(async (params: any) => {
          const result = await params.toolSet.load_skill.execute({ name: 'memory_agent' });
          expect(result.markdown).toContain('memory_agent');
          expect(result.structured).toMatchObject({ name: 'memory_agent' });
          return { stopReason: 'natural' as const };
        }),
      };
      const mocks = buildMocks({
        agentRunner,
        skillsRegistry: {
          listSkills: vi.fn().mockResolvedValue([{ name: 'memory_agent', path: skillDir }]),
          buildSkillsPrompt: vi.fn().mockReturnValue(''),
          getSkill: vi.fn().mockResolvedValue({ name: 'memory_agent', path: skillDir }),
          stripFrontmatter: vi.fn().mockReturnValue('Skill body'),
        },
      });
      const svc = buildService(mocks);

      await svc.ingest(baseInput);

      expect(agentRunner.runLoop).toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('logs prompt debug output when KTX_MEMORY_AGENT_DEBUG_PROMPTS is enabled', async () => {
    const previousDebugPrompts = process.env.KTX_MEMORY_AGENT_DEBUG_PROMPTS;
    const mocks = buildMocks();
    const svc = buildService(mocks);

    try {
      process.env.KTX_MEMORY_AGENT_DEBUG_PROMPTS = '1';

      await svc.ingest(baseInput);

      expect(mocks.logger.debug).toHaveBeenCalledWith(expect.stringContaining('[memory-agent prompt-debug] system='));
      expect(mocks.logger.debug).toHaveBeenCalledWith(expect.stringContaining('[memory-agent prompt-debug] user='));
    } finally {
      if (previousDebugPrompts === undefined) {
        delete process.env.KTX_MEMORY_AGENT_DEBUG_PROMPTS;
      } else {
        process.env.KTX_MEMORY_AGENT_DEBUG_PROMPTS = previousDebugPrompts;
      }
    }
  });

  it('empty path: squash returns no touched paths → no enqueue, cleanup(empty), commitHash=null', async () => {
    const mocks = buildMocks();
    mocks.gitService.squashMergeIntoMain.mockResolvedValue({
      ok: true,
      squashSha: 'basesha',
      touchedPaths: [],
    });
    const svc = buildService(mocks);

    const result = await svc.ingest(baseInput);

    expect(mocks.configService.enqueueCommitMessageJobForExternalCommit).not.toHaveBeenCalled();
    expect(mocks.sessionWorktreeService.cleanup).toHaveBeenCalledWith(expect.any(Object), 'empty', expect.any(Object));
    expect(result.commitHash).toBeNull();
  });

  it('conflict path: rolls back DB, cleanup(conflict, conflictPaths), returns commitHash=null with empty actions', async () => {
    const mocks = buildMocks();
    mocks.gitService.squashMergeIntoMain.mockResolvedValue({
      ok: false,
      conflict: true,
      conflictPaths: ['semantic-layer/conn-x/fct_intakes.yaml'],
    });
    // Have the wikiService report a still-existing page in main, so rollback re-syncs.
    mocks.wikiService.readPage.mockResolvedValue({
      pageKey: 'phantom',
      frontmatter: { summary: 'x', usage_mode: 'auto' },
      content: 'body',
    });
    const svc = buildService(mocks);

    const result = await svc.ingest(baseInput);

    expect(mocks.gitService.squashMergeIntoMain).toHaveBeenCalled();
    // Cleanup got the conflict outcome + the paths.
    expect(mocks.sessionWorktreeService.cleanup).toHaveBeenCalledWith(expect.any(Object), 'conflict', {
      conflictPaths: ['semantic-layer/conn-x/fct_intakes.yaml'],
    });
    expect(mocks.configService.enqueueCommitMessageJobForExternalCommit).not.toHaveBeenCalled();
    expect(result.commitHash).toBeNull();
    expect(result.actions).toEqual([]);
  });

  it('dirty-target path: rolls back DB and does not land when main has uncommitted changes', async () => {
    const mocks = buildMocks();
    mocks.gitService.squashMergeIntoMain.mockResolvedValue({
      ok: false,
      dirty: true,
      dirtyPaths: ['pending.md'],
    });
    const svc = buildService(mocks);

    const result = await svc.ingest(baseInput);

    // Treated as a not-landed abort: rolled back, no commit, no message-enhancement job.
    expect(mocks.sessionWorktreeService.cleanup).toHaveBeenCalledWith(expect.any(Object), 'conflict', expect.any(Object));
    expect(mocks.configService.enqueueCommitMessageJobForExternalCommit).not.toHaveBeenCalled();
    expect(result.commitHash).toBeNull();
    expect(result.actions).toEqual([]);
  });

  it('crash path: post-loop step throws → cleanup(crash), commitHash=null', async () => {
    const mocks = buildMocks();
    // Force the cross-ref reconciler to throw, escaping into the outer try/catch and
    // landing in the crash branch.
    mocks.knowledgeSlRefsRepository.syncFromWiki.mockRejectedValue(new Error('db down'));
    // squashMergeIntoMain shouldn't even be reached.
    mocks.gitService.squashMergeIntoMain.mockRejectedValue(new Error('should not be called after crash'));
    // Need a wiki action to trigger the cross-ref code path. Easiest: have the LLM mock
    // not push actions, so syncFromWiki is never called and crash won't happen here.
    // Instead, force the squash to throw.
    mocks.knowledgeSlRefsRepository.syncFromWiki.mockResolvedValue({ inserted: 0, deleted: 0 });
    mocks.gitService.squashMergeIntoMain.mockRejectedValue(new Error('git crashed'));

    const svc = buildService(mocks);

    const result = await svc.ingest(baseInput);

    expect(mocks.sessionWorktreeService.cleanup).toHaveBeenCalledWith(expect.any(Object), 'crash', expect.any(Object));
    expect(result.commitHash).toBeNull();
  });
});

describe('MemoryAgentService.ingest — concurrency regression', () => {
  it('two parallel ingest() calls produce distinct squash commits (no absorption)', async () => {
    // FIFO lock: each acquisition chains onto the previous holder's release. This is the
    // same shape as production withLock — the test asserts that two parallel ingests
    // sequence both their phase-1 (worktree create) and phase-3 (squash merge) calls
    // without deadlocking, and produce distinct commits.
    let chain: Promise<void> = Promise.resolve();
    const lockingService = {
      withLock: vi.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => {
        const previous = chain;
        let releaseMe!: () => void;
        chain = new Promise<void>((resolve) => {
          releaseMe = resolve;
        });
        await previous;
        try {
          return await fn();
        } finally {
          releaseMe();
        }
      }),
    };

    let createCount = 0;
    const sessionWorktreeService = {
      create: vi.fn().mockImplementation((chatId: string) => {
        createCount += 1;
        return Promise.resolve({
          chatId,
          workdir: `/tmp/wt/session-${chatId}`,
          branch: `session/${chatId}`,
          baseSha: 'basesha',
          createdAt: new Date(),
          git: { revParseHead: vi.fn().mockResolvedValue('basesha') },
          config: { writeFile: vi.fn() },
        });
      }),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };

    let mergeCount = 0;
    const gitService = {
      revParseHead: vi.fn().mockResolvedValue('basesha'),
      squashMergeIntoMain: vi.fn().mockImplementation(() => {
        mergeCount += 1;
        return Promise.resolve({
          ok: true,
          squashSha: `sha-${mergeCount}`,
          touchedPaths: [`${mergeCount}.yaml`],
        });
      }),
    };

    const mocksA = buildMocks({ lockingService, sessionWorktreeService, gitService });
    const mocksB = buildMocks({ lockingService, sessionWorktreeService, gitService });
    const svcA = buildService(mocksA);
    const svcB = buildService(mocksB);

    const [a, b] = await Promise.all([
      svcA.ingest({ ...baseInput, chatId: 'chat-A' }),
      svcB.ingest({ ...baseInput, chatId: 'chat-B' }),
    ]);

    expect(createCount).toBe(2);
    expect(gitService.squashMergeIntoMain).toHaveBeenCalledTimes(2);
    expect(a.commitHash).not.toBeNull();
    expect(b.commitHash).not.toBeNull();
    expect(a.commitHash).not.toBe(b.commitHash);
  });
});
